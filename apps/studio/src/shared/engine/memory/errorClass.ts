/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deterministic classification of a failure into a small, closed taxonomy — the `error_class` the
 * failure memory matches on. Matching happens on the class, never the raw message, so one
 * connection's stack-trace noise can't fragment the memory.
 *
 * The app has no structured driver error codes (every driver flattens its error to a string), so this
 * is lexical: vendor-spanning patterns per class, spanning Postgres / MySQL / SQL Server / Oracle /
 * DB2 / SQLite. `unclassified` is a first-class, MEASURED outcome — a high unclassified rate is the
 * signal to extend the taxonomy, not a silent gap. Keep the enum closed and grow it from real data.
 */
export type ErrorClass =
	| 'unsupported-translation'
	| 'deadlock'
	| 'timeout'
	| 'constraint-violation'
	| 'type-mismatch'
	/** The query ran into a limit on what it may use: memory, a quota, too many parts to insert
	 *  into, too many queries at once. Not wrong SQL: the same statement can pass on a smaller read. */
	| 'resource-limit'
	| 'unclassified';

/** Where a failure surfaced. A translation failure is known by construction (the compiler refused);
 *  an execution failure is classified lexically from the driver message. */
export type FailureOrigin = 'execution' | 'translation';

// Ordered: the FIRST class whose pattern matches wins. Order resolves the rare overlap — a lock-wait
// message mentions "timeout", a constraint message may name a column's type — so higher-signal, more
// specific classes come first (deadlock before the generic timeout; constraint before type).
const PATTERNS: ReadonlyArray<readonly [ErrorClass, RegExp]> = [
	// A distinct word across every vendor (PG "deadlock detected", MySQL "Deadlock found", SQL Server
	// "was deadlocked").
	['deadlock', /deadlock/i],
	// Statement/lock timeouts and server-side execution time limits. Genuine user cancellations never
	// reach here — they're filtered at the write site by the `cancelled` flag, not by message.
	['timeout', /timed?\s*out|timeout expired|statement timeout|lock wait timeout|maximum statement execution time|execution was interrupted|e(?:socket)?timedout/i],
	// Unique / FK / not-null / check violations and their NULL-insert phrasings, plus Oracle codes
	// (ORA-00001 unique, ORA-0229x integrity, ORA-01400 NULL).
	['constraint-violation', /violates .*constraint|constraint failed|duplicate (?:entry|key)|unique constraint|foreign key constraint|integrity constraint|check constraint|cannot be null|does not allow nulls|cannot insert the value null|null value in column .* violates|ora-00001|ora-0229[0-2]|ora-01400/i],
	// Cast / conversion / wrong-literal errors (ORA-01722 invalid number, ORA-01858, ORA-00932
	// inconsistent datatypes).
	// Out of memory or over a quota, on any engine (PG "out of memory", SQL Server "insufficient
	// system memory", MySQL "total number of locks exceeds the lock table size").
	['resource-limit', /out of memory|insufficient system memory|memory limit|exceeds the lock table size|quota exceeded|too many (?:parts|simultaneous queries)/i],
	['type-mismatch', /invalid input syntax|cannot cast|operator does not exist|conversion failed|error converting|operand type clash|incorrect .* value|data truncat|inconsistent datatypes|invalid number|is of type .* but expression is of type|ora-01722|ora-01858|ora-00932/i],
];

/**
 * ClickHouse puts a stable numeric code in every error (`Code: 241. DB::Exception: ...`), which is
 * better evidence than the wording around it, so a known code decides before any pattern is tried.
 */
const CLICKHOUSE_CODES: ReadonlyMap<number, ErrorClass> = new Map<number, ErrorClass>([
	[159, 'timeout'], // TIMEOUT_EXCEEDED
	[209, 'timeout'], // SOCKET_TIMEOUT
	[241, 'resource-limit'], // MEMORY_LIMIT_EXCEEDED
	[252, 'resource-limit'], // TOO_MANY_PARTS
	[202, 'resource-limit'], // TOO_MANY_SIMULTANEOUS_QUERIES
	[201, 'resource-limit'], // QUOTA_EXCEEDED
	[396, 'resource-limit'], // TOO_MANY_ROWS_OR_BYTES
	[158, 'resource-limit'], // TOO_MANY_ROWS
	[307, 'resource-limit'], // TOO_MANY_BYTES
	[53, 'type-mismatch'], // TYPE_MISMATCH
	[70, 'type-mismatch'], // CANNOT_CONVERT_TYPE
	[6, 'type-mismatch'], // CANNOT_PARSE_TEXT
	[27, 'type-mismatch'], // CANNOT_PARSE_INPUT_ASSERTION_FAILED
	[38, 'type-mismatch'], // CANNOT_PARSE_DATE
	[41, 'type-mismatch'], // CANNOT_PARSE_DATETIME
	[72, 'type-mismatch'], // CANNOT_PARSE_NUMBER
	[43, 'type-mismatch'], // ILLEGAL_TYPE_OF_ARGUMENT
	[386, 'type-mismatch'], // NO_COMMON_TYPE
	[469, 'constraint-violation'], // VIOLATED_CONSTRAINT
]);

/** The numeric code of a ClickHouse error, or undefined for any other message. */
export function clickhouseErrorCode(message: string): number | undefined {
	const match = /Code: (\d+)\. DB::Exception/.exec(message);
	return match ? Number(match[1]) : undefined;
}

/**
 * Classify a failure. Translation-origin failures are always `unsupported-translation` (deterministic
 * by construction). Execution-origin failures are matched lexically; no match is `unclassified`.
 */
export function classifyError(message: string, origin: FailureOrigin): ErrorClass {
	if (origin === 'translation') {
		return 'unsupported-translation';
	}
	const text = message ?? '';
	const code = clickhouseErrorCode(text);
	const byCode = code === undefined ? undefined : CLICKHOUSE_CODES.get(code);
	if (byCode) {
		return byCode;
	}
	for (const [cls, pattern] of PATTERNS) {
		if (pattern.test(text)) {
			return cls;
		}
	}
	return 'unclassified';
}

// Codes a driver puts in its message, most specific first. Each pattern matches a FIXED shape (a
// SQLSTATE is five characters, an Oracle code is ORA- and five digits), so what it returns cannot
// carry a value out of the message around it.
const CODE_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
	[/\bSQLSTATE[\s=:[(]*([0-9A-Z]{5})\b/i, (m) => `SQLSTATE ${m[1].toUpperCase()}`],
	[/\b(ORA-\d{5})\b/, (m) => m[1]],
	[/Code: (\d+)\. DB::Exception/, (m) => `Code ${m[1]}`],
	[/\b(ER_[A-Z_]{3,})\b/, (m) => m[1]],
	[/\b(SQLITE_[A-Z_]{3,})\b/, (m) => m[1]],
	[/\bMsg (\d{3,6})\b/, (m) => `Msg ${m[1]}`],
	[/\bSQLCODE[\s=:]*(-?\d{1,5})\b/i, (m) => `SQLCODE ${m[1]}`],
	[/\b(?:errno|error number|error code)[\s=:]+(\d{3,5})\b/i, (m) => `error ${m[1]}`],
	[/\b(E(?:CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|HOSTUNREACH|ADDRINUSE|PIPE|AI_AGAIN))\b/, (m) => m[1]],
];

/** The engine's own code in a driver message (a SQLSTATE, `ORA-00001`, `ER_DUP_ENTRY`, ...), if it has one. */
export function errorCode(message: string): string | undefined {
	const text = message ?? '';
	for (const [pattern, format] of CODE_PATTERNS) {
		const match = pattern.exec(text);
		if (match) {
			return format(match);
		}
	}
	return undefined;
}

/**
 * A database error with its text taken out: its class and its code, and nothing quoted. What a
 * database says when something fails can quote the values it failed on (a duplicate key, the input
 * it could not cast), so this is the form handed to a model that may not see values.
 */
export function valueFreeError(message: string): string {
	const code = errorCode(message);
	return `A database error (class: ${classifyError(message, 'execution')}${code ? `, code: ${code}` : ''}). Its text is withheld: it can quote values from the database, which the AI may not see here.`;
}

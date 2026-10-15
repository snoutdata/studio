/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prod write guard (ported from the original VSCode extension). Pure, deterministic — no parser
// dependency: scans `;`-split statements for a destructive verb and flags an UPDATE/DELETE
// with no WHERE clause (it would affect every row).
//
// It is the one check behind four gates — the dashboard's confirm, `cloud-project-sql`'s refusal
// on a production project, Studio's production confirm and its read-only connections — and the
// agent broker's read-only test builds on it. So it reads the statement the DATABASE will run,
// not its first word. A QA pass on 2026-10-01 ran all of these on a project marked production,
// with no question asked by the page or the server:
//
//   WITH gone AS (DELETE FROM t RETURNING *) SELECT count(*) FROM gone   -- a write behind WITH
//   DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$                           -- an opaque block
//
// and a leading comment, EXPLAIN ANALYZE (which executes its statement) and CALL went through the
// same hole. Everything below is found on a copy of the SQL with comments removed and the insides
// of strings, quoted identifiers and dollar-quoted bodies blanked, so neither a `;` in a string
// nor a comment can hide or invent a statement.
//
// Three rules keep a write from running on a production or read-only connection unasked:
//
// 1. The text is read the way the connection's ENGINE reads it. Postgres nests block comments and
//    escapes a backslash in E'...', and in every string when standard_conforming_strings is off
//    (a database or role can set that, so Postgres is lexed with both rules); MySQL runs the inside of `/*! ... */` (MariaDB's `/*M!` and TiDB's `/*T!` too), does not nest, needs
//    whitespace after `--` and escapes `\` in every string; SQL Server has [bracketed] names; Oracle
//    has q'[...]' strings; Snowflake has `//` comments, and its `->>` flow operator runs the statement
//    after it, so it splits a statement like `;`. A statement the engine sees and the lexer
//    does not is a statement nobody judged. So callers pass the connection's driver id, and the SQL
//    is lexed with Postgres's rules AND that engine's: a statement either reading finds is judged,
//    so where the two disagree the guard takes the worse answer. An unknown driver is lexed every
//    way there is. No driver means Postgres (both of its string rules), which is what the cloud copy
//    of this file serves.
// 2. It is an ALLOW-list. A statement is a read only when it leads with a read (SELECT, WITH, SHOW,
//    DESCRIBE, EXPLAIN without ANALYZE, VALUES, TABLE) or is session bookkeeping that writes
//    nothing: transaction control, USE, and the SET forms each engine keeps to the session (all of
//    Postgres's; MySQL's but GLOBAL, PERSIST, PASSWORD and DEFAULT ROLE; SQL Server's `SET x ON`).
//    Anything else (an IF or BEGIN block, a bare procedure call, LOAD DATA, VACUUM, a verb nobody
//    listed) is reported with its first word as the verb, so it is confirmed or blocked. SQL Server
//    runs a batch with no `;` between its statements, so there a write verb ANYWHERE counts, and
//    so does transaction control (COMMIT, ROLLBACK, SAVE TRAN, a BEGIN TRAN inside a statement) and
//    the statements that act with no write verb (DISABLE/ENABLE TRIGGER, RECEIVE, WRITETEXT): a
//    COMMIT ends the transaction a read-only run is rolled back in. An unknown driver reads the same.
//    Session bookkeeping is a read to a production confirm, never to a read-only run: there
//    `readOnlyEscape` refuses the transaction control and the settings that step out of it.
// 3. A read with a write inside it is the write. Db2 runs DML from inside a SELECT
//    (`SELECT * FROM OLD TABLE (DELETE FROM t)`, `FINAL TABLE (UPDATE ...)`, `NEW TABLE (INSERT ...)`),
//    Postgres from a CTE (`WITH x AS (DELETE ...)`, MERGE ... RETURNING on 17) and from COPY (...) TO,
//    so a DML/DDL verb inside a read's parentheses is judged as the statement, whatever leads.
//
// 4. A statement that reads or writes a FILE ON THE DATABASE SERVER is judged by that, whatever it
//    leads with: MySQL's `INTO OUTFILE`/`INTO DUMPFILE` after a SELECT, a TABLE or a VALUES,
//    LOAD DATA and LOAD_FILE(), Postgres's large-object and admin file functions (every
//    `pg_read_*`, every `pg_ls_*`, `pg_stat_file`), SQL Server's xp_cmdshell, OLE automation,
//    OPENROWSET(BULK ...) and the functions that open an audit, trace or event file by path,
//    Oracle's BFILENAME and UTL_FILE, SQLite's readfile/writefile/load_extension. Found anywhere in
//    the blanked text, on every engine (`serverFileAccess`): until 2026-10-14 only a SELECT's INTO
//    was looked at, so MySQL 8's `TABLE t INTO OUTFILE '...'` and `VALUES ROW(1) INTO DUMPFILE '...'`
//    passed as reads. A string naming a network share is the read check's (`uncPath`).
//
// 5. On Db2, SAP HANA and Oracle every EXPLAIN writes the plan into a table (`explainStoresPlan`),
//    so there it is a write, where elsewhere a plain EXPLAIN only answers.
//
// What no lexer can see is a SELECT that calls a function with a side effect (pg_terminate_backend,
// dblink_exec). `sideEffects.ts` lists those for the gates that run reads unasked.
//
// Self-contained on purpose: this one file is copied verbatim into the cloud's server functions and
// the dashboard, so it imports nothing.

export interface DestructiveStatement {
	verb: string;
	/** true for an UPDATE/DELETE with no WHERE, or one that is always true: it would affect every row. */
	unfiltered: boolean;
}

/**
 * The first destructive (write/DDL) statement in `sql`, if any, or any statement the guard cannot
 * read as a plain read. `driver` is the connection's driver id (`ConnectionConfig.driver`); absent,
 * the SQL is read as Postgres.
 */
export function destructiveStatement(sql: string, driver?: string): DestructiveStatement | undefined {
	const rules = rulesFor(driver);
	const storesPlan = explainStoresPlan(driver);
	for (const statement of guardStatements(sql, driver)) {
		const found = classify(statement, rules, storesPlan);
		if (found) {
			return found;
		}
	}
	// A gated executable comment runs on some servers and versions and not others, so what runs
	// may be neither the code reading nor the comment reading above: not a plain read.
	const gated = executableComments(sql, driver).find((opener) => opener !== '/*!');
	return gated ? { verb: `${gated} ... */`, unfiltered: false } : undefined;
}

/**
 * The executable comments in `sql` that a MySQL-family server may run as code, by their openers as
 * written (`/*!`, `/*!50000`, `/*M!`, `/*M!100100`, `/*T!`, `/*T![clustered_index]`), read by every
 * lexer the driver needs that has them: MySQL, MariaDB, TiDB, OceanBase, SingleStore, and any driver
 * nobody knows. Optimizer hints (slash-star-plus) are not among them. Empty on every other engine.
 * A bare `/*!` runs on every one of those servers; the others run only on one family or from one
 * version, so a statement that holds one cannot be judged by its text alone.
 */
export function executableComments(sql: string, driver?: string): string[] {
	const openers: string[] = [];
	for (const lexer of lexersFor(driver)) {
		if (lexer.executable) {
			blank(sql, lexer, undefined, openers);
		}
	}
	return openers;
}

/**
 * The statements in `sql` as the guard reads them: comments gone, the insides of literals and
 * quoted identifiers blanked (their quotes kept), split on the `;` that really end a statement,
 * trimmed, empties dropped. Read once per lexer the driver needs (see the header), so a statement
 * only one engine's reading finds is still in the list. Exported for the agent broker's read-only
 * test, which has to look at the same text this does.
 */
export function guardStatements(sql: string, driver?: string): string[] {
	return merged(readings(sql, driver, false));
}

/**
 * {@link guardStatements} with every quoted identifier read as the bare name it holds: `"SEQ1"."NEXTVAL"`,
 * `` `sys_exec` `` and `[xp_cmdshell]` become ` SEQ1 . NEXTVAL `, ` sys_exec ` and ` xp_cmdshell `, a
 * character no bare name may hold becoming `_`, so one quoted name is always one word. Strings stay
 * blanked. For a check that matches NAMES (`sideEffects.ts`), which quoting would otherwise hide; a
 * check that looks for keywords reads {@link guardStatements}, where a column called `"begin"` is no
 * BEGIN. A `"..."` that is a string on MySQL reads as a name here too, which can only refuse more.
 */
export function guardNamedStatements(sql: string, driver?: string): string[] {
	return merged(readings(sql, driver, true));
}

/**
 * The raw inside of every string in `sql` (and of every `"..."`, which is a string on some engines),
 * by every lexer the driver needs, escapes and doubled quotes left as written. For the check that
 * reads what a string would run if something ran it (`sideEffects.ts`).
 */
export function guardLiterals(sql: string, driver?: string): string[] {
	const out: string[] = [];
	for (const lexer of lexersFor(driver)) {
		const literals: string[] = [];
		blank(sql, lexer, literals);
		for (const literal of literals) {
			if (!out.includes(literal)) {
				out.push(literal);
			}
		}
	}
	return out;
}

function merged(readingsOf: string[][]): string[] {
	const out: string[] = [];
	for (const reading of readingsOf) {
		for (const statement of reading) {
			if (!out.includes(statement)) {
				out.push(statement);
			}
		}
	}
	return out;
}

/**
 * The statements in `sql`, once per lexer the driver needs, each reading kept apart: what
 * {@link guardStatements} merges. A reading split on more than the `;` (Snowflake's `->>` flow
 * operator runs the statement after it) holds more statements than one that is not, which is how a
 * caller that admits exactly ONE statement tells a pipeline from a query.
 */
export function guardReadings(sql: string, driver?: string): string[][] {
	return readings(sql, driver, false);
}

function readings(sql: string, driver: string | undefined, names: boolean): string[][] {
	return lexersFor(driver).map((lexer) =>
		blank(sql, lexer, undefined, undefined, names).split(lexer.flow ? /;|->>/ : ';').map((raw) => raw.trim()).filter((statement) => statement !== ''));
}

const VERBS =
	/^(delete|update|drop|truncate|alter|insert|replace|create|grant|revoke|merge|comment|reindex|cluster|refresh|reassign|import|security|upsert|rename)\b/i;

/** Statements whose effect is not on their face: a block of procedural code, a procedure, a prepared statement. */
const OPAQUE = /^(do|call|execute|exec)\b/i;

/** The statements that only read. Everything else is asked about, unless it is session bookkeeping. */
const READ_LEAD = /^(select|with|show|describe|desc|explain|values|table)\b/i;

/**
 * Verbs SQL Server runs from anywhere in a batch, since it needs no `;` between statements. Two
 * kinds: the writes, and what starts a statement that acts with no write verb in it. Transaction
 * control is the second kind and the worse one: a read-only run on SQL Server is a transaction the
 * app rolls back (`dialect/readOnly.ts`), and `SELECT 1 COMMIT DISABLE TRIGGER t ON x` ends that
 * transaction, so the statement after the COMMIT autocommits. Found by an outside review on
 * 2026-10-14, with DISABLE/ENABLE TRIGGER, RECEIVE and WRITETEXT behind the COMMIT, all of which
 * passed as reads. A lone BEGIN TRAN only nests, and stays session bookkeeping (see `classify`).
 */
const ANYWHERE = /\b(insert|update|delete|merge|drop|create|alter|truncate|exec|execute|grant|revoke|deny|backup|restore|dbcc|kill|shutdown|bulk|reconfigure|waitfor|openquery|openrowset|opendatasource|commit|rollback|save\s+tran(?:saction)?|begin\s+(?:distributed\s+)?tran(?:saction)?|(?:disable|enable)\s+trigger|receive|writetext|updatetext|send\s+on\s+conversation|(?:end|move)\s+conversation|begin\s+(?:dialog|conversation)|get\s+conversation\s+group|checkpoint|setuser)\b/gi;

/** A word in {@link ANYWHERE} that SQL Server does not reserve, so it is also a name when it reads as one. */
const UNRESERVED = /^receive$/i;

/** A transaction BEGIN on its own: it only nests (a COMMIT or ROLLBACK is what ends one). */
const BEGIN_TRAN_ALONE = /^begin\s+tran(?:saction)?(?:\s+[\w$]+)?\s*$/i;

/** BEGIN / START a transaction, and the statements that end one. A BEGIN with anything else after it is a block. */
const TRANSACTION =
	/^(?:(?:begin|start)(?:[\s,]+(?:transaction|tran|work|isolation|level|read|write|only|committed|uncommitted|repeatable|serializable|snapshot|not|deferrable|consistent|with))*|(?:commit|rollback|abort|end|savepoint|release)(?:\s+[\w$]+)*)\s*$/i;

const USE = /^use\s+(?:(?:database|schema|warehouse|role|catalog)\s+)?(?:\[[^\]]*\]|"[^"]*"|`[^`]*`|[\w$.@]+)\s*$/i;

const SET_TRANSACTION = /^set\s+(?:session\s+)?transaction\b[\w\s,]*$/i;

/** SQLite's PRAGMAs that only report. `PRAGMA x = y` and `PRAGMA x(y)` otherwise SET. */
const PRAGMA_READ =
	/^pragma\s+(?:\w+\.)?(?:(?:table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|database_list|collation_list|function_list|module_list|pragma_list|compile_options|integrity_check|quick_check|foreign_key_check)\b[^=]*|\w+\s*)$/i;

/** How a statement is judged. Postgres's family, MySQL's, SQL Server's, everything else, and an unknown driver. */
type Rules = 'postgres' | 'mysql' | 'tsql' | 'plain' | 'strict';

function rulesFor(driver: string | undefined): Rules {
	switch (driver) {
		case undefined:
		case 'postgres':
		case 'redshift':
		case 'duckdb':
			return 'postgres';
		case 'mysql-aurora':
		case 'mariadb':
			return 'mysql';
		case 'sqlserver':
			return 'tsql';
		case 'oracle':
		case 'sqlite':
		case 'snowflake':
		case 'clickhouse':
		case 'db2':
		case 'hana':
		case 'mongodb':
		case 'pinecone':
			return 'plain';
		default:
			return 'strict';
	}
}

/**
 * Reaching a file on the database server, by statement or by function. The first group is what
 * the guard reports. Read on the blanked text, so a name in a string or a comment is not a call;
 * a call through a quoted name is `sideEffects.ts`'s.
 */
const SERVER_FILE: readonly RegExp[] = [
	// MySQL, MariaDB, TiDB (and ClickHouse's client): after a SELECT, a TABLE, a VALUES.
	/\b(into\s+(?:outfile|dumpfile))\b/i,
	/\b(load\s+(?:data|xml))\b/i,
	/\b(load_file)\s*\(/i,
	// Postgres: large objects to and from server files, and the admin file functions. Every
	// `pg_read_*` reads a file, every `pg_ls_*` lists a server directory, and `pg_stat_file` says
	// what a path is, so those are matched as families, not by name.
	/\b(lo_export|lo_import|pg_file_write|pg_file_unlink|pg_file_rename|pg_file_sync|pg_read_\w+|pg_ls_\w+|pg_stat_file)\s*\(/i,
	// SQL Server: a shell, OLE automation, external scripts, and server files as rows.
	/\b(xp_cmdshell|sp_oacreate|sp_oamethod|sp_execute_external_script)\b/i,
	/\b(openrowset)\s*\(\s*bulk\b/i,
	// SQL Server's functions that open a file by the path they are handed: audit, trace and
	// extended-event files, a backup's log, a directory listing. A `\\host\share` path makes the
	// service account sign in to that host (see `uncPath`); a local one reads the server's disk.
	/\b(fn_get_audit_file\w*|fn_trace_gettable|fn_xe_\w*read_file|fn_dump_dblog|dm_os_enumerate_filesystem|dm_os_file_exists)\s*\(/i,
	/\b(bulk\s+insert)\b/i,
	// Oracle: a server file as a LOB, and UTL_FILE.
	/\b(bfilename|utl_file\s*\.\s*\w+)\s*\(/i,
	// SQLite's file and extension functions.
	/\b(readfile|writefile|load_extension)\s*\(/i,
];

/**
 * What a statement does to a file on the database server, as the name to report, or undefined.
 * `statement` is one of {@link guardStatements}' (comments gone, literals blanked). Any lead, any
 * engine: a statement that reaches a server file is never a read.
 */
export function serverFileAccess(statement: string): string | undefined {
	for (const pattern of SERVER_FILE) {
		const m = pattern.exec(statement);
		if (m) {
			return m[1].replace(/\s+/g, ' ').toUpperCase();
		}
	}
	return undefined;
}

/**
 * {@link serverFileAccess} for the patterns that are a call (`load_file(`, `bfilename(`), never a
 * phrase like `INTO OUTFILE`: for reading the inside of a string, where a phrase may be prose.
 */
export function serverFileCall(text: string): string | undefined {
	for (const pattern of SERVER_FILE) {
		const m = pattern.source.includes('\\s*\\(') ? pattern.exec(text) : null;
		if (m) {
			return m[1].replace(/\s+/g, ' ').toUpperCase();
		}
	}
	return undefined;
}

/**
 * A network path at the start of a string: `\\host\share`, and the same with forward slashes,
 * which Windows reads alike (`\\?\UNC\...` and `\\.\pipe\...` included). Two backslashes on
 * their own, or followed by a third, are not one, so `REPLACE(p, '\\', '\')` stays a read.
 */
const UNC = /^\s*([\\/]{2}[\w.?$@:\[-][^\s'"]*)/;

/**
 * The first string in `sql` that names a network path, on SQL Server (and a driver nobody knows,
 * which is read every way there is), or undefined. Handed to any function that opens a path
 * (`sys.fn_get_audit_file`, `fn_trace_gettable`, `sys.fn_xe_file_target_read_file`, and whatever
 * Microsoft adds next), it makes the server's service account sign in to that host over SMB, which
 * leaks its credentials to whoever answers. So in a read the path itself is refused, whatever
 * receives it: a rule for the family, where `serverFileAccess` can only name the functions it knows.
 * Read on the raw strings, by every lexer the driver needs. Not a production-confirm rule: a
 * person's own query may compare a column with a share's name.
 */
export function uncPath(sql: string, driver?: string): string | undefined {
	const rules = rulesFor(driver);
	if (rules !== 'tsql' && rules !== 'strict') {
		return undefined;
	}
	for (const lexer of lexersFor(driver)) {
		const literals: string[] = [];
		blank(sql, lexer, literals);
		for (const literal of literals) {
			const m = UNC.exec(literal);
			if (m) {
				return m[1];
			}
		}
	}
	return undefined;
}

/** Transaction control: each of these ends, or replaces, the transaction a read-only run is in. */
const LEAVES_TRANSACTION = /^(begin|start\s+transaction|commit|end|abort|rollback|prepare\s+transaction|savepoint|release)\b/i;

/**
 * A SET or RESET that can make what runs next writable: the read-only settings by name (Postgres's
 * `default_transaction_read_only` and `transaction_read_only`, MySQL's `transaction_read_only` and
 * `tx_read_only`), READ WRITE, the session's transaction characteristics, and autocommit.
 */
const READ_ONLY_SETTING = /^(?:set|reset)\b[\s\S]*?(?:read_only|\bread\s+write\b|\bcharacteristics\b|\bautocommit\b)/i;

/**
 * What in `sql` would take a READ out of the read-only run it is sent in (`dialect/readOnly.ts`),
 * as the statement to name, or undefined. Two kinds, on every engine:
 *
 * - transaction control (BEGIN, START TRANSACTION, COMMIT, END, ABORT, ROLLBACK, PREPARE
 *   TRANSACTION, SAVEPOINT, RELEASE): the run is a read-only transaction the app rolls back, and a
 *   statement after a COMMIT runs outside it;
 * - a setting that turns read-only off for the session or the next transaction (a SET or RESET of
 *   the read-only settings, READ WRITE, the session's transaction characteristics, RESET ALL,
 *   DISCARD, and set_config()).
 *
 * `destructiveStatement` lets transaction control and Postgres's SET through as session
 * bookkeeping, which is right for a production confirm (they write nothing) and wrong for anything
 * judged a read: together they step out of the database-side layer. An outside review on
 * 2026-10-14 hid `SET default_transaction_read_only = off; COMMIT; DELETE ...` in a string the
 * lexer misread and deleted rows inside a read-only run. Read with every lexer the driver needs,
 * like the rest of the guard.
 */
export function readOnlyEscape(sql: string, driver?: string): string | undefined {
	for (const raw of guardStatements(sql, driver)) {
		const statement = raw.replace(/^[(\s]+/, '');
		const leaves = LEAVES_TRANSACTION.exec(statement);
		if (leaves) {
			return leaves[1].replace(/\s+/g, ' ').toUpperCase();
		}
		const setting = READ_ONLY_SETTING.exec(statement) ?? /^(reset)\s+all\b/i.exec(statement) ?? /^(discard)\b/i.exec(statement);
		if (setting) {
			return /^\w+/.exec(statement)![0].toUpperCase();
		}
		if (/\bset_config\s*\(/i.test(statement)) {
			return 'set_config';
		}
	}
	return undefined;
}

/**
 * Whether EXPLAIN on this engine WRITES the plan into a table rather than answering with it: Db2's
 * EXPLAIN fills the explain tables, SAP HANA's EXPLAIN PLAN fills EXPLAIN_PLAN_TABLE, and Oracle's
 * fills PLAN_TABLE or whatever table its INTO names. None of them has an EXPLAIN that only answers,
 * so there every EXPLAIN is a write, to every gate.
 */
export function explainStoresPlan(driver: string | undefined): boolean {
	return driver === 'db2' || driver === 'hana' || driver === 'oracle';
}

function classify(raw: string, rules: Rules, storesPlan = false): DestructiveStatement | undefined {
	// `(SELECT ...) UNION (SELECT ...)` leads with a parenthesis; what is inside leads the statement.
	const statement = raw.replace(/^[(\s]+/, '');
	const file = serverFileAccess(statement);
	if (file) {
		return { verb: file, unfiltered: false };
	}
	// An EXPLAIN that stores its plan writes that table, whatever it explains.
	if (storesPlan && /^explain\b/i.test(statement)) {
		return { verb: 'EXPLAIN', unfiltered: false };
	}
	// EXPLAIN ANALYZE runs what it explains; a plain EXPLAIN does not.
	const explain = /^explain\b\s*(?:\(([^)]*)\))?\s*(analy[sz]e\b)?\s*(?:verbose\b\s*)?([\s\S]*)$/i.exec(statement);
	if (explain) {
		const options = explain[1] ?? '';
		const analyze = Boolean(explain[2]) || /\banaly[sz]e\b(?!\s*(?:false|off|0)\b)/i.test(options);
		return analyze ? classify(explain[3].trim(), rules, storesPlan) : undefined;
	}
	// ClickHouse's mutation (`ALTER TABLE t DELETE WHERE ...`) is the DELETE or UPDATE it performs,
	// and is unfiltered in exactly the same way.
	const mutation = /^alter\s+table\s+[^\s(]+(?:\s+on\s+cluster\s+\S+)?\s+(delete|update)\b([\s\S]*)$/i.exec(statement);
	if (mutation) {
		return { verb: mutation[1].toUpperCase(), unfiltered: everyRow(mutation[2]) };
	}
	const opaque = OPAQUE.exec(statement);
	if (opaque) {
		// Nothing about what it does can be read from here, so it is treated as the worst case it
		// could be: never "additive", always asked about.
		return { verb: opaque[1].toUpperCase() === 'EXEC' ? 'EXECUTE' : opaque[1].toUpperCase(), unfiltered: false };
	}
	// COPY ... FROM loads rows; COPY ... TO STDOUT only reads, unless what it copies out is a
	// write's RETURNING (`COPY (UPDATE t SET ... RETURNING *) TO STDOUT` runs the UPDATE). COPY TO
	// anywhere else (a server file, TO PROGRAM, DuckDB's local file) writes outside the database.
	if (/^copy\b/i.test(statement)) {
		const inner = nestedWrite(statement, true);
		if (inner) {
			return inner;
		}
		const outer = atDepthZero(statement);
		if (/\bfrom\b/i.test(outer)) {
			return { verb: 'INSERT', unfiltered: false };
		}
		return /\bto\s+stdout\b/i.test(outer) ? undefined : { verb: 'COPY', unfiltered: false };
	}
	const match = VERBS.exec(statement);
	if (match) {
		const verb = match[1].toUpperCase();
		const unfiltered = (verb === 'DELETE' || verb === 'UPDATE') && everyRow(statement);
		return { verb, unfiltered };
	}
	if ((rules === 'tsql' || rules === 'strict') && !BEGIN_TRAN_ALONE.test(statement)) {
		const buried = anywhere(statement);
		if (buried) {
			return buried;
		}
	}
	// A data-modifying CTE: `WITH x AS (DELETE ...) SELECT ...` writes, whatever it ends with, and so
	// does the statement a WITH leads into (`WITH x AS (...) DELETE FROM t ...`).
	if (/^with\b/i.test(statement)) {
		// Snowflake's anonymous procedure: `WITH p AS PROCEDURE () ... AS $$ <body> $$ CALL p()` runs
		// whatever its blanked body says.
		if (/\bas\s+procedure\b/i.test(atDepthZero(statement))) {
			return { verb: 'CALL', unfiltered: false };
		}
		const write = nestedWrite(statement, false);
		if (write) {
			return write;
		}
		// `WITH x AS (...) SELECT * INTO t FROM x` makes a table as surely as a bare SELECT INTO.
		return /\binto\b/i.test(atDepthZero(statement)) ? { verb: 'CREATE', unfiltered: false } : undefined;
	}
	// A read with a write inside its parentheses runs the write: Db2's data-change table reference
	// (`SELECT * FROM OLD TABLE (DELETE FROM t)`, `FINAL TABLE (UPDATE ...)`, `NEW TABLE (INSERT ...)`),
	// and any engine's that grows one. Db2 has no read-only session, so this is all that stops it.
	if (/^(?:select|values|table)\b/i.test(statement)) {
		const write = nestedWrite(statement, true);
		if (write) {
			return write;
		}
	}
	// SELECT ... INTO makes a table (INTO OUTFILE/DUMPFILE was answered above, on any lead).
	if (/^select\b/i.test(statement)) {
		return /\binto\b/i.test(atDepthZero(statement)) ? { verb: 'CREATE', unfiltered: false } : undefined;
	}
	if (READ_LEAD.test(statement) || session(statement, rules)) {
		return undefined;
	}
	// Not a read the guard can name, so it is not a read: an IF or BEGIN block, a bare procedure
	// call, LOAD DATA, VACUUM. Its first word is the best name for what it does.
	const word = /^[^\s(;,'"`[]+/.exec(statement)?.[0] ?? statement.slice(0, 1);
	return { verb: word.toUpperCase(), unfiltered: false };
}

/** Statements that only change the session: transaction control, USE, and each engine's harmless SET. */
function session(statement: string, rules: Rules): boolean {
	if (TRANSACTION.test(statement) || USE.test(statement) || SET_TRANSACTION.test(statement)) {
		return true;
	}
	switch (rules) {
		case 'postgres':
			return /^(?:set|reset|show|listen|unlisten|fetch|move|close|deallocate|discard)\b/i.test(statement);
		case 'mysql':
			return /^set\b/i.test(statement) && !/\b(?:global|persist|persist_only|password|default)\b|@@(?:global|persist)/i.test(statement);
		case 'tsql':
			return /^set\s+[\w@]+(?:\s*,\s*[\w@]+)*\s+(?:on|off)\s*$/i.test(statement);
		case 'plain':
			return PRAGMA_READ.test(statement);
		default:
			return false;
	}
}

/** The first write verb anywhere in `statement` (SQL Server's batches need no `;`). */
function anywhere(statement: string): DestructiveStatement | undefined {
	for (const m of statement.matchAll(ANYWHERE)) {
		const at = m.index ?? 0;
		if (m[1].toLowerCase() === 'update' && /\b(?:for|key|of)\s+$/i.test(statement.slice(0, at))) {
			continue;
		}
		// `l.receive`, `x AS receive`, `SELECT receive, a`: a column, not the statement.
		if (UNRESERVED.test(m[1]) && (/(?:\.|\bas)\s*$/i.test(statement.slice(0, at)) || /^\s*(?:[,)]|$)/.test(statement.slice(at + m[0].length)))) {
			continue;
		}
		const verb = m[1].toLowerCase() === 'exec' ? 'EXECUTE' : m[1].replace(/\s+/g, ' ').toUpperCase();
		const unfiltered = (verb === 'DELETE' || verb === 'UPDATE') && everyRow(enclosing(statement, at));
		return { verb, unfiltered };
	}
	return undefined;
}

/**
 * Statement verbs a database runs from INSIDE another statement: the body of a data-modifying CTE
 * (Postgres, MERGE ... RETURNING in one on 17), Db2's data-change table reference, COPY (...) TO,
 * and the DML/DDL a WITH leads into.
 */
const NESTED = /\b(delete|update|insert|merge|upsert|replace|truncate|drop|create|alter)\b/gi;

/**
 * The first write verb in `statement` that the database would RUN, or undefined. With `nestedOnly`,
 * only what sits inside parentheses counts (a SELECT's own words are not a nested statement).
 * Fails closed: a verb is skipped only where it cannot start a statement: the row locks
 * (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR UPDATE OF`, Db2's `KEEP UPDATE LOCKS`), the string
 * functions REPLACE(...) and MySQL's INSERT(...), and a name spelled like a verb (`t.update`,
 * `AS merge`, `SELECT merge, a`).
 */
function nestedWrite(statement: string, nestedOnly: boolean): DestructiveStatement | undefined {
	const scan = nestedOnly ? insideParentheses(statement) : statement;
	for (const m of scan.matchAll(NESTED)) {
		const at = m.index ?? 0;
		const word = m[1].toLowerCase();
		const before = statement.slice(0, at);
		const after = statement.slice(at + m[0].length);
		if (word === 'update' && /\b(?:for|key|of|keep)\s+$/i.test(before)) {
			continue;
		}
		if ((word === 'replace' || word === 'insert') && /^\s*\(/.test(after)) {
			continue;
		}
		if (/\.\s*$/.test(before) || /\bas\s+$/i.test(before) || /^\s*(?:[,)]|$)/.test(after)) {
			continue;
		}
		const verb = word.toUpperCase();
		const unfiltered = (verb === 'DELETE' || verb === 'UPDATE') && everyRow(enclosing(statement, at));
		return { verb, unfiltered };
	}
	return undefined;
}

/**
 * The first DML/DDL verb anywhere in one statement of {@link guardStatements}' text that the
 * database could run, with the same exceptions as the nested check (row locks, REPLACE(...) and
 * INSERT(...), a name spelled like a verb). For a caller that admits only plain reads.
 */
export function writeVerbIn(statement: string): DestructiveStatement | undefined {
	return nestedWrite(statement, false);
}

/** `statement` with everything OUTSIDE parentheses blanked, positions kept. */
function insideParentheses(statement: string): string {
	let depth = 0;
	let out = '';
	for (let i = 0; i < statement.length; i++) {
		const ch = statement[i];
		if (ch === ')' && depth > 0) {
			depth--;
		}
		out += depth > 0 || ch === '(' || ch === ')' ? ch : ' ';
		if (ch === '(') {
			depth++;
		}
	}
	return out;
}

/** No WHERE at all, or one that holds for every row (`WHERE 1`, `WHERE true`, `WHERE 1 = 1`). */
function everyRow(statement: string): boolean {
	const where = /\bwhere\b([\s\S]*)$/i.exec(statement);
	if (!where) {
		return true;
	}
	const condition = where[1].replace(/\bsettings\b[\s\S]*$/i, '').replace(/\breturning\b[\s\S]*$/i, '').trim();
	return /^(?:\(\s*(?:1|true|1\s*=\s*1)\s*\)|(?:1|true|1\s*=\s*1))$/i.test(condition);
}

/** The text from `from` to the parenthesis that closes the group it sits in (a CTE's body). */
function enclosing(statement: string, from: number): string {
	let depth = 0;
	for (let i = from; i < statement.length; i++) {
		if (statement[i] === '(') {
			depth++;
		} else if (statement[i] === ')') {
			if (depth === 0) {
				return statement.slice(from, i);
			}
			depth--;
		}
	}
	return statement.slice(from);
}

/** `statement` with everything inside parentheses blanked, so a subquery's INTO is not the statement's. */
function atDepthZero(statement: string): string {
	let depth = 0;
	let out = '';
	for (const ch of statement) {
		if (ch === '(') {
			depth++;
		}
		out += depth > 0 ? ' ' : ch;
		if (ch === ')' && depth > 0) {
			depth--;
		}
	}
	return out;
}

/** How one engine reads comments, strings and quoted names. */
interface Lexer {
	// A block comment inside a block comment nests (Postgres, SQL Server). Elsewhere the first
	// closing star-slash ends the comment.
	nested: boolean;
	// MySQL-family servers run the inside of an executable comment as code: slash-star-bang
	// (optionally versioned), MariaDB's slash-star-M-bang and TiDB's slash-star-T-bang (optionally
	// with a [feature] list). See EXECUTABLE.
	executable: boolean;
	/** MySQL: `--` starts a comment only when whitespace follows it. */
	dashNeedsSpace: boolean;
	/** `#` comments: where a statement starts (MySQL text read as Postgres), anywhere, or never. */
	hash: 'start' | 'anywhere' | 'none';
	/** Snowflake's `//` line comment. */
	slashSlash: boolean;
	/** Snowflake's `->>` flow operator, which runs the statement after it: a separator like `;`. */
	flow: boolean;
	/** The quote characters inside which a backslash escapes the next character. */
	backslash: string;
	/** Postgres's E'...' strings, which escape with a backslash. */
	eStrings: boolean;
	/** `$tag$ ... $tag$` (and `$$ ... $$`) strings. */
	dollar: boolean;
	/** `[name]` identifiers (SQL Server, SQLite). */
	brackets: boolean;
	/** Oracle's q'[...]' strings. */
	qQuote: boolean;
}

const POSTGRES: Lexer = { nested: true, executable: false, dashNeedsSpace: false, hash: 'start', slashSlash: false, flow: false, backslash: '', eStrings: true, dollar: true, brackets: false, qQuote: false };
/**
 * Postgres with standard_conforming_strings off, which a database, a role or a session can set
 * (and Redshift reads strings this way): a backslash escapes in EVERY single-quoted string, not
 * only E'...'. `'a\', '; DELETE ...; --'` is then one string to the lexer above and code to the
 * server, so Postgres-family text is lexed both ways (an outside review, 2026-10-14).
 */
const POSTGRES_NO_SCS: Lexer = { ...POSTGRES, backslash: "'" };
const STANDARD: Lexer = { nested: false, executable: false, dashNeedsSpace: false, hash: 'none', slashSlash: false, flow: false, backslash: '', eStrings: false, dollar: false, brackets: false, qQuote: false };
/**
 * The opener of an executable comment: MySQL's `/*!` and `/*!NNNNN` (every MySQL-family server),
 * MariaDB's `/*M!` and `/*M!NNNNNN`, TiDB's `/*T!` and `/*T![feature,...]`. Case as the servers
 * read it. A malformed TiDB feature list is left as code after `/*T!`, the safe reading.
 */
const EXECUTABLE = /^\/\*(?:M?!\d*|T!(?:\[[\w\s,]*\])?)/;
const MYSQL: Lexer = { ...STANDARD, executable: true, dashNeedsSpace: true, hash: 'anywhere', backslash: '\'"' };
const TSQL: Lexer = { ...STANDARD, nested: true, brackets: true };
const ORACLE: Lexer = { ...STANDARD, qQuote: true };
const SQLITE: Lexer = { ...STANDARD, brackets: true };
const SNOWFLAKE: Lexer = { ...STANDARD, slashSlash: true, flow: true, backslash: '\'', dollar: true };
const CLICKHOUSE: Lexer = { ...STANDARD, hash: 'anywhere', backslash: '\'"`', dollar: true };

function lexersFor(driver: string | undefined): Lexer[] {
	switch (driver) {
		case undefined:
		case 'postgres':
			return [POSTGRES, POSTGRES_NO_SCS];
		case 'mysql-aurora':
		case 'mariadb':
			return [POSTGRES, MYSQL];
		case 'sqlserver':
			// Postgres's reading with SQL Server's [names], or every `[delete]` column would read as a
			// DELETE to the scan that looks for a write anywhere in a batch.
			return [{ ...POSTGRES, brackets: true }, TSQL];
		case 'oracle':
			return [POSTGRES, ORACLE];
		case 'sqlite':
			return [POSTGRES, SQLITE];
		case 'snowflake':
			return [POSTGRES, SNOWFLAKE];
		case 'clickhouse':
			return [POSTGRES, CLICKHOUSE];
		case 'redshift':
			return [POSTGRES, POSTGRES_NO_SCS, STANDARD];
		case 'duckdb':
		case 'db2':
		case 'hana':
		case 'mongodb':
		case 'pinecone':
			return [POSTGRES, STANDARD];
		default:
			return [POSTGRES, POSTGRES_NO_SCS, MYSQL, TSQL, ORACLE, SQLITE, SNOWFLAKE, CLICKHOUSE];
	}
}

const Q_CLOSE: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };

/** Oracle's `q'<delim>...<delim>'` (or `nq'...'`) starts at `i`: a q not ending a longer name. */
function startsQQuote(sql: string, i: number): boolean {
	if ((sql[i] !== 'q' && sql[i] !== 'Q') || sql[i + 1] !== "'" || i + 2 >= sql.length) {
		return false;
	}
	const before = i > 0 && /[nN]/.test(sql[i - 1]) ? i - 2 : i - 1;
	return before < 0 || !/[\w$#]/.test(sql[before]);
}

/** A quoted identifier's inside as one bare word, set apart by spaces: `"my seq"` is ` my_seq `. */
function bareName(inside: string): string {
	return ` ${inside.replace(/[^\w$#]/g, '_') || '_'} `;
}

/**
 * Comments removed; the insides of strings and quoted identifiers replaced by spaces, their
 * delimiters kept so a statement still reads as one; the inside of a MySQL executable comment kept
 * as the code it is. Unterminated anything runs to the end, which is the safe reading of
 * half-typed SQL. With `literals`, the raw inside of every quoted string (a `"..."` name, an Oracle
 * `q'[...]'` and a dollar-quoted body included) is collected into it; with
 * `openers`, every executable comment's opener as written; with `names`, a quoted identifier
 * (`"..."`, `` `...` ``, `[...]`) is written as the bare name inside it (see {@link guardNamedStatements}).
 */
function blank(sql: string, lexer: Lexer, literals?: string[], openers?: string[], names = false): string {
	let out = '';
	let i = 0;
	const n = sql.length;
	// Inside MySQL's executable comment, whose closing star-slash is the only part that is not code.
	let executable = false;
	while (i < n) {
		const ch = sql[i];
		const next = sql[i + 1];
		const dashComment = ch === '-' && next === '-' && (!lexer.dashNeedsSpace || i + 2 >= n || /[\s\x00-\x1f]/.test(sql[i + 2]));
		const hashComment = ch === '#' && (lexer.hash === 'anywhere' || (lexer.hash === 'start' && /(?:^|;)\s*$/.test(out)));
		// `#` where a statement starts is MySQL's line comment. Anywhere else under Postgres's rules
		// it is XOR (or `#>`), and reading it as a comment would blank the rest of the line:
		// `select 1 # 2; drop table t` would hide its DROP.
		if (dashComment || hashComment || (lexer.slashSlash && ch === '/' && next === '/')) {
			while (i < n && sql[i] !== '\n') {
				i++;
			}
			out += ' ';
			continue;
		}
		if (executable && ch === '*' && next === '/') {
			executable = false;
			out += '  ';
			i += 2;
			continue;
		}
		if (ch === '/' && next === '*') {
			const opener = lexer.executable ? EXECUTABLE.exec(sql.slice(i, i + 200)) : null;
			if (opener) {
				openers?.push(opener[0]);
				executable = true;
				out += ' '.repeat(opener[0].length);
				i += opener[0].length;
				continue;
			}
			let depth = 1;
			i += 2;
			while (i < n && depth > 0) {
				if (lexer.nested && sql[i] === '/' && sql[i + 1] === '*') {
					depth++;
					i += 2;
				} else if (sql[i] === '*' && sql[i + 1] === '/') {
					depth--;
					i += 2;
				} else {
					i++;
				}
			}
			out += ' ';
			continue;
		}
		if (lexer.qQuote && startsQQuote(sql, i)) {
			const open = sql[i + 2];
			const close = (Q_CLOSE[open] ?? open) + "'";
			const end = sql.indexOf(close, i + 3);
			const stop = end === -1 ? n : end + close.length;
			literals?.push(sql.slice(i + 3, end === -1 ? n : end));
			out += "'" + ' '.repeat(Math.max(0, stop - i - 3)) + (end === -1 ? '' : "'");
			i = stop;
			continue;
		}
		if (lexer.brackets && ch === '[') {
			const mark = out.length;
			const start = i + 1;
			out += ch;
			i++;
			while (i < n) {
				if (sql[i] === ']') {
					if (sql[i + 1] === ']') {
						out += '  ';
						i += 2;
						continue;
					}
					break;
				}
				out += sql[i] === '\n' ? '\n' : ' ';
				i++;
			}
			const stop = i;
			if (i < n) {
				out += ']';
				i++;
			}
			if (names) {
				out = out.slice(0, mark) + bareName(sql.slice(start, stop));
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const escapes = lexer.backslash.includes(ch) ||
				(lexer.eStrings && ch === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/\w/.test(sql[i - 2])));
			const mark = out.length;
			out += ch;
			i++;
			const start = i;
			while (i < n) {
				if (escapes && sql[i] === '\\') {
					out += '  ';
					i += 2;
					continue;
				}
				if (sql[i] === ch) {
					if (sql[i + 1] === ch) {
						out += '  ';
						i += 2;
						continue;
					}
					break;
				}
				out += sql[i] === '\n' ? '\n' : ' ';
				i++;
			}
			const stop = i;
			if (ch !== '`') {
				literals?.push(sql.slice(start, i));
			}
			if (i < n) {
				out += ch;
				i++;
			}
			if (names && ch !== "'") {
				out = out.slice(0, mark) + bareName(sql.slice(start, stop));
			}
			continue;
		}
		if (lexer.dollar && ch === '$') {
			const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
			if (tag && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
				const close = sql.indexOf(tag[0], i + tag[0].length);
				const end = close === -1 ? n : close + tag[0].length;
				literals?.push(sql.slice(i + tag[0].length, close === -1 ? n : close));
				out += tag[0] + ' '.repeat(Math.max(0, end - i - 2 * tag[0].length)) + (close === -1 ? '' : tag[0]);
				i = end;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return out;
}

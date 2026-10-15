/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Splitting a file into the statements a review reasons about.
 *
 *  Boundaries are semicolons, scanned over MASKED text so a `;` inside a string, a quoted
 *  identifier or a comment does not end a statement — which the editor's splitter, working on
 *  raw text, is deliberately naive about. A reviewer cannot afford that: a migration that
 *  inserts `'a;b'` would be reported as two broken statements.
 *
 *  A file with no semicolons at all (one statement, no terminator) is one statement.
 *--------------------------------------------------------------------------------------------*/

import { LEGACY_LEX, maskSql, MYSQL_LEX, ORACLE_LEX, POSTGRES_LEX, SQLITE_LEX, SQLSERVER_LEX } from './mask.js';
import type { SqlLexRules } from './mask.js';

export interface StatementSpan {
	/** The statement text, trimmed, exactly as it appears in the file. */
	sql: string;
	/** Character offset of the trimmed statement's first character. */
	start: number;
	/** Character offset one past its last character. */
	end: number;
	/** 1-based line of `start`. */
	line: number;
	/** 1-based line of the last character. */
	endLine: number;
}

/** Line number (1-based) for every character offset in `text`, computed once. */
export function lineIndex(text: string): number[] {
	const lines: number[] = new Array(text.length + 1);
	let line = 1;
	for (let i = 0; i < text.length; i++) {
		lines[i] = line;
		if (text[i] === '\n') {
			line++;
		}
	}
	lines[text.length] = line;
	return lines;
}

/** Every statement in `text`, in order. Empty pieces and bare `;` are dropped. `rules` is how the
 *  destination's vendor reads strings and comments; without it, the permissive legacy reading. */
export function splitStatements(text: string, rules: SqlLexRules = LEGACY_LEX): StatementSpan[] {
	const masked = maskSql(text, rules).text;
	const lines = lineIndex(text);
	const out: StatementSpan[] = [];

	const push = (from: number, to: number): void => {
		const raw = text.slice(from, to);
		const trimmedStart = from + (raw.length - raw.trimStart().length);
		const sql = raw.trim();
		if (sql === '' || sql === ';') {
			return;
		}
		const start = trimmedStart;
		const end = start + sql.length;
		out.push({ sql, start, end, line: lines[start], endLine: lines[Math.max(start, end - 1)] });
	};

	let last = 0;
	for (let i = 0; i < masked.length; i++) {
		if (masked[i] === ';') {
			push(last, i + 1); // the ';' stays with the statement before it
			last = i + 1;
		}
	}
	push(last, text.length);
	return out;
}

/** Every lexer a supported vendor might apply, each with backslash escapes both on and off: whether
 *  a backslash escapes is a SERVER setting (standard_conforming_strings, NO_BACKSLASH_ESCAPES) the
 *  reviewer cannot see. */
const EVERY_LEXER: SqlLexRules[] = [LEGACY_LEX, POSTGRES_LEX, MYSQL_LEX, SQLSERVER_LEX, ORACLE_LEX, SQLITE_LEX].flatMap((rules) => [
	{ ...rules, backslashInSingle: true, backslashInDouble: true },
	{ ...rules, backslashInSingle: false, backslashInDouble: false },
]);

/**
 * Why `sql` may not be sent to a database inside generated SQL, or undefined when it may.
 *
 * Text from a pull request is hostile. Before any of it is embedded in a probe it must be ONE
 * statement however the destination reads it, so it is checked against every lexer above and refused
 * when any of them sees a second statement or a string, quoted name or comment that never closes
 * MySQL's executable comments (`/*! … *\/`, MariaDB's `/*M!` and TiDB's `/*T!`) run their contents,
 * so they are refused too.
 * Refusing SQL a database would have read as one statement costs a plan; the reverse runs a stranger's
 * DDL.
 */
export function singleStatementRefusal(sql: string): string | undefined {
	if (/\/\*[MT]?!/.test(sql)) {
		return 'it contains an executable comment';
	}
	for (const rules of EVERY_LEXER) {
		const masked = maskSql(sql, rules);
		if (masked.unterminated) {
			return 'it has a string, quoted name or comment that does not close';
		}
		const semicolon = masked.text.indexOf(';');
		if (semicolon !== -1 && masked.text.slice(semicolon + 1).trim() !== '') {
			return 'it is more than one statement';
		}
	}
	return undefined;
}

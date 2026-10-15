/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Turning a parser failure into something a person can act on.
 *
 *  `node-sql-parser` reports a PEG failure as a 60-term "Expected …, but ">" found" wall plus a
 *  location. That wall is unreadable, and the layers above used to throw it away entirely: a
 *  syntax error was raised as `UnsupportedQueryError` ("valid SQL we can't express"), so a typo was
 *  answered with "try a simpler SELECT" AND offered to the AI transcriber, which spends the user's
 *  budget translating something that isn't SQL. `placedAt => '2025-03-01'` would go all the way
 *  through that and come back with nothing.
 *
 *  So: keep the location (the character, the line, the column) and name the mistake where it is a
 *  KNOWN near-miss. The rules below are the ones people actually type, mostly habits carried in
 *  from another dialect. A rule that fires sets `confident`, which is what lets the editor squiggle
 *  it live: a half-typed statement is a syntax error too, and marking that would put a red line
 *  under the user's fingers all day.
 *
 *  Pure (engine rule): no I/O and no parser of its own — it reads the failure it is handed.
 *--------------------------------------------------------------------------------------------*/

/** A parse failure, located and described. Offsets are into the statement text that was parsed. */
export interface SqlSyntaxProblem {
	/** What is wrong, as a sentence, with no position in it (callers place it where it fits). */
	message: string;
	/** The fix, when the mistake is a recognised near-miss. */
	suggestion?: string;
	/** Character offsets of the offending text. */
	start: number;
	end: number;
	/** 1-based, from the parser where it gave one. */
	line: number;
	column: number;
	/** True when a rule below recognised the mistake, rather than this being a generic "unexpected
	 *  token". Only a confident problem is shown inline while the user is still typing. */
	confident: boolean;
}

/** The shape `node-sql-parser` (a PEG grammar) throws. Every field is optional on purpose: a
 *  failure that carries no location still has to produce a usable problem. */
interface RawParseFailure {
	message?: string;
	found?: string | null;
	location?: { start?: { offset?: number; line?: number; column?: number } };
}

/** One recognised near-miss. `before` is the statement text up to the failure with trailing
 *  whitespace removed, `found` the character the parser choked on, `after` what follows it. */
interface Rule {
	match(ctx: { before: string; found: string; after: string }): boolean;
	message: string;
	suggestion?: string;
	/** How far back from the failure the offending text starts, so `=>` underlines both characters. */
	back?: number;
	/** How many characters it covers from there. */
	width?: number;
}

const RULES: Rule[] = [
	{
		match: ({ before, found }) => before.endsWith('=') && found === '>',
		message: '"=>" is not a SQL comparison.',
		suggestion: 'Did you mean ">="?',
		back: 1,
		width: 2,
	},
	{
		match: ({ before, found }) => before.endsWith('=') && found === '<',
		message: '"=<" is not a SQL comparison.',
		suggestion: 'Did you mean "<="?',
		back: 1,
		width: 2,
	},
	{
		// `!<` / `!>` fail ON the `!` (the grammar has no prefix `!`), so this reads forward.
		match: ({ found, after }) => found === '!' && after.startsWith('>'),
		message: '"!>" is not a SQL comparison.',
		suggestion: 'Did you mean "<="?',
		width: 2,
	},
	{
		match: ({ found, after }) => found === '!' && after.startsWith('<'),
		message: '"!<" is not a SQL comparison.',
		suggestion: 'Did you mean ">="?',
		width: 2,
	},
	{
		match: ({ before, found }) => before.endsWith('=') && found === '=',
		message: '"==" is not a SQL comparison.',
		suggestion: 'SQL compares with a single "=".',
		back: 1,
		width: 2,
	},
	{
		match: ({ found }) => found === '#',
		message: '"#" does not start a comment in standard SQL.',
		suggestion: 'Use "--" for a line comment.',
	},
	{
		match: ({ before, found }) => found === ',' && /\blimit\s+\d+$/i.test(before),
		message: '"LIMIT a, b" is MySQL\'s two-argument form.',
		suggestion: 'Use "LIMIT <count> OFFSET <skip>".',
	},
	{
		match: ({ before, found }) => /\btop$/i.test(before) && /^\d/.test(found),
		message: '"TOP" is SQL Server\'s way of limiting rows.',
		suggestion: 'Use "LIMIT <count>" at the end of the statement instead.',
		back: 3,
		width: 3,
	},
	{
		// `select a, from t` fails on `t`, not on FROM: the keyword was already eaten as the column
		// the comma promised. So the comma is found by looking back past the clause keyword.
		match: ({ before }) => /,\s*(from|where|group|order|having|limit|offset)$/i.test(before),
		message: 'There is a trailing comma in the list before this.',
		suggestion: 'Remove the comma, or finish the list it starts.',
	},
	{
		match: ({ before, found }) => before.endsWith(',') && found !== '',
		message: 'There is a trailing comma before this.',
		suggestion: 'Remove the comma, or finish the list it starts.',
		back: 1,
		width: 1,
	},
];

/** True when the statement has an odd number of single quotes, i.e. a string was opened and never
 *  closed. Deliberately naive (an escaped '' pair cancels out on its own), which is enough to name
 *  the mistake rather than guess at its extent. */
function hasUnterminatedString(sql: string): boolean {
	let quotes = 0;
	for (let i = 0; i < sql.length; i++) {
		if (sql[i] === "'") {
			quotes++;
		}
	}
	return quotes % 2 === 1;
}

/** A character named the way a person would read it out. */
function nameToken(found: string): string {
	if (found === '' || found === '\n' || found === '\r') {
		return "the end of the statement";
	}
	return `"${found}"`;
}

/** The 1-based line an offset falls on. */
function lineOf(sql: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < sql.length; i++) {
		if (sql[i] === '\n') {
			line++;
		}
	}
	return line;
}

/** The 1-based column an offset falls on. */
function columnOf(sql: string, offset: number): number {
	const nl = sql.lastIndexOf('\n', Math.max(0, offset - 1));
	return offset - nl;
}

/**
 * Describe a parser failure over `sql`. Always returns a problem: an unrecognised failure still
 * gets its position and the character that caused it, which is the minimum the user needs.
 */
export function describeParseFailure(sql: string, err: unknown): SqlSyntaxProblem {
	const raw = (err ?? {}) as RawParseFailure;
	const start = raw.location?.start;
	const trimmedEnd = sql.replace(/\s+$/, '').length;
	const offset = Math.max(0, Math.min(typeof start?.offset === 'number' ? start.offset : trimmedEnd, sql.length));
	const line = start?.line ?? lineOf(sql, offset);
	const column = start?.column ?? columnOf(sql, offset);
	const found = typeof raw.found === 'string' ? raw.found : sql.slice(offset, offset + 1);
	const before = sql.slice(0, offset).replace(/\s+$/, '');
	const after = sql.slice(offset + Math.max(0, found.length));

	for (const rule of RULES) {
		if (!rule.match({ before, found, after })) {
			continue;
		}
		const back = rule.back ?? 0;
		const from = Math.max(0, offset - back);
		return {
			message: rule.message,
			suggestion: rule.suggestion,
			start: from,
			end: Math.min(sql.length, from + (rule.width ?? Math.max(1, found.length))),
			line,
			column: Math.max(1, column - back),
			confident: true,
		};
	}

	// Not a recognised mistake. An unclosed string is still worth naming, because the position a
	// parser reports for one is the end of the statement and reads like nonsense on its own.
	if (hasUnterminatedString(sql)) {
		const quote = sql.lastIndexOf("'");
		return {
			message: 'A text value is opened with a quote that is never closed.',
			suggestion: 'Close the string with a single quote.',
			start: quote,
			end: sql.length,
			line: lineOf(sql, quote),
			column: columnOf(sql, quote),
			confident: true,
		};
	}
	if (offset >= trimmedEnd) {
		return { message: 'The statement is incomplete.', start: trimmedEnd, end: sql.length, line, column, confident: false };
	}
	return {
		message: `Unexpected ${nameToken(found)}.`,
		start: offset,
		end: Math.min(sql.length, offset + Math.max(1, found.length)),
		line,
		column,
		confident: false,
	};
}

/** A double-quoted value where a text literal was clearly meant. */
export interface QuotedValueWarning {
	message: string;
	suggestion: string;
	start: number;
	end: number;
}

// An operator (or IN list) followed by a double-quoted token: `city = "Lisbon"`. The
// operator has to sit immediately before it, which is what keeps this out of the inside of a
// single-quoted string that happens to contain double quotes.
const DOUBLE_QUOTED_VALUE = /(?:<=|>=|<>|!=|=|<|>|\bLIKE\b|\bIN\s*\(\s*)\s*"([^"\n]*)"/gi;

/**
 * Text compared with DOUBLE quotes. This is not a syntax error (it parses, as an identifier), which
 * is the problem: the statement runs, compares a field to another field's name, and returns nothing
 * at all. A MySQL habit, where double quotes ARE a string, so callers must only run this for
 * backends whose SQL is read as standard SQL.
 */
export function quotedValueWarnings(sql: string): QuotedValueWarning[] {
	const out: QuotedValueWarning[] = [];
	DOUBLE_QUOTED_VALUE.lastIndex = 0;
	for (let m = DOUBLE_QUOTED_VALUE.exec(sql); m; m = DOUBLE_QUOTED_VALUE.exec(sql)) {
		const quoted = m[0].lastIndexOf('"', m[0].length - 2);
		const start = m.index + quoted;
		out.push({
			message: `Double quotes name a column here, not text, so this compares against a column called "${m[1]}".`,
			suggestion: `Use single quotes for a value: '${m[1]}'.`,
			start,
			end: m.index + m[0].length,
		});
	}
	return out;
}

/** The whole problem as one sentence, position first: what a thrown error says. */
export function formatSyntaxProblem(problem: SqlSyntaxProblem): string {
	return [`Syntax error at line ${problem.line}, column ${problem.column}: ${problem.message}`, problem.suggestion].filter(Boolean).join(' ');
}

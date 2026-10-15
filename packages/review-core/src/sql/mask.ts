/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Masking — the shared, parser-free scan every textual SQL rule stands on.
//
// A real parser normalises the AST and hides exactly the textual mistakes the guard and the
// PR reviewer hunt for, and it must never throw on half-typed SQL. So the rules scan text
// instead — with string literals, quoted identifiers and comments blanked out (offsets
// preserved 1:1) and paren depth recorded per character, which is what lets a rule ask
// "the first FROM at depth 0" or "split this column list on top-level commas".
//
// This is the ONE copy. The desktop app's `src/shared/engine/parse/mask.ts` re-exports it (it
// held a duplicate until the app had a reason to depend on this package), so the guard
// the user sees in the editor and the reviewer that comments on a pull request scan text the
// same way. One direction, once: nothing here ever imports from the app.

/**
 * How one vendor's lexer reads strings, quoted names and comments: the part of SQL where vendors
 * disagree, and where disagreeing with the database about where a string ends means disagreeing
 * about where a STATEMENT ends (Postgres reads `'a\'` as a whole string, so a masker that took the
 * backslash as an escape would hide the `;` after it).
 */
export interface SqlLexRules {
	/** A backslash escapes the next character inside `'…'` (MySQL; Postgres only with
	 *  standard_conforming_strings off). */
	backslashInSingle: boolean;
	/** A backslash escapes the next character inside `"…"` (MySQL, where `"` is a string). */
	backslashInDouble: boolean;
	/** `E'…'` turns backslash escapes on for that one string (Postgres). */
	escapeStrings: boolean;
	/** `$$…$$` and `$tag$…$tag$` (Postgres). */
	dollarQuotes: boolean;
	/** `` `name` `` quotes an identifier. */
	backtickQuotes: boolean;
	/** `[name]` quotes an identifier (SQL Server, SQLite). */
	bracketQuotes: boolean;
	/** Oracle's alternative quoting, `q'[…]'`, `nq'!…!'`. */
	alternativeQuotes: boolean;
	/** `#` opens a line comment (MySQL). */
	hashComments: boolean;
	/** `--` opens a comment only when whitespace or the end follows it (MySQL); elsewhere always. */
	dashCommentNeedsSpace: boolean;
}

/** What `maskSql` has always done, and still does when no dialect is named: every quote form any
 *  vendor uses, backslash escapes in both string forms. */
export const LEGACY_LEX: SqlLexRules = {
	backslashInSingle: true,
	backslashInDouble: true,
	escapeStrings: false,
	dollarQuotes: false,
	backtickQuotes: true,
	bracketQuotes: true,
	alternativeQuotes: false,
	hashComments: false,
	dashCommentNeedsSpace: false,
};

const NONE: SqlLexRules = {
	backslashInSingle: false,
	backslashInDouble: false,
	escapeStrings: false,
	dollarQuotes: false,
	backtickQuotes: false,
	bracketQuotes: false,
	alternativeQuotes: false,
	hashComments: false,
	dashCommentNeedsSpace: false,
};

/** Postgres with standard_conforming_strings on, the default since 9.1. */
export const POSTGRES_LEX: SqlLexRules = { ...NONE, escapeStrings: true, dollarQuotes: true };
/** MySQL and MariaDB in their default sql_mode. */
export const MYSQL_LEX: SqlLexRules = { ...NONE, backslashInSingle: true, backslashInDouble: true, backtickQuotes: true, hashComments: true, dashCommentNeedsSpace: true };
export const SQLSERVER_LEX: SqlLexRules = { ...NONE, bracketQuotes: true };
export const ORACLE_LEX: SqlLexRules = { ...NONE, alternativeQuotes: true };
export const SQLITE_LEX: SqlLexRules = { ...NONE, backtickQuotes: true, bracketQuotes: true };

/** `text` is `sql` with literal/comment content blanked (offsets preserved); `depth[i]` is the
 *  paren nesting at character `i`. */
export interface MaskedSql {
	/** `sql` with literal/comment content replaced by spaces (offsets preserved). */
	text: string;
	/** Paren depth at each character. */
	depth: number[];
	/** A string, quoted name or comment ran to the end of the input without closing. */
	unterminated?: boolean;
}

const WORD = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
const ALT_CLOSER: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };

/** Blank out string literals, quoted identifiers and comments so keyword/operator scanning can't
 *  trip over their contents, and record paren depth per character. Offsets stay 1:1 with `sql`.
 *  `rules` says how the vendor reads them; without it, the permissive legacy reading. */
export function maskSql(sql: string, rules: SqlLexRules = LEGACY_LEX): MaskedSql {
	const out: string[] = new Array(sql.length);
	const depth: number[] = new Array(sql.length);
	let d = 0;
	let i = 0;
	let unterminated = false;
	const blank = (n: number): void => {
		for (let k = 0; k < n && i < sql.length; k++) {
			out[i] = sql[i] === '\n' ? '\n' : ' ';
			depth[i] = d;
			i++;
		}
	};
	const afterWord = (at: number): boolean => at > 0 && WORD.test(sql[at - 1]);
	/** Blank through the first `closer` at or after `from`, or to the end (unterminated). */
	const blankThrough = (from: number, closer: string): void => {
		const close = sql.indexOf(closer, from);
		if (close === -1) {
			unterminated = true;
			blank(sql.length - i);
		} else {
			blank(close + closer.length - i);
		}
	};
	while (i < sql.length) {
		const c = sql[i];
		const lineComment =
			(c === '-' && sql[i + 1] === '-' && (!rules.dashCommentNeedsSpace || i + 2 >= sql.length || /\s/.test(sql[i + 2]))) ||
			(c === '#' && rules.hashComments);
		if (lineComment) {
			while (i < sql.length && sql[i] !== '\n') {
				blank(1);
			}
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			blankThrough(i + 2, '*/');
			continue;
		}
		if (c === '$' && rules.dollarQuotes && !afterWord(i)) {
			DOLLAR_TAG.lastIndex = i;
			const tag = DOLLAR_TAG.exec(sql);
			if (tag) {
				blankThrough(i + tag[0].length, tag[0]);
				continue;
			}
		}
		if (rules.alternativeQuotes && !afterWord(i)) {
			const alt = /[nN]?[qQ]'/y;
			alt.lastIndex = i;
			const open = alt.exec(sql);
			if (open && i + open[0].length < sql.length) {
				const delimiter = sql[i + open[0].length];
				const start = i + open[0].length + 1;
				blankThrough(start, (ALT_CLOSER[delimiter] ?? delimiter) + "'");
				continue;
			}
		}
		const quoted = c === "'" || c === '"' || (c === '`' && rules.backtickQuotes) || (c === '[' && rules.bracketQuotes);
		if (quoted) {
			const closer = c === '[' ? ']' : c;
			const escapes =
				c === "'"
					? rules.backslashInSingle || (rules.escapeStrings && (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !afterWord(i - 1))
					: c === '"' && rules.backslashInDouble;
			blank(1);
			let closed = false;
			while (i < sql.length) {
				if (escapes && sql[i] === '\\') {
					blank(2);
					continue;
				}
				if (sql[i] === closer) {
					if (closer !== ']' && sql[i + 1] === closer) {
						blank(2); // a doubled quote escapes itself, we're still inside
						continue;
					}
					blank(1);
					closed = true;
					break;
				}
				blank(1);
			}
			if (!closed) {
				unterminated = true;
			}
			continue;
		}
		if (c === '(') {
			d++;
			out[i] = c;
			depth[i] = d;
			i++;
			continue;
		}
		if (c === ')') {
			out[i] = c;
			depth[i] = d;
			d = Math.max(0, d - 1);
			i++;
			continue;
		}
		out[i] = c;
		depth[i] = d;
		i++;
	}
	return { text: out.join(''), depth, unterminated };
}

/** Offset of the first match of `re` inside [from, to) that sits at paren depth `want`, or -1. */
export function findAtDepth(m: MaskedSql, re: RegExp, from: number, to: number, want: number): number {
	const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
	scan.lastIndex = from;
	for (let hit = scan.exec(m.text); hit; hit = scan.exec(m.text)) {
		if (hit.index >= to) {
			return -1;
		}
		if (m.depth[hit.index] === want) {
			return hit.index;
		}
	}
	return -1;
}

/** Split [from, to) on commas at paren depth `want`. */
export function splitAtDepth(m: MaskedSql, from: number, to: number, want: number): { start: number; end: number }[] {
	const parts: { start: number; end: number }[] = [];
	let last = from;
	for (let i = from; i < to; i++) {
		if (m.text[i] === ',' && m.depth[i] === want) {
			parts.push({ start: last, end: i });
			last = i + 1;
		}
	}
	parts.push({ start: last, end: to });
	return parts;
}


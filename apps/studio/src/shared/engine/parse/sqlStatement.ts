/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Picks the single SQL statement under the caret so "run" (with no selection) executes
// just that statement, not the whole buffer. Pure/deterministic — no Monaco import — so
// it stays node-testable. Boundaries are semicolons or blank lines; either delimiter lets
// the user keep several statements in one tab and run the one they're sitting in.

/** The statement bounded by the delimiters around `offset` (may be empty/whitespace). */
function sliceAround(text: string, at: number): string {
	let start = 0;
	let end = text.length;

	// Semicolon boundaries: the ';' stays with the statement before it.
	const prevSemi = text.lastIndexOf(';', at - 1);
	if (prevSemi >= 0) {
		start = prevSemi + 1;
	}
	const nextSemi = text.indexOf(';', at);
	if (nextSemi >= 0) {
		end = nextSemi + 1;
	}

	// Blank-line boundaries (a newline-only run); take the closest one on each side.
	const blank = /\r?\n[ \t]*\r?\n/g;
	for (let m = blank.exec(text); m; m = blank.exec(text)) {
		const after = m.index + m[0].length;
		if (after <= at) {
			start = Math.max(start, after);
		} else if (m.index >= at) {
			end = Math.min(end, m.index);
			break;
		}
	}
	return text.slice(start, end).trim();
}

/** The statement surrounding `offset`, or the whole text when it has no delimiters. */
export function statementAt(text: string, offset: number): string {
	const at = Math.max(0, Math.min(offset, text.length));
	const here = sliceAround(text, at);
	if (here !== '') {
		return here;
	}
	// The caret sits past the last statement — right after its ';' or in the trailing
	// whitespace/blank line — so there's nothing ahead. Run the statement that just ended.
	const prevSemi = text.lastIndexOf(';', at - 1);
	if (prevSemi >= 0) {
		return sliceAround(text, prevSemi);
	}
	return here;
}

/** A statement and where its trimmed text sits in the original buffer, so "Run script" can both
 *  execute the SQL and mark its lines in the editor as it runs. `start`/`end` are character offsets
 *  of the trimmed statement (leading/trailing whitespace excluded). */
export interface StatementSpan {
	sql: string;
	start: number;
	end: number;
}

/** Every statement in the buffer, in order, with its offset span, for "Run script". Splits on the
 *  same boundaries as the single-statement picker (semicolons — the ';' stays with the statement
 *  before it — and blank lines), so a user's mental model of where one statement ends matches both.
 *  Empty/whitespace-only pieces are dropped. Naive about ';' inside strings/comments, exactly like
 *  statementAt — consistent behaviour beats a heavier parser here. */
export function splitStatementSpans(text: string): StatementSpan[] {
	const out: StatementSpan[] = [];
	const push = (from: number, to: number): void => {
		const raw = text.slice(from, to);
		const sql = raw.trim();
		// Drop empty pieces and a bare ';' (an empty statement, e.g. ";;" or a trailing ";").
		if (sql === '' || sql === ';') {
			return;
		}
		const start = from + (raw.length - raw.trimStart().length);
		out.push({ sql, start, end: start + sql.length });
	};
	const delim = /;|\r?\n[ \t]*\r?\n/g;
	let last = 0;
	for (let m = delim.exec(text); m; m = delim.exec(text)) {
		const isSemi = m[0] === ';';
		const end = isSemi ? m.index + 1 : m.index; // keep the ';' with its statement
		push(last, end);
		last = m.index + m[0].length;
	}
	push(last, text.length);
	return out;
}

/** The statement strings only (see splitStatementSpans for the boundaries). */
export function splitStatements(text: string): string[] {
	return splitStatementSpans(text).map((s) => s.sql);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Statement hazards — the "this does not do what it reads like" guard.
//
// `destructiveStatement` answers "is this dangerous?", which a user who MEANT to run an
// UPDATE just clicks through. It says nothing about whether the statement they wrote is the
// statement they think they wrote. This module covers that second class: SQL that parses,
// runs, reports success, and silently does something else.
//
// The case it exists for:
//   UPDATE products SET discount = NULL AND promo_code = NULL;
// `AND` is not an assignment separator, so this is ONE assignment whose value is the boolean
// expression `NULL AND (promo_code = NULL)`. `discount` gets NULL on every row and
// `promo_code` is never touched, yet the run reports N rows affected.
//
// Pure and parser-free, like sqlGuard (a real parser normalises the AST and hides exactly the
// textual mistake we are hunting, and it must never throw on half-typed SQL). Everything is
// found by scanning with string literals, quoted identifiers and comments masked out.

import { findAtDepth, maskSql, splitAtDepth } from '../parse/mask';
import type { MaskedSql } from '../parse/mask';
import { splitStatementSpans } from '../parse/sqlStatement';

export type HazardKind =
	| 'set-boolean-expression' // `SET a = x AND b = y` — one assignment, not two
	| 'null-comparison'        // `= NULL` / `<> NULL` — never true, use IS [NOT] NULL
	| 'clickhouse-mutation';   // `ALTER TABLE t DELETE/UPDATE` — a background rewrite of every part it touches

export interface StatementHazard {
	kind: HazardKind;
	/** One line, stated as what the statement will actually do. */
	message: string;
	/** Why it happens, for the user who wants to know they aren't going mad. */
	rationale: string;
	/** The statement rewritten the way it was almost certainly meant, when we can derive it. */
	suggestedSql?: string;
	/** Character offsets into the SQL passed in, for an inline squiggle. */
	range: { start: number; end: number };
}

/** Characters that turn a lone '=' into a different operator. */
const EQ_PREFIX = new Set(['<', '>', '!', '=', ':', '+', '-', '*', '/', '%', '&', '|', '^']);

/** The offset of the assignment '=' in [from, to) at depth `want`, or -1. */
function findAssignment(m: MaskedSql, from: number, to: number, want: number): number {
	for (let i = from; i < to; i++) {
		if (m.text[i] !== '=' || m.depth[i] !== want) {
			continue;
		}
		if (i > from && EQ_PREFIX.has(m.text[i - 1])) {
			continue;
		}
		if (m.text[i + 1] === '=') {
			continue;
		}
		return i;
	}
	return -1;
}

/** Strip the vendor quoting off an identifier and keep its last dotted segment. */
function bareName(raw: string): string {
	const trimmed = raw.trim().replace(/[`"\[\]]/g, '');
	const dot = trimmed.lastIndexOf('.');
	return dot === -1 ? trimmed : trimmed.slice(dot + 1);
}

function list(names: string[]): string {
	if (names.length === 1) {
		return `"${names[0]}"`;
	}
	const quoted = names.map((n) => `"${n}"`);
	return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

const BOOL_OP = /\b(and|or|xor)\b/gi;

/** Flag the `SET a = x AND b = y` mistake inside one UPDATE statement. */
function setClauseHazards(sql: string, m: MaskedSql, from: number, to: number, out: StatementHazard[]): void {
	if (!/^\s*update\b/i.test(m.text.slice(from, to))) {
		return;
	}
	const set = findAtDepth(m, /\bset\b/i, from, to, 0);
	if (set === -1) {
		return;
	}
	const body = set + 3;
	const where = findAtDepth(m, /\bwhere\b/i, body, to, 0);
	let end = where === -1 ? to : where;
	while (end > body && /[;\s]/.test(m.text[end - 1])) {
		end--;
	}
	for (const part of splitAtDepth(m, body, end, 0)) {
		const eq = findAssignment(m, part.start, part.end, 0);
		if (eq === -1) {
			continue;
		}
		const op = findAtDepth(m, BOOL_OP, eq + 1, part.end, 0);
		if (op === -1) {
			continue;
		}
		const column = bareName(sql.slice(part.start, eq));
		if (!column) {
			continue;
		}
		// Each `<name> = …` after a boolean operator was meant to be its own assignment; those
		// columns keep their current values. Names are read from the ORIGINAL text (the mask blanks
		// quoted identifiers) between the operator and the '=' that follows it.
		const ignored: string[] = [];
		for (let cursor = op; cursor < part.end; ) {
			const width = /^(and|or|xor)/i.exec(m.text.slice(cursor))?.[0].length ?? 3;
			const eqAfter = findAssignment(m, cursor + width, part.end, 0);
			if (eqAfter === -1) {
				break;
			}
			const name = bareName(sql.slice(cursor + width, eqAfter));
			if (name && !ignored.includes(name)) {
				ignored.push(name);
			}
			const next = findAtDepth(m, BOOL_OP, eqAfter + 1, part.end, 0);
			if (next === -1) {
				break;
			}
			cursor = next;
		}
		let start = part.start;
		while (start < part.end && /\s/.test(sql[start])) {
			start++;
		}
		const value = sql.slice(eq + 1, part.end).trim();
		const operator = (/^(and|or|xor)/i.exec(m.text.slice(op))?.[0] ?? "AND").toUpperCase();
		out.push({
			kind: 'set-boolean-expression',
			message: ignored.length > 0
				? `Only "${column}" is assigned. ${list(ignored)} will NOT be updated.`
				: `Only "${column}" is assigned, and its value is a boolean expression, not the value it looks like.`,
			rationale: `${operator} does not separate assignments in a SET clause, a comma does. `
				+ `This parses as the single assignment "${column} = (${value})", `
				+ "so the whole right-hand side collapses to one true/false/NULL value and every other column named in it is only being compared, not set.",
			suggestedSql: commaForm(sql, m, start, part.end),
			range: { start, end: part.end },
		});
	}
}

/** Rewrite `a = x AND b = y` as `a = x, b = y` (the assignment list that was meant). */
function commaForm(sql: string, m: MaskedSql, from: number, to: number): string {
	let outText = '';
	let last = from;
	for (let op = findAtDepth(m, BOOL_OP, from, to, 0); op !== -1; op = findAtDepth(m, BOOL_OP, last, to, 0)) {
		const width = /^(and|or|xor)/i.exec(m.text.slice(op))?.[0].length ?? 3;
		outText += `${sql.slice(last, op).trimEnd()}, `;
		last = op + width;
		while (last < to && /\s/.test(sql[last])) {
			last++;
		}
	}
	return `${outText}${sql.slice(last, to)}`.trim();
}

const NULL_COMPARISON = /(?:=|!=|<>)\s*null\b|\bnull\s*(?:=|!=|<>)/gi;

/** Flag `WHERE col = NULL`, which matches nothing rather than matching the NULLs. */
function nullComparisonHazards(m: MaskedSql, from: number, to: number, out: StatementHazard[]): void {
	const where = findAtDepth(m, /\b(where|having)\b/i, from, to, 0);
	if (where === -1) {
		return;
	}
	NULL_COMPARISON.lastIndex = where;
	for (let hit = NULL_COMPARISON.exec(m.text); hit && hit.index < to; hit = NULL_COMPARISON.exec(m.text)) {
		const negated = hit[0].includes('!') || hit[0].includes('<>');
		out.push({
			kind: 'null-comparison',
			message: negated
				? "\"<> NULL\" never matches any row, not even the non-NULL ones."
				: "\"= NULL\" never matches any row, not even the NULL ones.",
			rationale: "Comparing anything to NULL yields NULL (unknown), never true, so the predicate filters everything out. "
				+ `Use ${negated ? "IS NOT NULL" : "IS NULL"} instead.`,
			range: { start: hit.index, end: hit.index + hit[0].length },
		});
	}
}

/** `ALTER TABLE t [ON CLUSTER c] DELETE|UPDATE ...`: ClickHouse's mutation syntax, found in no other
 *  engine, so matching it needs no idea of which engine the statement is for. */
const MUTATION = /^(\s*ALTER\s+TABLE\s+[^\s(]+(?:\s+ON\s+CLUSTER\s+\S+)?\s+)(DELETE|UPDATE)\b/i;

/**
 * A ClickHouse mutation reads like a row edit and is a rewrite: every data part holding a matching
 * row is rewritten, in the background, with no rollback, which on a large table is hours of I/O and
 * a queue that blocks the next mutation on the table. The statement does what it says; its cost is
 * what it does not say, and a lightweight DELETE is usually what was meant.
 */
function mutationHazards(sql: string, m: MaskedSql, from: number, to: number, out: StatementHazard[]): void {
	const hit = MUTATION.exec(m.text.slice(from, to));
	if (!hit) {
		return;
	}
	const start = from + hit[1].length;
	const range = { start, end: start + hit[2].length };
	if (hit[2].toUpperCase() === 'DELETE') {
		const table = /ALTER\s+TABLE\s+([^\s(]+)/i.exec(sql.slice(from, to))?.[1] ?? 'the table';
		out.push({
			kind: 'clickhouse-mutation',
			message: `ALTER TABLE ... DELETE rewrites every part of ${table} that holds a matching row, in the background, and cannot be rolled back.`,
			rationale: `This is a mutation, not a row delete. A lightweight DELETE FROM ${table} WHERE ... (ClickHouse 23.3 and later) marks the rows deleted at once and drops them in ordinary merges, which is far cheaper; ALTER TABLE ... DELETE is for when the disk space must come back now. Watch it in Operations > Storage > Mutations.`,
			range,
		});
		return;
	}
	out.push({
		kind: 'clickhouse-mutation',
		message: 'ALTER TABLE ... UPDATE rewrites every column it sets in every part that holds a matching row, in the background, and cannot be rolled back.',
		rationale: 'This is a mutation, not a row update: on a large table it is a long rewrite, and a failing one blocks the mutations after it on the same table. Narrow the WHERE as far as it will go, and watch it in Operations > Storage > Mutations.',
		range,
	});
}

/**
 * Every hazard in `sql`. Offsets are relative to the string passed in, so this works on a whole
 * editor buffer (inline squiggles) or on one statement about to run (the confirm dialog).
 * Deterministic, local, and never throws.
 */
export function statementHazards(sql: string): StatementHazard[] {
	const out: StatementHazard[] = [];
	if (!sql.trim()) {
		return out;
	}
	const m = maskSql(sql);
	for (const span of splitStatementSpans(sql)) {
		setClauseHazards(sql, m, span.start, span.end, out);
		nullComparisonHazards(m, span.start, span.end, out);
		mutationHazards(sql, m, span.start, span.end, out);
	}
	return out;
}

/** `sql` with every hazard that has a suggested rewrite replaced by it, so the confirm dialog can
 *  offer "run what you meant" as one button. Splices back-to-front so earlier offsets stay valid. */
export function applyHazardFixes(sql: string, hazards: readonly StatementHazard[]): string {
	const fixable = hazards.filter((h) => h.suggestedSql !== undefined).sort((a, b) => b.range.start - a.range.start);
	let out = sql;
	for (const h of fixable) {
		out = out.slice(0, h.range.start) + h.suggestedSql + out.slice(h.range.end);
	}
	return out;
}

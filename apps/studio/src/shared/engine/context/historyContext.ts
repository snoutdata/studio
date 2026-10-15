/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QueryHistoryEntry } from '../../queries';
import { canonicalizeQuery } from '../parse/queryShape';
import { statementAt } from '../parse/sqlStatement';
import { referencedTables } from '../dialect/querylang/sql';
import { partialIdentifier } from './completionGuard';
import { queryTokens } from './schemaPrompt';

// History-grounded completion context. The inline FIM model already sees the schema and
// the current buffer; this adds the SQL *you* have written before against this same
// connection, so completion follows your phrasing (joins, filters, aliasing) — the part a
// generic code model can't guess. Deterministic and local: no embeddings, no model round-trip.
//
// RETRIEVAL, not recency. The first version ranked by token overlap against the WHOLE prefix and
// fell back to "the most recent N" when nothing matched, which failed in a specific and very
// visible way: with hundreds of tables, `select * from cus‸` was completed as
// `customer_order_check_status ORDER BY \`id\` LIMIT 200 OFFSET 0` — copied verbatim off a
// history line. Four things were wrong, and each has a rule below:
//
//   1. The whole document's tokens drowned out the cursor. → rank against the CURRENT STATEMENT.
//   2. `cus` can never token-match `customer`, so the one signal that mattered scored zero.
//      → the partial identifier at the cursor is matched by PREFIX.
//   3. The explorer's own browse queries (`SELECT * FROM t ORDER BY id LIMIT 200 OFFSET 0`) are
//      recorded as history and were being shown to the model as "SQL you have written". They are
//      machine-generated, they teach nothing about your phrasing, and there are hundreds of them.
//      → browse-shaped queries are excluded, and the rest are DEDUPED BY SHAPE so one repeated
//      query is one example, not twenty.
//   4. A shape you run constantly is more representative than a one-off. → frequency scores.

// Caps so a small local model isn't swamped: a handful of examples, a modest char budget,
// and we skip any single query too long to be a useful example.
const MAX_EXAMPLES = 5;
const HISTORY_CHAR_BUDGET = 2000;
const MAX_QUERY_CHARS = 400;

/** Relevance weights. A shared table is the strongest evidence that a past query is about the
 *  same thing as the one being typed; the partial word under the cursor is next; loose token
 *  overlap is weak on its own (any two queries share words) and is capped so a long query can't
 *  win on volume alone. */
const TABLE_HIT = 6;
const PARTIAL_HIT = 4;
const TOKEN_HIT = 1;
const TOKEN_HIT_CAP = 5;
const FREQUENCY_CAP = 3;

/** How far back around the cursor to look when the current statement can't be isolated. */
const FOCUS_CHARS = 400;

export interface HistoryContextOptions {
	maxExamples?: number;
	charBudget?: number;
}

/**
 * A query the app generated for you rather than one you wrote: `SELECT * FROM t` with nothing but
 * paging on it, which is exactly what clicking a table in the explorer runs
 * (`dialect.paginatedSelect`). Showing these back as "SQL you have written" is what taught the
 * model to complete a half-typed table name into a whole browse statement. A browse WITH a filter
 * (`… WHERE status = 1 ORDER BY id LIMIT 200`) is kept — the user typed that predicate.
 */
export function isBrowseShaped(sql: string): boolean {
	const flat = sql.trim().replace(/;+$/, '').replace(/\s+/g, ' ').toLowerCase();
	return /^select \* from [`"[\]\w.]+( order by [`"[\]\w.]+( asc| desc)?)?( limit \d+)?( offset \d+)?$/.test(flat);
}

/** Count how many of `a`'s tokens also appear in `b`. */
function overlap(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const token of a) {
		if (b.has(token)) {
			n++;
		}
	}
	return n;
}

/** Every whole identifier in the SQL, lowercased — for prefix-matching the word being typed
 *  (`cus` → `customer`, `customer_order`), which token matching alone can never do. */
function identifiers(sql: string): string[] {
	return (sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
}

/** The statement the cursor is in — the context a past query should be relevant TO. Falls back to
 *  a trailing window when the buffer has no statement boundaries to cut on. */
function focusText(prefix: string): string {
	const statement = statementAt(prefix, prefix.length);
	return statement.trim() ? statement : prefix.slice(-FOCUS_CHARS);
}

/**
 * The past queries most worth showing the model for a completion at `prefix`. Restricted to
 * successful, hand-written queries on the same connection (so table/column names line up),
 * excluding the statement being typed. Ranked by relevance to the CURRENT STATEMENT — shared
 * tables first, then the partial identifier under the cursor, then loose token overlap, with
 * how often you run that shape as a tiebreaker.
 *
 * Returns [] when nothing is relevant. That is deliberate: no examples beat irrelevant ones,
 * because whatever is in this block is what a small base model will copy. `history` is expected
 * newest-first (as QueryStore returns it), and that order survives as the final tiebreak.
 */
export function relevantHistory(
	prefix: string,
	connectionId: string | undefined,
	history: QueryHistoryEntry[],
	opts: HistoryContextOptions = {},
): QueryHistoryEntry[] {
	if (!connectionId) {
		return [];
	}
	const maxExamples = opts.maxExamples ?? MAX_EXAMPLES;
	const charBudget = opts.charBudget ?? HISTORY_CHAR_BUDGET;
	const focus = focusText(prefix);
	const typed = focus.trim().toLowerCase();

	// Dedup by SHAPE (literal-free canonical form), keeping the most recent representative and
	// counting the rest as frequency. Twenty runs of one query are one example plus a strong
	// signal that you run it a lot — not twenty slots in the prompt.
	const byShape = new Map<string, { entry: QueryHistoryEntry; count: number }>();
	for (const entry of history) {
		if (entry.connectionId !== connectionId || !entry.outcome.ok || entry.sql.trim() === '') {
			continue;
		}
		if (entry.sql.trim().toLowerCase() === typed || isBrowseShaped(entry.sql)) {
			continue;
		}
		const shape = canonicalizeQuery(entry.sql);
		const seen = byShape.get(shape);
		if (seen) {
			seen.count++;
		} else {
			byShape.set(shape, { entry, count: 1 });
		}
	}
	if (byShape.size === 0) {
		return [];
	}

	const focusTokens = queryTokens(focus);
	const cursorTables = new Set(referencedTables(focus));
	const partial = partialIdentifier(prefix);

	const ranked = [...byShape.values()]
		.map(({ entry, count }) => {
			let score = 0;
			for (const table of referencedTables(entry.sql)) {
				if (cursorTables.has(table)) {
					score += TABLE_HIT;
				}
			}
			if (partial && identifiers(entry.sql).some((name) => name.startsWith(partial) || name.split('_').some((part) => part.startsWith(partial)))) {
				score += PARTIAL_HIT;
			}
			score += TOKEN_HIT * Math.min(TOKEN_HIT_CAP, overlap(queryTokens(entry.sql), focusTokens));
			// Frequency is a TIEBREAK, never a reason on its own: log2 so it takes a doubling to
			// earn each point, and a query run once scores nothing (otherwise every candidate gets
			// a baseline and the relevance filter below can never reject anything).
			score += Math.min(FREQUENCY_CAP, Math.floor(Math.log2(count)));
			return { entry, score };
		})
		.filter((scored) => scored.score > 0)
		// Stable sort keeps newest-first order among equal scores (history is newest-first).
		.sort((a, b) => b.score - a.score)
		.map((scored) => scored.entry);

	const picked: QueryHistoryEntry[] = [];
	let used = 0;
	for (const entry of ranked) {
		if (picked.length >= maxExamples) {
			break;
		}
		const len = entry.sql.trim().length;
		if (len > MAX_QUERY_CHARS) {
			continue;
		}
		if (picked.length > 0 && used + len > charBudget) {
			break;
		}
		picked.push(entry);
		used += len;
	}
	return picked;
}

/**
 * The relevant past queries rendered as SQL comment lines, to prepend to a FIM prefix (a raw
 * code model has no system prompt — comments are how it sees prior context, the same way the
 * schema is injected). Returns "" when there's nothing relevant to add.
 */
export function buildHistoryComment(
	prefix: string,
	connectionId: string | undefined,
	history: QueryHistoryEntry[],
	opts: HistoryContextOptions = {},
): string {
	const picks = relevantHistory(prefix, connectionId, history, opts);
	if (picks.length === 0) {
		return '';
	}
	const lines = ['-- Examples of SQL you have written against this database before:'];
	picks.forEach((entry, i) => {
		if (i > 0) {
			lines.push('--');
		}
		for (const line of entry.sql.trim().split(/\r?\n/)) {
			lines.push(`-- ${line}`);
		}
	});
	return lines.join('\n');
}

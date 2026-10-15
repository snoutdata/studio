/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The canonical `query_shape` the failure memory keys on. The point is to match on a query's
 * STRUCTURE, not its raw text: `WHERE id = 5` and `WHERE id = 6` are the same shape, and
 * reformatting or re-casing a query must not change it.
 *
 * v1 is a normalized-text form (deterministic, dependency-free): strip comments, replace literals
 * with a `?` hole, fold case and whitespace, normalize spacing around comparison operators, and
 * collapse `IN (?, ?, ?)` to `IN (?)`. This is
 * deliberately the dumbest thing that could work — critically, it is ROBUST to unparseable input,
 * which matters because a large share of the failures we record are themselves syntax errors (the
 * exact SQL a parser rejects). AST-structural canonicalization (parameterizing over a parse tree,
 * sorting commutative predicates) is the first upgrade a retrieval benchmark could justify — it ships
 * when a measured retrieval miss shows it would help, not before.
 *
 * Applied to every backend's recorded query text. For relational SQL that's the authored statement;
 * for a native document/vector query it's the shell-style rendering — the same normalization still
 * yields a stable key, it just isn't SQL-aware. Known lexical limitation: a comment marker or a
 * digit sitting inside a string literal can be normalized imperfectly. Acceptable for a match key.
 */
export function canonicalizeQuery(query: string): string {
	let text = query ?? '';
	if (!text.trim()) {
		return '';
	}
	// 1. Strip comments (block first, then line-to-EOL).
	text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
	// 2. Single-quoted string literals (with '' escapes) → a hole.
	text = text.replace(/'(?:[^']|'')*'/g, '?');
	// 3. Numeric literals → a hole, but not digits that are part of an identifier (e.g. `col1`).
	text = text.replace(/(?<![A-Za-z0-9_.])\d+(?:\.\d+)?/g, '?');
	// 4. Fold case and whitespace so formatting can't change the shape.
	text = text.toLowerCase().replace(/\s+/g, ' ').trim();
	// 4b. Strip spaces around comparison operators so `id = 1` and `id=1` share a shape. Multi-char
	// operators lead the alternation so `>=` isn't split into `>` then `=`. Known caveat: this can
	// nick JSON path operators like `->`/`->>`; rare in recorded queries, and still deterministic.
	text = text.replace(/\s*(<=|>=|<>|!=|=|<|>)\s*/g, '$1');
	// 5. Collapse variable-length value lists: `in (?, ?, ?)` → `in (?)` so arity doesn't fragment.
	text = text.replace(/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/g, 'in (?)');
	// 6. Drop trailing statement terminators / stray spacing.
	return text.replace(/\s*;\s*$/, '').trim();
}

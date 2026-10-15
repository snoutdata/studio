/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reading SQL text without parsing it: blank out everything that only LOOKS like syntax.
 *
 * Several things in the dialect layer need to find a word at the top level of a statement and
 * nowhere else - where a `LIMIT` may go, where a trailing `FORMAT` starts, where a `SETTINGS`
 * clause begins, which `{name:Type}` placeholders a statement really has. All of them have the
 * same two ways to be wrong: a word inside a string, a quoted name or a comment is not that word,
 * and a word inside parentheses belongs to a subquery or an argument list rather than to the
 * statement.
 *
 * So this masks the first kind to spaces and counts the second, once, for the dialect layer.
 *
 * **Why this is not `parse/mask.ts`, which does the same job.** That one re-exports
 * `@snout/review-core`, so the guard the user sees and the reviewer that comments on a pull
 * request scan text with one implementation. Everything that CAN depend on that package should
 * use it. `dialect/index.ts` and `dialect/explain.ts` cannot: they are COPIED, file for file, into
 * the dashboard's bundle, and a copied file that imports a package
 * the copy does not install is refused by that script and would break a deploy. So the dialect
 * layer keeps its own dependency-free scan, and it keeps it HERE, in one place, rather than a
 * copy per file - which is what it was until 2026-09-20.
 */

/**
 * `sql` with every string, quoted name and comment blanked to spaces - the SAME LENGTH, so an
 * index into the result is an index into the source - plus the parenthesis depth at each
 * character. A closing paren carries the depth OUTSIDE it, so `depth[i] === 0` reads as "this
 * character belongs to the statement itself".
 */
export function maskClickHouse(sql: string): { text: string; depth: number[] } {
	const masked: string[] = [];
	const depth: number[] = [];
	let d = 0;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		const close = c === "'" ? "'" : c === '"' ? '"' : c === '`' ? '`' : null;
		if (close) {
			let j = i + 1;
			while (j < sql.length && sql[j] !== close) {
				j += sql[j] === '\\' ? 2 : 1;
			}
			for (; i <= j && i < sql.length; i++) {
				masked.push(' ');
				depth.push(d);
			}
			i--;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			for (; i < sql.length && sql[i] !== '\n'; i++) {
				masked.push(' ');
				depth.push(d);
			}
			i--;
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			const stop = end < 0 ? sql.length : end + 2;
			for (; i < stop; i++) {
				masked.push(' ');
				depth.push(d);
			}
			i--;
			continue;
		}
		if (c === '(') {
			d++;
		}
		masked.push(c);
		depth.push(c === ')' ? d - 1 : d);
		if (c === ')') {
			d = Math.max(0, d - 1);
		}
	}
	return { text: masked.join(''), depth };
}

/**
 * The first match of `re` (which must be global) that sits outside any string, quoted name,
 * comment or parenthesis, or -1.
 */
export function topLevelMatch(sql: string, re: RegExp): number {
	const { text, depth } = maskClickHouse(sql);
	re.lastIndex = 0;
	for (let hit = re.exec(text); hit; hit = re.exec(text)) {
		if (depth[hit.index] === 0) {
			return hit.index;
		}
		if (hit[0].length === 0) {
			re.lastIndex++;
		}
	}
	return -1;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Derive a friendly `*.sql` file name from SQL content, deterministically (no AI, no round-trip).
 * The shape is `<verb>-<object>.sql`, e.g. `select-orders.sql`, `create-customers.sql`. We read
 * the first statement's leading keyword and its primary table/object; anything we can't parse
 * falls back to `query.sql` (the store dedupes collisions, so a plain name is always safe).
 */

const TYPE_WORDS = new Set([
	'table', 'view', 'index', 'if', 'not', 'exists', 'temporary', 'temp', 'or', 'replace',
	'unique', 'materialized', 'from', 'into', 'database', 'schema', 'procedure', 'function',
	'trigger', 'as', 'all', 'distinct', 'top',
]);

/** Strip quoting/brackets and any schema qualifier, leaving a bare identifier. */
function normalizeIdent(raw: string): string {
	const cleaned = raw.replace(/[`"[\]]/g, '');
	const last = cleaned.split('.').pop() ?? cleaned;
	return last.replace(/[^a-z0-9_]/gi, '');
}

/** The identifier immediately following a keyword (e.g. the table after FROM/INTO). */
function tokenAfter(text: string, keyword: string): string {
	const m = text.match(new RegExp(`\\b${keyword}\\b\\s+([a-z0-9_.\`"[\\]]+)`, 'i'));
	return m ? normalizeIdent(m[1]) : '';
}

function sanitizeSlug(slug: string): string {
	return slug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
}

export function suggestFileName(sql: string): string {
	const cleaned = sql
		.replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
		.replace(/--[^\n]*/g, ' ') // line comments
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) {
		return 'query.sql';
	}
	const stmt = cleaned.split(';')[0].trim().toLowerCase();
	const verb = (stmt.match(/^[a-z]+/) ?? [''])[0];

	// Prefer the table after FROM/INTO; otherwise the first non-keyword identifier after the verb.
	let object = tokenAfter(stmt, 'from') || tokenAfter(stmt, 'into');
	if (!object) {
		const tokens = stmt.split(/[^a-z0-9_.`"[\]]+/).slice(1);
		for (const token of tokens) {
			const id = normalizeIdent(token);
			if (id && !TYPE_WORDS.has(id) && !/^\d+$/.test(id)) {
				object = id;
				break;
			}
		}
	}

	const slug = sanitizeSlug([verb, object].filter(Boolean).join('-'));
	return `${slug || 'query'}.sql`;
}

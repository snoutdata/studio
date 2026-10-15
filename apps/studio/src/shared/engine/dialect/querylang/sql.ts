/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The relational (SQL) QueryLanguageProfile. Everything the app used to hardcode to `'sql'`
 *  — the Monaco language, the chat fence id, the AI flavour name, the destructive-write guard,
 *  and the table-reference extraction — lives here, delegating per-vendor specifics to the
 *  existing `Dialect` strategy. The document (Mongo) and vector (Pinecone) profiles slot in
 *  beside this one.
 *--------------------------------------------------------------------------------------------*/

import type { NativeQuery } from '../../compile/native';
import { dialectFor } from '../index';
import { destructiveStatement } from '../../guard/sqlGuard';
import type { BrowsePage, BrowseTarget, QueryLanguageProfile } from './index';

/**
 * The table names a SQL snippet reads from: the identifier right after FROM/JOIN (handles
 * `db.table`, backticks/quotes, and a trailing alias). Lowercased, deduped. Good enough for
 * schema-relevance ranking and the edit-correction hint — not a full parser. (Canonical home;
 * `schemaPrompt` imports this rather than keeping its own copy.)
 */
export function referencedTables(sql: string): string[] {
	const out = new Set<string>();
	const re = /\b(?:from|join)\s+([`"\[]?[A-Za-z0-9_$.]+[`"\]]?)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(sql)) !== null) {
		const raw = m[1].replace(/[`"\[\]]/g, '');
		const name = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
		if (name) {
			out.add(name.toLowerCase());
		}
	}
	return [...out];
}

export const SQL_PROFILE: QueryLanguageProfile = {
	kind: 'relational',
	newEntityLabel: 'New table',
	monacoLanguage: 'sql',
	fenceId: 'sql',
	// The AI flavour name is per-vendor ("PostgreSQL", "Oracle", …); fall back to the generic
	// dialect's "SQL" when no driver id is known.
	aiDisplayName: (driverId) => dialectFor(driverId).aiDisplayName,
	isDestructive: (query: NativeQuery, driverId?: string) => query.lang === 'sql' && destructiveStatement(query.sql, driverId) !== undefined,
	referencedEntities: (input) => referencedTables(input),
	browse: (target: BrowseTarget, page: BrowsePage, driverId) => {
		const dialect = dialectFor(driverId);
		const qname = target.schema
			? `${dialect.quoteIdent(target.schema)}.${dialect.quoteIdent(target.name)}`
			: dialect.quoteIdent(target.name);
		// No grid ordering for a plain browse; OFFSET..FETCH dialects need *some* deterministic
		// ORDER BY, so fall back to the first column ordinal. LIMIT..OFFSET dialects ignore it.
		const sql = dialect.paginatedSelect(`SELECT * FROM ${qname}`, {
			limit: page.limit,
			offset: page.offset,
			orderBy: '',
			fallbackOrderBy: '1',
		});
		return { lang: 'sql', sql };
	},
};

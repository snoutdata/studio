/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  QueryLanguageProfile — the per-backend-kind strategy, parallel to the SQL-only `Dialect`
 *  (src/shared/dialect). Where `Dialect` captures per-vendor SQL surface (quoting, pagination),
 *  a profile captures everything that used to be hardcoded to SQL across the app: the Monaco
 *  language, the chat fence id, the AI flavour name, the destructive-write guard, and entity
 *  extraction. Keyed by `BackendKind` so document (Mongo) and vector (Pinecone) backends plug
 *  in one profile each instead of growing `if (kind === …)` branches. Pure + dependency-free
 *  (like dialect/) so renderer, main and server all import it.
 *--------------------------------------------------------------------------------------------*/

import type { BackendKind, NativeQuery } from '../../compile/native';
import { findAtDepth, maskSql } from '../../parse/mask';
import { dialectFor } from '../index';
import { SQL_PROFILE } from './sql';
import { MONGO_PROFILE } from './mongo';
import { PINECONE_PROFILE } from './pinecone';
import { LOGS_PROFILE } from './logs';

/** A table/collection the grid wants the first page of. */
export interface BrowseTarget {
	/** Table or collection name. */
	name: string;
	/** Owning schema/database, if any (ignored by document backends). */
	schema?: string;
}

/** A page request for {@link QueryLanguageProfile.browse}: how many rows/docs and how far in. */
export interface BrowsePage {
	limit: number;
	offset: number;
}

export interface QueryLanguageProfile {
	/** The backend family this profile serves. */
	readonly kind: BackendKind;
	/** Monaco language id for the editor of this backend (`'sql'` | `'json'`). */
	readonly monacoLanguage: string;
	/** Markdown chat fence id the AI proposes code in (`'sql'` | `'json'`). */
	readonly fenceId: string;
	/** The flavour name handed to the AI prompt. SQL is per-vendor ("PostgreSQL"), so it takes
	 *  the connection's driver id; document/vector profiles ignore it. */
	aiDisplayName(driverId?: string): string;
	/** The generalized write/DDL guard: true when running this query mutates data or structure
	 *  (the SQL-only `destructiveStatement` is what the `'sql'` profile delegates to). */
	isDestructive(query: NativeQuery, driverId?: string): boolean;
	/** The schema entities (tables / collections / indexes) an authored query references, for
	 *  schema-relevance ranking. Replaces the SQL-only `referencedTables` regex. */
	referencedEntities(input: string): string[];
	/** The "first N rows/docs of X" query the grid issues to browse a table/collection. SQL
	 *  builds a paginated SELECT (needs the driver id for the dialect); Mongo a
	 *  `[{$skip},{$limit}]` pipeline. */
	browse(target: BrowseTarget, page: BrowsePage, driverId?: string): NativeQuery;
	/**
	 * What a person can CREATE here from the connection tree, named as this backend names it, or
	 * `undefined` when the answer is nothing.
	 *
	 * Nothing is the honest answer for a log service: the scopes belong to the provider and are made
	 * by whatever writes the logs, so an "+ New table" beside a CloudWatch region offers something
	 * that cannot exist. Pinecone is the same today — an index is created in Pinecone's own console,
	 * and this app has no authoring surface for one.
	 */
	readonly newEntityLabel?: string;
}

const PROFILES: Partial<Record<BackendKind, QueryLanguageProfile>> = {
	relational: SQL_PROFILE,
	document: MONGO_PROFILE,
	vector: PINECONE_PROFILE,
	telemetry: LOGS_PROFILE,
};

/**
 * Resolve the profile for a backend kind. Falls back to the relational/SQL profile for kinds
 * not yet implemented, so callers never get `undefined` before a phase lands.
 */
export function profileFor(kind: BackendKind | undefined): QueryLanguageProfile {
	return (kind && PROFILES[kind]) || SQL_PROFILE;
}

/** The alias the counting query gives its one column: what the results footer reads back. */
const COUNT_ALIAS = 'snout_total';

/**
 * The statement that answers "how many rows would this query return, ignoring the fetch limit" —
 * the results footer's "Count total".
 *
 * Two shapes, because the subquery wrap is not universal. A relational engine counts a derived
 * table: `SELECT COUNT(*) FROM (<the query>) x`. A LOG service has no such thing — one query reads
 * one scope, and `sqlToLogs` refuses a subquery in FROM — so the statement is rewritten in place
 * instead: the projection becomes `count(*)` and everything from FROM onwards is kept as written,
 * minus the ORDER BY / LIMIT, which a count has no use for. The WHERE survives, which is the part
 * that matters: the count is over the same time window as the rows on screen.
 *
 * Returns `null` when there is no honest count to run, and the caller hides the button rather than
 * showing a number that answers a different question:
 * - anything that is not a single SELECT/WITH read;
 * - a grouped log query, where the total is a count of GROUPS and this rewrite would count events.
 */
export function countingSql(sql: string, kind: BackendKind | undefined): string | null {
	const trimmed = sql.trim().replace(/;\s*$/, '');
	if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(';')) {
		return null;
	}
	if (kind !== 'telemetry') {
		return `SELECT COUNT(*) AS ${COUNT_ALIAS} FROM (${trimmed}) AS snout_count`;
	}
	const masked = maskSql(trimmed);
	const from = findAtDepth(masked, /\bfrom\b/i, 0, trimmed.length, 0);
	if (from === -1 || findAtDepth(masked, /\bgroup\s+by\b/i, from, trimmed.length, 0) !== -1) {
		return null;
	}
	let end = trimmed.length;
	for (const clause of [/\border\s+by\b/i, /\blimit\b/i, /\boffset\b/i]) {
		const at = findAtDepth(masked, clause, from, trimmed.length, 0);
		if (at !== -1 && at < end) {
			end = at;
		}
	}
	return `SELECT count(*) AS ${COUNT_ALIAS} ${trimmed.slice(from, end).trim()}`;
}

/** Aggregation stages that make a pipeline non-windowable: it writes back, or it already caps
 *  its own output (so the rows the user asked for are all there is). */
const UNWINDOWABLE_STAGES = new Set(['$out', '$merge', '$limit']);

/**
 * Re-issue `query` as a window over the SAME query: `page.limit` rows starting at `page.offset`.
 * Returns `null` when this query can't be windowed, which is the single gate the results grid
 * reads to decide whether "Next" may fetch past the rows already loaded.
 *
 * Dispatch is on the query's LANGUAGE, not on the connection's backend kind, because that's what
 * decides how a window is expressed — a Mongo connection whose query was authored in SQL is
 * windowed as SQL (`LIMIT n OFFSET m`) and transcribed to `$skip`/`$limit` downstream, exactly
 * like its first page was.
 *
 * Not windowable:
 * - a statement that carries its own cap (LIMIT/TOP/FETCH FIRST, or a pipeline `$limit`) — the
 *   user asked for exactly those rows;
 * - anything that isn't a plain single read (multi-statement SQL, a non-SELECT, a write pipeline,
 *   an explain);
 * - a **native** vector (Pinecone) query, whose `topK` IS the cap the author asked for — the same
 *   rule as a SQL statement that carries its own LIMIT. SQL against a Pinecone connection IS
 *   windowable: `sqlToPinecone` compiles OFFSET to `PineconeQuery.offset`, which the driver serves
 *   by walking Pinecone's continuation tokens and slicing.
 *
 * The offset caveat from {@link Dialect.windowClause} applies: without a total ordering,
 * consecutive windows are not guaranteed disjoint.
 */
export function windowQuery(query: NativeQuery, page: BrowsePage, driverId?: string): NativeQuery | null {
	if (page.limit <= 0 || page.offset < 0) {
		return null;
	}
	switch (query.lang) {
		case 'sql': {
			const trimmed = query.sql.trim().replace(/;\s*$/, '');
			// A read we can wrap: one statement (no inner `;`), starting at SELECT/WITH, uncapped.
			if (!/^(select|with)\b/i.test(trimmed) || trimmed.includes(';')) {
				return null;
			}
			const dialect = dialectFor(driverId);
			if (dialect.hasLimit(trimmed)) {
				return null;
			}
			return { lang: 'sql', sql: dialect.windowClause(trimmed, page.limit, page.offset), params: query.params };
		}
		case 'mongo': {
			if (query.explain || query.pipeline.some((stage) => Object.keys(stage).some((key) => UNWINDOWABLE_STAGES.has(key)))) {
				return null;
			}
			// Appended at the END, so the window is over the pipeline's own output stream (after any
			// $match/$group/$sort), which is what `LIMIT n OFFSET m` means on the SQL side too.
			const pipeline: object[] = [...query.pipeline];
			if (page.offset > 0) {
				pipeline.push({ $skip: page.offset });
			}
			pipeline.push({ $limit: page.limit });
			return { lang: 'mongo', collection: query.collection, pipeline };
		}
		default:
			// Write batches, DDL and Pinecone queries have no "further in" form.
			return null;
	}
}

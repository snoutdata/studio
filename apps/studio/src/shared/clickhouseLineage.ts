/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ClickHouse lineage and dictionary structure, as pure functions over `system.*` rows.
 *
 * ClickHouse has no foreign keys, so the only thing that connects two tables is a MATERIALIZED
 * VIEW: an insert trigger whose SELECT runs over the rows written to a source table and whose
 * result lands in a target table. Both ends matter to a reader of the explorer, and neither is
 * visible from the table itself:
 *
 * - The SOURCE end is the server's own answer. `system.tables.dependencies_*` on a table lists
 *   the views that fire on an insert into it, so inverting that map gives each view its sources.
 * - The TARGET end is in the view's own `CREATE ... TO db.t`. There is no catalog column for it.
 *   A view written without `TO` owns an inner table the server named `.inner_id.<uuid>`, which is
 *   filtered out of introspection and has no name worth showing, so that case is simply absent.
 *
 * A REFRESHABLE view (`REFRESH EVERY ...`) is not an insert trigger: it re-runs on a schedule, and
 * the server records no dependency for it. Its sources are therefore unknown rather than none,
 * which is why {@link ObjectLineage.refreshable} is carried and the explorer says so instead of
 * drawing an empty list. Guessing them by regexing `FROM` out of the SELECT would be wrong on a
 * join, a subquery or a CTE, and this is a screen people trust.
 */

import type { DictionaryInfo, ObjectLineage, SchemaRef } from './schema';

/** The `system.tables` columns lineage is computed from. */
export interface LineageRow {
	database: string;
	name: string;
	engine: string;
	create_table_query?: string;
	/** Databases of the views that fire on an insert into this table, paired with {@link dependencies_table}. */
	dependencies_database?: string[] | null;
	dependencies_table?: string[] | null;
}

const MATERIALIZED = 'MaterializedView';

/**
 * The table a materialized view writes into, from its CREATE statement.
 *
 * `CREATE MATERIALIZED VIEW shop.mv TO shop.daily (…) AS SELECT …` → `shop.daily`. The name may
 * be backquoted on either side of the dot, and the database may be left out, in which case the
 * view's own database is the answer. Anything else (no `TO` at all, so the view owns an inner
 * table) is `undefined`.
 */
export function materializedViewTarget(createQuery: string | undefined, database: string): SchemaRef | undefined {
	if (!createQuery) {
		return undefined;
	}
	// Anchored on the view's own name so a `TO` inside the SELECT cannot match: the target always
	// follows `CREATE MATERIALIZED VIEW <name>`, before the column list or `AS`.
	const match = /\bCREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`(?:[^`]|``)*`|[\w$]+)(?:\.(?:`(?:[^`]|``)*`|[\w$]+))?\s+TO\s+(?:(`(?:[^`]|``)*`|[\w$]+)\.)?(`(?:[^`]|``)*`|[\w$]+)/i.exec(createQuery);
	if (!match) {
		return undefined;
	}
	const schema = unquote(match[1]);
	const name = unquote(match[2]);
	return name ? { schema: schema || database, name } : undefined;
}

/** A view that re-runs on a schedule rather than firing on insert. */
export function isRefreshableView(createQuery: string | undefined): boolean {
	return !!createQuery && /\bREFRESH\s+(EVERY|AFTER)\b/i.test(createQuery);
}

function unquote(token: string | undefined): string {
	if (!token) {
		return '';
	}
	return token.startsWith('`') ? token.slice(1, -1).replace(/``/g, '`') : token;
}

/**
 * Lineage for every object in `rows`, keyed `database\u0000name`.
 *
 * One pass: a table's `dependencies_*` names the views it feeds, and the same pair read backwards
 * is a view's sources. Only objects with something to say get an entry, so the explorer can test
 * for the field rather than for an empty record.
 */
export function clickhouseLineage(rows: LineageRow[]): Map<string, ObjectLineage> {
	const out = new Map<string, ObjectLineage>();
	const entry = (schema: string, name: string): ObjectLineage => {
		const k = `${schema}\u0000${name}`;
		let value = out.get(k);
		if (!value) {
			value = {};
			out.set(k, value);
		}
		return value;
	};

	for (const row of rows) {
		const dbs = row.dependencies_database ?? [];
		const names = row.dependencies_table ?? [];
		for (let i = 0; i < names.length; i++) {
			const view: SchemaRef = { schema: dbs[i] ?? row.database, name: names[i] };
			const source = entry(row.database, row.name);
			(source.feeds ??= []).push(view);
			const target = entry(view.schema, view.name);
			(target.readsFrom ??= []).push({ schema: row.database, name: row.name });
		}
	}

	for (const row of rows) {
		if (row.engine !== MATERIALIZED) {
			continue;
		}
		const view = entry(row.database, row.name);
		const target = materializedViewTarget(row.create_table_query, row.database);
		if (target) {
			view.writesTo = target;
			(entry(target.schema, target.name).writtenBy ??= []).push({ schema: row.database, name: row.name });
		}
		if (isRefreshableView(row.create_table_query)) {
			view.refreshable = true;
		}
	}

	for (const [k, value] of out) {
		if (!value.feeds && !value.readsFrom && !value.writesTo && !value.writtenBy && !value.refreshable) {
			out.delete(k);
		}
	}
	return out;
}

/** The lineage key for one object, so callers do not spell the separator themselves. */
export function lineageKey(database: string, name: string): string {
	return `${database}\u0000${name}`;
}

/** The `system.dictionaries` columns a dictionary's structure is read from. */
export interface DictionaryRow {
	database: string;
	name: string;
	key_names?: string[] | null;
	key_types?: string[] | null;
	attribute_names?: string[] | null;
	attribute_types?: string[] | null;
}

/**
 * A dictionary's structure, from `system.dictionaries` plus its own CREATE statement.
 *
 * The layout and the source KIND are parsed out of the statement rather than read from
 * `system.dictionaries.layout_type`/`source`, because those two columns are empty until the
 * dictionary has been loaded, and a dictionary that has never been used is exactly the one
 * somebody is looking at. The source's own arguments are deliberately dropped: a SOURCE clause
 * carries a host, a user and (in the DDL the server hands back) a `PASSWORD '[HIDDEN]'`.
 */
export function clickhouseDictionary(row: DictionaryRow | undefined, createQuery: string | undefined): DictionaryInfo | undefined {
	const keyColumns = (row?.key_names ?? []).filter(Boolean);
	const names = row?.attribute_names ?? [];
	const types = row?.attribute_types ?? [];
	const attributes = names.map((name, i) => ({ name, dataType: types[i] ?? '' }));
	const layout = /\bLAYOUT\s*\(\s*([A-Za-z_][\w]*)/i.exec(createQuery ?? '')?.[1];
	const sourceKind = /\bSOURCE\s*\(\s*([A-Za-z_][\w]*)/i.exec(createQuery ?? '')?.[1];
	if (keyColumns.length === 0 && attributes.length === 0 && !layout && !sourceKind) {
		return undefined;
	}
	return {
		keyColumns,
		attributes,
		...(layout ? { layout: layout.toUpperCase() } : {}),
		...(sourceKind ? { sourceKind: sourceKind.toUpperCase() } : {}),
	};
}

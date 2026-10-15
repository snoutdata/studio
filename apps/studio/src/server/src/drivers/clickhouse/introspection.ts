/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasDynamicPaths } from '../../../../shared/cellValue';
import { clickhouseDictionary, clickhouseLineage, lineageKey, type DictionaryRow } from '../../../../shared/clickhouseLineage';
import { quoteClickHouseIdent } from '../../../../shared/engine';
import type { ColumnInfo, DatabaseSchema, IndexInfo, TableInfo } from '../../../../shared/schema';

/**
 * A query runner: takes a SQL string and resolves to named-column rows. The driver supplies one
 * backed by the HTTP interface; tests inject canned `system.*` rows.
 */
export type ClickHouseRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * ClickHouse keeps its catalog in `system.tables` and `system.columns`. A ClickHouse DATABASE is
 * what the rest of the app calls a schema (a namespace inside one server), so every non-system
 * database comes back as a schema, the way Postgres's schemas do.
 *
 * Two things are left empty ON PURPOSE:
 *
 * - **The primary key.** A MergeTree primary key is a SORT PREFIX, not a uniqueness constraint:
 *   many rows share one key. The grid addresses a row for UPDATE/DELETE by its primary key, and
 *   keyset paging assumes a key names one row, so reporting the sort key there would let an edit
 *   of one row rewrite every row sharing it, and let paging skip rows. With no key, the grid says
 *   the table is not editable and paging falls back to OFFSET, which are both true. The sort key
 *   is shown instead in the table's engine line.
 * - **Foreign keys.** ClickHouse has none.
 */
const SYSTEM_DATABASES = `'system', 'INFORMATION_SCHEMA', 'information_schema'`;

interface TableRow {
	database: string;
	name: string;
	engine: string;
	as_select: string;
	sorting_key: string;
	primary_key: string;
	sampling_key: string;
	partition_key: string;
	create_table_query: string;
	total_rows: string | number | null;
	total_bytes: string | number | null;
	comment: string;
	dependencies_database: string[] | null;
	dependencies_table: string[] | null;
}

interface SkipIndexRow {
	database: string;
	table: string;
	name: string;
	type_full: string;
	expr: string;
	granularity: string | number;
}

interface ColumnRow {
	database: string;
	table: string;
	name: string;
	type: string;
	default_kind: string;
	default_expression: string;
	comment: string;
	compression_codec: string;
	is_in_primary_key: string | number;
	is_in_sorting_key: string | number;
	data_compressed_bytes: string | number | null;
	data_uncompressed_bytes: string | number | null;
}

const VIEW_ENGINES = new Set(['View', 'MaterializedView', 'LiveView', 'WindowView']);

/** A ClickHouse dictionary is in `system.tables` like anything else, with this engine. It is not a
 *  table: nothing writes to it, its rows come from its SOURCE, and it has no parts. */
const DICTIONARY_ENGINE = 'Dictionary';

function key(database: string, table: string): string {
	return `${database}.${table}`;
}

function toNumber(value: string | number | null): number | undefined {
	if (value === null || value === '') {
		return undefined;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/** `Nullable(String)` is nullable; `LowCardinality(Nullable(String))` is too. Nothing else is. */
function isNullableType(type: string): boolean {
	return /^(LowCardinality\()?Nullable\(/.test(type);
}

/** `MergeTree PARTITION BY (toYYYYMM(ts)) ORDER BY (kind, ts)`: what a reader of the explorer
 *  needs to know to write a fast query against the table. A PRIMARY KEY is named only when it is
 *  shorter than the ORDER BY, since that is the only case where the two differ. */
export function engineLine(row: Pick<TableRow, 'engine' | 'partition_key' | 'primary_key' | 'sorting_key' | 'sampling_key'>): string {
	let line = row.engine;
	if (row.partition_key) {
		line += ` PARTITION BY (${row.partition_key})`;
	}
	if (row.primary_key && row.primary_key !== row.sorting_key) {
		line += ` PRIMARY KEY (${row.primary_key})`;
	}
	if (row.sorting_key) {
		line += ` ORDER BY (${row.sorting_key})`;
	}
	if (row.sampling_key) {
		line += ` SAMPLE BY (${row.sampling_key})`;
	}
	return line;
}

function flag(value: string | number): boolean {
	return value === 1 || value === '1';
}

/** Cheap structural fingerprint: a column count plus a hash sum over each column's identity. */
export async function clickhouseStructuralDigest(run: ClickHouseRowRunner): Promise<string> {
	const rows = await run(
		`SELECT count() AS n, sum(cityHash64(database, table, name, type, position)) AS h
		   FROM system.columns
		  WHERE database NOT IN (${SYSTEM_DATABASES})`,
	);
	const row = rows[0] as { n?: string | number; h?: string | number } | undefined;
	return row ? `${row.n ?? 0}:${row.h ?? 0}` : '0:0';
}

export async function introspectClickHouse(run: ClickHouseRowRunner, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const tableRows = (await run(
		`SELECT database, name, engine, as_select, sorting_key, primary_key, sampling_key, partition_key, create_table_query, total_rows, total_bytes, comment,
		        dependencies_database, dependencies_table
		   FROM system.tables
		  WHERE database NOT IN (${SYSTEM_DATABASES}) AND NOT is_temporary AND name NOT LIKE '.inner%'
		  ORDER BY database, name`,
	)) as unknown as TableRow[];

	const columnRows = (await run(
		`SELECT database, table, name, type, default_kind, default_expression, comment, compression_codec,
		        is_in_primary_key, is_in_sorting_key, data_compressed_bytes, data_uncompressed_bytes
		   FROM system.columns
		  WHERE database NOT IN (${SYSTEM_DATABASES})
		  ORDER BY database, table, position`,
	)) as unknown as ColumnRow[];

	// Data-skipping indexes: ClickHouse's only secondary index, over an expression, with a type.
	// Optional because an old server or a restricted user may not be able to read the table.
	const indexRows = (await run(
		`SELECT database, table, name, type_full, expr, granularity
		   FROM system.data_skipping_indices
		  WHERE database NOT IN (${SYSTEM_DATABASES})
		  ORDER BY database, table, name`,
	).catch(() => [])) as unknown as SkipIndexRow[];
	const indexesByTable = new Map<string, IndexInfo[]>();
	for (const row of indexRows) {
		const list = indexesByTable.get(key(row.database, row.table)) ?? [];
		list.push({ name: row.name, columns: [row.expr], unique: false, method: `${row.type_full} GRANULARITY ${row.granularity}` });
		indexesByTable.set(key(row.database, row.table), list);
	}

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const list = columnsByTable.get(key(row.database, row.table)) ?? [];
		const column: ColumnInfo = {
			name: row.name,
			dataType: row.type,
			nullable: isNullableType(row.type),
			isPrimaryKey: false,
			default: row.default_expression ? row.default_expression : null,
			comment: row.comment || undefined,
		};
		// Where the column sits in the key, what it is compressed with, and what it takes on disk:
		// all already in the row, so no extra round trip.
		if (flag(row.is_in_primary_key)) {
			column.sortKey = 'primary';
		} else if (flag(row.is_in_sorting_key)) {
			column.sortKey = 'sort';
		}
		if (row.compression_codec) {
			column.codec = row.compression_codec;
		}
		const compressed = toNumber(row.data_compressed_bytes ?? null);
		const uncompressed = toNumber(row.data_uncompressed_bytes ?? null);
		if (compressed !== undefined && uncompressed !== undefined && (compressed > 0 || uncompressed > 0)) {
			column.storedBytes = { compressed, uncompressed };
		}
		list.push(column);
		columnsByTable.set(key(row.database, row.table), list);
	}

	// A dictionary's key and attributes. Optional in the same way the skip indexes are: a user
	// refused `system.dictionaries` keeps every dictionary in the tree, without its key.
	const dictionaryRows = (await run(
		`SELECT database, name, \`key.names\` AS key_names, \`key.types\` AS key_types,
		        \`attribute.names\` AS attribute_names, \`attribute.types\` AS attribute_types
		   FROM system.dictionaries
		  ORDER BY database, name`,
	).catch(() => [])) as unknown as DictionaryRow[];
	const dictionaryByName = new Map(dictionaryRows.map((row) => [key(row.database, row.name), row]));

	// Lineage is computed from the rows already read: no extra round trip, and the map holds both
	// ends of every materialized view (what it reads, what it writes, what a table feeds).
	const lineage = clickhouseLineage(tableRows);

	const tables: TableInfo[] = [];
	for (const row of tableRows) {
		const isView = VIEW_ENGINES.has(row.engine);
		const isDictionary = row.engine === DICTIONARY_ENGINE;
		if (isView && !includeViews) {
			continue;
		}
		tables.push({
			name: row.name,
			schema: row.database,
			kind: isView ? 'view' : isDictionary ? 'dictionary' : 'table',
			definition: isView && row.as_select ? row.as_select : undefined,
			viewEngine: isView ? row.engine : undefined,
			columns: columnsByTable.get(key(row.database, row.name)) ?? [],
			primaryKey: [],
			foreignKeys: [],
			indexes: indexesByTable.get(key(row.database, row.name)),
			lineage: lineage.get(lineageKey(row.database, row.name)),
			dictionary: isDictionary ? clickhouseDictionary(dictionaryByName.get(key(row.database, row.name)), row.create_table_query) : undefined,
			stats: isView || isDictionary ? undefined : {
				rowCount: toNumber(row.total_rows),
				totalBytes: toNumber(row.total_bytes),
				engine: engineLine(row),
			},
			comment: row.comment || undefined,
			createStatement: row.create_table_query || undefined,
		});
	}

	await readJsonPaths(run, tables);
	return { database: database ?? '', tables, fetchedAt: Date.now() };
}

/**
 * How many rows a JSON column's paths are read from. A `JSON` column's paths are in the DATA, so
 * the only way to offer `payload.user.id` in completion is to look; a bounded sample is the
 * difference between a cheap read and scanning a billion rows to fill a dropdown.
 */
const JSON_SAMPLE_ROWS = 1000;

/** And how many tables are sampled at all, so a schema full of JSON columns cannot turn one
 *  introspection into a hundred queries. */
const JSON_SAMPLE_TABLES = 20;

/**
 * Fill in the paths inside each `JSON` column, by asking the data. Best-effort in every direction:
 * a server too old for `JSONAllPaths`, a user refused the table, or a table that is simply empty
 * all leave the column with no paths, which is exactly what it had before.
 */
async function readJsonPaths(run: ClickHouseRowRunner, tables: TableInfo[]): Promise<void> {
	const targets: { table: TableInfo; column: ColumnInfo }[] = [];
	for (const table of tables) {
		if (table.kind !== 'table') {
			continue;
		}
		for (const column of table.columns) {
			if (hasDynamicPaths(column.dataType)) {
				targets.push({ table, column });
			}
		}
	}
	for (const { table, column } of targets.slice(0, JSON_SAMPLE_TABLES)) {
		const name = quoteClickHouseIdent(column.name);
		const ref = `${quoteClickHouseIdent(table.schema ?? '')}.${quoteClickHouseIdent(table.name)}`;
		const rows = (await run(
			`SELECT DISTINCT arrayJoin(JSONAllPaths(${name})) AS path
			   FROM (SELECT ${name} FROM ${ref} LIMIT ${JSON_SAMPLE_ROWS})
			  ORDER BY path LIMIT 500`,
		).catch(() => [])) as { path?: string }[];
		const paths = rows.map((row) => String(row.path ?? '')).filter(Boolean);
		if (paths.length > 0) {
			column.dynamicPaths = paths.map((path) => ({ name: path }));
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A ClickHouse table's ANATOMY: the physical shape of one MergeTree table, as its own page.
 *
 *  Every other database's table page is columns, keys and indexes. A MergeTree table's real
 *  behaviour is none of those: it is the order it is stored in, the partitions it is cut into,
 *  the parts inside each partition (which merges combine and which, past a limit, refuse an
 *  insert), the projections that answer a query instead of the table, and the data-skipping
 *  indexes that cross granules out. That is what someone tuning a ClickHouse table looks at, and
 *  until now the app showed none of it.
 *
 *  Pure, like `clickhouseOps.ts` beside it: the statements to run, the reading of an answer, and
 *  the sentence an action asks before it runs. `ClickHouseTableStorage.tsx` runs them.
 *
 *  Sizes are MB as numbers, not `formatReadableSize` text, so a column sorts by size and not
 *  alphabetically - the same rule the Operations panel follows.
 *--------------------------------------------------------------------------------------------*/

import { literal, quoteName } from './clickhouseOps';
import { findAtDepth, maskSql, splitAtDepth } from './engine';

/** One line of the engine header: `ORDER BY`, `PARTITION BY`, `TTL`. */
export interface AnatomyClause {
	readonly label: string;
	readonly value: string;
}

/** What a table IS, physically, before any of its rows are looked at. */
export interface EngineAnatomy {
	/** `MergeTree`, `ReplacingMergeTree`, `Distributed`, `Memory`. */
	engine: string;
	/** The whole engine clause as the server wrote it, for the cases the lines below leave out. */
	engineFull: string;
	/** ORDER BY / PRIMARY KEY / PARTITION BY / SAMPLE BY / TTL, each only when the table has one.
	 *  PRIMARY KEY is left out when it is the same as ORDER BY, which is the usual case and is
	 *  noise: it is only worth a line when the sparse index is SHORTER than the sort order. */
	clauses: AnatomyClause[];
	/** The table's own `SETTINGS`, split out of the engine clause. */
	settings: AnatomyClause[];
	storagePolicy: string;
	rows?: number;
	bytes?: number;
	/** Parts in all, and the ones that are still live. A gap between them is merges not yet
	 *  cleaned up, which is normal. */
	parts?: number;
	activeParts?: number;
	marks?: number;
	/** False for a Memory table, a Dictionary, a view: there are no parts, partitions or
	 *  projections to read, and the page says so rather than showing four empty lists. */
	isMergeTree: boolean;
}

/** A write a partition row offers. Always confirmed first, and always through the normal path, so
 *  it lands in query history and is caught by the production guard like any other statement. */
export interface PartitionAction {
	readonly id: 'optimize' | 'detach' | 'drop';
	readonly label: string;
	readonly icon: string;
	/** True for the ones that lose data if the person is wrong. */
	readonly danger: boolean;
	confirm(table: string, row: PartitionRow): string;
	sql(table: string, row: PartitionRow): string;
}

export interface PartitionRow {
	partition: string;
	partitionId: string;
	parts: number;
	rows: number;
	diskMb: number;
	rawMb: number;
	from?: string;
	to?: string;
	modified?: string;
}

/** `database.table`, each part quoted, for a statement that names the table. */
export function qualified(schema: string, table: string): string {
	return `${quoteName(schema)}.${quoteName(table)}`;
}

function where(schema: string, table: string): string {
	return `database = ${literal(schema)} AND table = ${literal(table)}`;
}

/** What the table is: read straight off `system.tables`, so nothing here is parsed that the
 *  server already broke out into a column. */
export function anatomySql(schema: string, table: string): string {
	return `SELECT engine, engine_full, partition_key, sorting_key, primary_key, sampling_key,
       storage_policy, total_rows, total_bytes, parts, active_parts, total_marks
FROM system.tables
WHERE database = ${literal(schema)} AND name = ${literal(table)}`;
}

/**
 * The partitions, largest first, with what is inside each.
 *
 * `active` only: an inactive part is one a merge has already replaced and the server has not yet
 * deleted, and counting it would say a partition holds its rows twice.
 */
export function partitionsSql(schema: string, table: string): string {
	return `SELECT partition, any(partition_id) AS partition_id, count() AS parts, sum(rows) AS rows,
       round(sum(bytes_on_disk) / 1048576, 2) AS on_disk_mb,
       round(sum(data_uncompressed_bytes) / 1048576, 2) AS raw_mb,
       min(min_time) AS covers_from, max(max_time) AS covers_to, max(modification_time) AS last_written
FROM system.parts
WHERE ${where(schema, table)} AND active
GROUP BY partition
ORDER BY partition DESC`;
}

/**
 * The projections: a second copy of the table kept in a different order or pre-aggregated, which
 * ClickHouse reads INSTEAD of the table when it answers the query for less.
 *
 * `system.projections` is 24.x and later. On an older server the read fails and the section says
 * so in one sentence rather than looking broken.
 */
export function projectionsSql(schema: string, table: string): string {
	// A LEFT JOIN onto an aggregate, not a correlated subquery in the SELECT list: ClickHouse's
	// scalar subqueries cannot reach a column of the outer query.
	return `SELECT p.name AS name, p.type AS type, arrayStringConcat(p.sorting_key, ', ') AS sorting_key,
       s.parts AS parts, s.rows AS rows, s.on_disk_mb AS on_disk_mb, p.query AS query
FROM system.projections AS p
LEFT JOIN (
  SELECT name, count() AS parts, sum(rows) AS rows, round(sum(bytes_on_disk) / 1048576, 2) AS on_disk_mb
  FROM system.projection_parts
  WHERE ${where(schema, table)} AND active
  GROUP BY name
) AS s ON s.name = p.name
WHERE p.database = ${literal(schema)} AND p.table = ${literal(table)}
ORDER BY p.name`;
}

/** The data-skipping indexes and what each one takes on disk. ClickHouse has no B-tree: these are
 *  what crosses a granule out for a column that is not in the sort key. */
export function skipIndexSql(schema: string, table: string): string {
	return `SELECT name, type_full AS type, expr AS expression, granularity AS granules_per_entry,
       round(data_compressed_bytes / 1048576, 3) AS on_disk_mb,
       round(data_uncompressed_bytes / 1048576, 3) AS raw_mb
FROM system.data_skipping_indices
WHERE ${where(schema, table)}
ORDER BY name`;
}

/** The engines whose data lives in parts on disk, which is what the partition / projection /
 *  skip-index sections describe. Everything else (Memory, Distributed, a Dictionary, a view) has
 *  no such thing, and the page says that instead of showing empty lists. */
export function isMergeTreeEngine(engine: string): boolean {
	return /MergeTree$/.test(engine);
}

/** Read one `system.tables` row into the header. */
export function readAnatomy(row: Record<string, unknown>): EngineAnatomy {
	const engine = text(row.engine);
	const engineFull = text(row.engine_full);
	const sorting = text(row.sorting_key);
	const primary = text(row.primary_key);
	const clauses: AnatomyClause[] = [];
	push(clauses, 'PARTITION BY', text(row.partition_key));
	push(clauses, 'ORDER BY', sorting);
	// Only when the sparse index is a PREFIX of the sort order rather than all of it: saying
	// "PRIMARY KEY (a, b)" under "ORDER BY (a, b)" teaches nobody anything.
	push(clauses, 'PRIMARY KEY', primary === sorting ? '' : primary);
	push(clauses, 'SAMPLE BY', text(row.sampling_key));
	push(clauses, 'TTL', ttlOf(engineFull));
	return {
		engine,
		engineFull,
		clauses,
		settings: settingsOf(engineFull),
		storagePolicy: text(row.storage_policy),
		rows: count(row.total_rows),
		bytes: count(row.total_bytes),
		parts: count(row.parts),
		activeParts: count(row.active_parts),
		marks: count(row.total_marks),
		isMergeTree: isMergeTreeEngine(engine),
	};
}

function push(into: AnatomyClause[], label: string, value: string): void {
	if (value !== '') {
		into.push({ label, value });
	}
}

/**
 * The `TTL ...` in the engine clause, which `system.tables` does not break out into a column of
 * its own the way it does the keys. It runs to the trailing `SETTINGS` or to the end.
 */
export function ttlOf(engineFull: string): string {
	const masked = maskSql(engineFull);
	const at = findAtDepth(masked, /\bTTL\s/gi, 0, engineFull.length, 0);
	if (at < 0) {
		return '';
	}
	const settings = findAtDepth(masked, /\bSETTINGS\s/gi, at, engineFull.length, 0);
	return engineFull.slice(at + 4, settings < 0 ? engineFull.length : settings).trim();
}

/** The trailing `SETTINGS a = 1, b = 2`, split into pairs. A value can hold a comma of its own
 *  (`storage_policy = 'hot, cold'`), which is why the split is at the top level and not on `,`. */
export function settingsOf(engineFull: string): AnatomyClause[] {
	const masked = maskSql(engineFull);
	const at = findAtDepth(masked, /\bSETTINGS\s/gi, 0, engineFull.length, 0);
	if (at < 0) {
		return [];
	}
	const out: AnatomyClause[] = [];
	for (const span of splitAtDepth(masked, at + 9, engineFull.length, 0)) {
		const pair = engineFull.slice(span.start, span.end);
		const eq = pair.indexOf('=');
		if (eq > 0) {
			out.push({ label: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
		}
	}
	return out;
}

/**
 * What a partition row offers.
 *
 * OPTIMIZE is first and is the one worth reaching for: it merges a partition's parts into one
 * now instead of waiting, which is the answer to "this partition has 582 parts". DETACH moves the
 * data out of the table but leaves it on disk, so it can be put back; DROP does not.
 */
export const PARTITION_ACTIONS: readonly PartitionAction[] = [
	{
		id: 'optimize',
		label: 'Merge now',
		icon: 'merge',
		danger: false,
		confirm: (table, row) =>
			`Merge partition ${row.partition} of ${table} into one part now? It holds ${row.parts.toLocaleString()} parts and ${row.rows.toLocaleString()} rows, and merging them reads and rewrites all ${row.diskMb.toLocaleString()} MB. ClickHouse would do this on its own eventually.`,
		// PARTITION ID '<id>', never the displayed partition expression: the display form of a
		// tuple partition key is `('gb', 2026)` and quoting that back correctly is a parser we do
		// not need, while the id is exact and is a plain string.
		sql: (table, row) => `OPTIMIZE TABLE ${table} PARTITION ID ${literal(row.partitionId)} FINAL`,
	},
	{
		id: 'detach',
		label: 'Detach',
		icon: 'debug-disconnect',
		danger: true,
		confirm: (table, row) =>
			`Detach partition ${row.partition} of ${table}? Its ${row.rows.toLocaleString()} rows leave the table at once. The files stay on disk under detached/, so ATTACH PARTITION puts them back.`,
		sql: (table, row) => `ALTER TABLE ${table} DETACH PARTITION ID ${literal(row.partitionId)}`,
	},
	{
		id: 'drop',
		label: 'Drop',
		icon: 'trash',
		danger: true,
		confirm: (table, row) =>
			`Drop partition ${row.partition} of ${table}? This deletes ${row.rows.toLocaleString()} rows and ${row.diskMb.toLocaleString()} MB, and it cannot be undone.`,
		sql: (table, row) => `ALTER TABLE ${table} DROP PARTITION ID ${literal(row.partitionId)}`,
	},
];

/** The plain sentence for an error that only means "this server has not got that system table",
 *  which is a version fact and not a failure. */
export function missingSystemTable(error: string): boolean {
	return /UNKNOWN_TABLE|doesn't exist|does not exist/i.test(error);
}

function text(value: unknown): string {
	return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * A cell as a number, whether the engine sent a number or (for a 64-bit value) its digits.
 *
 * NULL stays undefined and does NOT become 0. `system.tables.total_rows` is NULL for a Dictionary
 * and for a materialized view, and `Number(null)` is 0, so the obvious version of this reports
 * that those tables hold no rows - which is not what the server said.
 */
function count(value: unknown): number | undefined {
	if (value === null || value === undefined || value === '') {
		return undefined;
	}
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Partitions, and SnoutTime series tables, for the Postgres introspection.
 *
 * Two facts the explorer and the AI prompt had no way to know: that a table is a partition of
 * another (so `metrics_p20260921` is not a table somebody should query), and that a partitioned
 * table is a SnoutTime series (so it has a time column, sealed partitions and rollups).
 *
 * The partition list is plain catalog reads, asked of every Postgres. SnoutTime's views are asked
 * only when `pg_extension` says it is installed, so a database without it sees one extra
 * catalog row lookup and no failing statement in its log. Everything SnoutTime reports is the
 * planner's estimate; nothing here scans a table.
 *
 * Reading is split from assembling: `attachSeries` is pure, and is what the tests drive.
 */

import type { SchemaRef, SeriesInfo, SeriesPartition, SeriesPartitionState, TableInfo } from '../../../../shared/schema';

/** What the reader needs from a pool: a query that resolves to rows, and swallows its own errors. */
export type OptionalQuery = (sql: string) => Promise<{ rows: unknown[] }>;

export interface PartitionRow {
	parent_schema: string;
	parent_name: string;
	table_schema: string;
	table_name: string;
}

/** A row of `snouttime.series_info` or `partition_info`, as `to_jsonb`, so a column an older
 *  build of the extension lacks is merely absent rather than a failed query. */
export interface SeriesRow {
	table_schema: string;
	table_name: string;
	info: Record<string, unknown>;
}

export interface PartitionInfoRow extends SeriesRow {
	series_schema: string;
	series_name: string;
}

export interface RollupRow {
	table_schema: string;
	table_name: string;
	store_schema?: string;
	store_name?: string;
	source_schema: string;
	source_name: string;
	bucket: string;
}

export interface SeriesRows {
	partitions: PartitionRow[];
	version?: string;
	/** Not installed, but the server carries it: the designer offers to switch it on. */
	available?: boolean;
	series: SeriesRow[];
	partitionInfo: PartitionInfoRow[];
	rollups: RollupRow[];
}

export async function readSeries(query: OptionalQuery): Promise<SeriesRows> {
	const partitions = (await query(
		`SELECT pn.nspname AS parent_schema, p.relname AS parent_name, n.nspname AS table_schema, c.relname AS table_name
		 FROM pg_inherits i
		 JOIN pg_class c ON c.oid = i.inhrelid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 JOIN pg_class p ON p.oid = i.inhparent
		 JOIN pg_namespace pn ON pn.oid = p.relnamespace
		 WHERE c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
	)).rows as PartitionRow[];
	const ext = (await query(`SELECT extversion FROM pg_extension WHERE extname = 'snouttime'`)).rows as { extversion: string }[];
	const version = ext[0]?.extversion;
	if (!version) {
		const available = (await query(`SELECT 1 FROM pg_available_extensions WHERE name = 'snouttime'`)).rows.length > 0;
		return { partitions, available, series: [], partitionInfo: [], rollups: [] };
	}
	const series = (await query(
		`SELECT n.nspname AS table_schema, c.relname AS table_name, to_jsonb(s) AS info
		 FROM snouttime.series_info s
		 JOIN pg_class c ON c.oid = s.series
		 JOIN pg_namespace n ON n.oid = c.relnamespace`,
	)).rows as SeriesRow[];
	const partitionInfo = (await query(
		`SELECT sn.nspname AS series_schema, sc.relname AS series_name,
		        n.nspname AS table_schema, c.relname AS table_name, to_jsonb(p) AS info
		 FROM snouttime.partition_info p
		 JOIN pg_class c ON c.oid = p.partition
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 JOIN pg_class sc ON sc.oid = p.series
		 JOIN pg_namespace sn ON sn.oid = sc.relnamespace
		 ORDER BY p.range_start NULLS FIRST, c.relname`,
	)).rows as PartitionInfoRow[];
	const rollups = (await query(
		`SELECT n.nspname AS table_schema, c.relname AS table_name,
		        sn.nspname AS source_schema, sc.relname AS source_name,
		        coalesce(r.bucket_interval::text, r.bucket_width::text) AS bucket,
		        mn.nspname AS store_schema, mc.relname AS store_name
		 FROM snouttime.rollups r
		 JOIN pg_class c ON c.oid = r.relid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 JOIN pg_class mc ON mc.oid = r.materialized
		 JOIN pg_namespace mn ON mn.oid = mc.relnamespace
		 JOIN pg_class sc ON sc.oid = r.source
		 JOIN pg_namespace sn ON sn.oid = sc.relnamespace
		 ORDER BY r.bucket_interval NULLS LAST, r.bucket_width NULLS LAST, c.relname`,
	)).rows as RollupRow[];
	return { partitions, version, series, partitionInfo, rollups };
}

function key(schema: string | undefined, name: string): string {
	return `${schema ?? ''}.${name}`;
}

function num(v: unknown): number | undefined {
	if (v == null || v === '') {
		return undefined;
	}
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
	return v == null || v === '' ? undefined : String(v);
}

/**
 * An interval as Postgres prints it (`01:00:00`, `1 day`, `00:05:00`, `1 mon`) in words (`1 hour`,
 * `1 day`, `5 minutes`, `1 month`), for the tree, the designer and the prompt. Still a valid
 * interval literal, which the rollup monitor's SQL relies on. Integer bucket widths, and any
 * shape not recognised here, come back unchanged.
 */
export function readableInterval(text: string): string {
	const units: [RegExp, string][] = [[/\byears?\b/, 'year'], [/\bmons?\b/, 'month'], [/\bdays?\b/, 'day']];
	const parts: string[] = [];
	let rest = text.trim();
	if (/^-?\d+$/.test(rest)) {
		return text;
	}
	for (const [re, unit] of units) {
		const m = new RegExp(`(-?\\d+)\\s*${re.source}`).exec(rest);
		if (m) {
			parts.push(plural(Number(m[1]), unit));
			rest = rest.replace(m[0], '').trim();
		}
	}
	if (rest !== '') {
		const clock = /^(-?)(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(rest);
		if (!clock) {
			return text;
		}
		const [h, m, sec] = [Number(clock[2]), Number(clock[3]), Number(clock[4])];
		if (h) { parts.push(plural(h, 'hour')); }
		if (m) { parts.push(plural(m, 'minute')); }
		if (sec) { parts.push(plural(sec, 'second')); }
	}
	return parts.length > 0 ? parts.join(' ') : text;
}

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

const STATES: readonly SeriesPartitionState[] = ['live', 'sealed', 'tiered', 'default', 'foreign', 'spread'];

/**
 * Marks partitions and fills in series and rollups on `tables`, in place. A partitioned parent
 * has no storage of its own, so a series parent's stats are replaced by the whole tree's.
 * Returns the extension version, for `DatabaseSchema.snouttime`.
 */
export function attachSeries(tables: TableInfo[], rows: SeriesRows): string | undefined {
	const byKey = new Map(tables.map((t) => [key(t.schema, t.name), t]));
	for (const row of rows.partitions) {
		const table = byKey.get(key(row.table_schema, row.table_name));
		if (table) {
			table.partitionOf = { schema: row.parent_schema, name: row.parent_name };
		}
	}
	if (!rows.version) {
		return undefined;
	}

	const partitionsBySeries = new Map<string, SeriesPartition[]>();
	for (const row of rows.partitionInfo) {
		const state = str(row.info.state) as SeriesPartitionState | undefined;
		const k = key(row.series_schema, row.series_name);
		const list = partitionsBySeries.get(k) ?? [];
		list.push({
			schema: row.table_schema,
			name: row.table_name,
			state: state && STATES.includes(state) ? state : 'foreign',
			rangeStart: str(row.info.range_start),
			rangeEnd: str(row.info.range_end),
			estimatedRows: num(row.info.estimated_rows),
			bytes: num(row.info.bytes),
			bytesBefore: num(row.info.bytes_before),
		});
		partitionsBySeries.set(k, list);
	}

	const rollupsBySource = new Map<string, SeriesInfo['rollups']>();
	for (const row of rows.rollups) {
		const source: SchemaRef = { schema: row.source_schema, name: row.source_name };
		const k = key(row.source_schema, row.source_name);
		const list = rollupsBySource.get(k) ?? [];
		const bucket = readableInterval(row.bucket);
		list.push({ schema: row.table_schema, name: row.table_name, bucket });
		rollupsBySource.set(k, list);
		const view = byKey.get(key(row.table_schema, row.table_name));
		if (view) {
			view.rollup = { source, bucket };
		}
		const store = row.store_name ? byKey.get(key(row.store_schema, row.store_name)) : undefined;
		if (store) {
			store.rollupStoreOf = { schema: row.table_schema, name: row.table_name };
		}
	}

	for (const row of rows.series) {
		const k = key(row.table_schema, row.table_name);
		const table = byKey.get(k);
		if (!table) {
			continue;
		}
		const i = row.info;
		table.series = {
			timeColumn: String(i.time_column ?? ''),
			timeType: String(i.time_type ?? ''),
			partitionSize: String(i.partition_size ?? ''),
			spaceColumn: str(i.space_column),
			spacePartitions: num(i.space_partitions),
			retention: str(i.retention),
			estimatedRows: num(i.estimated_rows),
			bytes: num(i.bytes),
			sealedBytes: num(i.sealed_bytes),
			sealedBytesBefore: num(i.sealed_bytes_before),
			partitions: partitionsBySeries.get(k) ?? [],
			rollups: rollupsBySource.get(k) ?? [],
		};
		// the parent's own zeros (a partitioned table has no storage) would read as "0 B data"
		table.stats = { ...table.stats, rowCount: table.series.estimatedRows, totalBytes: table.series.bytes, dataBytes: undefined, indexBytes: undefined };
	}
	return rows.version;
}

/** How much smaller sealing made a series, as a factor (7.9 for 7.9×), when it can be said. */
export function sealRatio(before: number | undefined, after: number | undefined): number | undefined {
	return before && after && before > 0 && after > 0 ? before / after : undefined;
}

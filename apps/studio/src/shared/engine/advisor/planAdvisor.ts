/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// EXPLAIN plan advisor (query advisor, Pillar 2 Tier B). Reads the JSON execution plan a database
// returns for a query (via `Dialect.explainJson`) and flags the patterns that make large-dataset
// queries slow: full/sequential table scans, large estimated row counts, filesorts and temp tables.
//
// Triggered POST-RUN on a slow query (App.tsx, gated on `slowQueryAdviseMs`) — never on keystrokes,
// and only one EXPLAIN round-trip. Deterministic + local (no model): it parses the plan the engine
// already produced. Pure/node-testable; the vendor plan shapes (Postgres vs MySQL) are handled here
// rather than on the Dialect so all the plan-parsing knowledge lives in one place.

import type { TableInfo } from '../../schema';
import type { Advisory, AdvisoryKind } from './types';

export interface PlanAdvisorOptions {
	/** Below this estimated-rows floor a scan is too small to be worth flagging. Default 1000. */
	minRowsToWarn?: number;
	/** At/above this estimated-rows count a scan is called out as large (stronger wording). Default 50000. */
	largeRowsThreshold?: number;
	/** A table's row count from the schema, by its unqualified name, where known. A full scan reads
	 *  all of it, so this is the exact size of one; the plan alone gives only granules. */
	tableRows?(table: string): number | undefined;
	/** The statement the plan is for, for what a plan does not show (ClickHouse's FINAL). */
	sql?: string;
	/** Where a table sits in a partition tree, by its unqualified name; {@link partitionIndex}
	 *  builds it from a schema. Without it a plan over partitions is read as unrelated tables. */
	partition?(table: string): PartitionPlace | undefined;
}

/** A leaf partition's root table, how many leaves that root has, and its time column if it is
 *  a SnoutTime series. */
export interface PartitionPlace {
	root: string;
	leaves: number;
	timeColumn?: string;
	/** The table's rows, from catalog statistics: what reading every partition READS. A plan's own
	 *  row counts are what each scan RETURNS after its filter, so `WHERE cpu > 95` over every
	 *  partition looked like a few hundred rows and was never flagged (2026-09-24). */
	rows?: number;
}

/**
 * Where each partition sits, from a schema's `partitionOf` links. A space-partitioned series is
 * two levels deep (series → day → hash leaf), so a leaf is resolved to its ROOT and counted
 * against the root's leaves: those are the tables a plan scans.
 */
export function partitionIndex(tables: TableInfo[]): (table: string) => PartitionPlace | undefined {
	const parentOf = new Map<string, string>();
	const parents = new Set<string>();
	for (const t of tables) {
		if (t.partitionOf) {
			parentOf.set(t.name, t.partitionOf.name);
			parents.add(t.partitionOf.name);
		}
	}
	if (parentOf.size === 0) {
		return () => undefined;
	}
	const rootOf = (name: string): string => {
		let at = name;
		for (let hops = 0; hops < 8 && parentOf.has(at); hops++) {
			at = parentOf.get(at)!;
		}
		return at;
	};
	const leavesByRoot = new Map<string, number>();
	for (const name of parentOf.keys()) {
		if (!parents.has(name)) {
			const root = rootOf(name);
			leavesByRoot.set(root, (leavesByRoot.get(root) ?? 0) + 1);
		}
	}
	const timeOf = new Map(tables.filter((t) => t.series).map((t) => [t.name, t.series!.timeColumn]));
	// A series parent carries the whole tree's statistics; a plain partitioned parent has none of
	// its own, so its leaves are added up. The larger of the two is what is there.
	const leafRows = new Map<string, number>();
	const ownRows = new Map<string, number>();
	for (const t of tables) {
		const n = t.stats?.rowCount;
		if (n === undefined || n < 0) {
			continue;
		}
		if (parentOf.has(t.name) && !parents.has(t.name)) {
			const root = rootOf(t.name);
			leafRows.set(root, (leafRows.get(root) ?? 0) + n);
		} else if (!parentOf.has(t.name)) {
			ownRows.set(t.name, n);
		}
	}
	return (table) => {
		if (!parentOf.has(table) || parents.has(table)) {
			return undefined;
		}
		const root = rootOf(table);
		const known = [ownRows.get(root), leafRows.get(root)].filter((n): n is number => n !== undefined);
		return { root, leaves: leavesByRoot.get(root) ?? 0, timeColumn: timeOf.get(root), rows: known.length > 0 ? Math.max(...known) : undefined };
	};
}

const DEFAULTS = { minRowsToWarn: 1000, largeRowsThreshold: 50000 };

type ResolvedOptions = PlanAdvisorOptions & typeof DEFAULTS;

/**
 * Analyse a query's execution plan and return advisories. `cell` is the single plan value the EXPLAIN
 * returned (a parsed object for Postgres' json column, or a JSON string for MySQL) — both accepted.
 * Returns [] for an unsupported driver, an unparseable plan, or a plan with nothing worth flagging.
 * Never throws.
 */
export function analyzePlan(driver: string | undefined, cell: unknown, options?: PlanAdvisorOptions): Advisory[] {
	const opts = { ...DEFAULTS, ...options };
	const plan = coerceJson(cell);
	if (plan === undefined) {
		return [];
	}
	try {
		switch (driver) {
			case 'postgres':
				return analyzePostgres(plan, opts);
			case 'mysql-aurora':
			case 'mariadb':
				return analyzeMysql(plan, opts);
			case 'clickhouse':
				return analyzeClickHouse(plan, opts);
			default:
				return [];
		}
	} catch {
		return []; // a plan shape we didn't expect — stay silent rather than mislead
	}
}

/** A parsed object either passed through (PG json column) or JSON.parse'd (MySQL string). */
function coerceJson(cell: unknown): unknown {
	if (cell == null) {
		return undefined;
	}
	if (typeof cell === 'string') {
		try {
			return JSON.parse(cell);
		} catch {
			return undefined;
		}
	}
	return cell;
}

// ---- Postgres: EXPLAIN (FORMAT JSON) → [ { "Plan": { "Node Type", "Relation Name", "Plan Rows", "Plans": [...] } } ]

interface PgNode {
	'Node Type'?: string;
	'Relation Name'?: string;
	'Plan Rows'?: number;
	'Plans'?: PgNode[];
	'Plan'?: PgNode;
}

function analyzePostgres(plan: unknown, opts: ResolvedOptions): Advisory[] {
	const root = Array.isArray(plan) ? (plan[0] as PgNode | undefined)?.Plan : (plan as PgNode).Plan;
	if (!root) {
		return [];
	}
	const out: Advisory[] = [];
	const seen = new Set<string>();
	const scanned = new Map<string, PartitionHit>();
	walkPg(root, out, seen, opts, scanned);
	for (const [rootTable, hit] of scanned) {
		// one cause, one advisory: all partitions read says more than "a scan of the table"
		if (!pushPartitionScan(out, seen, rootTable, hit.place, hit.leaves.size, hit.rows, opts) && hit.seqRows > 0) {
			pushScan(out, seen, rootTable, hit.seqRows, opts);
		}
	}
	return out;
}

/** What a plan read of one partitioned table: which leaves, their rows, and how many of those
 *  rows came from sequential scans. */
interface PartitionHit {
	place: PartitionPlace;
	leaves: Set<string>;
	rows: number;
	seqRows: number;
}

/**
 * Every leaf of a partitioned table was read, so nothing in the query let Postgres skip one. On
 * a SnoutTime series that is the one mistake that makes it slow however it is stored: the time
 * filter is missing, or wraps the time column in a function the planner cannot prune through.
 * Replaces the per-partition full-scan advisories, which would name thirty tables for one cause.
 */
function pushPartitionScan(out: Advisory[], seen: Set<string>, table: string, place: PartitionPlace, read: number, returned: number, opts: ResolvedOptions): boolean {
	// Sized by what is READ, which the statistics know and the plan does not (see PartitionPlace.rows).
	const rows = Math.max(returned, place.rows ?? 0);
	if (place.leaves < 2 || read < place.leaves || rows < opts.minRowsToWarn) {
		return false;
	}
	const time = place.timeColumn;
	pushKind(out, seen, 'partition-scan', table, rows,
		`Reads all ${place.leaves} partitions of ${table} (~${formatRows(rows)} rows): nothing in the query lets the database skip one.`,
		time
			? `${table} is a series table partitioned by ${time}. Filter on ${time} with a range the planner can compare directly (${time} >= now() - interval '1 day', or a literal range), never on a function or cast of ${time}, so it reads only the partitions in that range.`
			: `${table} is partitioned. A filter on its partition key, compared directly rather than through a function or cast, lets the planner skip the partitions outside it.`);
	return true;
}

function walkPg(node: PgNode, out: Advisory[], seen: Set<string>, opts: ResolvedOptions, scanned: Map<string, PartitionHit>): void {
	const type = node['Node Type'] ?? '';
	const rows = node['Plan Rows'];
	const relation = node['Relation Name'];
	const place = relation ? opts.partition?.(relation) : undefined;
	if (place && relation) {
		// Named after the table the user queried, once, after the walk (analyzePostgres).
		const hit = scanned.get(place.root) ?? { place, leaves: new Set<string>(), rows: 0, seqRows: 0 };
		if (!hit.leaves.has(relation)) {
			hit.leaves.add(relation);
			hit.rows += rows ?? 0;
			if (type === 'Seq Scan') {
				hit.seqRows += rows ?? 0;
			}
		}
		scanned.set(place.root, hit);
	} else if (type === 'Seq Scan') {
		// A Seq Scan READS the whole table; `Plan Rows` is what it RETURNS after the filter. Sizing
		// the warning by the second missed the trap it exists for: `WHERE date(created_at) = …` on
		// 3M rows returns ~15k by estimate, reads all 3M, and never warned. The table's own row
		// count (from the statistics) is the size of the read whenever it is known.
		const read = relation ? opts.tableRows?.(relation) : undefined;
		pushScan(out, seen, relation, read !== undefined ? Math.max(read, rows ?? 0) : rows, opts);
	} else if (type === 'Sort') {
		pushKind(out, seen, 'filesort', undefined, rows,
			'The plan sorts rows that aren\'t already ordered by an index (an in-memory/disk sort).',
			'Add an index whose leading columns match the ORDER BY so the engine reads rows in order instead of sorting them.');
	}
	for (const child of node.Plans ?? []) {
		walkPg(child, out, seen, opts, scanned);
	}
}

// ---- MySQL / MariaDB: EXPLAIN FORMAT=JSON → { "query_block": { "table" | "nested_loop" | "ordering_operation" ... } }

interface MyTable {
	table_name?: string;
	access_type?: string; // ALL = full scan; index = full index scan; ref/eq_ref/range = index used
	rows_examined_per_scan?: number;
	using_filesort?: boolean;
	using_temporary_table?: boolean;
}

function analyzeMysql(plan: unknown, opts: ResolvedOptions): Advisory[] {
	const qb = (plan as { query_block?: unknown }).query_block;
	if (!qb) {
		return [];
	}
	const out: Advisory[] = [];
	const seen = new Set<string>();
	walkMy(qb, out, seen, opts);
	return out;
}

function walkMy(node: unknown, out: Advisory[], seen: Set<string>, opts: ResolvedOptions): void {
	if (!node || typeof node !== 'object') {
		return;
	}
	const obj = node as Record<string, unknown>;
	// A table node: check its access type + flags.
	const table = obj.table as MyTable | undefined;
	if (table && typeof table === 'object') {
		inspectMyTable(table, out, seen, opts);
	}
	// Ordering/grouping operations carry filesort/temp flags and may nest a table.
	for (const key of ['ordering_operation', 'grouping_operation', 'duplicates_removal']) {
		const op = obj[key] as Record<string, unknown> | undefined;
		if (op && typeof op === 'object') {
			if (op.using_filesort === true) {
				pushKind(out, seen, 'filesort', undefined, undefined,
					'The plan uses a filesort (rows aren\'t read in the required order from an index).',
					'Add a composite index whose columns cover the WHERE equality columns then the ORDER BY column, so one index serves both.');
			}
			if (op.using_temporary_table === true) {
				pushKind(out, seen, 'temp-table', undefined, undefined,
					'The plan materialises an internal temporary table.',
					'A GROUP BY/DISTINCT/UNION that can\'t use an index builds a temp table; an index matching the grouping columns often removes it.');
			}
			walkMy(op, out, seen, opts);
		}
	}
	// nested_loop is an array of { table: ... } join steps.
	const nested = obj.nested_loop;
	if (Array.isArray(nested)) {
		for (const step of nested) {
			walkMy(step, out, seen, opts);
		}
	}
	// Subqueries / derived tables nest their own query_block.
	if (obj.query_block) {
		walkMy(obj.query_block, out, seen, opts);
	}
	if (table && typeof table === 'object' && (table as Record<string, unknown>).materialized_from_subquery) {
		walkMy((table as Record<string, unknown>).materialized_from_subquery, out, seen, opts);
	}
}

function inspectMyTable(table: MyTable, out: Advisory[], seen: Set<string>, opts: ResolvedOptions): void {
	const rows = table.rows_examined_per_scan;
	if (table.access_type === 'ALL') {
		pushScan(out, seen, table.table_name, rows, opts);
	}
	if (table.using_filesort === true) {
		pushKind(out, seen, 'filesort', table.table_name, rows,
			'The plan uses a filesort on this table (rows aren\'t read in order from an index).',
			'Add a composite index covering the WHERE equality columns then the ORDER BY column.');
	}
	if (table.using_temporary_table === true) {
		pushKind(out, seen, 'temp-table', table.table_name, rows,
			'The plan materialises an internal temporary table for this step.',
			'An index matching the grouping/join columns often removes the temp table.');
	}
}

// ---- ClickHouse: EXPLAIN json = 1, indexes = 1 → [ { "Plan": { "Node Type", "Plans", "Indexes" } } ]
//
// ClickHouse has no B-tree to miss. What it has is GRANULE PRUNING: a MergeTree read starts from
// every granule (8192 rows by default) and each index in turn (partition min-max, the ORDER BY key,
// any skip index) crosses some out. A read whose last index still selects every granule it started
// with read the whole table, and that, not a missing index, is the thing worth telling someone.

/** Rows per granule, ClickHouse's default `index_granularity`. Only used to size a warning when the
 *  table's own row count is not known: a table with a custom granularity (or adaptive granules)
 *  makes this wrong, which is why the schema's count is preferred. */
const GRANULE_ROWS = 8192;

interface ChNode {
	'Node Type'?: string;
	'Description'?: string;
	'Plans'?: ChNode[];
	'Plan'?: ChNode;
	'Indexes'?: { 'Type'?: string; 'Initial Granules'?: number; 'Selected Granules'?: number }[];
}

function analyzeClickHouse(plan: unknown, opts: ResolvedOptions): Advisory[] {
	const root = Array.isArray(plan) ? (plan[0] as ChNode | undefined)?.Plan : (plan as ChNode).Plan;
	if (!root) {
		return [];
	}
	const out: Advisory[] = [];
	const seen = new Set<string>();
	const tables: string[] = [];
	walkCh(root, out, seen, opts, tables);
	flagFinal(out, seen, opts, tables);
	return out;
}

/**
 * FINAL leaves no mark on the plan, so it is found in the statement: outside strings and comments,
 * after a FROM target. Flagged only for a table big enough for a read-time merge to cost.
 */
function flagFinal(out: Advisory[], seen: Set<string>, opts: ResolvedOptions, tables: string[]): void {
	const sql = (opts.sql ?? '').replace(/'(?:[^'\\]|\\.)*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
	if (!/\bFINAL\b/i.test(sql)) {
		return;
	}
	for (const table of new Set(tables)) {
		const rows = opts.tableRows?.(table);
		// `events FINAL`, `db.events AS e FINAL`, `` `events` FINAL ``.
		const final = new RegExp(`\\b${table.replace(/\W/g, '')}[\`"]?(?:\\s+(?:AS\\s+)?\\w+)?\\s+FINAL\\b`, 'i');
		if (rows === undefined || rows < opts.largeRowsThreshold || !final.test(sql)) {
			continue;
		}
		pushKind(out, seen, 'final', table, rows,
			`FINAL on ${table} (${formatRows(rows)} rows) merges its parts while the query reads them.`,
			'FINAL collapses duplicate rows at read time, which on a large table costs far more than the query itself. Filter first so less is merged, or deduplicate in the query instead (argMax(value, version) ... GROUP BY key); do_not_merge_across_partitions_select_final = 1 helps when the key never crosses partitions.');
	}
}

function walkCh(node: ChNode, out: Advisory[], seen: Set<string>, opts: ResolvedOptions, tables: string[]): void {
	if (node['Node Type'] === 'ReadFromMergeTree' && node.Indexes && node.Indexes.length > 0) {
		const first = node.Indexes[0]['Initial Granules'];
		const last = node.Indexes[node.Indexes.length - 1]['Selected Granules'];
		// A table read says `database.table`; a read answered from a projection names the projection.
		const description = node.Description ?? '';
		const fromProjection = description !== '' && !description.includes('.');
		const table = fromProjection ? undefined : description.split('.').pop();
		if (table) {
			tables.push(table);
		}
		if (fromProjection && typeof first === 'number' && typeof last === 'number') {
			pushKind(out, seen, 'projection', description, undefined,
				`Answered from projection ${description}: ${last.toLocaleString()} of ${first.toLocaleString()} granules read.`,
				'A projection is a copy of the table kept in a different order or pre-aggregated, and ClickHouse used it because it reads less than the table would. Nothing to do: this is the lever working.');
		}
		if (!fromProjection && typeof first === 'number' && typeof last === 'number' && first > 0 && last >= first) {
			// Every granule was read, so the whole table was: its own row count is exact.
			const known = table ? opts.tableRows?.(table) : undefined;
			const rows = known ?? first * GRANULE_ROWS;
			if (rows >= opts.minRowsToWarn) {
				const large = rows >= opts.largeRowsThreshold;
				pushKind(out, seen, large ? 'large-scan' : 'full-scan', table, rows,
					`Full scan${table ? ` of ${table}` : ''}: all ${first.toLocaleString()} granules (${known === undefined ? '~' : ''}${formatRows(rows)} rows) were read, none skipped.`,
					'ClickHouse skips data by the table\'s ORDER BY key and its partition key, not by an index on any column. This filter narrowed neither, so every granule was read. Filter on a leading column of the ORDER BY key (the first one first), or on the partition key; for a column outside the key, a data-skipping index (bloom_filter, set, minmax) or a projection ordered by it is the lever.');
			}
		}
	}
	for (const child of node.Plans ?? []) {
		walkCh(child, out, seen, opts, tables);
	}
}

// ---- shared emit helpers -------------------------------------------------------------------

function pushScan(out: Advisory[], seen: Set<string>, table: string | undefined, rows: number | undefined, opts: ResolvedOptions): void {
	if (rows !== undefined && rows < opts.minRowsToWarn) {
		return; // scanning a small table is fine
	}
	const large = rows !== undefined && rows >= opts.largeRowsThreshold;
	const where = table ? ` of ${table}` : '';
	const rowsText = rows !== undefined ? ` (~${formatRows(rows)} rows)` : '';
	pushKind(out, seen, large ? 'large-scan' : 'full-scan', table, rows,
		`Full table scan${where}${rowsText}: no index is used to narrow the rows.`,
		'The engine reads every row because no index matches the query\'s filter or join. Add an index on the column(s) in the WHERE/JOIN, or make the predicate sargable (see the inline hints), so the query touches only the rows it needs.');
}

function pushKind(out: Advisory[], seen: Set<string>, kind: AdvisoryKind, table: string | undefined, rows: number | undefined, message: string, rationale: string): void {
	const key = `${kind}|${table ?? ''}`;
	if (seen.has(key)) {
		return;
	}
	seen.add(key);
	const level = kind === 'large-scan' || kind === 'full-scan' || kind === 'final' || kind === 'partition-scan' ? 'warn' : 'info';
	out.push({ level, kind, table, message, rows, rationale });
}

function formatRows(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(0)}k`;
	}
	return String(Math.round(n));
}

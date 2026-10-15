/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TableInfo } from '../../schema';
import { analyzePlan, partitionIndex } from './planAdvisor';

// ---- Postgres EXPLAIN (FORMAT JSON) fixtures ----------------------------------------------

const pgSeqScanLarge = [
	{
		Plan: {
			'Node Type': 'Seq Scan',
			'Relation Name': 'events',
			'Plan Rows': 4200000,
			'Total Cost': 91234.5,
		},
	},
];

const pgIndexScanClean = [
	{
		Plan: {
			'Node Type': 'Index Scan',
			'Relation Name': 'events',
			'Plan Rows': 12,
		},
	},
];

const pgSortOverSeqScan = [
	{
		Plan: {
			'Node Type': 'Sort',
			'Plan Rows': 4200000,
			Plans: [
				{ 'Node Type': 'Seq Scan', 'Relation Name': 'events', 'Plan Rows': 4200000 },
			],
		},
	},
];

test('Postgres large Seq Scan → large-scan warning naming the table', () => {
	const out = analyzePlan('postgres', pgSeqScanLarge);
	const scan = out.find((a) => a.kind === 'large-scan');
	assert.ok(scan, 'expected a large-scan advisory');
	assert.equal(scan.table, 'events');
	assert.equal(scan.level, 'warn');
	assert.match(scan.message, /4\.2M rows/);
});

test('Postgres Seq Scan with a selective filter is sized by the rows it READS, not returns', () => {
	// `WHERE date(created_at) = …`: the planner expects ~15k rows out of a 3M-row table, and reads all 3M.
	const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'events', 'Plan Rows': 15000 } }];
	const scan = analyzePlan('postgres', plan, { tableRows: (t) => (t === 'events' ? 3_000_000 : undefined) }).find((a) => a.kind === 'large-scan');
	assert.ok(scan, 'expected a large-scan advisory');
	assert.equal(scan.rows, 3_000_000);
	assert.match(scan.message, /3(\.0)?M rows/);
});

test('Postgres Index Scan of a few rows → no advisory', () => {
	assert.deepEqual(analyzePlan('postgres', pgIndexScanClean), []);
});

test('scan advisories carry the estimated row count (for the pre-flight threshold)', () => {
	const pg = analyzePlan('postgres', pgSeqScanLarge).find((a) => a.kind === 'large-scan');
	assert.equal(pg?.rows, 4200000);
	const my = analyzePlan('mysql-aurora', myFullScan).find((a) => a.kind === 'large-scan' || a.kind === 'full-scan');
	assert.equal(my?.rows, 3000000);
});

test('Postgres Sort over a Seq Scan → both filesort and scan flagged', () => {
	const out = analyzePlan('postgres', pgSortOverSeqScan);
	assert.ok(out.some((a) => a.kind === 'filesort'));
	assert.ok(out.some((a) => a.kind === 'large-scan'));
});

test('Postgres plan cell as a JSON string is parsed', () => {
	const out = analyzePlan('postgres', JSON.stringify(pgSeqScanLarge));
	assert.ok(out.some((a) => a.kind === 'large-scan'));
});

// ---- MySQL EXPLAIN FORMAT=JSON fixtures ----------------------------------------------------

const myFullScan = JSON.stringify({
	query_block: {
		select_id: 1,
		table: {
			table_name: 'events',
			access_type: 'ALL',
			rows_examined_per_scan: 3000000,
			filtered: '10.00',
		},
	},
});

const myRefScanClean = JSON.stringify({
	query_block: {
		select_id: 1,
		table: { table_name: 'events', access_type: 'ref', rows_examined_per_scan: 4 },
	},
});

const myFilesort = JSON.stringify({
	query_block: {
		select_id: 1,
		ordering_operation: {
			using_filesort: true,
			table: { table_name: 'people', access_type: 'ALL', rows_examined_per_scan: 800000 },
		},
	},
});

test('MySQL access_type ALL → full/large scan flagged', () => {
	const out = analyzePlan('mysql-aurora', myFullScan);
	const scan = out.find((a) => a.kind === 'large-scan' || a.kind === 'full-scan');
	assert.ok(scan);
	assert.equal(scan.table, 'events');
});

test('MySQL ref access of a few rows → no advisory', () => {
	assert.deepEqual(analyzePlan('mysql-aurora', myRefScanClean), []);
});

test('MySQL filesort in ordering_operation → filesort + underlying scan flagged', () => {
	const out = analyzePlan('mariadb', myFilesort);
	assert.ok(out.some((a) => a.kind === 'filesort'));
	assert.ok(out.some((a) => a.kind === 'large-scan'));
});

test('small scan below the floor is not flagged', () => {
	const smallScan = JSON.stringify({ query_block: { table: { table_name: 't', access_type: 'ALL', rows_examined_per_scan: 50 } } });
	assert.deepEqual(analyzePlan('mysql-aurora', smallScan), []);
});

test('unsupported driver / garbage input is silent', () => {
	assert.deepEqual(analyzePlan('oracle', pgSeqScanLarge), []);
	assert.deepEqual(analyzePlan('postgres', 'not json'), []);
	assert.deepEqual(analyzePlan('postgres', null), []);
	assert.deepEqual(analyzePlan('mysql-aurora', '{}'), []);
});

// ---- ClickHouse EXPLAIN json = 1, indexes = 1 fixtures -------------------------------------

function chPlan(initial: number, selected: number): unknown {
	return [{ Plan: { 'Node Type': 'Expression', Plans: [{ 'Node Type': 'ReadFromMergeTree', Description: 'shop.events', Indexes: [
		{ Type: 'Partition', 'Initial Granules': initial, 'Selected Granules': initial },
		{ Type: 'PrimaryKey', 'Initial Granules': initial, 'Selected Granules': selected },
	] }] } }];
}

test('ClickHouse: a read that skipped no granule is a full scan, named in ClickHouse terms', () => {
	const out = analyzePlan('clickhouse', JSON.stringify(chPlan(24, 24)));
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'large-scan');
	assert.equal(out[0].table, 'events');
	assert.match(out[0].message, /all 24 granules/);
	assert.match(out[0].rationale ?? '', /ORDER BY key/);
});

test('ClickHouse: a read the key narrowed is not flagged', () => {
	assert.deepEqual(analyzePlan('clickhouse', JSON.stringify(chPlan(24, 1))), []);
});

test('ClickHouse: a full scan is sized by the table\'s own row count, not a guessed granularity', () => {
	// 195 granules of a table with index_granularity = 1024 is 200k rows, not 195 × 8192 = 1.6M.
	const out = analyzePlan('clickhouse', JSON.stringify(chPlan(195, 195)), { tableRows: (t) => (t === 'events' ? 200_000 : undefined) });
	assert.equal(out[0].rows, 200_000);
	assert.match(out[0].message, /\(200k rows\)/);
	// Without the schema it is still an estimate, and says so.
	assert.match(analyzePlan('clickhouse', JSON.stringify(chPlan(195, 195)))[0].message, /\(~1\.6M rows\)/);
});

test('ClickHouse: a read answered from a projection is said, and never called a scan', () => {
	const plan = [{ Plan: { 'Node Type': 'Aggregating', Plans: [{ 'Node Type': 'ReadFromMergeTree', Description: 'by_v', Indexes: [
		{ Type: 'PrimaryKey', 'Initial Granules': 13, 'Selected Granules': 13 },
	] }] } }];
	const out = analyzePlan('clickhouse', JSON.stringify(plan));
	assert.deepEqual(out.map((a) => [a.kind, a.level]), [['projection', 'info']]);
	assert.match(out[0].message, /projection by_v: 13 of 13 granules/);
});

test('ClickHouse: FINAL on a large table is flagged, from the statement since the plan does not show it', () => {
	const big = { tableRows: () => 5_000_000 };
	const final = analyzePlan('clickhouse', JSON.stringify(chPlan(600, 2)), { ...big, sql: 'SELECT * FROM shop.events AS e FINAL WHERE id = 1' });
	assert.deepEqual(final.map((a) => [a.kind, a.level]), [['final', 'warn']]);
	assert.match(final[0].rationale ?? '', /argMax/);
	// Not in a string or a comment, not on a small table, not without FINAL.
	assert.deepEqual(analyzePlan('clickhouse', JSON.stringify(chPlan(600, 2)), { ...big, sql: "SELECT 'events FINAL' FROM shop.events -- FINAL" }), []);
	assert.deepEqual(analyzePlan('clickhouse', JSON.stringify(chPlan(600, 2)), { tableRows: () => 500, sql: 'SELECT * FROM events FINAL' }), []);
});

// ---- Partitions and SnoutTime series ----------------------

function tbl(name: string, parent?: string, series?: boolean): TableInfo {
	return {
		name, schema: 'public', kind: 'table', columns: [], primaryKey: [], foreignKeys: [],
		partitionOf: parent ? { schema: 'public', name: parent } : undefined,
		series: series ? { timeColumn: 'ts', timeType: 'timestamptz', partitionSize: '1 day', partitions: [], rollups: [] } : undefined,
	};
}

const SERIES_TABLES = [tbl('metrics', undefined, true), tbl('metrics_p1', 'metrics'), tbl('metrics_p2', 'metrics'), tbl('metrics_p3', 'metrics')];

function appendOver(names: string[], node = 'Seq Scan'): unknown {
	return [{ Plan: { 'Node Type': 'Append', 'Plan Rows': 30000, Plans: names.map((n) => ({ 'Node Type': node, 'Relation Name': n, 'Plan Rows': 10000 })) } }];
}

test('every partition of a series read → one partition-scan naming the time column, not a scan per partition', () => {
	const out = analyzePlan('postgres', appendOver(['metrics_p1', 'metrics_p2', 'metrics_p3']), { partition: partitionIndex(SERIES_TABLES) });
	assert.deepEqual(out.map((a) => [a.kind, a.table]), [['partition-scan', 'metrics']]);
	assert.equal(out[0].level, 'warn');
	assert.match(out[0].message, /Reads all 3 partitions of metrics \(~30k rows\)/);
	assert.match(out[0].rationale ?? '', /partitioned by ts\. Filter on ts/);
});

test('a selective filter over every partition still warns, sized by the table\'s rows, not what the filter returns', () => {
	const tables = SERIES_TABLES.map((t) => (t.name === 'metrics' ? { ...t, stats: { rowCount: 374000 } } : t));
	const plan = [{ Plan: { 'Node Type': 'Append', 'Plan Rows': 30, Plans: ['metrics_p1', 'metrics_p2', 'metrics_p3'].map((n) => ({ 'Node Type': 'Seq Scan', 'Relation Name': n, 'Plan Rows': 10 })) } }];
	const out = analyzePlan('postgres', plan, { partition: partitionIndex(tables) });
	assert.deepEqual(out.map((a) => a.kind), ['partition-scan']);
	assert.match(out[0].message, /Reads all 3 partitions of metrics \(~374k rows\)/);
	// With no statistics it falls back to what the plan says, and a tiny result stays quiet.
	assert.deepEqual(analyzePlan('postgres', plan, { partition: partitionIndex(SERIES_TABLES) }).map((a) => a.kind), []);
});

test('a plain partitioned table\'s rows are its leaves\' rows added up', () => {
	const tables = [tbl('orders'), { ...tbl('orders_a', 'orders'), stats: { rowCount: 600 } }, { ...tbl('orders_b', 'orders'), stats: { rowCount: 900 } }];
	assert.equal(partitionIndex(tables)('orders_a')?.rows, 1500);
});

test('a pruned plan is not a partition scan, and its seq scans are one table\'s, with their rows summed', () => {
	const out = analyzePlan('postgres', appendOver(['metrics_p2', 'metrics_p3']), { partition: partitionIndex(SERIES_TABLES) });
	assert.deepEqual(out.map((a) => [a.kind, a.table, a.rows]), [['full-scan', 'metrics', 20000]]);
});

test('a column store read of every partition still counts (a custom scan names its relation too)', () => {
	const out = analyzePlan('postgres', appendOver(['metrics_p1', 'metrics_p2', 'metrics_p3'], 'Custom Scan'), { partition: partitionIndex(SERIES_TABLES) });
	assert.deepEqual(out.map((a) => a.kind), ['partition-scan']);
});

test('a plain partitioned table two levels deep is resolved to its root and its leaves', () => {
	const tables = [tbl('orders'), tbl('orders_2025', 'orders'), tbl('orders_2025_a', 'orders_2025'), tbl('orders_2025_b', 'orders_2025'), tbl('orders_2026', 'orders')];
	const place = partitionIndex(tables);
	assert.deepEqual(place('orders_2025_a'), { root: 'orders', leaves: 3, timeColumn: undefined, rows: undefined });
	assert.equal(place('orders_2025'), undefined); // not a leaf: never scanned itself
	const out = analyzePlan('postgres', appendOver(['orders_2025_a', 'orders_2025_b', 'orders_2026']), { partition: place });
	assert.match(out[0].rationale ?? '', /is partitioned\. A filter on its partition key/);
});

test('without partition facts a plan reads as before', () => {
	const out = analyzePlan('postgres', appendOver(['metrics_p1', 'metrics_p2']));
	assert.deepEqual(out.map((a) => a.table), ['metrics_p1', 'metrics_p2']);
});

// Postgres 18: EXPLAIN ANALYZE carries BUFFERS by default, so every node grows block counts, an
// index scan reports its "Index Searches" (skip scan), and the document gains Planning and timing
// keys. None of that may change what the advisor reads.
const pg18AnalyzePlan = [
	{
		Plan: {
			'Node Type': 'Nested Loop',
			'Plan Rows': 4200000,
			'Actual Rows': 4100000,
			'Actual Loops': 1,
			'Shared Hit Blocks': 1024,
			'Shared Read Blocks': 88,
			'Shared Dirtied Blocks': 0,
			'Shared Written Blocks': 0,
			'Local Hit Blocks': 0,
			'Temp Read Blocks': 0,
			Plans: [
				{ 'Node Type': 'Seq Scan', 'Parent Relationship': 'Outer', 'Relation Name': 'events', 'Plan Rows': 4200000, 'Actual Rows': 4100000, 'Shared Hit Blocks': 900, 'Shared Read Blocks': 88 },
				{ 'Node Type': 'Index Scan', 'Parent Relationship': 'Inner', 'Relation Name': 'users', 'Index Name': 'users_tenant_email_idx', 'Plan Rows': 1, 'Actual Rows': 1, 'Index Searches': 3, 'Shared Hit Blocks': 124 },
			],
		},
		Planning: { 'Shared Hit Blocks': 12, 'Shared Read Blocks': 0 },
		'Planning Time': 0.21,
		Triggers: [],
		'Execution Time': 812.4,
	},
];

test('postgres 18 EXPLAIN ANALYZE (BUFFERS by default, Index Searches) reads as before', () => {
	const out = analyzePlan('postgres', pg18AnalyzePlan);
	assert.deepEqual(out.map((a) => [a.kind, a.table]), [['large-scan', 'events']]);
	// The same document as the json column's TEXT, which is how some paths hand it over.
	assert.deepEqual(analyzePlan('postgres', JSON.stringify(pg18AnalyzePlan)).map((a) => a.kind), ['large-scan']);
});

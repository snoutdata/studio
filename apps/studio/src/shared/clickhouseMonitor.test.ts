/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clickhouseStarterMonitor, clickhouseStarterWidgets } from './clickhouseMonitor';
import { effectiveIntervalSec, extractTrendSamples } from './monitor';
import type { QueryResult } from './query';

const CLUSTER = { replicas: 3, cluster: 'default', settings: 'SETTINGS max_execution_time = 10, skip_unavailable_shards = 1' };

describe('the ClickHouse starter monitor', () => {
	test('one widget per number an operator watches, all trends the poller can keep', () => {
		let n = 0;
		const dash = clickhouseStarterMonitor('conn-1', 'prod', () => `id-${n++}`, undefined, 1000);
		assert.equal(dash.name, 'ClickHouse · prod');
		assert.deepEqual(dash.widgets.map((w) => w.title), [
			'Queries per second', 'Failed queries per minute', 'Memory used (MB)', 'Merges running',
			'Parts in the largest partition', 'Replica delay (seconds)', 'Errors by name (cumulative)',
		]);
		assert.ok(dash.widgets.every((w) => w.kind === 'trend' && w.connectionId === 'conn-1'));
		// The poller floors an interval; a widget saved under the floor would be silently changed.
		assert.ok(dash.widgets.every((w) => effectiveIntervalSec(w) === w.intervalSec));
		assert.equal(new Set(dash.widgets.map((w) => w.id)).size, dash.widgets.length);
	});

	test('a per-node table is read across every replica, and a replicated one is not', () => {
		const sql = Object.fromEntries(clickhouseStarterWidgets(CLUSTER).map((w) => [w.title, w.sql]));
		// query_log, metrics, replicas and errors are local to the node that answers, so on Cloud
		// without this each sample is a different arbitrary replica.
		assert.match(sql['Queries per second'], /clusterAllReplicas\('default', system\.query_log\)/);
		assert.match(sql['Memory used \(MB\)'], /clusterAllReplicas\('default', system\.metrics\)/);
		assert.match(sql['Replica delay \(seconds\)'], /clusterAllReplicas\('default', system\.replicas\)/);
		// Parts are REPLICATED: a fan-out would count every part once per replica.
		assert.match(sql['Parts in the largest partition'], /FROM system\.parts\b/);
		assert.ok(!sql['Parts in the largest partition'].includes('clusterAllReplicas'));
	});

	test('the scope\'s settings ride along, and are absent on a single node', () => {
		const cluster = clickhouseStarterWidgets(CLUSTER).find((w) => w.title === 'Queries per second')!;
		assert.match(cluster.sql, /SETTINGS max_execution_time = 10/);
		const single = clickhouseStarterWidgets().find((w) => w.title === 'Queries per second')!;
		assert.ok(!single.sql.includes('SETTINGS'));
		assert.match(single.sql, /FROM system\.query_log/);
	});

	// A `readonly = 1` user may send NO setting but `default_format`, and that account is the one a
	// production analyst has. The scope's own SETTINGS is dropped for them upstream (it comes back
	// empty), so nothing here may add one of its own.
	test('no widget sends a setting of its own', () => {
		for (const widget of clickhouseStarterWidgets()) {
			assert.ok(!/\bSETTINGS\b/i.test(widget.sql), `${widget.title} sends a setting`);
		}
	});

	test('the workload widgets count real queries, not the app watching the server', () => {
		// The Operations panel's health reads run every few seconds and would BE the workload on a
		// quiet server; a distributed query's remote legs are the same query counted again.
		for (const title of ['Queries per second', 'Failed queries per minute']) {
			const sql = clickhouseStarterWidgets().find((w) => w.title === title)!.sql;
			assert.match(sql, /is_initial_query/);
			assert.match(sql, /snoutdata-ops/);
		}
	});

	test('each widget returns a shape the trend extractor reads as one series', () => {
		// One column is ONE metric, and the extractor names its series '' rather than after the
		// column: the tile's own title is the label. Every widget here but the errors one is that.
		const scalar: QueryResult = { fields: [{ name: 'queries_per_second' }], rows: [[1.5]], rowCount: 1 } as unknown as QueryResult;
		assert.deepEqual(extractTrendSamples(scalar, 7), [{ t: 7, series: '', value: 1.5 }]);
		// The errors widget is the one grouped metric: first column names the series.
		const grouped: QueryResult = { fields: [{ name: 'name' }, { name: 'errors' }], rows: [['TIMEOUT_EXCEEDED', 3], ['TOO_MANY_PARTS', 1]], rowCount: 2 } as unknown as QueryResult;
		assert.deepEqual(extractTrendSamples(grouped, 7), [
			{ t: 7, series: 'TIMEOUT_EXCEEDED', value: 3 },
			{ t: 7, series: 'TOO_MANY_PARTS', value: 1 },
		]);
	});
});

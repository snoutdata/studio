/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { TableInfo } from './schema';
import { rollupWidgets, seriesMonitor } from './seriesMonitor';

function view(name: string, columns: [string, string][]): TableInfo {
	return {
		name, schema: 'public', kind: 'view', primaryKey: [], foreignKeys: [],
		columns: columns.map(([n, t]) => ({ name: n, dataType: t, nullable: true, isPrimaryKey: false })),
		rollup: { source: { schema: 'public', name: 'metrics' }, bucket: '01:00:00' },
	};
}

const hourly = view('metrics_hourly', [['bucket', 'timestamp with time zone'], ['max_cpu', 'double precision'], ['n', 'bigint']]);
const byHost = view('metrics_host_hourly', [['bucket', 'timestamp with time zone'], ['max_cpu', 'double precision'], ['host', 'text']]);

const metrics: TableInfo = {
	name: 'metrics', schema: 'public', kind: 'table', columns: [], primaryKey: [], foreignKeys: [],
	series: {
		timeColumn: 'ts', timeType: 'timestamp with time zone', partitionSize: '1 day', partitions: [],
		rollups: [{ schema: 'public', name: 'metrics_hourly', bucket: '01:00:00' }, { schema: 'public', name: 'metrics_host_hourly', bucket: '01:00:00' }],
	},
};

describe('a monitor over a series\' rollups', () => {
	test('an ungrouped rollup charts its measures over the recent buckets, read from the database', () => {
		const [w] = rollupWidgets(hourly, false);
		assert.equal(w.viz, 'line');
		assert.equal(w.sql, `SELECT bucket, "max_cpu", "n"\nFROM "public"."metrics_hourly"\nWHERE bucket >= (SELECT max(bucket) FROM "public"."metrics_hourly") - 48 * interval '01:00:00'\nORDER BY bucket`);
	});

	test('a grouped rollup shows the top groups of its latest bucket, one widget per measure', () => {
		const out = rollupWidgets(byHost, false);
		assert.deepEqual(out.map((w) => w.viz), ['bar']);
		assert.match(out[0].sql, /^SELECT "host", "max_cpu"\nFROM "public"\."metrics_host_hourly"\nWHERE bucket = \(SELECT max\(bucket\)/);
		assert.match(out[0].sql, /LIMIT 10$/);
	});

	test('an integer series reaches back from its newest bucket too', () => {
		const [w] = rollupWidgets({ ...hourly, rollup: { source: { schema: 'public', name: 'm' }, bucket: '1000' } }, true);
		assert.match(w.sql, /WHERE bucket >= \(SELECT max\(bucket\) FROM "public"\."metrics_hourly"\) - 48 \* 1000/);
	});

	test('the monitor is snapshots, one poll a minute, and nothing when there is nothing to chart', () => {
		let n = 0;
		const d = seriesMonitor(metrics, [metrics, hourly, byHost], 'c1', 'prod', () => `id${n++}`, 5);
		assert.equal(d?.name, 'metrics rollups · prod');
		assert.deepEqual(d?.widgets.map((w) => [w.kind, w.viz, w.intervalSec, w.connectionId]), [['snapshot', 'line', 60, 'c1'], ['snapshot', 'bar', 60, 'c1']]);
		// views not introspected: no columns, so no widget, so no monitor
		assert.equal(seriesMonitor(metrics, [metrics], 'c1', 'prod', () => 'x'), undefined);
		assert.equal(seriesMonitor({ ...metrics, series: undefined }, [], 'c1', 'prod', () => 'x'), undefined);
	});
});

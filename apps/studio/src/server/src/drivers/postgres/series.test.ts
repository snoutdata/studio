/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { TableInfo } from '../../../../shared/schema';
import { attachSeries, readableInterval, readSeries, sealRatio, type SeriesRows } from './series';

function table(name: string, kind: TableInfo['kind'] = 'table'): TableInfo {
	return { name, schema: 'public', kind, columns: [], primaryKey: [], foreignKeys: [] };
}

const PARTITIONS = [
	{ parent_schema: 'public', parent_name: 'metrics', table_schema: 'public', table_name: 'metrics_p20260921' },
	{ parent_schema: 'public', parent_name: 'metrics', table_schema: 'public', table_name: 'metrics_p20260922' },
	{ parent_schema: 'public', parent_name: 'orders', table_schema: 'public', table_name: 'orders_2025' },
];

const ROWS: SeriesRows = {
	partitions: PARTITIONS,
	version: '0.0.0',
	series: [{
		table_schema: 'public',
		table_name: 'metrics',
		info: {
			time_column: 'ts', time_type: 'timestamp with time zone', partition_size: '1 day', space_column: null,
			retention: '30 days', estimated_rows: 2000, bytes: 90000, sealed_bytes: 10000, sealed_bytes_before: 80000,
		},
	}],
	partitionInfo: [
		{ series_schema: 'public', series_name: 'metrics', table_schema: 'public', table_name: 'metrics_p20260921',
			info: { state: 'sealed', range_start: '2026-09-21 00:00:00+00', range_end: '2026-09-22 00:00:00+00', estimated_rows: 1000, bytes: 10000, bytes_before: 80000 } },
		// an extension built before bytes_before existed: the column is simply not there
		{ series_schema: 'public', series_name: 'metrics', table_schema: 'public', table_name: 'metrics_p20260922',
			info: { state: 'live', range_start: '2026-09-22 00:00:00+00', range_end: '2026-09-23 00:00:00+00', estimated_rows: 1000, bytes: 80000 } },
	],
	rollups: [{ table_schema: 'public', table_name: 'metrics_hourly', source_schema: 'public', source_name: 'metrics', bucket: '01:00:00', store_schema: 'public', store_name: 'metrics_hourly_materialized' }],
};

describe('Postgres partitions and SnoutTime series', () => {
	test('any partition is marked with its parent, series or not', () => {
		const tables = [table('metrics'), table('metrics_p20260921'), table('metrics_p20260922'), table('orders'), table('orders_2025')];
		attachSeries(tables, { ...ROWS, version: undefined });
		assert.deepEqual(tables.find((t) => t.name === 'orders_2025')?.partitionOf, { schema: 'public', name: 'orders' });
		assert.equal(tables.find((t) => t.name === 'orders')?.partitionOf, undefined);
		// without the extension there is no series, whatever rows came back
		assert.equal(tables.find((t) => t.name === 'metrics')?.series, undefined);
	});

	test('a series parent carries its shape, partitions, rollups and the whole tree\'s size', () => {
		const tables = [table('metrics'), table('metrics_p20260921'), table('metrics_p20260922'), table('metrics_hourly', 'view'), table('metrics_hourly_materialized')];
		tables[0].stats = { rowCount: -1, totalBytes: 0, dataBytes: 0, indexBytes: 0 };
		assert.equal(attachSeries(tables, ROWS), '0.0.0');
		const s = tables[0].series;
		assert.equal(s?.timeColumn, 'ts');
		assert.equal(s?.partitionSize, '1 day');
		assert.equal(s?.retention, '30 days');
		assert.equal(s?.spaceColumn, undefined);
		assert.deepEqual(s?.partitions.map((p) => [p.name, p.state, p.bytesBefore]), [
			['metrics_p20260921', 'sealed', 80000],
			['metrics_p20260922', 'live', undefined],
		]);
		assert.deepEqual(s?.rollups, [{ schema: 'public', name: 'metrics_hourly', bucket: '1 hour' }]);
		// the parent's own zeros are gone: a partitioned table has no storage of its own
		assert.deepEqual(tables[0].stats, { rowCount: 2000, totalBytes: 90000, dataBytes: undefined, indexBytes: undefined });
		assert.deepEqual(tables[4].rollupStoreOf, { schema: 'public', name: 'metrics_hourly' });
		assert.deepEqual(tables[3].rollup, { source: { schema: 'public', name: 'metrics' }, bucket: '1 hour' });
		assert.equal(sealRatio(s?.sealedBytesBefore, s?.sealedBytes), 8);
	});

	test('an unknown state is not trusted', () => {
		const tables = [table('metrics'), table('metrics_p20260921')];
		const rows: SeriesRows = { ...ROWS, partitionInfo: [{ ...ROWS.partitionInfo[0], info: { state: 'melted' } }] };
		attachSeries(tables, rows);
		assert.equal(tables[0].series?.partitions[0].state, 'foreign');
	});

	test('SnoutTime\'s views are asked only when the extension is installed', async () => {
		const asked: string[] = [];
		const without = await readSeries(async (sql) => {
			asked.push(sql);
			return { rows: sql.includes('pg_inherits') ? PARTITIONS : [] };
		});
		assert.equal(without.version, undefined);
		assert.equal(without.partitions.length, 3);
		assert.equal(asked.some((sql) => sql.includes('snouttime.')), false);
		assert.equal(without.available, false);

		const offered = await readSeries(async (sql) => ({
			rows: sql.includes('pg_available_extensions') ? [{ '?column?': 1 }] : [],
		}));
		assert.equal(offered.version, undefined);
		assert.equal(offered.available, true);

		const withIt = await readSeries(async (sql) => ({
			rows: sql.includes('pg_extension') ? [{ extversion: '0.0.0' }] : sql.includes('series_info') ? ROWS.series : [],
		}));
		assert.equal(withIt.version, '0.0.0');
		assert.equal(withIt.series.length, 1);
	});

	test('a bucket reads as words, and stays a valid interval', () => {
		assert.equal(readableInterval('01:00:00'), '1 hour');
		assert.equal(readableInterval('00:05:00'), '5 minutes');
		assert.equal(readableInterval('1 day'), '1 day');
		assert.equal(readableInterval('7 days'), '7 days');
		assert.equal(readableInterval('1 mon'), '1 month');
		assert.equal(readableInterval('1 year 2 mons'), '1 year 2 months');
		assert.equal(readableInterval('1 day 02:30:00'), '1 day 2 hours 30 minutes');
		assert.equal(readableInterval('00:00:30'), '30 seconds');
		assert.equal(readableInterval('3600'), '3600');
		assert.equal(readableInterval('P1D'), 'P1D');
	});

	test('the ratio is only given when both sides are known', () => {
		assert.equal(sealRatio(undefined, 10), undefined);
		assert.equal(sealRatio(10, 0), undefined);
		assert.equal(sealRatio(100, 25), 4);
	});
});

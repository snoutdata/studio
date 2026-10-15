/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseSchema, TableInfo } from '../../shared/schema';
import { listedInSchema, partitionRows, partitionsByParent, ratioText, seriesKindLabel } from './seriesTree';

function tbl(name: string, extra: Partial<TableInfo> = {}): TableInfo {
	return { name, schema: 'public', kind: 'table', columns: [], primaryKey: [], foreignKeys: [], ...extra };
}

const metrics = tbl('metrics', {
	series: {
		timeColumn: 'ts', timeType: 'timestamptz', partitionSize: '1 day', sealedBytes: 1000, sealedBytesBefore: 8000,
		partitions: [
			{ name: 'metrics_p20260921', state: 'sealed', rangeStart: '2026-09-21', rangeEnd: '2026-09-22', estimatedRows: 1200, bytes: 1000, bytesBefore: 8000 },
			{ name: 'metrics_p20260922', state: 'live', bytes: 8192 },
		],
		rollups: [],
	},
});

describe('the explorer\'s partitions and series', () => {
	test('a partition is folded under its parent, which lists it', () => {
		const part = tbl('orders_2025', { partitionOf: { schema: 'public', name: 'orders' } });
		const schema: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [tbl('orders'), part] };
		assert.equal(listedInSchema(part), false);
		assert.equal(listedInSchema(schema.tables[0]), true);
		assert.deepEqual(partitionsByParent(schema).get('public.orders')?.map((t) => t.name), ['orders_2025']);
		// SnoutTime's storage is not the user's to open; its catalog views are
		const withExt: DatabaseSchema = { ...schema, snouttime: { version: '0.0.0' } };
		assert.equal(listedInSchema(tbl('delta_1', { schema: 'snouttime_internal' }), withExt), false);
		assert.equal(listedInSchema(tbl('series_info', { schema: 'snouttime', kind: 'view' }), withExt), true);
		assert.equal(listedInSchema(tbl('m_hourly_materialized', { rollupStoreOf: { schema: 'public', name: 'm_hourly' } }), withExt), false);
	});

	test('a series lists its partitions newest first, with what sealing saved', () => {
		const rows = partitionRows(metrics);
		assert.deepEqual(rows.map((r) => r.name), ['metrics_p20260922', 'metrics_p20260921']);
		assert.equal(rows[0].detail, 'live · 8.0 KB');
		assert.match(rows[1].detail, /^sealed · .+ → .+ \(8\.0×\)$/);
		assert.match(rows[1].title, /Holds 2026-09-21 to 2026-09-22\n~1,200 rows\nSealed:/);
	});

	test('the label beside a table says what it is', () => {
		assert.equal(seriesKindLabel(metrics, true), 'series · 1 sealed · 8.0× smaller');
		assert.equal(seriesKindLabel(tbl('orders'), true), 'partitioned');
		assert.equal(seriesKindLabel(tbl('orders'), false), undefined);
		assert.equal(seriesKindLabel(tbl('m_hourly', { kind: 'view', rollup: { source: { schema: 'public', name: 'metrics' }, bucket: '01:00:00' } }), false), 'rollup · 01:00:00');
	});

	test('a ratio is only claimed when both sizes are known', () => {
		assert.equal(ratioText(undefined, 10), undefined);
		assert.equal(ratioText(100, 0), undefined);
		assert.equal(ratioText(250, 10), '25×');
	});
});

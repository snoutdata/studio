/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { effectiveIntervalSec, extractTrendSamples, guardMonitor, MIN_INTERVAL_SEC, monitorQueryRefusal } from './monitor';
import type { QueryResult } from './query';

function result(fields: string[], rows: unknown[][]): QueryResult {
	return { fields: fields.map((name) => ({ name })), rows, rowCount: rows.length, durationMs: 0 };
}

test('single column → one scalar sample', () => {
	const samples = extractTrendSamples(result(['c'], [[42]]), 1000);
	assert.deepStrictEqual(samples, [{ t: 1000, series: '', value: 42 }]);
});

test('single row of several columns → one series per numeric column (by name)', () => {
	const samples = extractTrendSamples(result(['payment_count', 'total_amount'], [[21, 15334]]), 5000);
	assert.deepStrictEqual(samples, [
		{ t: 5000, series: 'payment_count', value: 21 },
		{ t: 5000, series: 'total_amount', value: 15334 },
	]);
});

test('single row with a text label column → that column is skipped, numerics kept', () => {
	const samples = extractTrendSamples(result(['status', 'n'], [['new', 7]]), 0);
	assert.deepStrictEqual(samples, [{ t: 0, series: 'n', value: 7 }]);
});

test('grouped query → one sample per row, first col label / last col value', () => {
	const samples = extractTrendSamples(result(['status', 'n'], [['new', 7], ['done', 3]]), 2000);
	assert.deepStrictEqual(samples, [
		{ t: 2000, series: 'new', value: 7 },
		{ t: 2000, series: 'done', value: 3 },
	]);
});

test('numeric strings are coerced; non-numeric → null', () => {
	assert.strictEqual(extractTrendSamples(result(['c'], [['15']]), 0)[0].value, 15);
	assert.strictEqual(extractTrendSamples(result(['c'], [['abc']]), 0)[0].value, null);
	assert.strictEqual(extractTrendSamples(result(['c'], [[null]]), 0)[0].value, null);
});

test('empty result → no samples', () => {
	assert.deepStrictEqual(extractTrendSamples(result(['c'], []), 0), []);
	assert.deepStrictEqual(extractTrendSamples(result([], []), 0), []);
});

test('null group label becomes empty-string series (grouped, multi-row)', () => {
	const samples = extractTrendSamples(result(['g', 'v'], [[null, 5], ['x', 3]]), 0);
	assert.strictEqual(samples[0].series, '');
	assert.strictEqual(samples[1].series, 'x');
});

test('interval is floored at the minimum', () => {
	assert.strictEqual(effectiveIntervalSec({ intervalSec: 1 } as never), MIN_INTERVAL_SEC);
	assert.strictEqual(effectiveIntervalSec({ intervalSec: MIN_INTERVAL_SEC + 30 } as never), MIN_INTERVAL_SEC + 30);
	assert.strictEqual(effectiveIntervalSec({ intervalSec: 0 } as never), MIN_INTERVAL_SEC);
});

test('a monitor runs only a read: a write is refused with the reason, a read passes', () => {
	assert.equal(monitorQueryRefusal('select count(*) from orders'), undefined);
	assert.equal(monitorQueryRefusal('with t as (select 1) select * from t'), undefined);
	for (const sql of ['delete from orders', 'select 1; drop table orders', 'update t set x = 1', 'insert into t values (1)']) {
		const refusal = monitorQueryRefusal(sql);
		assert.ok(refusal, sql);
		assert.match(refusal, /^Paused: a monitor only runs read-only queries/);
		assert.match(refusal, /Edit the query to resume it\.$/);
	}
	assert.match(monitorQueryRefusal('delete from orders') ?? '', /DELETE/);
});

test('guardMonitor pauses a widget that writes and clears the pause once it reads', () => {
	const base = { id: 'w', title: 'T', connectionId: 'c', kind: 'trend' as const, viz: 'line' as const, intervalSec: 60 };
	const monitor = { id: 'm', name: 'M', createdAt: 0, updatedAt: 0, widgets: [{ ...base, sql: 'delete from t' }, { ...base, id: 'r', sql: 'select 1', paused: 'stale' }] };
	const guarded = guardMonitor(monitor, () => 'postgres');
	assert.match(guarded.widgets[0].paused ?? '', /^Paused:/);
	assert.equal(guarded.widgets[0].sql, 'delete from t', 'kept as written, never dropped');
	assert.equal('paused' in guarded.widgets[1], false);
});

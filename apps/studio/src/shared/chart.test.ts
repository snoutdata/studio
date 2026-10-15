/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChartSpec, chartDataToCsv, type ChartSpec } from './chart';

function ok(parsed: ReturnType<typeof parseChartSpec>): ChartSpec {
	assert.ok('spec' in parsed, `expected a spec, got error: ${'error' in parsed ? parsed.error : '?'}`);
	return parsed.spec;
}

test('parses a valid bar spec', () => {
	const spec = ok(parseChartSpec(JSON.stringify({
		type: 'bar',
		title: 'Revenue',
		x: 'month',
		series: [{ key: 'revenue', name: 'Revenue' }],
		data: [{ month: 'Jan', revenue: 100 }, { month: 'Feb', revenue: 200 }],
	})));
	assert.equal(spec.type, 'bar');
	assert.equal(spec.x, 'month');
	assert.equal(spec.series[0].name, 'Revenue');
	assert.equal(spec.data.length, 2);
});

test('rejects invalid JSON', () => {
	const r = parseChartSpec('{ not json');
	assert.ok('error' in r);
});

test('rejects an unknown chart type', () => {
	const r = parseChartSpec(JSON.stringify({ type: 'donut', x: 'a', series: [{ key: 'b' }], data: [{ a: 1, b: 2 }] }));
	assert.ok('error' in r);
});

test('rejects a missing x key', () => {
	const r = parseChartSpec(JSON.stringify({ type: 'line', series: [{ key: 'b' }], data: [{ b: 2 }] }));
	assert.ok('error' in r);
});

test('rejects empty series and empty data', () => {
	assert.ok('error' in parseChartSpec(JSON.stringify({ type: 'line', x: 'a', series: [], data: [{ a: 1 }] })));
	assert.ok('error' in parseChartSpec(JSON.stringify({ type: 'line', x: 'a', series: [{ key: 'b' }], data: [] })));
});

test('coerces non-primitive cell values to strings', () => {
	const spec = ok(parseChartSpec(JSON.stringify({
		type: 'bar', x: 'a', series: [{ key: 'b' }], data: [{ a: 'x', b: 5, extra: { nested: 1 } }],
	})));
	assert.equal(typeof spec.data[0].extra, 'string');
});

test('chartDataToCsv emits a header of x + series keys and escapes specials', () => {
	const spec = ok(parseChartSpec(JSON.stringify({
		type: 'bar', x: 'label', series: [{ key: 'v' }],
		data: [{ label: 'a,b', v: 1 }, { label: 'c', v: 2 }],
	})));
	const csv = chartDataToCsv(spec);
	assert.equal(csv.split('\r\n')[0], 'label,v');
	assert.ok(csv.includes('"a,b"'));
});

test('chartDataToCsv neutralises a label a spreadsheet would read as a formula, and leaves numbers alone', () => {
	const spec = ok(parseChartSpec(JSON.stringify({
		type: 'bar', x: 'label', series: [{ key: 'v' }],
		data: [{ label: '=HYPERLINK("http://evil.example")', v: -1 }, { label: '@x', v: 2 }],
	})));
	const lines = chartDataToCsv(spec).split('\r\n');
	assert.equal(lines[1], '"\'=HYPERLINK(""http://evil.example"")",-1');
	assert.equal(lines[2], "'@x,2");
});

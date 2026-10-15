/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	aggregateLogRows,
	IncompleteAggregateError,
	logResultColumns,
	logRowOf,
	matchesLogPredicates,
	projectLogRow,
	sortLogRows,
	type LogRow,
} from './logRows';
import type { LogsQuery } from './logs';

const EVENT = { id: 'e1', at: 1_700_000_000_000, ingestedAt: 1_700_000_000_500, stream: 's1', message: 'plain text' };

test('an event becomes the fixed contract, with nulls where the provider has nothing', () => {
	assert.deepEqual(logRowOf({ id: 'e', at: 5, message: 'hi' }), {
		ts: 5, message: 'hi', stream: null, id: 'e', ingested_at: null,
	});
});

test('a JSON message contributes parsed fields, flattened one level', () => {
	const row = logRowOf({ ...EVENT, message: '{"level":"ERROR","status":500,"http":{"path":"/a"},"tags":["x"]}' });
	assert.equal(row.level, 'ERROR');
	assert.equal(row.status, 500);
	assert.equal(row['http.path'], '/a');
	assert.deepEqual(row.tags, ['x']);
	// The contract survives: the raw text is still there.
	assert.equal(row.message, '{"level":"ERROR","status":500,"http":{"path":"/a"},"tags":["x"]}');
});

test('a parsed field never overwrites a contract column', () => {
	const row = logRowOf({ ...EVENT, message: '{"message":"inner","ts":1,"level":"WARN"}' });
	assert.equal(row.message, '{"message":"inner","ts":1,"level":"WARN"}');
	assert.equal(row.json_message, 'inner');
	assert.equal(row.ts, EVENT.at);
	assert.equal(row.json_ts, 1);
	assert.equal(row.level, 'WARN');
});

test('non-JSON and malformed-JSON messages contribute nothing and do not throw', () => {
	assert.deepEqual(Object.keys(logRowOf({ id: 'e', at: 1, message: 'not json' })).sort(), ['id', 'ingested_at', 'message', 'stream', 'ts']);
	assert.deepEqual(Object.keys(logRowOf({ id: 'e', at: 1, message: '{oops' })).sort(), ['id', 'ingested_at', 'message', 'stream', 'ts']);
	assert.deepEqual(Object.keys(logRowOf({ id: 'e', at: 1, message: '[1,2]' })).sort(), ['id', 'ingested_at', 'message', 'stream', 'ts']);
});

const ROW: LogRow = { ts: 100, message: 'boom ERROR here', stream: 'a', id: 'e', ingested_at: null, level: 'ERROR', status: 500 };

test('predicates: equality, ordering, LIKE, IN and NULL', () => {
	assert.ok(matchesLogPredicates(ROW, [{ op: '=', field: 'level', value: 'ERROR' }]));
	assert.ok(!matchesLogPredicates(ROW, [{ op: '=', field: 'level', value: 'WARN' }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: '>=', field: 'status', value: 500 }]));
	assert.ok(!matchesLogPredicates(ROW, [{ op: '<', field: 'status', value: 500 }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: 'like', field: 'message', pattern: '%ERROR%' }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: 'like', field: 'message', pattern: '%error%', caseInsensitive: true }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: 'not like', field: 'message', pattern: '%WARN%' }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: 'in', field: 'level', values: ['WARN', 'ERROR'] }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: 'is null', field: 'ingested_at' }]));
	assert.ok(matchesLogPredicates(ROW, [{ op: 'is not null', field: 'stream' }]));
	// Several predicates are ANDed.
	assert.ok(matchesLogPredicates(ROW, [{ op: '=', field: 'level', value: 'ERROR' }, { op: '=', field: 'stream', value: 'a' }]));
	assert.ok(!matchesLogPredicates(ROW, [{ op: '=', field: 'level', value: 'ERROR' }, { op: '=', field: 'stream', value: 'b' }]));
});

test('a JSON field serialised as a string still matches a numeric comparison', () => {
	// The deliberate liberty: a log line is not a typed column, and `status = 200` must find both.
	assert.ok(matchesLogPredicates({ status: '200' }, [{ op: '=', field: 'status', value: 200 }]));
	assert.ok(matchesLogPredicates({ status: 200 }, [{ op: '=', field: 'status', value: 200 }]));
});

test('a LIKE wildcard spans newlines (a stack trace is one message)', () => {
	assert.ok(matchesLogPredicates({ message: 'a\nException\nb' }, [{ op: 'like', field: 'message', pattern: '%Exception%' }]));
});

test('a missing field fails every comparison, including inequality against NULL', () => {
	assert.ok(!matchesLogPredicates({}, [{ op: '=', field: 'level', value: 'ERROR' }]));
	assert.ok(!matchesLogPredicates({}, [{ op: '>', field: 'status', value: 1 }]));
	assert.ok(!matchesLogPredicates({ level: null }, [{ op: '=', field: 'level', value: null }]));
});

test('vendor spellings resolve in a predicate too', () => {
	assert.ok(matchesLogPredicates(ROW, [{ op: '=', field: '@message', value: 'boom ERROR here' }]));
});

test('projection keeps order and fills absent fields with null', () => {
	assert.deepEqual(projectLogRow(ROW, ['level', 'nope', '@timestamp']), { level: 'ERROR', nope: null, ts: 100 });
	assert.equal(projectLogRow(ROW, undefined), ROW);
});

test('sorting is by field, descending on request, with missing values last either way', () => {
	const rows = [{ n: 2 }, { n: 1 }, {}, { n: 3 }];
	assert.deepEqual(sortLogRows([...rows], [{ field: 'n', desc: false }]), [{ n: 1 }, { n: 2 }, { n: 3 }, {}]);
	assert.deepEqual(sortLogRows([...rows], [{ field: 'n', desc: true }]), [{ n: 3 }, { n: 2 }, { n: 1 }, {}]);
});

test('grouped aggregation computes each function over its group', () => {
	const rows: LogRow[] = [
		{ level: 'ERROR', ms: 10 },
		{ level: 'ERROR', ms: 30 },
		{ level: 'WARN', ms: 5 },
	];
	const out = aggregateLogRows(rows, {
		by: ['level'],
		aggs: [
			{ fn: 'count', as: 'n' },
			{ fn: 'avg', field: 'ms', as: 'avg_ms' },
			{ fn: 'min', field: 'ms', as: 'lo' },
			{ fn: 'max', field: 'ms', as: 'hi' },
			{ fn: 'sum', field: 'ms', as: 'total' },
		],
	}, true);
	assert.deepEqual(out, [
		{ level: 'ERROR', n: 2, avg_ms: 20, lo: 10, hi: 30, total: 40 },
		{ level: 'WARN', n: 1, avg_ms: 5, lo: 5, hi: 5, total: 5 },
	]);
});

test('count(DISTINCT) counts distinct non-null values', () => {
	const rows: LogRow[] = [{ s: 'a' }, { s: 'a' }, { s: 'b' }, { s: null }];
	assert.deepEqual(aggregateLogRows(rows, { by: [], aggs: [{ fn: 'count', field: 's', distinct: true, as: 'd' }] }, true), [{ d: 2 }]);
});

test('an ungrouped aggregate over no rows is still one row', () => {
	assert.deepEqual(aggregateLogRows([], { by: [], aggs: [{ fn: 'count', as: 'n' }] }, true), [{ n: 0 }]);
	// …but a grouped one over no rows has no groups.
	assert.deepEqual(aggregateLogRows([], { by: ['level'], aggs: [{ fn: 'count', as: 'n' }] }, true), []);
});

test('an aggregate with no non-null values is NULL, not zero', () => {
	assert.deepEqual(aggregateLogRows([{ x: null }], { by: [], aggs: [{ fn: 'sum', field: 'x', as: 's' }] }, true), [{ s: null }]);
});

test('aggregating a truncated scan throws rather than reporting a wrong total', () => {
	assert.throws(
		() => aggregateLogRows([{ level: 'ERROR' }], { by: [], aggs: [{ fn: 'count', as: 'n' }] }, false),
		IncompleteAggregateError,
	);
});

test('result columns follow the projection, the aggregate, or the whole contract', () => {
	const base: LogsQuery = { scope: 's', start: 0, end: 1 };
	assert.deepEqual(logResultColumns(base), ['ts', 'message', 'stream', 'id', 'ingested_at']);
	assert.deepEqual(logResultColumns({ ...base, select: ['@message', 'level'] }), ['message', 'level']);
	assert.deepEqual(logResultColumns({ ...base, aggregate: { by: ['level'], aggs: [{ fn: 'count', as: 'n' }] } }), ['level', 'n']);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sqlToLogs, DEFAULT_LOG_WINDOW_MS } from './sqlToLogs';
import { CompileError, SqlSyntaxError, UnsupportedQueryError } from './sqlAst';
import type { DatabaseSchema } from '../../schema';

/** 2026-09-03T12:00:00.000Z — every relative assertion is anchored here so `now()` is testable. */
const NOW = Date.parse('2026-09-03T12:00:00.000Z');

const SCHEMA: DatabaseSchema = {
	name: 'eu-west-1',
	tables: [
		{ name: '/aws/lambda/api', columns: [] },
		{ name: 'app_logs', columns: [] },
	],
} as unknown as DatabaseSchema;

function compile(sql: string, schema: DatabaseSchema | null = SCHEMA) {
	return sqlToLogs(sql, { schema, now: NOW });
}

test('a bare SELECT * gets the default window and no projection', () => {
	const { query, windowFromSql, needsAggregation } = compile('SELECT * FROM app_logs');
	assert.equal(query.scope, 'app_logs');
	assert.equal(query.end, NOW);
	assert.equal(query.start, NOW - DEFAULT_LOG_WINDOW_MS);
	assert.equal(query.select, undefined);
	assert.equal(windowFromSql, false);
	assert.equal(needsAggregation, false);
});

test('the caller-supplied window is used when the SQL names none', () => {
	const window = { start: NOW - 86_400_000, end: NOW - 60_000 };
	const { query, windowFromSql } = sqlToLogs('SELECT * FROM app_logs', { schema: SCHEMA, now: NOW, window });
	assert.deepEqual({ start: query.start, end: query.end }, window);
	assert.equal(windowFromSql, false);
});

test('a ts bound in the WHERE wins over the caller window and leaves no predicate behind', () => {
	const { query, windowFromSql } = sqlToLogs("SELECT * FROM app_logs WHERE ts >= '2026-09-03T11:00:00Z'", {
		schema: SCHEMA,
		now: NOW,
		window: { start: NOW - 86_400_000, end: NOW - 60_000 },
	});
	assert.equal(query.start, Date.parse('2026-09-03T11:00:00Z'));
	// Only the start was bounded, so the end still comes from the caller.
	assert.equal(query.end, NOW - 60_000);
	assert.equal(query.where, undefined);
	assert.equal(windowFromSql, true);
});

test('exclusive and inclusive comparisons differ by exactly one millisecond', () => {
	const gt = compile("SELECT * FROM app_logs WHERE ts > '2026-09-03T11:00:00Z'").query;
	const gte = compile("SELECT * FROM app_logs WHERE ts >= '2026-09-03T11:00:00Z'").query;
	assert.equal(gt.start - gte.start, 1);
	const lt = compile("SELECT * FROM app_logs WHERE ts < '2026-09-03T11:30:00Z'").query;
	const lte = compile("SELECT * FROM app_logs WHERE ts <= '2026-09-03T11:30:00Z'").query;
	assert.equal(lte.end - lt.end, 1);
});

test("now(), now() minus millis and ago('15m') all resolve against the injected clock", () => {
	assert.equal(compile('SELECT * FROM app_logs WHERE ts > now() - 900000').query.start, NOW - 900_000 + 1);
	assert.equal(compile("SELECT * FROM app_logs WHERE ts >= ago('15m')").query.start, NOW - 900_000);
	assert.equal(compile("SELECT * FROM app_logs WHERE ts >= ago('2 hours')").query.start, NOW - 7_200_000);
	assert.equal(compile("SELECT * FROM app_logs WHERE ts >= ago('7d')").query.start, NOW - 604_800_000);
	assert.equal(compile('SELECT * FROM app_logs WHERE ts < now()').query.end, NOW);
});

test('BETWEEN on the time column is inclusive at both ends', () => {
	const { query } = compile("SELECT * FROM app_logs WHERE ts BETWEEN '2026-09-03T10:00:00Z' AND '2026-09-03T11:00:00Z'");
	assert.equal(query.start, Date.parse('2026-09-03T10:00:00Z'));
	assert.equal(query.end, Date.parse('2026-09-03T11:00:00Z') + 1);
});

test('several lower bounds narrow rather than replace each other', () => {
	const { query } = compile("SELECT * FROM app_logs WHERE ts > '2026-09-03T10:00:00Z' AND ts > '2026-09-03T11:00:00Z'");
	assert.equal(query.start, Date.parse('2026-09-03T11:00:00Z') + 1);
});

test('epoch seconds and epoch millis are both understood', () => {
	const seconds = Math.floor(Date.parse('2026-09-03T11:00:00Z') / 1000);
	assert.equal(compile(`SELECT * FROM app_logs WHERE ts >= ${seconds}`).query.start, seconds * 1000);
	const millis = Date.parse('2026-09-03T11:00:00Z');
	assert.equal(compile(`SELECT * FROM app_logs WHERE ts >= ${millis}`).query.start, millis);
});

test('vendor field spellings are normalised to the canonical contract', () => {
	const { query } = compile('SELECT "@timestamp", "@message", "@logStream" FROM app_logs');
	assert.deepEqual(query.select, ['ts', 'message', 'stream']);
});

test('an unknown field is passed through as a parsed field rather than rejected', () => {
	const { query } = compile("SELECT ts, level FROM app_logs WHERE level = 'ERROR'");
	assert.deepEqual(query.select, ['ts', 'level']);
	assert.deepEqual(query.where, [{ op: '=', field: 'level', value: 'ERROR' }]);
});

test('the supported predicate forms compile', () => {
	assert.deepEqual(compile("SELECT * FROM app_logs WHERE message LIKE '%ERROR%'").query.where, [
		{ op: 'like', field: 'message', pattern: '%ERROR%' },
	]);
	assert.deepEqual(compile("SELECT * FROM app_logs WHERE message ILIKE '%error%'").query.where, [
		{ op: 'like', field: 'message', pattern: '%error%', caseInsensitive: true },
	]);
	assert.deepEqual(compile("SELECT * FROM app_logs WHERE level IN ('WARN', 'ERROR')").query.where, [
		{ op: 'in', field: 'level', values: ['WARN', 'ERROR'] },
	]);
	assert.deepEqual(compile('SELECT * FROM app_logs WHERE stream IS NOT NULL').query.where, [
		{ op: 'is not null', field: 'stream' },
	]);
	assert.deepEqual(compile('SELECT * FROM app_logs WHERE duration_ms >= 250').query.where, [
		{ op: '>=', field: 'duration_ms', value: 250 },
	]);
});

test('GROUP BY with an aggregate compiles and flags that it needs the aggregating engine', () => {
	const { query, needsAggregation } = compile('SELECT level, count(*) AS n FROM app_logs GROUP BY level ORDER BY n DESC LIMIT 5');
	assert.equal(needsAggregation, true);
	assert.deepEqual(query.aggregate, { by: ['level'], aggs: [{ fn: 'count', as: 'n' }] });
	assert.deepEqual(query.orderBy, [{ field: 'n', desc: true }]);
	assert.equal(query.limit, 5);
	// The grouped projection replaces the scan projection rather than sitting beside it.
	assert.equal(query.select, undefined);
});

test('an ungrouped aggregate is a whole-window aggregate', () => {
	const { query } = compile('SELECT count(*) FROM app_logs');
	assert.deepEqual(query.aggregate, { by: [], aggs: [{ fn: 'count', as: 'count' }] });
});

test('count(DISTINCT x) and the numeric aggregates carry their field', () => {
	assert.deepEqual(compile('SELECT count(DISTINCT stream) AS streams FROM app_logs').query.aggregate?.aggs, [
		{ fn: 'count', field: 'stream', distinct: true, as: 'streams' },
	]);
	assert.deepEqual(compile('SELECT avg(duration_ms) AS d FROM app_logs').query.aggregate?.aggs, [
		{ fn: 'avg', field: 'duration_ms', as: 'd' },
	]);
});

test('a scope that introspection never reported is a terminal CompileError', () => {
	assert.throws(() => compile('SELECT * FROM nope'), (err: unknown) => {
		assert.ok(err instanceof CompileError);
		assert.match((err as Error).message, /no log scope called 'nope'/);
		return true;
	});
});

test('an unquoted scope name asks for the quotes, not for an AI translation', () => {
	// `/aws/lambda/api` written bare dies in the PARSER, whose message is a list of expected tokens
	// that never mentions quoting — and an UnsupportedQueryError there is what used to offer to spend
	// AI budget on a query one pair of quotes fixes. Terminal, and it spells the fix out.
	for (const sql of ['SELECT ts, message FROM /aws/lambda/api', 'select * from /aws/lambda/api limit 10']) {
		assert.throws(() => compile(sql), (err: unknown) => {
			assert.ok(err instanceof CompileError, sql);
			assert.match((err as Error).message, /has to be quoted/);
			assert.match((err as Error).message, /FROM "\/aws\/lambda\/api"/);
			return true;
		});
	}
	// It does not hijack every parse failure: this one has nothing to do with quoting, and gets the
	// shared near-miss table's answer instead (still terminal, still no model).
	assert.throws(() => compile('SELECT ts, FROM "/aws/lambda/api"'), (err: unknown) => {
		assert.ok(err instanceof SqlSyntaxError);
		assert.match((err as Error).message, /trailing comma/);
		return true;
	});
	// Nor does a division in a projection look like a path.
	assert.throws(() => compile('SELECT a / b FROM app_logs'), (err: unknown) => {
		assert.ok(err instanceof UnsupportedQueryError);
		assert.match((err as Error).message, /plain columns/);
		return true;
	});
});

test('schema-blind compilation accepts any scope', () => {
	assert.equal(compile('SELECT * FROM anything', null).query.scope, 'anything');
});

test('a write statement is terminal, never offered to the AI transcriber', () => {
	assert.throws(() => compile("INSERT INTO app_logs (message) VALUES ('x')"), CompileError);
	assert.throws(() => compile('DELETE FROM app_logs'), CompileError);
	assert.throws(() => compile("UPDATE app_logs SET message = 'x'"), CompileError);
});

test('the rejections that route to the AI transcriber are UnsupportedQueryError', () => {
	const cases = [
		'SELECT * FROM app_logs a JOIN other b ON a.id = b.id',
		"SELECT * FROM app_logs WHERE level = 'A' OR level = 'B'",
		'SELECT * FROM app_logs LIMIT 10 OFFSET 20',
		'SELECT DISTINCT stream FROM app_logs',
		'SELECT count(*) AS n FROM app_logs GROUP BY level HAVING count(*) > 5',
		'SELECT level, count(*) AS n FROM app_logs',
		'SELECT stream, count(*) AS n FROM app_logs GROUP BY level',
		'SELECT * FROM app_logs UNION SELECT * FROM app_logs',
		'WITH x AS (SELECT 1) SELECT * FROM app_logs',
		'SELECT upper(message) FROM app_logs',
		'SELECT message AS body FROM app_logs',
		'SELECT * FROM app_logs GROUP BY level',
	];
	for (const sql of cases) {
		assert.throws(() => compile(sql), UnsupportedQueryError, `expected ${sql} to be unsupported`);
	}
});

test('an empty time range is a terminal error rather than a query that returns nothing', () => {
	assert.throws(
		() => compile("SELECT * FROM app_logs WHERE ts >= '2026-09-03T12:00:00Z' AND ts < '2026-09-03T11:00:00Z'"),
		CompileError,
	);
});

test('an unreadable timestamp names itself in the error', () => {
	assert.throws(() => compile("SELECT * FROM app_logs WHERE ts > 'last tuesday'"), (err: unknown) => {
		assert.match((err as Error).message, /'last tuesday' is not a timestamp/);
		return true;
	});
});

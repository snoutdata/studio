/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withLogTimeBound } from './logs';
import { sqlToLogs } from '../../compile/sqlToLogs';

const SIX_HOURS = 6 * 60 * 60_000;

test('adds a WHERE to a statement that has none', () => {
	assert.equal(
		withLogTimeBound('select * from "/aws/lambda/orders-worker";', SIX_HOURS),
		`select * from "/aws/lambda/orders-worker" where ts >= ago('6h');`,
	);
});

test('keeps the statement\'s own keyword case', () => {
	assert.equal(
		withLogTimeBound('SELECT * FROM "/aws/lambda/orders-worker"', SIX_HOURS),
		`SELECT * FROM "/aws/lambda/orders-worker" WHERE ts >= ago('6h')`,
	);
});

test('lands before the clauses that may follow a WHERE', () => {
	assert.equal(
		withLogTimeBound('select level, count(*) from "app" group by level order by 2 desc limit 10', SIX_HOURS),
		`select level, count(*) from "app" where ts >= ago('6h') group by level order by 2 desc limit 10`,
	);
});

test('ANDs onto a WHERE that names no time', () => {
	assert.equal(
		withLogTimeBound(`select * from "app" where message like '%ERROR%' limit 200`, SIX_HOURS),
		`select * from "app" where message like '%ERROR%' and ts >= ago('6h') limit 200`,
	);
});

test('replaces a bound it wrote itself rather than adding a second', () => {
	const once = withLogTimeBound('select * from "app";', 60 * 60_000);
	assert.equal(once, `select * from "app" where ts >= ago('1h');`);
	assert.equal(withLogTimeBound(once!, 7 * 24 * 60 * 60_000), `select * from "app" where ts >= ago('7d');`);
});

test('replaces its own bound in the middle of a longer predicate', () => {
	assert.equal(
		withLogTimeBound(`select * from "app" where ts >= ago('1h') and level = 'ERROR' limit 50`, SIX_HOURS),
		`select * from "app" where ts >= ago('6h') and level = 'ERROR' limit 50`,
	);
});

test('refuses a bound somebody else wrote', () => {
	assert.equal(withLogTimeBound(`select * from "app" where ts between 1 and 2`, SIX_HOURS), null);
	assert.equal(withLogTimeBound(`select * from "app" where ts < now() - 3600000`, SIX_HOURS), null);
});

test('is not fooled by a keyword inside a literal', () => {
	assert.equal(
		withLogTimeBound(`select * from "app" where message like '%order by%'`, SIX_HOURS),
		`select * from "app" where message like '%order by%' and ts >= ago('6h')`,
	);
});

test('refuses a statement carrying a comment, rather than splicing into one', () => {
	assert.equal(withLogTimeBound('select * from "app" -- the one we care about', SIX_HOURS), null);
	assert.equal(withLogTimeBound('select * from "app" /* the one we care about */', SIX_HOURS), null);
});

test('refuses anything that is not one SELECT', () => {
	assert.equal(withLogTimeBound('delete from "app"', SIX_HOURS), null);
	assert.equal(withLogTimeBound('select 1; select 2', SIX_HOURS), null);
	assert.equal(withLogTimeBound('select * from "app" where', SIX_HOURS), null);
	assert.equal(withLogTimeBound('select * from "app"', 0), null);
});

test('spells the span the way ago() reads it', () => {
	const spans: [number, string][] = [
		[15 * 60_000, '15m'],
		[60 * 60_000, '1h'],
		[6 * 60 * 60_000, '6h'],
		[24 * 60 * 60_000, '1d'],
		[7 * 24 * 60 * 60_000, '7d'],
		[30 * 24 * 60 * 60_000, '30d'],
	];
	for (const [ms, literal] of spans) {
		assert.equal(withLogTimeBound('select * from "app"', ms), `select * from "app" where ts >= ago('${literal}')`);
	}
});

test('what it writes is what the compiler reads back', () => {
	const now = Date.UTC(2026, 8, 11, 12, 0, 0);
	const sql = withLogTimeBound('select * from "app" limit 200', SIX_HOURS)!;
	const compiled = sqlToLogs(sql, { now });
	assert.equal(compiled.windowFromSql, true);
	assert.equal(compiled.query.start, now - SIX_HOURS);
	// The END is deliberately left unbounded, so "last 6 hours" is the six before THIS run.
	assert.equal(compiled.query.end, now);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listDialects, readOnlyEnforcement } from './index';
import { readOnlyEnforcementFor } from './flavors';

// What a read-only run asks of each DATABASE. The statements are pinned
// exactly: each one is what the integration test (`server/src/readOnly.integration.test.ts`)
// proves the engine refuses a write under, and a quiet edit here would change what is enforced.

test('Postgres: a read-only session default and a READ ONLY transaction, both undone after', () => {
	const e = readOnlyEnforcement('postgres');
	assert.equal(e.mechanism, 'transaction');
	assert.deepEqual(e.begin, ['SET default_transaction_read_only = on', 'BEGIN TRANSACTION READ ONLY']);
	assert.deepEqual(e.end, ['ROLLBACK', 'RESET default_transaction_read_only']);
});

test('Redshift: a READ ONLY transaction, rolled back', () => {
	const e = readOnlyEnforcement('redshift');
	assert.deepEqual([e.mechanism, e.begin, e.end], ['transaction', ['BEGIN TRANSACTION READ ONLY'], ['ROLLBACK']]);
});

test('MySQL and MariaDB: session and transaction read-only, put back to READ WRITE', () => {
	for (const driver of ['mysql-aurora', 'mariadb']) {
		const e = readOnlyEnforcement(driver);
		assert.deepEqual(e.begin, ['SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION READ ONLY'], driver);
		assert.deepEqual(e.end, ['ROLLBACK', 'SET SESSION TRANSACTION READ WRITE'], driver);
	}
});

test('Oracle, SQLite and DuckDB use their own read-only statements', () => {
	assert.deepEqual(readOnlyEnforcement('oracle').begin, ['SET TRANSACTION READ ONLY']);
	assert.deepEqual(readOnlyEnforcement('oracle').end, ['ROLLBACK']);
	assert.deepEqual([readOnlyEnforcement('sqlite').begin, readOnlyEnforcement('sqlite').end], [['PRAGMA query_only = ON'], ['PRAGMA query_only = OFF']]);
	assert.deepEqual([readOnlyEnforcement('duckdb').begin, readOnlyEnforcement('duckdb').end], [['BEGIN TRANSACTION READ ONLY'], ['ROLLBACK']]);
});

test('ClickHouse is a request setting, with nothing to run or undo', () => {
	const e = readOnlyEnforcement('clickhouse');
	assert.deepEqual([e.mechanism, e.begin.length, e.end.length], ['setting', 0, 0]);
	assert.match(e.summary, /readonly = 2/);
});

test('SQL Server says it UNDOES a write, never that it refuses one', () => {
	const e = readOnlyEnforcement('sqlserver');
	assert.equal(e.mechanism, 'rollback');
	assert.match(e.summary, /undone, not refused/);
	assert.match(e.summary, /COMMIT/);
});

test('Snowflake, SAP HANA and Db2 claim only the statement check', () => {
	for (const driver of ['snowflake', 'hana', 'db2']) {
		const e = readOnlyEnforcement(driver);
		assert.equal(e.mechanism, 'none', driver);
		assert.deepEqual([e.begin.length, e.end.length], [0, 0], driver);
		assert.match(e.summary, /not asked to refuse writes: only the statement check/, driver);
	}
});

test('a flavor not known to honour the base driver\'s statements falls back to the statement check', () => {
	assert.equal(readOnlyEnforcementFor('mysql-aurora', 'tidb').mechanism, 'none');
	assert.match(readOnlyEnforcementFor('mysql-aurora', 'tidb').summary, /^TiDB /);
	assert.equal(readOnlyEnforcementFor('mysql-aurora', 'oceanbase').mechanism, 'none');
	assert.equal(readOnlyEnforcementFor('postgres', 'cockroachdb').mechanism, 'transaction');
	assert.equal(readOnlyEnforcementFor('postgres').mechanism, 'transaction');
});

test('every engine that runs statements also undoes them, and every summary is one sentence-ish line', () => {
	for (const dialect of listDialects()) {
		const e = readOnlyEnforcement(dialect.driverId);
		assert.equal(e.begin.length > 0, e.end.length > 0, `${dialect.driverId}: begin without end, or end without begin`);
		assert.ok(e.summary.length > 20 && !e.summary.includes('\n'), dialect.driverId);
		assert.doesNotMatch(e.summary, /—/, `${dialect.driverId}: no em-dash in text the user reads`);
	}
});

test('Postgres: the run is checked afterwards to still be inside a read-only transaction', () => {
	assert.equal(readOnlyEnforcement('postgres').verify, "SELECT current_setting('transaction_read_only') = 'on' AND now() <> statement_timestamp()");
	assert.match(readOnlyEnforcement('postgres').summary, /standard_conforming_strings/);
	assert.doesNotMatch(readOnlyEnforcement('postgres').summary, /refuses any write/);
});

// The transaction covers what the session writes here, and nothing that lands somewhere else.
test('Postgres and MySQL say the transaction covers writes here, and the statement check the rest', () => {
	for (const driver of ['postgres', 'mysql-aurora']) {
		const { summary } = readOnlyEnforcementFor(driver);
		assert.doesNotMatch(summary, /functions it calls included/, driver);
		assert.match(summary, /outside the database/, driver);
		assert.match(summary, /statement check/, driver);
	}
});

// What the statement check refuses beyond a write here, said where a person reads what holds.
test('the summaries name the reads that act outside the database and are refused by the statement check', () => {
	assert.match(readOnlyEnforcement('postgres').summary, /cloud AI service/);
	assert.match(readOnlyEnforcement('postgres').summary, /pg_ls_dir/);
	assert.match(readOnlyEnforcement('clickhouse').summary, /table function/);
	assert.match(readOnlyEnforcement('sqlserver').summary, /network path/);
	assert.match(readOnlyEnforcement('oracle').summary, /EXPLAIN PLAN/);
	for (const driver of ['db2', 'hana']) {
		assert.match(readOnlyEnforcement(driver).summary, /not on Db2 or SAP HANA/, driver);
	}
});

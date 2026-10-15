/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ConnectionConfig } from '../../shared/connection';
import type { DatabaseDriver } from './drivers/databaseDriver';
import { createDuckDbDriver } from './drivers/duckdb/duckdbDriver';
import { createSqliteDriver } from './drivers/sqlite/sqliteDriver';
import { configForTest, testConnection } from './testConnection';

// A Test of a file database must open an EXISTING file and never create one: a path a model chose
// (or a typo) used to leave an empty database behind, anywhere the user can write.

let duckAvailable = true;
try {
	require.resolve('@duckdb/node-api');
} catch {
	duckAvailable = false;
}

function factory(id: string): DatabaseDriver {
	if (id === 'sqlite') {
		return createSqliteDriver();
	}
	if (id === 'duckdb') {
		return createDuckDbDriver();
	}
	throw new Error(`no ${id} here`);
}

function fileConfig(driver: string, database: string): ConnectionConfig {
	return { id: 't', label: 't', driver, host: '', port: 0, username: '', database };
}

describe('testing a file database', () => {
	let dir: string;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'snout-test-conn-'));
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('the test config opens sqlite and duckdb read-only, and leaves every other driver alone', () => {
		assert.equal(configForTest(fileConfig('sqlite', '/x.db')).readOnly, true);
		assert.equal(configForTest(fileConfig('duckdb', '/x.duckdb')).readOnly, true);
		const pg = { ...fileConfig('postgres', 'app'), host: 'db', readOnly: false };
		assert.equal(configForTest(pg), pg);
	});

	test('sqlite: a missing path fails and no file is created', async () => {
		const missing = join(dir, 'nope', '..', 'made-up.db');
		const result = await testConnection(fileConfig('sqlite', missing), factory);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /never creates/);
		assert.equal(existsSync(missing), false);
	});

	test('sqlite: opening read-only does not create the file even past the existence check', async () => {
		const missing = join(dir, 'raced.db');
		const driver = createSqliteDriver();
		await assert.rejects(driver.connect(configForTest(fileConfig('sqlite', missing))));
		assert.equal(existsSync(missing), false);
	});

	test('sqlite: an existing file passes', async () => {
		const file = join(dir, 'real.db');
		const db = new DatabaseSync(file);
		db.exec('CREATE TABLE t (id INTEGER)');
		db.close();
		assert.deepEqual(await testConnection(fileConfig('sqlite', file), factory), { ok: true });
	});

	test('duckdb: a missing path fails and no file is created', { skip: !duckAvailable && '@duckdb/node-api is not installed' }, async () => {
		const missing = join(dir, 'made-up.duckdb');
		assert.equal((await testConnection(fileConfig('duckdb', missing), factory)).ok, false);
		assert.equal(existsSync(missing), false);
		const driver = createDuckDbDriver();
		await assert.rejects(driver.connect(configForTest(fileConfig('duckdb', missing))));
		assert.equal(existsSync(missing), false);
	});

	test('duckdb: an existing file passes', { skip: !duckAvailable && '@duckdb/node-api is not installed' }, async () => {
		const file = join(dir, 'real.duckdb');
		const writer = createDuckDbDriver();
		await writer.connect(fileConfig('duckdb', file));
		await writer.execute({ lang: 'sql', sql: 'CREATE TABLE t (id INTEGER)' });
		await writer.disconnect();
		assert.deepEqual(await testConnection(fileConfig('duckdb', file), factory), { ok: true });
	});
});

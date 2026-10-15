/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionConfig } from '../../../../shared/connection';
import type { DatabaseDriver } from '../databaseDriver';
import { createDuckDbDriver } from './duckdbDriver';

// DuckDB runs in this process, so a read-only run (the agent's, the assistant's, every
// statement on a read-only connection) must not reach the files and URLs the app can. Driven against
// the real engine; skipped where `@duckdb/node-api` is not installed (it is an on-demand component).

let available = true;
try {
	require.resolve('@duckdb/node-api');
} catch {
	available = false;
}

function config(database: string, readOnly = false): ConnectionConfig {
	return { id: 'duck', label: 'duck', driver: 'duckdb', host: '', port: 0, username: '', database, readOnly };
}

/** What DuckDB says when the confined handle refuses: no external access, locked settings, read-only file. */
const REFUSED = /disabled by configuration|disabled through configuration|configuration has been locked|Cannot enable external access|read-only mode/;

function read(driver: DatabaseDriver, sql: string) {
	return driver.execute({ lang: 'sql', sql, readOnly: true });
}

function run(driver: DatabaseDriver, sql: string) {
	return driver.execute({ lang: 'sql', sql });
}

describe('DuckDB read-only runs cannot reach files, URLs or extensions', { skip: !available && '@duckdb/node-api is not installed' }, () => {
	let dir: string;
	let file: string;
	let secret: string;
	let csv: string;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'snout-duckdb-'));
		file = join(dir, 'shop.duckdb');
		secret = join(dir, 'id_rsa');
		csv = join(dir, 'rows.csv');
		writeFileSync(secret, 'PRIVATE KEY');
		writeFileSync(csv, 'a,b\n1,2\n');
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('a writable connection: the session keeps its file access, a read-only run has none', async () => {
		const driver = createDuckDbDriver();
		await driver.connect(config(file));
		try {
			await run(driver, 'CREATE TABLE orders (id INTEGER)');
			await run(driver, 'INSERT INTO orders VALUES (1), (2)');
			// Interactive use of local files is the point of DuckDB, and stays.
			assert.deepEqual((await run(driver, `SELECT content FROM read_text('${secret}')`)).rows, [['PRIVATE KEY']]);

			// A read-only run sees what the session committed, uncheckpointed rows included.
			assert.deepEqual((await read(driver, 'SELECT count(*) FROM orders')).rows, [['2']]);

			for (const sql of [
				`SELECT content FROM read_text('${secret}')`,
				`SELECT content FROM read_blob('${secret}')`,
				`SELECT * FROM glob('${dir}/*')`,
				`SELECT * FROM read_csv('${csv}')`,
				`SELECT * FROM '${csv}'`,
				"SELECT * FROM read_csv('https://example.com/x.csv')",
				`COPY orders TO '${join(dir, 'out.csv')}'`,
				`ATTACH '${join(dir, 'other.duckdb')}' AS other`,
				'INSTALL httpfs',
				'LOAD httpfs',
				'SET enable_external_access = true',
				"SET allowed_paths = ['/']",
				'INSERT INTO orders VALUES (3)',
			]) {
				await assert.rejects(read(driver, sql), REFUSED, sql);
			}

			// The refusals touched nothing: the session still reads files and writes its table.
			assert.deepEqual((await run(driver, `SELECT content FROM read_text('${secret}')`)).rows, [['PRIVATE KEY']]);
			await run(driver, 'INSERT INTO orders VALUES (3)');
			assert.deepEqual((await read(driver, 'SELECT count(*) FROM orders')).rows, [['3']]);
		} finally {
			await driver.disconnect();
		}
	});

	test('a connection flagged read-only is confined on its own handle', async () => {
		const driver = createDuckDbDriver();
		await driver.connect(config(file, true));
		try {
			assert.deepEqual((await read(driver, 'SELECT count(*) FROM orders')).rows, [['3']]);
			for (const sql of [`SELECT content FROM read_text('${secret}')`, `SELECT * FROM '${csv}'`, 'SET enable_external_access = true', 'DELETE FROM orders']) {
				await assert.rejects(read(driver, sql), REFUSED, sql);
			}
			const schema = await driver.introspectSchema();
			assert.ok(JSON.stringify(schema).includes('orders'));
		} finally {
			await driver.disconnect();
		}
	});

	test('an in-memory database refuses a read-only run rather than run it unconfined', async () => {
		const driver = createDuckDbDriver();
		await driver.connect(config(':memory:'));
		try {
			await assert.rejects(read(driver, 'SELECT 1'), /in-memory/);
			assert.deepEqual((await run(driver, 'SELECT 1')).rows, [[1]]);
		} finally {
			await driver.disconnect();
		}
	});
});

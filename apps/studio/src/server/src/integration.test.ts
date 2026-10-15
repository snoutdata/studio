/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';

// End-to-end test against a real database, gated on SNOUTDATA_IT_* env vars so the
// normal `npm test` (no DB) skips it. Spawns the built server (out/server/server.js)
// and drives the same LSP requests the app uses. Run with, e.g.:
//   SNOUTDATA_IT_HOST=127.0.0.1 SNOUTDATA_IT_NAME=db SNOUTDATA_IT_USER=u \
//   SNOUTDATA_IT_PASSWORD=p npm test
// Other drivers: add SNOUTDATA_IT_DRIVER=postgres|sqlserver|oracle|db2|sqlite|duckdb|redshift|hana
//   (+ SNOUTDATA_IT_PORT).
// For Oracle, SNOUTDATA_IT_NAME is the service name and the port defaults to 1521.
// For Db2, SNOUTDATA_IT_NAME is the database name and the port defaults to 50000.
// For SQLite, SNOUTDATA_IT_NAME is the path to the .db file (host/port/user/password are ignored);
//   set SNOUTDATA_IT_HOST=sqlite just to enable the tier.
// For DuckDB, SNOUTDATA_IT_NAME is the path to the .duckdb file (host/port/user/password ignored);
//   set SNOUTDATA_IT_HOST=duckdb just to enable the tier.
// For Redshift, SNOUTDATA_IT_NAME is the database and the port is 5439.
// For SAP HANA, SNOUTDATA_IT_NAME is the TENANT DATABASE name (leave blank when connecting straight
//   to a tenant's SQL port) and the port is 3<instance>15 (30015 for instance 00) or 443 on HANA Cloud.
const enabled = Boolean(process.env.SNOUTDATA_IT_HOST);
const skip = enabled ? false : 'set SNOUTDATA_IT_* env vars to run integration tests';

const config = {
	id: 'integration',
	label: 'integration',
	driver: process.env.SNOUTDATA_IT_DRIVER ?? 'mysql-aurora',
	host: process.env.SNOUTDATA_IT_HOST,
	port: Number(process.env.SNOUTDATA_IT_PORT ?? 3306),
	database: process.env.SNOUTDATA_IT_NAME,
	username: process.env.SNOUTDATA_IT_USER,
	password: process.env.SNOUTDATA_IT_PASSWORD,
	// Opt-in TLS for managed endpoints (e.g. IBM Cloud Db2, which only accepts SSL connections).
	ssl: process.env.SNOUTDATA_IT_SSL === '1' ? true : undefined,
};

let child: ChildProcessWithoutNullStreams | undefined;
let conn: MessageConnection | undefined;
let tableCount = 0;
let firstTable: string | undefined;

before(async () => {
	if (!enabled) {
		return;
	}
	child = spawn(process.execPath, ['out/server/server.js', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
	conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
	conn.listen();
	await conn.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
	conn.sendNotification('initialized', {});
	const result = await conn.sendRequest('snout/connect', { config }) as { tableCount: number };
	tableCount = result.tableCount;
	const schema = await conn.sendRequest('snout/getSchema', { connectionId: config.id }) as { tables?: { name: string }[] } | null;
	firstTable = schema?.tables?.[0]?.name;
});

after(async () => {
	if (conn) {
		await conn.sendRequest('snout/disconnect', config.id).catch(() => undefined);
		conn.dispose();
	}
	child?.kill();
});

describe('server integration (env-gated)', () => {
	test('connect introspects a schema', { skip }, () => {
		assert.equal(typeof tableCount, 'number');
		assert.ok(tableCount >= 0);
	});

	test('executeQuery returns rows', { skip }, async () => {
		// Oracle/Db2/HANA SELECTs need a FROM clause; DUAL / SYSIBM.SYSDUMMY1 / DUMMY are their built-in
		// one-row tables.
		const sql = config.driver === 'oracle' ? 'SELECT 1 AS x FROM DUAL'
			: config.driver === 'db2' ? 'SELECT 1 AS x FROM SYSIBM.SYSDUMMY1'
			: config.driver === 'hana' ? 'SELECT 1 AS x FROM DUMMY'
			: 'SELECT 1 AS x';
		const r = await conn!.sendRequest('snout/executeQuery', { connectionId: config.id, query: { lang: 'sql', sql } }) as { ok: boolean; result: { rowCount: number; rows: unknown[][] } };
		assert.equal(r.ok, true);
		assert.equal(r.result.rowCount, 1);
		assert.equal(String(r.result.rows[0][0]), '1');
	});

	test('completion suggests tables after FROM', { skip }, async () => {
		const uri = 'inmemory://it/1';
		await conn!.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sql', version: 1, text: 'SELECT * FROM ' } });
		const items = await conn!.sendRequest('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 14 } }) as Array<{ kind?: number }>;
		assert.ok(Array.isArray(items) && items.length > 0);
		assert.ok(items.some((i) => i.kind === 22)); // Struct = table
	});

	test('hover describes the first table', { skip }, async (t) => {
		if (!firstTable) {
			t.skip('no tables in the test schema');
			return;
		}
		const uri = 'inmemory://it/2';
		const text = `SELECT * FROM ${firstTable}`;
		await conn!.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sql', version: 1, text } });
		const hover = await conn!.sendRequest('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: text.indexOf(firstTable) + 1 } }) as { contents?: unknown } | null;
		assert.ok(hover && hover.contents);
	});
});

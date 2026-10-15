/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dialectFor } from '../../../../shared/engine';
import type { ConnectionConfig } from '../../../../shared/connection';
import { createClickHouseDriver, isAccountReadOnlyRefusal, killStatements, onlyBindsParameters, parseBody, parseSet, parseUse, progressSql, readCost, readProgress, textResult, withExceptionCode } from './clickhouseDriver';

describe('a statement with its own FORMAT', () => {
	test('its output is the answer, one line per row, not a parse error', () => {
		const result = textResult('CSV', '1,"a"\n2,"b"\n', 3);
		assert.deepEqual(result.fields, [{ name: 'CSV', dataType: 'String' }]);
		assert.deepEqual(result.rows, [['1,"a"'], ['2,"b"']]);
		assert.equal(result.rowCount, 2);
	});
});

describe('ClickHouse session state over a stateless interface', () => {
	test('SET is remembered setting by setting, quoted values unquoted', () => {
		assert.deepEqual(parseSet('SET max_threads = 4'), [['max_threads', '4']]);
		assert.deepEqual(parseSet("SET format_csv_delimiter = ';', join_use_nulls = 1;"), [['format_csv_delimiter', ';'], ['join_use_nulls', '1']]);
		assert.deepEqual(parseSet("set a = 'x,y'"), [['a', 'x,y']]);
	});

	test('SET ROLE changes access, not a setting, and is not remembered', () => {
		assert.deepEqual(parseSet('SET ROLE analyst'), []);
		assert.deepEqual(parseSet('SET DEFAULT ROLE analyst TO bob'), []);
		assert.deepEqual(parseSet('SELECT 1'), []);
	});

	test('USE names the database', () => {
		assert.equal(parseUse('USE analytics'), 'analytics');
		assert.equal(parseUse('use `my db`;'), 'my db');
		assert.equal(parseUse('SELECT 1'), undefined);
	});
});

describe('ClickHouse answers', () => {
	test('an integer past 2^53 keeps every digit, without asking the server for a setting', () => {
		const body = '{"data":[[18446744073709551615, -9223372036854775807, 42, 1.5, 1e20]]}';
		assert.deepEqual(parseBody<{ data: unknown[][] }>(body).data[0], ['18446744073709551615', '-9223372036854775807', 42, 1.5, 1e20]);
	});

	test('what a statement read is its cost', () => {
		assert.deepEqual(readCost({ elapsed: 0.1, rows_read: 200000, bytes_read: '1600000' }), { engine: 'ClickHouse', recordsScanned: 200000, bytesScanned: 1600000 });
		assert.equal(readCost(undefined), undefined);
	});

	test('a body that is not JSON is ClickHouse talking, and is shown as such', () => {
		assert.throws(() => parseBody('Code: 241. DB::Exception: Memory limit exceeded (version 25.1.1.1)'), /^Error: Code: 241\. DB::Exception: Memory limit exceeded$/);
	});
});

test('Stop kills on the node it lands on, and on every replica when there are several', () => {
	assert.deepEqual(killStatements('q-1', undefined), ["KILL QUERY WHERE query_id = 'q-1'"]);
	assert.deepEqual(killStatements("q'1", 'default'), ["KILL QUERY WHERE query_id = 'q1'", "KILL QUERY ON CLUSTER `default` WHERE query_id = 'q1'"]);
	assert.equal(killStatements('q-1', 'c\\`x')[1], "KILL QUERY ON CLUSTER `c\\\\``x` WHERE query_id = 'q-1'");
});

test('a parameter bound with SET arrives as the escaped value the server parses', () => {
	const bind = dialectFor('clickhouse').bindParameters!;
	for (const value of ['42', "O'Brien", 'C:\\x\ty', "['a', 'b']", '']) {
		const [[name, sent]] = parseSet(bind({ p: value }));
		assert.equal(name, 'param_p');
		assert.equal(sent, value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t'));
	}
	assert.deepEqual(parseSet('SET param_ids = [1, 2], param_s = \'a,b\''), [['param_ids', '[1, 2]'], ['param_s', 'a,b']]);
	assert.equal(onlyBindsParameters("SET param_id = '1'"), true);
	assert.equal(onlyBindsParameters("SET param_id = '1', max_threads = 2"), false);
	assert.equal(onlyBindsParameters('SELECT 1'), false);
});

test('progress reads the running query, across replicas when there are several, and marks the read', () => {
	const local = progressSql('q-1', undefined);
	assert.match(local, /^\/\* snoutdata-ops \*\/ SELECT /);
	assert.match(local, /FROM system\.processes WHERE query_id = 'q-1'$/);
	const across = progressSql('q-1', { replicas: 2, cluster: 'default', settings: 'SETTINGS max_execution_time = 15' });
	assert.match(across, /FROM clusterAllReplicas\('default', system\.processes\) WHERE query_id = 'q-1'\nSETTINGS max_execution_time = 15$/);
	assert.deepEqual(readProgress({ read_rows: '1000', read_bytes: 8000, total_rows_approx: '0', memory_usage: '2048', peak_memory_usage: '4096' }),
		{ rowsRead: 1000, bytesRead: 8000, totalRowsEstimate: undefined, memoryBytes: 2048, peakMemoryBytes: 4096 });
});

test('the exception code header is put at the head of a message that lacks one', () => {
	assert.equal(withExceptionCode('Bad Gateway', '241'), 'Code: 241. DB::Exception: Bad Gateway');
	assert.equal(withExceptionCode('Code: 241. DB::Exception: x', '241'), 'Code: 241. DB::Exception: x');
	assert.equal(withExceptionCode('x', undefined), 'x');
});

test('an account that is already readonly = 1 is recognised by its refusal, and nothing else is', () => {
	// That account may not send readonly = 2, and the server already refuses its writes, so the
	// driver retries without the setting. A refused WRITE must not be mistaken for it.
	assert.equal(isAccountReadOnlyRefusal("Code: 164. DB::Exception: Cannot modify 'readonly' setting in readonly mode. (READONLY)"), true);
	assert.equal(isAccountReadOnlyRefusal('Code: 164. DB::Exception: default: Cannot execute query in readonly mode. (READONLY)'), false);
	assert.equal(isAccountReadOnlyRefusal("Code: 452. DB::Exception: Setting readonly should not be changed. (SETTING_CONSTRAINT_VIOLATION)"), false);
});

/**
 * A ClickHouse HTTP interface on 127.0.0.1 that answers every statement and keeps the settings each
 * request carried. `refuseReadOnly` answers a `readonly` setting the way a `readonly = 1` account's
 * server does.
 */
async function fakeClickHouse(refuseReadOnly = false): Promise<{ port: number; requests: { sql: string; settings: URLSearchParams }[]; close(): Promise<void> }> {
	const requests: { sql: string; settings: URLSearchParams }[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const settings = new URL(req.url ?? '/', 'http://x').searchParams;
			const sql = settings.get('query') ?? Buffer.concat(chunks).toString('utf8');
			requests.push({ sql, settings });
			if (refuseReadOnly && settings.has('readonly')) {
				res.writeHead(500, { 'X-ClickHouse-Exception-Code': '164' });
				res.end("Code: 164. DB::Exception: Cannot modify 'readonly' setting in readonly mode. (READONLY)");
				return;
			}
			if (/FORMAT CSV\s*$/.test(sql)) {
				res.writeHead(200, { 'X-ClickHouse-Format': 'CSV' });
				res.end('1,a\n2,b\n');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ meta: [{ name: '1', type: 'UInt8' }], data: [[1]] }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as AddressInfo).port,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe('an export from the server', () => {
	async function exportOnce(refuseReadOnly: boolean): Promise<{ sent: { sql: string; settings: URLSearchParams }; file: string }> {
		const fake = await fakeClickHouse(refuseReadOnly);
		const dir = mkdtempSync(join(tmpdir(), 'ch-export-'));
		const driver = createClickHouseDriver();
		try {
			await driver.connect({ id: 'c', label: 'c', driver: 'clickhouse', host: '127.0.0.1', port: fake.port, database: 'default', username: 'default' } as ConnectionConfig);
			const filePath = join(dir, 'out.csv');
			await driver.bulkExport!({ sql: 'SELECT * FROM events FORMAT CSV', filePath });
			const exports = fake.requests.filter((request) => /FORMAT CSV/.test(request.sql));
			return { sent: exports[exports.length - 1], file: readFileSync(filePath, 'utf8') };
		} finally {
			await driver.disconnect();
			await fake.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test('asks the server to refuse a write, since an export only reads', async () => {
		const { sent, file } = await exportOnce(false);
		assert.equal(sent.settings.get('readonly'), '2');
		assert.equal(file, '1,a\n2,b\n');
	});

	test('an account that is already readonly = 1 still exports, without the setting it may not send', async () => {
		const { sent, file } = await exportOnce(true);
		assert.equal(sent.settings.has('readonly'), false);
		assert.equal(file, '1,a\n2,b\n');
	});
});

describe('introspection', () => {
	async function introspectOnce(refuseReadOnly: boolean): Promise<{ sql: string; settings: URLSearchParams }[]> {
		const fake = await fakeClickHouse(refuseReadOnly);
		const driver = createClickHouseDriver();
		try {
			await driver.connect({ id: 'c', label: 'c', driver: 'clickhouse', host: '127.0.0.1', port: fake.port, database: 'default', username: 'default' } as ConnectionConfig);
			await driver.introspectSchema();
			return fake.requests.filter((request) => /system\.tables/.test(request.sql));
		} finally {
			await driver.disconnect();
			await fake.close();
		}
	}

	test('asks the server to refuse a write, since it runs with no click and builds SQL from catalog names', async () => {
		const sent = await introspectOnce(false);
		assert.ok(sent.length > 0);
		assert.ok(sent.every((request) => request.settings.get('readonly') === '2'));
	});

	test('an account that is already readonly = 1 still introspects, without the setting it may not send', async () => {
		const sent = await introspectOnce(true);
		assert.ok(sent.some((request) => !request.settings.has('readonly')));
	});
});

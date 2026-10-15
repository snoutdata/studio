/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { newMoveSpec, type MoveSpec } from '@snout/move';
import type { ConnectionConfig } from '../shared/connection';
import type { ExecuteQueryResult } from '../shared/protocol';
import { checkMove, connectionFor, fixMove, type MoveHost } from './moveService';

function connection(overrides: Partial<ConnectionConfig>): ConnectionConfig {
	return { id: 'x', label: 'x', driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'app', username: 'u', ...overrides } as ConnectionConfig;
}

const laptop = connection({ id: 'laptop', label: 'laptop' });
const cloud = connection({ id: 'cloud', label: 'home-test', host: 'qwertyzxcv123.db.snoutdata.com', cloudProjectRef: 'qwertyzxcv123' });

function answer(facts: Record<string, unknown>): ExecuteQueryResult {
	return { ok: true, result: { fields: [], rows: [[facts]], rowCount: 1, durationMs: 1 } } as unknown as ExecuteQueryResult;
}

const emptyDb = { serverMajor: 17, superuser: true, sizeBytes: 1000, schemas: [{ name: 'public', bytes: 0 }], extensions: ['plpgsql'], availableExtensions: ['plpgsql'], extensionTables: [], objects: [] };
const fullDb = { ...emptyDb, objects: [{ schema: 'public', name: 'orders', kind: 'table', arguments: null }] };

function host(options: { toolMajor?: number | null; target?: Record<string, unknown>; fail?: string; connections?: ConnectionConfig[] } = {}): MoveHost & { executed: string[] } {
	const executed: string[] = [];
	return {
		executed,
		connections: () => options.connections ?? [laptop, cloud],
		ensureConnected: async () => {},
		execute: async (id) => {
			executed.push(id);
			if (options.fail) {
				return { ok: false, error: options.fail } as unknown as ExecuteQueryResult;
			}
			return answer(id === 'cloud' ? (options.target ?? emptyDb) : fullDb);
		},
		toolMajor: async () => (options.toolMajor === undefined ? 17 : options.toolMajor)
	};
}

function spec(overrides: Partial<MoveSpec> = {}): MoveSpec {
	return {
		...newMoveSpec({
			id: 'm',
			name: 'laptop to cloud',
			source: { kind: 'connection', id: 'laptop', driver: 'postgres' },
			target: { kind: 'connection', id: 'cloud', driver: 'postgres' }
		}),
		...overrides
	};
}

test('two ordinary databases and installed tools: nothing stands in the way', async () => {
	const fake = host();
	const check = await checkMove(spec(), fake);
	assert.equal(check.error, null);
	assert.deepEqual(check.findings, []);
	assert.equal(check.ready, true);
	assert.deepEqual(fake.executed.sort(), ['cloud', 'laptop']);
});

test('without the tools the move is blocked, in a sentence', async () => {
	const check = await checkMove(spec(), host({ toolMajor: null }));
	assert.equal(check.ready, false);
	assert.equal(check.findings[0]?.id, 'tools-missing');
});

test('a hosted target is read with the platform profile, so its own objects do not make it full', async () => {
	const hosted = { ...emptyDb, schemas: [{ name: 'auth', bytes: 0 }, { name: 'public', bytes: 0 }], objects: [{ schema: 'auth', name: 'users', kind: 'table', arguments: null }] };
	const check = await checkMove(spec(), host({ target: hosted }));
	assert.equal(check.ready, true);
});

test('a target that holds tables is fixed by replacing it, applied in main against a fresh check', async () => {
	const fake = host({ target: fullDb });
	const before = await checkMove(spec(), fake);
	assert.equal(before.findings[0]?.key, 'target-not-empty');
	assert.deepEqual(before.drops, []);

	const outcome = await fixMove(spec(), 'target-not-empty', 'replaceTarget', fake);
	assert.ok(outcome.ok);
	assert.equal(outcome.ok && outcome.spec.targetMode, 'replace');
	assert.equal(outcome.ok && outcome.check.ready, true);
	assert.deepEqual(outcome.ok && outcome.check.drops, ['public.orders']);
});

test('a fix for a finding that is not there is refused', async () => {
	const outcome = await fixMove(spec(), 'target-not-empty', 'replaceTarget', host());
	assert.equal(outcome.ok, false);
});

test('a database that cannot be read is an error naming it, not a crash', async () => {
	const check = await checkMove(spec(), host({ fail: 'connection refused' }));
	assert.match(String(check.error), /Could not read ".*": connection refused/);
	assert.equal(check.ready, false);
});

test('a non-Postgres end is never asked Postgres questions; the strategy explains', async () => {
	const mysql = connection({ id: 'my', label: 'mysql', driver: 'mysql' });
	const fake = host({ connections: [laptop, mysql] });
	const check = await checkMove(spec({ target: { kind: 'connection', id: 'my', driver: 'mysql' } }), fake);
	// The Postgres end is read; the MySQL end is not asked a Postgres catalogue query.
	assert.deepEqual(fake.executed, ['laptop']);
	assert.equal(check.findings[0]?.id, 'strategy-refused');
});

test('a new database is checked by asking its server, and nothing is created by checking', async () => {
	const sql: string[] = [];
	const fake: MoveHost = {
		connections: () => [laptop, cloud],
		ensureConnected: async () => {},
		execute: async (id, text) => {
			sql.push(`${id}: ${text.slice(0, 40)}`);
			return id === 'cloud'
				? answer({ serverMajor: 17, superuser: false, canCreate: true, nameTaken: false, availableExtensions: [] })
				: answer(fullDb);
		},
		toolMajor: async () => 17
	};
	const check = await checkMove(spec({ target: { kind: 'newDatabase', serverConnectionId: 'cloud', database: 'shop_copy', driver: 'postgres' } }), fake);
	assert.equal(check.error, null);
	assert.deepEqual(check.findings.map((finding) => finding.id), ['new-target']);
	assert.ok(sql.every((line) => !/create database/i.test(line)));
});

test('a new cloud project is never queried: its facts are what every new project is', async () => {
	const fake = host({ toolMajor: 18 });
	const check = await checkMove(spec({ target: { kind: 'newCloudProject', name: 'shop', region: 'us-west-2', driver: 'postgres' } }), fake);
	assert.deepEqual(fake.executed, ['laptop']);
	assert.deepEqual(check.findings.map((finding) => finding.id), ['new-target']);
	assert.equal(check.ready, true);
});

test('a new cloud project runs 18, so tools older than that are refused before anything is created', async () => {
	const check = await checkMove(spec({ target: { kind: 'newCloudProject', name: 'shop', region: 'us-west-2', driver: 'postgres' } }), host({ toolMajor: 17 }));
	assert.equal(check.ready, false);
	assert.ok(check.findings.some((finding) => finding.id === 'tool-too-old'));
});

test('a cloud endpoint resolves to the connection imported from that project', () => {
	assert.equal(connectionFor({ kind: 'cloud', ref: 'qwertyzxcv123', driver: 'postgres' }, [laptop, cloud])?.id, 'cloud');
	assert.equal(connectionFor({ kind: 'cloud', ref: 'aaaaaaaaaaaaa', driver: 'postgres' }, [laptop, cloud]), undefined);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { newMoveSpec, type MoveRunResult, type MoveSpec } from '@snout/move';
import type { ConnectionConfig } from '../shared/connection';
import type { MoveRunRecord } from '../shared/move';
import type { ExecuteQueryResult } from '../shared/protocol';
import { CloudRequestError, type CloudApi, type CloudProjectSummary } from './cloudApi';
import { MoveRuns, pgAccessFor, wakeProject, type MoveRunDeps } from './moveRunner';

function connection(overrides: Partial<ConnectionConfig>): ConnectionConfig {
	return { id: 'x', label: 'x', driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'app', username: 'u', ...overrides } as ConnectionConfig;
}

test('a tool reaches a connection the way the app driver does, TLS verified where the driver verifies', () => {
	const roots = ['ROOT-A', 'ROOT-B'];
	assert.deepEqual(pgAccessFor(connection({ password: 'pw' }), roots), { host: '127.0.0.1', port: 5432, user: 'u', password: 'pw', database: 'app', sslmode: 'prefer', caPem: null });
	assert.equal(pgAccessFor(connection({ database: undefined }), roots).database, 'u');
	const hosted = pgAccessFor(connection({ ssl: { rejectUnauthorized: true } }), roots);
	assert.equal(hosted.sslmode, 'verify-full');
	assert.equal(hosted.caPem, 'ROOT-A\nROOT-B');
	assert.equal(pgAccessFor(connection({ ssl: true }), roots).sslmode, 'verify-full');
	assert.equal(pgAccessFor(connection({ ssl: { rejectUnauthorized: true, ca: 'RDS' } }), roots).caPem, 'RDS');
	assert.deepEqual(pgAccessFor(connection({ ssl: { rejectUnauthorized: false } }), roots).sslmode, 'require');
	assert.throws(() => pgAccessFor(connection({ label: 'bastion', sshTunnelRef: 't' }), roots), /"bastion" connects through an SSH tunnel/);
});

function project(overrides: Partial<CloudProjectSummary> = {}): CloudProjectSummary {
	return { ref: 'qwertyzxcv123', name: 'home', region: 'us-west-2', production: false, state: 'paused', host: 'h', database: 'd', user: 'u', wakesInstantly: false, readOnly: false, ...overrides };
}

test('a paused project is resumed and nothing proceeds until it is ready', async () => {
	const states = ['paused', 'restoring', 'restoring', 'ready'];
	const said: string[] = [];
	let resumed = 0;
	const cloud = {
		list: async () => [project({ state: states.shift() ?? 'ready' })],
		resume: async () => {
			resumed++;
			return { project: project(), changed: true };
		}
	} as unknown as CloudApi;
	await wakeProject(cloud, 'qwertyzxcv123', 'home', (message) => said.push(message), async () => undefined);
	assert.equal(resumed, 1);
	assert.deepEqual(said, ['Waking "home"', 'Waiting for "home": restoring', 'Waiting for "home": restoring']);
	assert.equal(states.length, 0);
});

test('a wake that lands in a control-plane deploy waits it out instead of failing the move', async () => {
	// Seen live 2026-10-15: a deploy restarted the front door and the poll got a 521.
	const answers: (string | number)[] = ['paused', 521, 'restoring', 502, 0, 'ready'];
	let resumed = 0;
	const cloud = {
		list: async () => {
			const next = answers.shift() ?? 'ready';
			if (typeof next === 'number') {
				throw new CloudRequestError("The function answered " + next, next);
			}
			return [project({ state: next })];
		},
		resume: async () => {
			resumed++;
			return { project: project(), changed: true };
		}
	} as unknown as CloudApi;
	await wakeProject(cloud, 'qwertyzxcv123', 'home', () => undefined, async () => undefined);
	assert.equal(resumed, 1);
	assert.equal(answers.length, 0);
});

test('a refusal while waking is not retried', async () => {
	let calls = 0;
	const cloud = { list: async () => { calls++; throw new CloudRequestError("no", 403); } } as unknown as CloudApi;
	await assert.rejects(wakeProject(cloud, 'qwertyzxcv123', 'home', () => undefined, async () => undefined), /no/);
	assert.equal(calls, 1);
});

const emptyDb = { serverMajor: 17, superuser: true, sizeBytes: 1000, schemas: [{ name: 'public', bytes: 0 }], extensions: [], availableExtensions: [], extensionTables: [], objects: [] };
const fullDb = { ...emptyDb, objects: [{ schema: 'public', name: 'orders', kind: 'table', arguments: null }] };

function deps(connections: ConnectionConfig[], toolsDir: string | null, finished: (result: MoveRunResult) => void, records: MoveRunRecord[] = []): MoveRunDeps {
	return {
		connections: () => connections,
		ensureConnected: async () => undefined,
		execute: async (id) => ({ ok: true, result: { fields: [], rows: [[id === 'prod' ? emptyDb : fullDb]], rowCount: 1, durationMs: 1 } }) as unknown as ExecuteQueryResult,
		toolMajor: async () => 17,
		resolved: async (id) => ({ ...connections.find((entry) => entry.id === id)!, password: 'pw' }),
		copyForDatabase: () => {
			throw new Error('not used');
		},
		saveConnection: () => {
			throw new Error('not used');
		},
		cloud: {} as CloudApi,
		toolsDir: () => toolsDir,
		record: (run) => records.push(run),
		recoverInterrupted: () => undefined,
		onProgress: () => undefined,
		onFinished: finished
	};
}

const laptop = connection({ id: 'laptop', label: 'laptop' });
// Another database: two connections to the same one are refused by preflight as the same database.
const prod = connection({ id: 'prod', label: 'orders prod', database: 'orders', environment: 'prod' });

function spec(): MoveSpec {
	return newMoveSpec({ id: 'm', name: 'm', source: { kind: 'connection', id: 'laptop', driver: 'postgres' }, target: { kind: 'connection', id: 'prod', driver: 'postgres' } });
}

test('starting refuses a production target until its name is typed, checked in main', async () => {
	const runs = new MoveRuns(deps([laptop, prod], '/tools', () => undefined));
	const refused = await runs.start(spec(), { target: 'orders' });
	assert.deepEqual(refused, { ok: false, error: 'The target is a production database. Type "orders prod" to start the move.' });
	assert.equal(runs.state('m').running, false);
});

test('starting refuses without the tools, and a started run lands in the ledger with its report', async () => {
	assert.equal((await new MoveRuns(deps([laptop, prod], null, () => undefined)).start(spec(), { target: 'orders prod' })).ok, false);

	const records: MoveRunRecord[] = [];
	let resolveFinished: (result: MoveRunResult) => void = () => undefined;
	const finished = new Promise<MoveRunResult>((resolve) => (resolveFinished = resolve));
	const runs = new MoveRuns(deps([laptop, prod], '/nowhere/at/all', resolveFinished, records));
	const started = await runs.start(spec(), { target: 'orders prod' });
	assert.equal(started.ok, true);
	const result = await finished;
	// The tools are not where they were said to be, so the run fails, and says which tool.
	assert.equal(result.status, 'failed');
	assert.match(result.error ?? '', /Could not start pg_(dump|restore)/);
	assert.deepEqual(records.map((record) => record.status), ['running', 'failed']);
	assert.equal(runs.state('m').result?.status, 'failed');
});

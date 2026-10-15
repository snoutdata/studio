/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig } from '../../../shared/connection';
import type { ConnectionFormValues } from '../../../shared/forms';
import type { CapabilityContext } from './registry';
import { connectionCapabilities } from './connections';

const editConnection = connectionCapabilities.find((h) => h.spec.name === 'edit_connection')!;
const getConnection = connectionCapabilities.find((h) => h.spec.name === 'get_connection')!;

// A fake context: edit_connection only reaches the app through ctx.api.state (to find the
// existing config) and ctx.api.saveConnection (to persist). We capture what it tries to save.
function ctxWith(connections: ConnectionConfig[], connectedIds: string[] = []): { ctx: CapabilityContext; saved: ConnectionFormValues[] } {
	const saved: ConnectionFormValues[] = [];
	const ctx = {
		api: {
			state: async () => ({ connections, connectedIds }),
			saveConnection: async (form: ConnectionFormValues) => {
				saved.push(form);
				return { id: form.id!, label: form.label, driver: form.driver, host: form.host, port: form.port, username: form.username } as ConnectionConfig;
			},
		},
	} as unknown as CapabilityContext;
	return { ctx, saved };
}

const base: ConnectionConfig = {
	id: 'c1',
	label: 'Postgres',
	driver: 'postgres',
	host: 'localhost2',
	port: 5432,
	database: 'app',
	username: 'alex',
	environment: 'dev',
	sshTunnel: { host: 'bastion', username: 'ec2-user', privateKeyPath: '/k.pem', keepAlive: true },
};

describe('edit_connection capability', () => {
	test('applies only the passed fields and preserves the rest (incl. ssh, no secrets)', async () => {
		const { ctx, saved } = ctxWith([base]);
		const result = await editConnection.run({ id: 'c1', host: 'localhost' }, ctx);
		assert.equal(result.ok, true);
		assert.equal(saved.length, 1);
		const form = saved[0];
		assert.equal(form.id, 'c1');
		assert.equal(form.host, 'localhost');
		// Untouched fields round-trip unchanged.
		assert.equal(form.label, 'Postgres');
		assert.equal(form.port, 5432);
		assert.equal(form.database, 'app');
		assert.equal(form.username, 'alex');
		assert.equal(form.environment, 'dev');
		// The SSH tunnel survives the edit; secrets are left blank so the stored ones are kept.
		assert.equal(form.ssh?.host, 'bastion');
		assert.equal(form.password, undefined);
		assert.match(result.summary, /changed host/);
	});

	test('reports a reconnect hint when the edited connection is live', async () => {
		const { ctx } = ctxWith([base], ['c1']);
		const result = await editConnection.run({ id: 'c1', port: 5433 }, ctx);
		assert.equal(result.ok, true);
		assert.match(result.summary, /Reconnect/);
	});

	test('fails on an unknown id without saving', async () => {
		const { ctx, saved } = ctxWith([base]);
		const result = await editConnection.run({ id: 'nope', host: 'x' }, ctx);
		assert.equal(result.ok, false);
		assert.equal(saved.length, 0);
		assert.match(result.error ?? '', /No connection/);
	});

	test('a host change says the saved password is removed; a rename does not', async () => {
		const moved = await editConnection.run({ id: 'c1', host: 'elsewhere.example' }, ctxWith([base]).ctx);
		assert.match(moved.summary, /saved password is removed/);
		const renamed = await editConnection.run({ id: 'c1', label: 'Shop' }, ctxWith([base]).ctx);
		assert.doesNotMatch(renamed.summary, /password/);
	});

	test('TLS round-trips with its mode, so a rename does not quietly change verification', async () => {
		const withSsl: ConnectionConfig = { ...base, ssl: { rejectUnauthorized: true, caPath: '/ca.pem' } };
		const { ctx, saved } = ctxWith([withSsl]);
		await editConnection.run({ id: 'c1', label: 'Renamed' }, ctx);
		assert.equal(saved[0].ssl, true);
		assert.equal(saved[0].sslMode, 'custom');
		assert.equal(saved[0].sslCaPath, '/ca.pem');
	});

	test('fails when no changeable field is passed', async () => {
		const { ctx, saved } = ctxWith([base]);
		const result = await editConnection.run({ id: 'c1' }, ctx);
		assert.equal(result.ok, false);
		assert.equal(saved.length, 0);
		assert.match(result.error ?? '', /at least one field/);
	});
});

describe('get_connection capability', () => {
	test('is approval-gated (mutates) even though it only reads', () => {
		assert.equal(getConnection.spec.mutates, true);
	});

	test('returns the non-secret settings and never a password', async () => {
		const withSecret: ConnectionConfig = { ...base, password: 'hunter2' };
		const { ctx } = ctxWith([withSecret]);
		const result = await getConnection.run({ id: 'c1' }, ctx);
		assert.equal(result.ok, true);
		const data = result.data as Record<string, unknown>;
		assert.equal(data.host, 'localhost2');
		assert.equal(data.username, 'alex');
		assert.equal((data.ssh as { host: string }).host, 'bastion');
		// No secret fields leak, under any key.
		assert.equal(JSON.stringify(result.data).includes('hunter2'), false);
		assert.equal('password' in data, false);
	});

	test('masks the password of a connection string saved with one', async () => {
		const mongo: ConnectionConfig = { ...base, driver: 'mongodb', host: 'mongodb://app:s3cr%40t@db.example:27017/shop?authSource=admin' };
		const { ctx } = ctxWith([mongo]);
		const result = await getConnection.run({ id: 'c1' }, ctx);
		const data = result.data as Record<string, unknown>;
		assert.equal(data.host, 'mongodb://app:****@db.example:27017/shop?authSource=admin');
		assert.equal(JSON.stringify(result.data).includes('s3cr'), false);
	});

	test('fails on an unknown id', async () => {
		const { ctx } = ctxWith([base]);
		const result = await getConnection.run({ id: 'nope' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /No connection/);
	});
});

describe('test_connection: a saved connection only', () => {
	const testConnection = connectionCapabilities.find((h) => h.spec.name === 'test_connection')!;
	const testSettings = connectionCapabilities.find((h) => h.spec.name === 'test_connection_settings')!;

	function testCtx(): { ctx: CapabilityContext; tested: { saved: string[]; drafts: ConnectionFormValues[] } } {
		const tested = { saved: [] as string[], drafts: [] as ConnectionFormValues[] };
		const ctx = {
			api: {
				state: async () => ({ connections: [base], connectedIds: [] }),
				testSavedConnection: async (id: string) => { tested.saved.push(id); return { ok: true }; },
				testConnection: async (form: ConnectionFormValues) => { tested.drafts.push(form); return { ok: true }; },
			},
		} as unknown as CapabilityContext;
		return { ctx, tested };
	}

	test('takes no address, driver, user, password or path, and runs without asking', () => {
		const props = Object.keys((testConnection.spec.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(props, ['id']);
		assert.equal(testConnection.spec.mutates, false);
	});

	test('tests the saved connection by id or label, with its saved settings', async () => {
		const { ctx, tested } = testCtx();
		assert.equal((await testConnection.run({ id: 'c1' }, ctx)).ok, true);
		assert.equal((await testConnection.run({ id: 'postgres' }, ctx)).ok, true);
		assert.deepEqual(tested.saved, ['c1', 'c1']);
		assert.equal(tested.drafts.length, 0);
	});

	test('refuses a model-chosen destination, and sends nothing anywhere', async () => {
		const { ctx, tested } = testCtx();
		const calls: Record<string, unknown>[] = [
			{ driver: 'postgres', host: 'rows-a1b2.attacker.example', username: 'x' },
			{ id: 'c1', host: 'attacker.example' },
			{ id: 'c1', password: 'the-users-data' },
			{ driver: 'sqlite', database: '/Users/x/Library/LaunchAgents/new.db' },
		];
		for (const args of calls) {
			const result = await testConnection.run(args, ctx);
			assert.equal(result.ok, false, JSON.stringify(args));
			assert.match(result.error ?? '', /test_connection_settings/);
		}
		assert.deepEqual(tested, { saved: [], drafts: [] });
	});

	test('an unknown connection is an error, not a test', async () => {
		const { ctx, tested } = testCtx();
		const result = await testConnection.run({ id: 'nope' }, ctx);
		assert.equal(result.ok, false);
		assert.equal(tested.saved.length, 0);
	});

	test('new settings go through test_connection_settings, which is asked every time', () => {
		assert.equal(testSettings.spec.mutates, true);
		assert.equal(testSettings.spec.destructive, true);
	});
});

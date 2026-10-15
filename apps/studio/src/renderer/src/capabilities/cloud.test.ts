/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CloudProjectRow } from '../../../shared/cloudProjects';
import type { CapabilityContext } from './registry';
import { cloudCapabilities } from './cloud';

// The assistant's and the coding agents' cloud tools. What matters for a small model: a project
// is found by the NAME the user said, a refusal stays a refusal in the control plane's words, and
// no tool ever returns a secret.

const tool = (name: string) => cloudCapabilities.find((h) => h.spec.name === name)!;

function row(over: Partial<CloudProjectRow> = {}): CloudProjectRow {
	return {
		ref: 'qwertyzxcv123', name: 'Orders', region: 'us-west-2', production: false, state: 'ready', busy: false,
		readOnly: false, wakesInstantly: true, sizeBytes: 100, host: 'qwertyzxcv123.db.snoutdata.com', database: 'qwertyzxcv123',
		user: 'qwertyzxcv123_owner', createdAt: null, lastConnectionAt: null, canPause: true, canResume: false, canDelete: true,
		...over,
	};
}

function ctxWith(api: Record<string, unknown>, opened: unknown[] = []): CapabilityContext {
	return {
		api: { cloudProjects: async () => ({ account: 'you@example.com', projects: [row()] }), ...api },
		app: { openCloudProject: (...a: unknown[]) => { opened.push(a); } },
		snapshot: () => ({ connections: [], tabs: [], appSettings: {} }),
	} as unknown as CapabilityContext;
}

test('every cloud tool that changes something is marked as mutating and carries a consent sentence', () => {
	for (const h of cloudCapabilities) {
		if (h.spec.mutates) {
			assert.ok(h.spec.consentLabel, `${h.spec.name} needs a consentLabel`);
		}
	}
	assert.equal(tool('list_cloud_projects').spec.mutates, false);
	assert.equal(tool('get_cloud_project').spec.mutates, false);
});

test('a project is found by its name, case-insensitive, and stopped by its ref', async () => {
	const asked: unknown[] = [];
	const result = await tool('stop_cloud_project').run({ project: 'orders' }, ctxWith({ cloudAsk: async (a: string, r: string) => { asked.push([a, r]); return { ok: true, message: 'Asked it to stop.' }; } }));
	assert.equal(result.ok, true);
	assert.deepEqual(asked, [['pause', 'qwertyzxcv123']]);
});

test('an unknown project says which ones exist', async () => {
	const result = await tool('delete_cloud_project').run({ project: 'billing' }, ctxWith({}));
	assert.equal(result.ok, false);
	assert.match(result.error ?? '', /No project "billing"\. Projects: Orders/);
});

test('a refusal from the control plane is a refusal, in its words', async () => {
	const result = await tool('stop_cloud_project').run({ project: 'Orders' }, ctxWith({ cloudAsk: async () => ({ ok: false, refused: true, message: 'a production project is never paused' }) }));
	assert.deepEqual({ ok: result.ok, refused: result.refused, error: result.error }, { ok: false, refused: true, error: 'a production project is never paused' });
});

test('signed out, every tool says so instead of guessing', async () => {
	const ctx = ctxWith({ cloudProjects: async () => ({ account: null, projects: [], unavailable: 'Sign in to SnoutData to see your hosted databases.' }) });
	const result = await tool('get_cloud_project').run({ project: 'Orders' }, ctx);
	assert.match(result.error ?? '', /Sign in/);
});

test('create passes the name, region and production flag, and reports the connection', async () => {
	let form: unknown;
	const result = await tool('create_cloud_project').run({ name: 'billing', production: true }, ctxWith({ cloudCreate: async (f: unknown) => { form = f; return { ok: true, ref: 'newref', connected: true, message: 'Created newref.' }; } }));
	assert.deepEqual(form, { name: 'billing', region: 'us-west-2', production: true });
	assert.deepEqual(result.data, { ref: 'newref', addedAsConnection: true });
});

test('get_cloud_project carries products, functions and secret names, and no secret values', async () => {
	const ctx = ctxWith({
		cloudProject: async (op: string) => {
			switch (op) {
				case 'services': return { ok: true, data: { auth: { enabled: true }, storage: { enabled: false }, dataApi: { enabled: false, allowed: false }, errors: {} } };
				case 'functions': return { ok: true, data: { functions: [{ name: 'hello' }], secrets: [{ name: 'STRIPE_KEY', bytes: 40 }] } };
				case 'domains': return { ok: true, data: [] };
				default: return { ok: true, data: { days: [{ day: 'd', dbBytes: 5 }], limit: { tier: 'free', maxStorageBytes: 10 } } };
			}
		},
	});
	const result = await tool('get_cloud_project').run({ project: 'Orders' }, ctx);
	const data = result.data as Record<string, unknown>;
	assert.deepEqual(data.products, { auth: true, storage: false, dataApi: false, dataApiAllowedOnPlan: false });
	assert.deepEqual(data.functions, ['hello']);
	assert.deepEqual(data.secretNames, ['STRIPE_KEY']);
	assert.equal(JSON.stringify(data).includes('password'), false);
});

test('size_cloud_function passes the size through and reports what the function now runs at', async () => {
	const asked: unknown[] = [];
	const ctx = ctxWith({
		cloudProject: async (op: string, args: unknown) => {
			asked.push([op, args]);
			return { ok: true, data: { functions: [{ name: 'hello', memoryMb: 256, concurrency: 4 }], secrets: [], plan: { tier: 'plus', functionMemoryMb: 256, concurrencyMax: 4, podMemoryMb: 1024 } } };
		},
	});
	assert.equal(tool('size_cloud_function').spec.mutates, true);
	const result = await tool('size_cloud_function').run({ project: 'Orders', name: 'hello', memoryMb: 256, concurrency: 4 }, ctx);
	assert.equal(result.ok, true);
	assert.match(result.summary, /256 MB × 4 workers/);
	assert.deepEqual(asked, [['sizeFunction', { ref: 'qwertyzxcv123', name: 'hello', memoryMb: 256, concurrency: 4, reset: false }]]);
	const nothing = await tool('size_cloud_function').run({ project: 'Orders', name: 'hello' }, ctx);
	assert.equal(nothing.ok, false);
});

test('open_cloud_project opens the tab at the section asked for, or the overview', async () => {
	const opened: unknown[] = [];
	await tool('open_cloud_project').run({ project: 'Orders', section: 'settings' }, ctxWith({}, opened));
	await tool('open_cloud_project').run({ project: 'Orders', section: 'nonsense' }, ctxWith({}, opened));
	assert.deepEqual(opened, [['qwertyzxcv123', 'Orders', 'settings'], ['qwertyzxcv123', 'Orders', 'overview']]);
});

test('no tool takes a secret value: a secret in a tool call is a secret in the audit log', () => {
	for (const h of cloudCapabilities) {
		const props = (h.spec.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		assert.equal('value' in props || 'password' in props, false, h.spec.name);
	}
	assert.ok(tool('remove_cloud_secret'));
	assert.equal(cloudCapabilities.some((h) => h.spec.name === 'set_cloud_secret'), false);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * A project's AI section, driven against a FAKE control plane on 127.0.0.1 (`SNOUT_E2E_CLOUD_API`,
 * honoured only under a scratch profile, as in cloud-panel.spec.ts). The real IPC, the real door in
 * main and the real section; only `cloud-project-ai` is played here, in the shapes the relay answers.
 */

let handle: AppHandle;
let server: Server;
/** Every admin call the app sent. */
let calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];

const REF = 'aaaaaaaaaaaaa';

const MODEL = {
	name: 'team-model', provider: 'openai', upstream: 'gpt-x', prompt_caching: false, max_output_tokens: 900, reasoning: null, embeddings: null,
	own_price: { input: 1, output: 2 }, price: { input: 1, output: 2 }, price_from: 'model', enabled: true, served: true, origin: 'api',
	edited: false, access: 'everyone', grants: 0, problem: null, fits: null, internet: 'provider',
};
const BACKUP = { ...MODEL, name: 'backup-model', upstream: 'gpt-y' };
const ROUTE = {
	name: 'steady', targets: ['team-model'], sort: 'order', weights: null, constraints: null, origin: 'api', created_at: '2026-11-01T10:00:00Z',
	updated_at: '2026-11-01T10:00:00Z', tried: ['team-model'], skipped: [], served: true,
};
const GROUP = { id: 'b0000000-0000-4000-8000-000000000001', name: 'team', members: 2 };
const USER = 'a0000000-0000-4000-8000-0000000000a1';
/** The grants the fake gateway holds, as `admin/grants` answers them. */
let grants: { id: string; model: string; user_id: string | null; group_id: string | null; group_name: string | null; created_at: number }[] = [];
const PROVIDER = { name: 'openai', kind: 'openai', base_url: 'https://api.openai.com/v1', region: null, credential: 'openai', credential_stored: true, key: 'credential', origin: 'api', models: ['team-model'], auth_header: null, problem: null };

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let raw = '';
		req.on('data', (chunk) => {
			raw += String(chunk);
		});
		req.on('end', () => resolve(JSON.parse(raw || '{}') as Record<string, unknown>));
	});
}

function admin(call: { method: string; path: string; body?: Record<string, unknown> }, res: ServerResponse): void {
	calls.push(call);
	if (call.method === 'GET') {
		const lists: Record<string, unknown[]> = {
			'admin/models': [MODEL, BACKUP], 'admin/routes': [ROUTE], 'admin/providers': [PROVIDER], 'admin/budgets': [], 'admin/limits': [], 'admin/keys': [], 'admin/groups': [GROUP],
		};
		if (call.path.startsWith('admin/grants')) {
			send(res, 200, { data: grants });
			return;
		}
		if (call.path.startsWith('admin/usage')) {
			send(res, 200, { by: 'model', from: '2026-10-11', to: '2026-11-10', data: [{ model: 'team-model', requests: 3, failed: 0, prompt_tokens: 10, completion_tokens: 20, cost: '0.0100', unpriced: 0 }] });
			return;
		}
		send(res, 200, { data: lists[call.path] ?? [] });
		return;
	}
	if (call.path === 'admin/models/refused') {
		send(res, 400, { error: { message: 'There is no provider named nobody.', code: 'bad_request' } });
		return;
	}
	if (call.method === 'POST' && call.path === 'admin/grants') {
		const body = call.body as { model: string; user_id?: string; group_id?: string };
		const grant = { id: `grant-${grants.length + 1}`, model: body.model, user_id: body.user_id ?? null, group_id: body.group_id ?? null, group_name: body.group_id === GROUP.id ? GROUP.name : null, created_at: 0 };
		grants.push(grant);
		send(res, 201, grant);
		return;
	}
	if (call.method === 'DELETE' && call.path.startsWith('admin/grants/')) {
		grants = grants.filter((g) => `admin/grants/${g.id}` !== call.path);
		// A delete answers nothing, as the relay does.
		res.writeHead(204);
		res.end();
		return;
	}
	if (call.path.startsWith('admin/routes/')) {
		send(res, 200, { name: call.path.slice('admin/routes/'.length), ...(call.body ?? {}), origin: 'api' });
		return;
	}
	send(res, 200, MODEL);
}

test.beforeAll(async () => {
	server = createServer((req, res) => {
		void (async () => {
			const body = await readBody(req);
			const path = (req.url ?? '').replace(/^\//, '').split('?')[0];
			if (path === 'account') {
				send(res, 200, { account: 'alex@example.com' });
				return;
			}
			if (path === 'cloud-project-list') {
				send(res, 200, { projects: [{
					ref: REF, name: 'shop', region: 'us-west-2', production: false, state: 'ready', desiredState: 'running', wakesInstantly: true,
					readOnly: false, sizeBytes: 9_000_000, createdAt: '2026-10-01T10:00:00Z', lastConnectionAt: null,
					host: `${REF}.db.snoutdata.com`, database: REF, user: `${REF}_owner`,
				}] });
				return;
			}
			if (path === 'cloud-project-ai') {
				if (body.admin) {
					admin(body.admin as { method: string; path: string; body?: Record<string, unknown> }, res);
					return;
				}
				send(res, 200, { ref: REF, ai: { enabled: true, endpoint: `https://${REF}.api.snoutdata.com/ai/v1` } });
				return;
			}
			send(res, 404, { error: `no such path: ${path}` });
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	handle = await launchApp('project-ai', { env: { SNOUT_E2E_CLOUD_API: api } });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const view = () => handle.page.locator('.cloud-project-view');

test('the section lists the project\'s models through the control plane', async () => {
	const page = handle.page;
	await page.click('.activity-bar button[aria-label="Dashboard"]');
	const header = page.locator('.sidebar-header', { hasText: 'DASHBOARD' });
	await expect(header).toBeVisible();
	await header.locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();
	const panel = page.locator('.sidebar', { has: header });
	await panel.locator('.tree-row:has-text("shop")').click();
	await panel.locator('.tree-row.depth-2', { hasText: /^AI$/ }).click();

	await expect(view().locator('.settings-section-title')).toHaveText('AI');
	await expect(view()).toContainText(`https://${REF}.api.snoutdata.com/ai/v1`);
	await expect(view().locator('.cloud-table')).toContainText('team-model');
	// "Served" is one word to a reader: the state cell never breaks it.
	const state = view().locator('.cloud-table tr', { hasText: 'team-model' }).locator('td.cloud-nowrap');
	await expect(state).toHaveText('Served');
	await expect(state).toHaveCSS('white-space', 'nowrap');
});

test('changing a model\'s internet level sends the whole model back with the new level', async () => {
	calls = [];
	await view().getByLabel('Internet for team-model').selectOption({ label: 'Provider and web' });
	await expect.poll(() => calls.find((c) => c.method === 'PUT')?.path).toBe('admin/models/team-model');
	const put = calls.find((c) => c.method === 'PUT');
	expect(put?.body).toMatchObject({ provider: 'openai', upstream: 'gpt-x', max_output_tokens: 900, price: { input: 1, output: 2 }, internet: 'web' });
});

const row = (name: string) => view().locator('.cloud-table tr', { hasText: name });

test('the model editor sends the whole model back with what its form changed', async () => {
	calls = [];
	await row('team-model').getByRole('button', { name: 'Edit' }).click();
	await view().getByLabel('Longest reply, in tokens').fill('1200');
	await view().getByLabel('Prompt caching').check();
	await view().getByRole('button', { name: 'Save model' }).click();
	await expect.poll(() => calls.find((c) => c.method === 'PUT')?.path).toBe('admin/models/team-model');
	expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
		provider: 'openai', upstream: 'gpt-x', enabled: true, access: 'everyone', max_output_tokens: 1200, prompt_caching: true, price: { input: 1, output: 2 }, internet: 'provider',
	});
	await expect(view().getByRole('button', { name: 'Save model' })).toHaveCount(0);
});

test('a model granted only lists its grants, grants a user and a group, and takes one back', async () => {
	calls = [];
	grants = [];
	await row('team-model').getByRole('button', { name: 'Edit' }).click();
	await view().getByLabel('Who may call it').selectOption('granted');
	const granted = view().getByRole('group', { name: 'Granted to' });
	await expect(granted).toContainText('No one yet.');

	await granted.getByLabel('User ID').fill(USER);
	await granted.getByRole('button', { name: 'Grant', exact: true }).click();
	await expect(granted.locator('.cloud-table')).toContainText(USER);
	expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ model: 'team-model', user_id: USER });

	await granted.getByLabel('Grant it to').selectOption('group');
	await granted.getByRole('combobox', { name: 'Group', exact: true }).selectOption(GROUP.id);
	await granted.getByRole('button', { name: 'Grant', exact: true }).click();
	await expect(granted.locator('.cloud-table')).toContainText('Group team');
	expect(calls.filter((c) => c.method === 'POST')[1]?.body).toEqual({ model: 'team-model', group_id: GROUP.id });

	await granted.locator('tr', { hasText: USER }).getByRole('button', { name: 'Take back' }).click();
	await expect(granted.locator('.cloud-table')).not.toContainText(USER);
	expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('admin/grants/grant-1');
	// A grant applies at once: nothing was saved, and Cancel leaves the model as it was.
	expect(calls.some((c) => c.method === 'PUT')).toBe(false);
	await view().getByRole('button', { name: 'Cancel' }).click();
	await expect(granted).toHaveCount(0);
});

test('the routes tab lists a route, and adds one with its models in the order set', async () => {
	await view().locator('.tabs .tab', { hasText: 'Routes' }).click();
	await expect(row('steady')).toContainText('team-model');
	await expect(row('steady').locator('td.cloud-nowrap')).toHaveText('Served');

	calls = [];
	await view().getByRole('button', { name: 'Add a route' }).click();
	await view().getByRole('textbox', { name: 'Name', exact: true }).fill('quick');
	await view().getByRole('combobox', { name: 'Models', exact: true }).selectOption('team-model');
	await view().getByRole('combobox', { name: 'Models', exact: true }).selectOption('backup-model');
	await row('backup-model').getByRole('button', { name: 'Move up' }).click();
	await view().getByLabel('Order of use').selectOption('price');
	await view().getByRole('button', { name: 'Save route' }).click();
	await expect.poll(() => calls.find((c) => c.method === 'PUT')?.path).toBe('admin/routes/quick');
	expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ targets: ['backup-model', 'team-model'], sort: 'price', weights: {}, constraints: {} });
	await expect(view().getByRole('button', { name: 'Save route' })).toHaveCount(0);
});

test('editing a route keeps its models and sends the new order of use', async () => {
	calls = [];
	await row('steady').getByRole('button', { name: 'Edit' }).click();
	await view().getByLabel('Order of use').selectOption('weighted');
	await view().getByLabel('Weight of team-model').fill('3');
	await view().getByRole('button', { name: 'Save route' }).click();
	await expect.poll(() => calls.find((c) => c.method === 'PUT')?.path).toBe('admin/routes/steady');
	expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ targets: ['team-model'], sort: 'weighted', weights: { 'team-model': 3 }, constraints: {} });
});

test('usage reads what the gateway says', async () => {
	await view().locator('.tabs .tab', { hasText: 'Usage' }).click();
	await expect(view().locator('.cloud-table')).toContainText('team-model');
	await expect(view().locator('.cloud-table')).toContainText('$0.0100');
});

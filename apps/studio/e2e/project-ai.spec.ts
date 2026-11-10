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
		const lists: Record<string, unknown[]> = { 'admin/models': [MODEL], 'admin/providers': [PROVIDER], 'admin/budgets': [], 'admin/limits': [], 'admin/keys': [] };
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
});

test('changing a model\'s internet level sends the whole model back with the new level', async () => {
	calls = [];
	await view().getByLabel('Internet for team-model').selectOption({ label: 'Provider and web' });
	await expect.poll(() => calls.find((c) => c.method === 'PUT')?.path).toBe('admin/models/team-model');
	const put = calls.find((c) => c.method === 'PUT');
	expect(put?.body).toMatchObject({ provider: 'openai', upstream: 'gpt-x', max_output_tokens: 900, price: { input: 1, output: 2 }, internet: 'web' });
});

test('usage reads what the gateway says', async () => {
	await view().locator('.tabs .tab', { hasText: 'Usage' }).click();
	await expect(view().locator('.cloud-table')).toContainText('team-model');
	await expect(view().locator('.cloud-table')).toContainText('$0.0100');
});

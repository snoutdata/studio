/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * A cloud project's Containers section, driven against a FAKE control plane on 127.0.0.1
 * (`SNOUT_E2E_CLOUD_API`, honoured only under a scratch profile, as in cloud-panel.spec.ts). The
 * real IPC, the real ops in main and the real section; only `cloud-project-containers` is played
 * here, in the shapes it answers in. A folder build needs a real Docker and is covered by
 * containerBuild.test.ts.
 */

let handle: AppHandle;
let server: Server;
/** Every body the app sent to cloud-project-containers. */
let calls: Record<string, unknown>[] = [];

const REF = 'aaaaaaaaaaaaa';
const DIGEST = 'sha256:' + 'c'.repeat(64);

function containers(): Record<string, unknown>[] {
	return [
		{
			name: 'web', image: 'ghcr.io/acme/web:1', built: false, digest: DIGEST, port: 8080,
			url: `https://${REF}.api.snoutdata.com/containers/v1/web/`, privateRegistry: true, status: 'running',
			statusDetail: null, restarts: 2, statusAt: '2026-10-14T10:00:00Z', allowed: true, updatedAt: '2026-10-14T09:00:00Z',
		},
		{
			name: 'worker', image: 'built from a Dockerfile', built: true, digest: DIGEST, port: 3000,
			url: `https://${REF}.api.snoutdata.com/containers/v1/worker/`, privateRegistry: false, status: 'failed',
			statusDetail: 'It exited with code 1.', restarts: 0, statusAt: null, allowed: true, updatedAt: null,
		},
	];
}

function listing(): Record<string, unknown> {
	return {
		ref: REF,
		allowance: { deployed: 2, maxContainers: 3, memoryMb: 256, cpuPercent: 50, egress: { month: '2026-10', usedBytes: 0.5 * 1024 ** 3, allowanceBytes: 5 * 1024 ** 3, held: false } },
		containers: containers(),
	};
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let raw = '';
		req.on('data', (chunk) => { raw += String(chunk); });
		req.on('end', () => {
			try {
				resolve(JSON.parse(raw || '{}') as Record<string, unknown>);
			} catch {
				resolve({});
			}
		});
	});
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
			if (path === 'cloud-project-containers') {
				calls.push(body);
				if (body.action === 'logs') {
					send(res, 200, { ref: REF, lines: [
						{ name: 'web', stream: 'stderr', message: 'warning: slow start', at: '2026-10-14T10:00:02Z' },
						{ name: 'web', stream: 'stdout', message: 'listening on 8080', at: '2026-10-14T10:00:01Z' },
					] });
					return;
				}
				if (body.action === 'deploy' && body.image === 'amd64/only:1') {
					send(res, 400, { error: 'amd64/only:1 has no linux/arm64 image.' });
					return;
				}
				send(res, 200, listing());
				return;
			}
			send(res, 404, { error: `no such path: ${path}` });
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	handle = await launchApp('cloud-containers', { env: { SNOUT_E2E_CLOUD_API: api } });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const view = () => handle.page.locator('.cloud-project-view');
const card = (name: string) => view().locator('.cloud-container', { has: handle.page.locator('.cloud-container-head .mono', { hasText: new RegExp(`^${name}$`) }) });

test('the section lists each container with its state, image, plan and address', async () => {
	const page = handle.page;
	await page.click('.activity-bar button[aria-label="Dashboard"]');
	const header = page.locator('.sidebar-header', { hasText: 'DASHBOARD' });
	await expect(header).toBeVisible();
	await header.locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();
	const panel = page.locator('.sidebar', { has: header });
	await panel.locator('.tree-row:has-text("shop")').click();
	await panel.locator('.tree-row.depth-2', { hasText: /^Containers$/ }).click();

	await expect(view().locator('.settings-section-title')).toHaveText('Containers');
	await expect(view()).toContainText('2 of 3 deployed, 256 MB and 50% of a core each');
	await expect(view()).toContainText('0.5 GB of 5 GB');
	await expect(card('web')).toContainText('Running');
	await expect(card('web')).toContainText(`ghcr.io/acme/web:1 @ ${'c'.repeat(12)}`);
	await expect(card('web')).toContainText('restarted 2 times');
	await expect(card('worker')).toContainText('Built from a Dockerfile');
	await expect(card('worker').locator('.form-status.error')).toHaveText('It exited with code 1.');
	await page.screenshot({ path: 'test-results/cloud-containers.png' });
});

test('a built container is redeployed by its digest, a registry one by its image', async () => {
	calls = [];
	await card('worker').locator('button:has-text("Redeploy")').click();
	await card('web').locator('button:has-text("Redeploy")').click();
	await expect.poll(() => calls.filter((c) => c.action === 'deploy').length).toBe(2);
	expect(calls.filter((c) => c.action === 'deploy')).toEqual([
		{ ref: REF, action: 'deploy', name: 'worker', pushed: DIGEST, port: 3000 },
		{ ref: REF, action: 'deploy', name: 'web', image: 'ghcr.io/acme/web:1', port: 8080 },
	]);
});

test('logs open under their controls, and the switch asks for stderr only', async () => {
	calls = [];
	await card('web').locator('button:has-text("Logs")').click();
	const logs = card('web').locator('.cloud-container-logs');
	await expect(logs.locator('pre')).toContainText('listening on 8080');
	await logs.locator('label.check').click();
	await expect.poll(() => calls.some((c) => c.action === 'logs' && c.errorsOnly === true)).toBe(true);
	await handle.page.screenshot({ path: 'test-results/cloud-containers-logs.png' });
	await card('web').locator('button:has-text("Hide logs")').click();
});

test('remove asks inline first, and Cancel sends nothing', async () => {
	calls = [];
	await card('worker').locator('button.danger:has-text("Remove")').click();
	await expect(card('worker')).toContainText('Remove worker? It stops at once.');
	await card('worker').locator('button:has-text("Cancel")').click();
	expect(calls.some((c) => c.action === 'delete')).toBe(false);
	await card('worker').locator('button.danger:has-text("Remove")').click();
	await card('worker').locator('button.danger:has-text("Remove")').click();
	await expect.poll(() => calls.filter((c) => c.action === 'delete')).toEqual([{ ref: REF, action: 'delete', name: 'worker' }]);
});

test('an image deploy sends the login once and clears the token; a refusal is shown in its words', async () => {
	calls = [];
	const form = view().locator('fieldset', { hasText: 'Deploy an image' });
	await form.locator('label:has-text("Name") input').fill('api');
	await form.locator('label:has-text("Image") input').fill('ghcr.io/acme/api:2');
	await form.locator('label:has-text("Port it listens on") input').fill('3000');
	await form.locator('label:has-text("Registry user") input').fill('acme');
	await form.locator('label:has-text("Registry token") input').fill('ghp_secret');
	await form.locator('button:has-text("Deploy")').click();
	await expect(form).toContainText('api is deployed');
	await expect(form.locator('label:has-text("Registry token") input')).toHaveValue('');
	expect(calls.filter((c) => c.action === 'deploy')).toEqual([
		{ ref: REF, action: 'deploy', name: 'api', image: 'ghcr.io/acme/api:2', port: 3000, registryUser: 'acme', registryPassword: 'ghp_secret' },
	]);

	await form.locator('label:has-text("Image") input').fill('amd64/only:1');
	await form.locator('label:has-text("Registry user") input').fill('');
	await form.locator('button:has-text("Deploy")').click();
	await expect(form.locator('.form-status.warn')).toHaveText('amd64/only:1 has no linux/arm64 image.');
});

test('deploy from a folder waits for a folder chosen through the picker', async () => {
	const form = view().locator('fieldset', { hasText: 'Deploy from a folder' });
	await expect(form.locator('button:has-text("Build and deploy")')).toBeDisabled();
	// A folder the picker did not hand out is refused in main, whatever the page sends.
	const outcome = await handle.page.evaluate(() => (window as unknown as { sqlApi: { cloudContainers: { build(ref: string, form: unknown, id: string): Promise<{ ok: boolean; message?: string }> } } })
		.sqlApi.cloudContainers.build('aaaaaaaaaaaaa', { name: 'x', folder: '/etc' }, 'b1'));
	expect(outcome.ok).toBe(false);
	await form.scrollIntoViewIfNeeded();
	await handle.page.screenshot({ path: 'test-results/cloud-containers-deploy.png' });
});

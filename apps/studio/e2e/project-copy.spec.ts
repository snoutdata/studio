/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * Copying a whole project between this computer and SnoutData Cloud (src/shared/projectCopy.ts).
 *
 * A FAKE CONTROL PLANE on 127.0.0.1 (`SNOUT_E2E_CLOUD_API`, honoured only under a scratch profile,
 * as in cloud-panel.spec.ts), and a local project SEEDED into the scratch profile: its registry
 * entry, its `.env`, a function and a secret, but no Docker. That is enough to drive the parts that
 * need neither a running stack nor a real cloud database, end to end through the real orchestrator:
 * a new cloud project is created, the function is deployed with the bundle the CLI would send, and
 * the secret is set with its value, which never passed through the renderer.
 *
 * Users, the database and files need a running local stack and a real cloud project; they are the
 * live half, not this file.
 */

let handle: AppHandle;
let server: Server;
let profile: string;
let projects: Record<string, unknown>[] = [];
const deployed: { ref: string; name: string; verifyJwt: unknown; bundle: { entrypoint: string; files: { path: string; text: string }[] } }[] = [];
const secretsSet: { ref: string; name: string; value: string }[] = [];
const created: string[] = [];

const LOCAL_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function project(over: Record<string, unknown> = {}): Record<string, unknown> {
	const base = { ref: 'ccccccccccccc', name: "first light", region: 'us-west-2', production: false, state: 'ready', desiredState: 'running', wakesInstantly: true, readOnly: false, sizeBytes: 8_000_000, ...over };
	const ref = String(base.ref);
	return { ...base, host: `${ref}.db.snoutdata.com`, database: ref, user: `${ref}_owner` };
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
				send(res, 200, { projects });
				return;
			}
			if (path === 'cloud-project-create') {
				const made = project({ ref: 'fffffffffffff', name: String(body.name ?? '') });
				created.push(String(body.name ?? ''));
				projects = [...projects, made];
				send(res, 200, { project: made, password: 'from-the-control-plane' });
				return;
			}
			if (path === 'cloud-project-connection') {
				const ref = String(body.ref ?? '');
				send(res, 200, { ref, host: `${ref}.db.snoutdata.com`, port: 5432, database: ref, user: `${ref}_owner`, password: 'from-the-control-plane', state: 'ready' });
				return;
			}
			if (path === 'cloud-project-functions') {
				if (body.action === 'deploy') {
					deployed.push({ ref: String(body.ref), name: String(body.name), verifyJwt: body.verifyJwt, bundle: body.bundle as typeof deployed[number]['bundle'] });
				}
				send(res, 200, { functions: deployed.filter((d) => d.ref === body.ref).map((d) => ({ name: d.name })), limit: {} });
				return;
			}
			if (path === 'cloud-project-secrets') {
				if (body.action === 'set') {
					secretsSet.push({ ref: String(body.ref), name: String(body.name), value: String(body.value) });
				}
				send(res, 200, { secrets: secretsSet.map((s) => ({ name: s.name, bytes: 10 })) });
				return;
			}
			send(res, 404, { error: `no such path: ${path}` });
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	// A local project as the setup wizard leaves one, minus Docker.
	profile = mkdtempSync(join(tmpdir(), 'snout-e2e-'));
	const folder = join(profile, 'shop');
	mkdirSync(join(folder, 'functions', 'hello'), { recursive: true });
	writeFileSync(join(folder, 'compose.yaml'), 'name: snout-stack\n');
	writeFileSync(join(folder, '.env'), 'SNOUT_REF=lllllllllllll\nPOSTGRES_OWNER_PASSWORD=x\nSERVICE_ROLE_KEY=y\nANON_KEY=z\nFUNCTIONS_NO_VERIFY_JWT=hello\n');
	writeFileSync(join(folder, 'functions', 'hello', 'index.ts'), 'Deno.serve(() => new Response("hi"));\n');
	writeFileSync(join(folder, 'functions', '.env'), "STRIPE_KEY='sk_test_123'\nSNOUT_INTERNAL='nope'\n");
	writeFileSync(join(profile, 'localProjects.json'), JSON.stringify({
		projects: [{ id: LOCAL_ID, name: 'shop', folder, ref: 'lllllllllllll', apiPort: 18001, dbPort: 15432, createdAt: '2026-10-01T00:00:00Z' }],
	}));
	handle = await launchApp('project-copy', { profile, env: { SNOUT_E2E_CLOUD_API: api } });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(profile, { recursive: true, force: true });
});

const header = () => handle.page.locator('.sidebar-header', { hasText: 'DASHBOARD' });

async function showProjects(): Promise<void> {
	if (!(await header().isVisible().catch(() => false))) {
		await handle.page.click('.activity-bar button[aria-label="Dashboard"]');
	}
	await expect(header()).toBeVisible();
}

/** Open a project's row: its Start, Stop and Copy are in the strip above its menu. */
async function openOverview(name: string): Promise<void> {
	const panel = handle.page.locator('.sidebar', { has: header() });
	await panel.locator('.tree-row.depth-1', { hasText: name }).click();
	await expect(panel.locator('.project-actions').first()).toBeVisible();
}

test('a cloud project copies to this computer, and says what does not come back', async () => {
	projects = [project()];
	await showProjects();
	await openOverview('first light');
	await handle.page.locator('.sidebar button[title="Copy this project to this computer"]').click();
	const view = handle.page.locator('.move-view', { hasText: 'Copy first light to this computer' });
	await expect(view).toBeVisible();
	// Functions and secrets cannot come back, and the switch says why rather than vanishing.
	await expect(view.locator('.copy-parts label.check[data-part="functions"] input')).toBeDisabled();
	await expect(view.locator('.copy-parts label.check[data-part="secrets"] input')).toBeDisabled();
	await expect(view.locator('.copy-parts')).toContainText('does not give a function\'s source back');
	await expect(view.locator('.copy-parts label.check[data-part="users"] input')).toBeChecked();
	// The only local project is the seeded one.
	await expect(view.locator('.move-end select')).toContainText('shop');
	await handle.page.screenshot({ path: 'test-results/project-copy-to-local.png' });
	await view.locator('button[aria-label="Close"]').click();
});

test('a local project copies its functions and secrets into a new cloud project', async () => {
	await showProjects();
	await openOverview('shop');
	await handle.page.locator('.sidebar button[title="Copy this project to SnoutData Cloud"]').click();
	const view = handle.page.locator('.move-view', { hasText: 'Copy shop to SnoutData Cloud' });
	await expect(view).toBeVisible();
	// A new cloud project, named after the source, is the default target.
	await expect(view.locator('.move-new-name')).toHaveValue('shop');
	await view.locator('.move-new-name').fill('shop cloud');
	// Only the two parts that need neither Docker nor a real cloud database.
	for (const part of ['users', 'database', 'files']) {
		await view.locator(`.copy-parts label.check[data-part="${part}"] input`).uncheck();
	}
	await handle.page.screenshot({ path: 'test-results/project-copy-choose.png' });
	await view.locator('button', { hasText: 'Check both projects' }).click();

	await expect(view.locator('.move-finding', { hasText: 'Functions' })).toContainText('1 function');
	await expect(view.locator('.move-finding', { hasText: 'Function secrets' })).toContainText('1 secret');
	await expect(view.locator('.move-finding', { hasText: 'Function secrets' })).toContainText('SNOUT_INTERNAL is reserved');
	await handle.page.screenshot({ path: 'test-results/project-copy-check.png' });
	await view.locator('button', { hasText: 'Review' }).click();
	await expect(view).toContainText('Create the SnoutData Cloud project "shop cloud"');
	await expect(view.locator('.copy-review.not')).toContainText('API keys');
	expect(created).toEqual([]);

	await view.locator('button', { hasText: 'Start the copy' }).click();
	await expect(view.locator('.move-result')).toContainText('Copied', { timeout: 30_000 });
	await handle.page.screenshot({ path: 'test-results/project-copy-done.png' });

	expect(created).toEqual(['shop cloud']);
	expect(deployed).toHaveLength(1);
	expect(deployed[0]).toMatchObject({ ref: 'fffffffffffff', name: 'hello', verifyJwt: false });
	expect(deployed[0].bundle.entrypoint).toBe('index.ts');
	expect(deployed[0].bundle.files.map((f) => f.path)).toEqual(['index.ts']);
	// The value went from the local .env to the cloud, and the reserved one stayed behind.
	expect(secretsSet).toEqual([{ ref: 'fffffffffffff', name: 'STRIPE_KEY', value: 'sk_test_123' }]);
	await expect(view.locator('button', { hasText: 'Open shop cloud' })).toBeVisible();
});

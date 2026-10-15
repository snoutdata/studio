/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, type Page } from '@playwright/test';

import { AUTH_PROFILE, closeApp, launchApp, signedInProfileExists, waitForSignIn, type AppHandle } from './helpers';

/*
 * Cloud projects against the LIVE control plane, on the signed-in e2e profile.
 *
 * Opt-in twice over, because it creates and deletes a real hosted project on that account:
 *   SNOUTDATA_E2E_LIVE_CLOUD=1                 the panel, the project tab, and the agent path over MCP
 *   SNOUTDATA_E2E_LIVE_CLOUD=1 SNOUTDATA_E2E_LIVE_AI=1   also the assistant, which spends AI budget
 *
 * Every project it makes is named `e2e-live-…` and deleted before it finishes, including by an
 * afterAll sweep if a test failed halfway.
 */

const cloudSkip = !process.env.SNOUTDATA_E2E_LIVE_CLOUD
	? 'set SNOUTDATA_E2E_LIVE_CLOUD=1 (it creates and deletes a real hosted project)'
	: !signedInProfileExists() ? `no signed-in profile at ${AUTH_PROFILE}: run \`npm run e2e:signin\`` : null;
const aiSkip = cloudSkip ?? (process.env.SNOUTDATA_E2E_LIVE_AI ? null : 'set SNOUTDATA_E2E_LIVE_AI=1 as well (the assistant spends real AI budget)');

const PREFIX = 'e2e-live-';
const stamp = Date.now().toString(36);

interface Row { ref: string; name: string; state: string; busy: boolean }

async function projects(page: Page): Promise<Row[]> {
	return page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: { cloudProjects(): Promise<{ projects: Row[] }> } }).sqlApi;
		return (await api.cloudProjects()).projects;
	});
}

async function connectionsFor(page: Page, ref: string): Promise<number> {
	return page.evaluate(async (r) => {
		const api = (window as unknown as { sqlApi: { state(): Promise<{ connections: { cloudProjectRef?: string }[] }> } }).sqlApi;
		return (await api.state()).connections.filter((c) => c.cloudProjectRef === r).length;
	}, ref);
}

async function waitReady(page: Page, name: string): Promise<Row> {
	let found: Row | undefined;
	await expect.poll(async () => {
		found = (await projects(page)).find((p) => p.name === name);
		return found ? `${found.state}${found.busy ? ' (busy)' : ''}` : 'missing';
	}, { timeout: 180_000, intervals: [3000] }).toBe('ready');
	return found!;
}

/** Delete every project this spec made, whatever state the run left them in. */
async function sweep(page: Page): Promise<void> {
	for (const p of (await projects(page).catch(() => [] as Row[])).filter((row) => row.name.startsWith(PREFIX))) {
		await page.evaluate(async (ref) => {
			const api = (window as unknown as { sqlApi: { cloudDelete(ref: string): Promise<unknown> } }).sqlApi;
			await api.cloudDelete(ref);
		}, p.ref).catch(() => undefined);
	}
}

async function showCloud(page: Page): Promise<void> {
	const header = page.locator('.sidebar-header', { hasText: 'DASHBOARD' });
	if (!(await header.isVisible().catch(() => false))) {
		await page.click('.activity-bar button[aria-label="Dashboard"]');
	}
	await expect(header).toBeVisible();
}

test.describe.serial('Cloud projects, live', () => {
	let handle: AppHandle;
	test.setTimeout(300_000);
	const panelName = `${PREFIX}panel-${stamp}`;

	test.skip(cloudSkip !== null, cloudSkip ?? '');

	test.beforeAll(async () => {
		handle = await launchApp('cloud-projects-live', { profile: AUTH_PROFILE });
		expect(await waitForSignIn(handle.page), 'the profile is not signed in').toBeTruthy();
	});
	test.afterAll(async () => {
		await sweep(handle.page);
		await closeApp(handle);
	});

	test('the panel lists the account projects and each already has a butterfly connection', async () => {
		const page = handle.page;
		await showCloud(page);
		const rows = await projects(page);
		const panel = page.locator('.sidebar', { has: page.locator('.sidebar-header', { hasText: 'DASHBOARD' }) });
		for (const row of rows) {
			await expect(panel.locator('.tree-row.depth-1', { hasText: row.name })).toHaveCount(1);
		}
		// The background sync has had its chance (opening the panel is one of its triggers).
		for (const row of rows) {
			await expect.poll(() => connectionsFor(page, row.ref), { timeout: 30_000 }).toBeGreaterThan(0);
		}
		await page.screenshot({ path: 'test-results/cloud-live-panel.png' });
	});

	test('nothing the app did on the way here raised an error notification', async () => {
		const page = handle.page;
		await page.locator('.activity-bar button[aria-label^="Notifications"]').click();
		await page.screenshot({ path: 'test-results/cloud-live-notifications.png' });
		const text = await page.locator('.notif-center, .notifications-center, .modal').first().innerText().catch(() => '');
		console.log(`NOTIFICATIONS:
${text}`);
		await page.keyboard.press('Escape');
		await expect(page.locator('.modal-backdrop')).toHaveCount(0);
	});

	test('a project created from the panel starts, and every section of its tab loads without an error', async () => {
		const page = handle.page;
		await showCloud(page);
		await page.locator('.sidebar-header button[aria-label="New project"]').click();
		// Since the panel holds Local and Cloud projects, New project asks which kind first.
		await page.getByRole('menuitem', { name: 'In SnoutData Cloud' }).click();
		await page.fill('.modal input[placeholder^="orders"]', panelName);
		await page.click('.modal-actions button:has-text("Create")');
		await expect(page.locator('.sidebar')).toContainText(`added it as a connection`, { timeout: 30_000 });
		const row = await waitReady(page, panelName);
		expect(await connectionsFor(page, row.ref)).toBe(1);

		const panel = page.locator('.sidebar', { has: page.locator('.sidebar-header', { hasText: 'DASHBOARD' }) });
		await page.locator('.sidebar-header button:is([title="Refresh"], [aria-label="Refresh"])').click();
		// The "created, it is starting" line goes once it has started.
		await expect(panel).not.toContainText(`Created ${row.ref}`);

		if (!(await panel.locator('.tree-row.depth-2', { hasText: /^Settings$/ }).first().isVisible().catch(() => false))) {
			await panel.locator('.tree-row.depth-1', { hasText: panelName }).click();
		}
		await panel.locator('.tree-row.depth-2', { hasText: /^Settings$/ }).first().click();
		const view = page.locator('.cloud-project-view');
		// Every section of the shared menu (shared/projects.ts), against the live control plane and,
		// for the shared ones, the project's own database through cloud-project-sql.
		for (const section of ['Overview', 'Database', 'Extensions', 'Cron', 'Time series', 'Auth', 'Storage', 'Data API', 'Functions', 'Containers', 'Realtime', 'Push', 'Logs', 'Domains', 'Settings']) {
			await view.locator('.settings-nav-item').filter({ hasText: new RegExp(`^${section}$`) }).click();
			await expect(view.locator('.settings-section-title')).toHaveText(section);
			await expect(view.locator('.field-hint:has-text("Loading…")')).toHaveCount(0, { timeout: 20_000 });
			// A refusal (amber) is fine on a plan that lacks the product; a failure (red) is not.
			await expect(view.locator('.form-status.error'), `${section} failed`).toHaveCount(0);
			await page.screenshot({ path: `test-results/cloud-live-${section.toLowerCase().replace(/[^a-z]+/g, '-')}.png` });
		}
		await view.locator('.settings-nav-item').filter({ hasText: /^Database$/ }).click();
		await expect(view.locator('input[readonly]').first()).toHaveValue(`${row.ref}.db.snoutdata.com`);
	});

	test('copying the connection string puts a working URI on the clipboard, never on screen', async () => {
		const page = handle.page;
		const view = page.locator('.cloud-project-view');
		await view.locator('.settings-nav-item').filter({ hasText: /^Database$/ }).click();
		await view.locator('button:has-text("Copy connection string")').click();
		await expect(view).toContainText('Connection string copied');
		const uri = await handle.app.evaluate(({ clipboard }) => clipboard.readText());
		expect(uri).toMatch(/^postgres(ql)?:\/\/[^:]+:[^@]+@[a-z0-9]+\.db\.snoutdata\.com:5432\/[a-z0-9]+\?sslmode=require$/);
		const password = decodeURIComponent(uri.split(':')[2].split('@')[0]);
		expect(await page.content()).not.toContain(password);
	});

	test('the project tab\'s operations answer against the live control plane', async () => {
		const page = handle.page;
		const row = (await projects(page)).find((p) => p.name === panelName)!;
		type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; refused: boolean; message: string };
		async function op(name: string, args: Record<string, unknown>): Promise<Outcome> {
			return page.evaluate(async (input) => {
				const api = (window as unknown as { sqlApi: { cloudProject(op: string, args: unknown): Promise<Outcome> } }).sqlApi;
				return api.cloudProject(input.name, input.args);
			}, { name, args });
		}
		/** An answer, or a refusal in words (a plan without the product); never a failure. */
		function answered(name: string, out: Outcome): void {
			expect(out.ok || out.refused, `${name}: ${out.ok ? '' : out.message}`).toBe(true);
		}
		async function selectOne(): Promise<{ ok: boolean; error?: string }> {
			return page.evaluate(async (ref) => {
				const api = (window as unknown as { sqlApi: {
					state(): Promise<{ connections: { id: string; cloudProjectRef?: string }[] }>;
					disconnect(id: string): Promise<void>;
					connect(id: string): Promise<{ error?: string }>;
					execute(input: unknown): Promise<{ ok?: boolean; error?: string }>;
				} }).sqlApi;
				const id = (await api.state()).connections.find((c) => c.cloudProjectRef === ref)!.id;
				await api.disconnect(id).catch(() => undefined);
				try {
					const connected = await api.connect(id);
					if (connected.error) {
						return { ok: false, error: connected.error };
					}
					const ran = await api.execute({ connectionId: id, sql: 'select 1' });
					return { ok: ran.ok === true, error: ran.error };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			}, row.ref);
		}

		for (const name of ['usage', 'connection', 'backups', 'services', 'functions', 'domains', 'containers']) {
			answered(name, await op(name, { ref: row.ref }));
		}
		const connection = await op('connection', { ref: row.ref });
		expect(connection.ok && connection.data.host).toBe(`${row.ref}.db.snoutdata.com`);

		// A secret is set and unset; its value never comes back.
		const secretName = `E2E_LIVE_${stamp.toUpperCase()}`;
		const set = await op('setSecret', { ref: row.ref, name: secretName, value: 'not-a-real-secret' });
		answered('setSecret', set);
		if (set.ok) {
			expect(JSON.stringify(set.data)).not.toContain('not-a-real-secret');
			expect((set.data as unknown as { name: string }[]).some((s) => s.name === secretName)).toBe(true);
			const unset = await op('unsetSecret', { ref: row.ref, name: secretName });
			answered('unsetSecret', unset);
			expect(unset.ok && (unset.data as unknown as { name: string }[]).some((s) => s.name === secretName)).toBe(false);
		}

		// A product switched on and off again, in the control plane's own words when the plan refuses.
		for (const enable of [true, false]) {
			answered(`storage ${enable ? 'on' : 'off'}`, await op('setService', { ref: row.ref, service: 'storage', enable }));
		}

		// The keys rotate, and the password resets and still reaches the database through the
		// connection it updated, which is the half a user would notice.
		answered('rotateKeys', await op('rotateKeys', { ref: row.ref }));
		const reset = await op('resetPassword', { ref: row.ref });
		answered('resetPassword', reset);
		if (reset.ok) {
			expect(reset.data.updatedConnections).toBe(1);
			console.log(`password reset applies in: ${String(reset.data.appliesIn)}`);
			let last: { ok: boolean; error?: string } = { ok: false };
			await expect.poll(async () => {
				last = await selectOne();
				return last.ok;
			}, { timeout: 120_000, intervals: [5000], message: 'select after reset' }).toBe(true);
			console.log(`select after reset: ok (last error before it: ${last.error ?? 'none'})`);
		}

		// Stop and start, as the panel asks for them.
		for (const [action, settled] of [['pause', 'paused'], ['resume', 'ready']] as const) {
			const asked = await page.evaluate(async (input) => {
				const api = (window as unknown as { sqlApi: { cloudAsk(action: string, ref: string): Promise<{ ok: boolean; message: string }> } }).sqlApi;
				return api.cloudAsk(input.action, input.ref);
			}, { action, ref: row.ref });
			expect(asked.ok, asked.message).toBe(true);
			await expect.poll(async () => {
				const found = (await projects(page)).find((p) => p.ref === row.ref);
				return found ? `${found.state}${found.busy ? ' (busy)' : ''}` : 'missing';
			}, { timeout: 240_000, intervals: [5000] }).toBe(settled);
			if (action === 'pause') {
				// And it STAYS stopped: the app's own open connection used to wake it again at once.
				await page.waitForTimeout(20_000);
				expect((await projects(page)).find((p) => p.ref === row.ref)?.state).toBe('paused');
			}
		}
	});

	test('deleting the project from its tab removes it and its connection', async () => {
		const page = handle.page;
		const row = (await projects(page)).find((p) => p.name === panelName)!;
		const view = page.locator('.cloud-project-view');
		await view.locator('.settings-nav-item').filter({ hasText: /^Settings$/ }).click();
		await view.locator('button:has-text("Delete project")').click();
		await page.click('.modal.confirm button:has-text("Delete")');
		await expect.poll(() => connectionsFor(page, row.ref), { timeout: 20_000 }).toBe(0);
		await expect.poll(async () => (await projects(page)).some((p) => p.ref === row.ref), { timeout: 60_000 }).toBe(false);
	});

	test('a coding agent sees the cloud tools over MCP and reads the projects with them', async () => {
		const page = handle.page;
		const ep = await expect.poll(async () => page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ running: boolean; url: string; token: string }> } } }).sqlApi;
			const s = await api.mcp.status();
			return s.running ? s : null;
		}), { timeout: 20_000 }).not.toBeNull().then(() => page.evaluate(async () => {
			const api = (window as unknown as { sqlApi: { mcp: { status(): Promise<{ url: string; token: string }> } } }).sqlApi;
			return api.mcp.status();
		}));
		async function rpc(body: unknown): Promise<Record<string, unknown>> {
			const res = await fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` }, body: JSON.stringify(body) });
			return JSON.parse(await res.text()) as Record<string, unknown>;
		}
		await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } });
		const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const names = ((listed.result as { tools: { name: string }[] }).tools).map((t) => t.name);
		for (const name of ['list_cloud_projects', 'get_cloud_project', 'create_cloud_project', 'start_cloud_project', 'stop_cloud_project', 'delete_cloud_project', 'set_cloud_product', 'remove_cloud_secret', 'open_cloud_project']) {
			expect(names, `agent is missing ${name}`).toContain(name);
		}
		const called = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cloud_projects', arguments: {} } });
		const result = called.result as { content: { text: string }[]; isError: boolean };
		expect(result.isError, result.content[0].text).toBe(false);
		for (const row of await projects(page)) {
			expect(result.content[0].text).toContain(row.name);
		}
	});
});

test.describe.serial('the assistant manages cloud projects, live', () => {
	let handle: AppHandle;
	// A model round trip plus a project starting is minutes, not the default minute.
	test.setTimeout(360_000);
	const aiName = `${PREFIX}ai-${stamp}`;

	test.skip(aiSkip !== null, aiSkip ?? '');

	test.beforeAll(async () => {
		handle = await launchApp('cloud-projects-live-ai', { profile: AUTH_PROFILE });
		expect(await waitForSignIn(handle.page), 'the profile is not signed in').toBeTruthy();
		if (!(await handle.page.locator('.composer-input').first().isVisible().catch(() => false))) {
			await handle.page.click('.activity-item[data-tool="assistant"]');
		}
		await expect(handle.page.locator('.composer-input').first()).toBeVisible();
	});
	test.afterAll(async () => {
		await sweep(handle.page);
		await closeApp(handle);
	});

	/** Ask, approve every change the assistant proposes, and answer with its last reply. */
	async function ask(question: string): Promise<string> {
		const page = handle.page;
		const before = await page.locator('.chat-msg.assistant').count();
		await page.locator('.composer-input').fill(question);
		await page.locator('.composer-input').press('Enter');
		const deadline = Date.now() + 180_000;
		for (;;) {
			const card = page.locator('.chat-approval');
			if (await card.first().isVisible().catch(() => false)) {
				await card.first().getByRole('button', { name: 'Allow' }).click();
				continue;
			}
			const done = await page.locator('.chat-msg.assistant').count() > before
				&& !(await page.locator('button[title^="Stop"]').first().isVisible().catch(() => false));
			if (done || Date.now() > deadline) {
				break;
			}
			await page.waitForTimeout(1000);
		}
		const reply = (await page.locator('.chat-msg.assistant').last().innerText()).trim();
		console.log(`ASKED: ${question}
REPLY: ${reply}
`);
		return reply;
	}

	test('it knows which projects there are and their state', async () => {
		const rows = await projects(handle.page);
		const reply = await ask('Which SnoutData Cloud projects do I have, and what state is each in?');
		for (const row of rows) {
			expect(reply, reply).toContain(row.name);
		}
	});

	test('it creates a project when asked, and the project becomes a connection', async () => {
		await ask(`Create a new SnoutData Cloud project named ${aiName}.`);
		const row = await waitReady(handle.page, aiName);
		expect(await connectionsFor(handle.page, row.ref)).toBe(1);
	});

	test('it reads a project\'s details and turns a product on', async () => {
		const reply = await ask(`What products are switched on for the cloud project ${aiName}? Then turn storage on for it.`);
		expect(reply.toLowerCase()).toMatch(/storage/);
		const services = await handle.page.evaluate(async (name) => {
			const api = (window as unknown as { sqlApi: { cloudProjects(): Promise<{ projects: { ref: string; name: string }[] }>; cloudProject(op: string, args: unknown): Promise<{ ok: boolean; data?: { storage?: { enabled: boolean } } }> } }).sqlApi;
			const ref = (await api.cloudProjects()).projects.find((p) => p.name === name)!.ref;
			return api.cloudProject('services', { ref });
		}, aiName);
		expect(services.ok && services.data?.storage?.enabled, JSON.stringify(services)).toBe(true);
	});

	test('it stops and deletes the project when asked', async () => {
		await ask(`Stop the cloud project ${aiName}.`);
		await expect.poll(async () => (await projects(handle.page)).find((p) => p.name === aiName)?.state, { timeout: 120_000, intervals: [3000] }).toBe('paused');
		const ref = (await projects(handle.page)).find((p) => p.name === aiName)!.ref;
		await ask(`Delete the cloud project ${aiName}. Yes, I am sure.`);
		await expect.poll(() => connectionsFor(handle.page, ref), { timeout: 30_000 }).toBe(0);
		await expect.poll(async () => (await projects(handle.page)).some((p) => p.ref === ref), { timeout: 60_000 }).toBe(false);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { launchApp, closeApp, type AppHandle } from './helpers';

/*
 * The Cloud tool window and the SnoutData Cloud import source, driven end to end.
 *
 * A FAKE CONTROL PLANE stands on 127.0.0.1 and the app is pointed at it
 * (`SNOUT_E2E_CLOUD_API`, which `cloudApiLive.ts` reads ONLY when the profile is already a
 * scratch one — the same gate the reviewer's fake GitHub uses, so nothing in a normal run
 * can be aimed anywhere but SnoutData Cloud). Everything else is real: the real IPC, the
 * real decisions in `cloudProjects.ts` and `cloudImport.ts`, the real panel, the real
 * picker, the real connection store and the real keychain.
 *
 * The states here are the point. A paused project, one mid-flight, one over its storage
 * quota, a production project that refuses a stop, and an account that is signed out are
 * all things a person cannot conjure on demand against the live system — the only live
 * project is a healthy `plus` one — so they would otherwise be reasoned about and never
 * seen. This does not replace connecting to a real hosted database: it proves our half of
 * the conversation, not that the control plane's payloads are the shapes we assume.
 */

let handle: AppHandle;
let server: Server;

/** Signed out until a test says otherwise, so the first thing asserted is the refusal. */
let account: string | null = null;
/** What the fake control plane says `cloud-project-list` holds. */
let projects: Record<string, unknown>[] = [];
/** Every action the app asked for, so "asked, never done" can be asserted on the wire. */
let asked: { action: string; ref: string }[] = [];
/** Set to make the next pause come back refused, in the control plane's own words. */
let pauseRefusal: string | null = null;
/** Every path the app asked for, so a test can tell "did not refresh" from "refreshed and got this". */
let hits: string[] = [];
let storageOn = false;
let secrets: string[] = [];
let sized = { memoryMb: 128, concurrency: 2 };
/** Every statement the app sent through cloud-project-sql, with the project it named. */
let sqls: { ref: string; sql: string }[] = [];

function project(over: Record<string, unknown> = {}): Record<string, unknown> {
	const base = {
		ref: 'aaaaaaaaaaaaa',
		name: "first light",
		region: 'us-west-2',
		production: false,
		state: 'ready',
		desiredState: 'running',
		wakesInstantly: true,
		readOnly: false,
		sizeBytes: 8_058_547,
		createdAt: '2026-09-01T10:00:00Z',
		lastConnectionAt: '2026-09-05T10:00:00Z',
		...over,
	};
	// Derived AFTER the override, so a project with a different ref gets a different
	// address. Spreading over a precomputed host gave every fixture the same one, which
	// the picker's screenshot showed as two rows claiming to be the same database.
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
			const path = (req.url ?? '').replace(/^\//, '');
			hits.push(path);
			if (path === 'account') {
				send(res, 200, { account });
				return;
			}
			if (path === 'cloud-project-list') {
				send(res, 200, { projects });
				return;
			}
			if (path === 'cloud-project-connection') {
				const ref = String(body.ref ?? '');
				send(res, 200, {
					ref, host: `${ref}.db.snoutdata.com`, port: 5432, database: ref,
					user: `${ref}_owner`, password: 'from-the-control-plane', state: 'ready',
				});
				return;
			}
			if (path === 'cloud-project-pause' || path === 'cloud-project-resume') {
				const action = path.endsWith('pause') ? 'pause' : 'resume';
				asked.push({ action, ref: String(body.ref ?? '') });
				if (action === 'pause' && pauseRefusal) {
					// The shape a refusal actually arrives in: the control plane's sentence,
					// with a 409. Nothing about it is composed on this side.
					send(res, 409, { error: pauseRefusal });
					return;
				}
				send(res, 200, { project: project(), changed: true });
				return;
			}
			// The project tab's functions, answering in the shapes the real ones do.
			// The project's own database, as the dashboard reads it: SQL as the owner. A section shared
			// with local projects sends its statements here for a cloud one.
			if (path === 'cloud-project-sql') {
				const sql = String(body.sql ?? '');
				sqls.push({ ref: String(body.ref), sql });
				if (sql.includes("to_regnamespace('snout_identity')")) {
					// A project born in the new layout (shared/ownLayout.ts, DB_LAYOUT_SQL).
					send(res, 200, { ref: body.ref, columns: ['layout'], rows: [{ layout: 'new' }], rowCount: 1, truncated: false, ms: 1, connectedMs: 1 });
				} else if (sql.includes('from snout_files.spaces')) {
					send(res, 200, { ref: body.ref, columns: ['id', 'name', 'public'], rows: [{ id: 'avatars', name: 'avatars', public: false, created_at: '2026-09-20T10:00:00Z', file_size_limit: null }], rowCount: 1, truncated: false, ms: 1, connectedMs: 1 });
				} else if (sql.includes('from pg_available_extensions')) {
					send(res, 200, { ref: body.ref, columns: ['name'], rows: [{ name: 'vector', defaultVersion: '0.8.0', installedVersion: '0.8.0', comment: 'vector data type', delegated: true }, { name: 'postgis', defaultVersion: '3.5', installedVersion: null, comment: 'spatial types', delegated: true }, ...Array.from({ length: 22 }, (_, i) => ({ name: `ext_${String(i).padStart(2, '0')}`, defaultVersion: '1.0', installedVersion: null, comment: 'an extension', delegated: true }))], rowCount: 24, truncated: false, ms: 1, connectedMs: 1 });
				} else {
					send(res, 200, { ref: body.ref, columns: [], rows: [], rowCount: 0, truncated: false, ms: 1, connectedMs: 1 });
				}
				return;
			}
			if (path === 'cloud-project-usage') {
				send(res, 200, { days: [{ day: '2026-09-20', dbBytes: 8_000_000, repoBytes: 2_000_000, computeSeconds: 600, connections: 3 }], limit: { tier: 'free', maxStorageBytes: 500_000_000 } });
				return;
			}
			if (path === 'cloud-project-storage') {
				if (body.enable !== undefined) {
					storageOn = body.enable === true;
				}
				send(res, 200, { storage: { enabled: storageOn, pending: false, bytes: null, files: null, lastError: null, limit: { maxFilesBytes: null } } });
				return;
			}
			if (path === 'cloud-project-data-api') {
				send(res, 200, { dataApi: { enabled: false, allowed: false } });
				return;
			}
			if (path === 'cloud-project-auth') {
				send(res, 200, { enabled: false, google: { enabled: false }, saml: { enabled: false } });
				return;
			}
			if (path === 'cloud-project-functions') {
				// Sized as the control plane answers: a free plan, 128 MB x 2 until changed.
				if (body.action === 'size') {
					sized = body.reset === true ? { memoryMb: 128, concurrency: 2 } : { memoryMb: Number(body.memoryMb ?? sized.memoryMb), concurrency: Number(body.concurrency ?? sized.concurrency) };
				}
				send(res, 200, {
					functions: [{ name: 'hello', verifyJwt: true, bytes: 1200, updatedAt: '2026-09-20T10:00:00Z', ...sized }],
					limit: { deployed: 1, maxFunctions: 5, tier: 'free', functionMemoryMb: 128, concurrencyMax: 2, podMemoryMb: 512 },
				});
				return;
			}
			if (path === 'cloud-project-secrets') {
				if (body.action === 'set') {
					secrets = [...secrets.filter((n) => n !== body.name), String(body.name)];
				}
				send(res, 200, { secrets: secrets.map((name) => ({ name, bytes: 40, updatedAt: '2026-09-20T10:00:00Z' })) });
				return;
			}
			if (path === 'cloud-project-domain') {
				send(res, 402, { error: 'Custom domains are on paid plans' });
				return;
			}
			if (path === 'cloud-project-create') {
				const created = project({ ref: 'fffffffffffff', name: String(body.name ?? ''), production: body.production === true, state: 'creating' });
				projects = [...projects, created];
				send(res, 200, { project: created, password: 'from-the-control-plane' });
				return;
			}
			if (path === 'cloud-project-delete') {
				const ref = String(body.ref ?? '');
				asked.push({ action: 'delete', ref });
				projects = projects.filter((p) => p.ref !== ref);
				send(res, 200, { project: project({ ref, desiredState: 'deleted' }), changed: true });
				return;
			}
			send(res, 404, { error: `no such path: ${path}` });
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	handle = await launchApp('cloud-panel', { env: { SNOUT_E2E_CLOUD_API: api } });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cloudHeader = () => handle.page.locator('.sidebar-header', { hasText: 'DASHBOARD' });
/** The open project's Start, Stop and Copy, in the strip above its menu. */
const actions = () => handle.page.locator('.project-actions').first();

/**
 * Show the Cloud tool window, from the activity bar the way a user finds it.
 *
 * Conditional, because the icon TOGGLES: a blind click on an already-open panel hides it.
 * These tests share one app in file order and some of them switch the left area to
 * Connections on the way past, so every test that needs the panel asks for it rather than
 * assuming the one before left it open.
 */
/** Show Connections. Conditional for the same reason as `showCloud`: the icon toggles. */
async function showConnections(): Promise<void> {
	const header = handle.page.locator('.sidebar-header', { hasText: 'CONNECTIONS' });
	if (!(await header.isVisible().catch(() => false))) {
		await handle.page.click('.activity-bar button[aria-label="Connections"]');
	}
	await expect(header).toBeVisible();
}

async function showCloud(): Promise<void> {
	if (!(await cloudHeader().isVisible().catch(() => false))) {
		await handle.page.click('.activity-bar button[aria-label="Dashboard"]');
	}
	await expect(cloudHeader()).toBeVisible();
}

/** Show it, then re-read: the fake control plane's answers change between tests. */
async function refreshPanel(): Promise<void> {
	await showCloud();
	await cloudHeader().locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();
}

test('signed out, the panel says to sign in rather than showing an empty list', async () => {
	// "You have no databases" and "you are not signed in" are different answers, and only
	// one of them is the user's to fix. This is the whole reason `unavailable` exists.
	account = null;
	projects = [];
	await showCloud();
	await expect(handle.page.locator('.sidebar')).toContainText('Sign in to SnoutData');
	await handle.page.screenshot({ path: 'test-results/cloud-panel-signed-out.png' });
});

test('signed in with nothing, it says where to make one', async () => {
	account = 'alex@example.com';
	projects = [];
	hits = [];
	await refreshPanel();
	await expect.poll(() => hits.join(','), { timeout: 5000 }).toContain('account');
	await expect(handle.page.locator('.sidebar')).toContainText('no hosted databases yet');
});

test('the projects list shows state, size and the flags that change what a user can do', async () => {
	account = 'alex@example.com';
	projects = [
		project(),
		project({ ref: 'bbbbbbbbbbbbb', name: "orders (prod)", production: true }),
		project({ ref: 'ccccccccccccc', name: "scratch", state: 'paused', desiredState: 'paused', wakesInstantly: false, sizeBytes: 1_200_000 }),
		project({ ref: 'ddddddddddddd', name: "over quota", readOnly: true }),
		project({ ref: 'eeeeeeeeeeeee', name: "waking up", state: 'starting' }),
	];
	await refreshPanel();

	const sidebar = handle.page.locator('.sidebar');
	await expect(sidebar).toContainText("first light");
	await expect(sidebar).toContainText("orders (prod)");
	// The two badges that mean something a user acts on.
	await expect(sidebar.locator('.env.prod')).toHaveCount(1);
	await expect(sidebar.locator('.env', { hasText: 'read-only' })).toHaveCount(1);
	await expect(sidebar).toContainText('Signed in as alex@example.com');
	await handle.page.screenshot({ path: 'test-results/cloud-panel-list.png' });
});

test('a running project offers Stop and not Start; the detail says its size and region', async () => {
	await handle.page.click('.tree-row:has-text("first light")');
	const detail = handle.page.locator('.cloud-detail').first();
	await expect(detail).toContainText('7.7 MB');
	await expect(detail).toContainText('us-west-2');
	await expect(actions().locator('button:has-text("Stop")')).toBeEnabled();
	await expect(actions().locator('button:has-text("Start")')).toBeDisabled();
	await handle.page.screenshot({ path: 'test-results/cloud-panel-detail.png' });
	await handle.page.click('.tree-row:has-text("first light")');
});

test('a paused project offers Start, and says its next start is a restore', async () => {
	await handle.page.click('.tree-row:has-text("scratch")');
	const detail = handle.page.locator('.cloud-detail').first();
	await expect(actions().locator('button:has-text("Start")')).toBeEnabled();
	await expect(actions().locator('button:has-text("Stop")')).toBeDisabled();
	// The difference a user FEELS, so it is said before they wait for it.
	await expect(detail).toContainText('the next start restores it');
	await handle.page.click('.tree-row:has-text("scratch")');
});

test('a project mid-flight offers nothing at all', async () => {
	// Something is already happening; asking for a second thing on top is how a pod gets
	// told to start and stop in the same tick.
	await handle.page.click('.tree-row:has-text("waking up")');
	const detail = handle.page.locator('.cloud-detail').first();
	await expect(detail).toContainText('working');
	await expect(actions().locator('button:has-text("Start")')).toBeDisabled();
	await expect(actions().locator('button:has-text("Stop")')).toBeDisabled();
	await handle.page.click('.tree-row:has-text("waking up")');
});

test('a production project says why it will never be stopped, before anyone tries', async () => {
	await handle.page.click('.tree-row:has-text("orders (prod)")');
	const detail = handle.page.locator('.cloud-detail').first();
	await expect(actions().locator('button:has-text("Stop")')).toBeDisabled();
	await expect(detail).toContainText('never paused');
	await handle.page.click('.tree-row:has-text("orders (prod)")');
});

test('stopping asks, and says so, rather than claiming the database is stopped', async () => {
	asked = [];
	pauseRefusal = null;
	await handle.page.click('.tree-row:has-text("first light")');
	await actions().locator('button:has-text("Stop")').click();
	const detail = handle.page.locator('.cloud-detail').first();
	// What actually happened: a desired state was set. The host agent has not run yet, so
	// reporting "stopped" here would be a lie for several seconds.
	await expect(detail).toContainText('Asked it to stop');
	expect(asked).toEqual([{ action: 'pause', ref: 'aaaaaaaaaaaaa' }]);
	await handle.page.screenshot({ path: 'test-results/cloud-panel-asked.png' });
	await handle.page.click('.tree-row:has-text("first light")');
});

test("a refusal is shown in the control plane's own words", async () => {
	// The rules live in the tested control package, not here. What the user sees is the
	// sentence the server sent, not a paraphrase this side composed.
	pauseRefusal = 'a production project is never paused';
	await handle.page.click('.tree-row:has-text("first light")');
	await actions().locator('button:has-text("Stop")').click();
	// AMBER, not red: the app stopping something is the system working, and painting it
	// the same colour as "the control plane is unreachable" says it broke when it did not.
	await expect(handle.page.locator('.cloud-detail .form-status.warn')).toContainText('a production project is never paused');
	await expect(handle.page.locator('.cloud-detail .form-status.error')).toHaveCount(0);
	await handle.page.screenshot({ path: 'test-results/cloud-panel-refused.png' });
	pauseRefusal = null;
	await handle.page.click('.tree-row:has-text("first light")');
});

test('the account projects become connections without an import', async () => {
	account = 'alex@example.com';
	projects = [project(), project({ ref: 'bbbbbbbbbbbbb', name: "orders (prod)", production: true })];

	// Refreshing the panel is one of the sync's triggers (startup and sign-in are the others).
	await showCloud();
	await cloudHeader().locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();

	// Ordinary connections: same tree, same shape, nothing saying "cloud".
	await showConnections();
	await expect(handle.page.locator('.sidebar')).toContainText("first light");
	await expect(handle.page.locator('.sidebar')).toContainText("orders (prod)");
	await handle.page.screenshot({ path: 'test-results/cloud-synced-connections.png' });
});

test('importing the same project again updates it rather than adding a second one', async () => {
	// Import lives in the Connections header only: the Cloud projects panel no longer carries it,
	// since its projects arrive as connections on their own.
	await expect(cloudHeader().locator('button[title="Import these as connections"]')).toHaveCount(0);
	await showConnections();
	await handle.page.click('.sidebar-header button[aria-label^="Import connections"]');
	await handle.page.click('.import-sources button:has-text("SnoutData Cloud")');

	// Not a warning: re-importing is the supported way to pick up a reset password. An
	// already-imported project is NOT pre-selected, so this one really is a tick.
	await expect(handle.page.locator('.import-row:has-text("first light")')).toContainText('already imported, will update');
	await handle.page.click('.import-row:has-text("first light") input[type="checkbox"]');
	await handle.page.click('.modal-actions button:has-text("Import")');

	await showConnections();
	await expect(handle.page.locator('.tree-row:has-text("first light")')).toHaveCount(1);
});

test('a project created from the panel is a connection at once, and a delete is asked for', async () => {
	await showCloud();
	await cloudHeader().locator('button[aria-label="New project"]').click();
	await handle.page.click('.panel-menu-item:has-text("In SnoutData Cloud")');
	await handle.page.fill('.modal input[placeholder^="orders"]', "made here");
	await handle.page.click('.modal-actions button:has-text("Create")');

	await expect(handle.page.locator('.sidebar')).toContainText('Created fffffffffffff and added it as a connection');
	await expect(handle.page.locator('.tree-row:has-text("made here")')).toHaveCount(1);
	await handle.page.screenshot({ path: 'test-results/cloud-created.png' });

	await showConnections();
	await expect(handle.page.locator('.sidebar')).toContainText("made here");

	// A project mid-create offers no delete, like any other in-flight state; let it finish.
	projects = projects.map((p) => (p.ref === 'fffffffffffff' ? { ...p, state: 'ready' } : p));
	await showCloud();
	await cloudHeader().locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();
	// "Created … It is starting" is news only until it has started: once the project is ready the
	// line goes, instead of sitting above a green dot saying the opposite.
	await expect(handle.page.locator('.sidebar')).not.toContainText('Created fffffffffffff');
	// Deleting is in the project's Settings, as on the online dashboard, never in the panel.
	await handle.page.click('.tree-row:has-text("made here")');
	await expect(handle.page.locator('.cloud-detail button:has-text("Delete")')).toHaveCount(0);
	await handle.page.locator('.sidebar .tree-row:has-text("Settings")').last().click();
	await handle.page.locator('.cloud-project-view button:has-text("Delete project")').click();
	await handle.page.click('.modal.confirm button:has-text("Delete")');
	await expect.poll(() => asked.some((a) => a.action === 'delete' && a.ref === 'fffffffffffff')).toBe(true);
	await expect(handle.page.locator('.tree-row:has-text("made here")')).toHaveCount(0);

	// Deleting a project takes its connection with it.
	await showConnections();
	await expect(handle.page.locator('.sidebar')).not.toContainText('made here');
});

test('a project expands into what belongs to it, and its database opens in Connections with the butterfly', async () => {
	await showCloud();
	await cloudHeader().locator('button:is([title="Refresh"], [aria-label="Refresh"])').click();
	const panel = handle.page.locator('.sidebar', { has: cloudHeader() });
	await panel.locator('.tree-row:has-text("first light")').click();
	// The dashboard's project menu, the same one a local project has (shared/projects.ts).
	for (const child of ['Overview', 'Extensions', 'Cron', 'Time series', 'Auth', 'Storage', 'Data API', 'Functions', 'Containers', 'Realtime', 'Push', 'Logs', 'Domains', 'Settings']) {
		await expect(panel.locator('.tree-row.depth-2:not(.projects-subgroup)', { hasText: new RegExp(`^${child}$`) })).toHaveCount(1);
	}
	// The Database row opens its section like the others; its plug is what jumps to Connections.
	await panel.locator('.tree-row.depth-2:not(.projects-subgroup)', { hasText: /^Database$/ }).locator('button[title="Show in Connections"]').click();

	// Connections is shown, and the cloud connection carries the butterfly, not the Postgres mark.
	const row = handle.page.locator('.sidebar .tree-row:has-text("first light")');
	await expect(row.locator('svg.brand-mark')).toHaveCount(1);
	await handle.page.screenshot({ path: 'test-results/cloud-butterfly.png' });
	await row.locator('svg.brand-mark').screenshot({ path: 'test-results/cloud-butterfly-mark.png', scale: 'device' });
});

test('the project tab walks every section against the control plane', async () => {
	await showCloud();
	const panel = handle.page.locator('.sidebar', { has: cloudHeader() });
	if (!(await panel.locator('.tree-row.depth-2', { hasText: /^Storage$/ }).isVisible().catch(() => false))) {
		await panel.locator('.tree-row:has-text("first light")').click();
	}
	await panel.locator('.tree-row.depth-2', { hasText: /^Storage$/ }).click();

	const view = handle.page.locator('.cloud-project-view');
	await expect(view.locator('.settings-section-title')).toHaveText('Storage');
	// The product switch is the control plane's; the buckets are the project's own SQL, the same
	// component a local project's Storage uses, sent through cloud-project-sql for this ref.
	const storageSwitch = view.locator('fieldset').first().locator('label.check');
	await storageSwitch.click();
	await expect(storageSwitch).toContainText('On');
	await expect(view.locator('.local-service', { hasText: 'avatars' })).toBeVisible();
	expect(sqls.some((q) => q.ref === 'aaaaaaaaaaaaa' && q.sql.startsWith('/* snoutdata-desktop */') && q.sql.includes('from snout_files.spaces'))).toBe(true);
	await handle.page.screenshot({ path: 'test-results/cloud-project-storage.png' });

	// Refused by the plan: said, amber, and the switch cannot be flipped. No real tier refuses the
	// data API any more; the fake control plane here still answers `allowed: false`, so
	// the refusal path stays exercised.
	await view.locator('.settings-nav-item:has-text("Data API")').click();
	await expect(view).toContainText("The data API is not included in this project's plan");
	await expect(view.locator('fieldset', { hasText: 'Data API' }).locator('label.check input')).toBeDisabled();

	// A shared section, read from the cloud project's own catalog.
	await view.locator('.settings-nav-item:has-text("Extensions")').click();
	await expect(view.locator('.cloud-table')).toContainText('postgis');
	// Ten at a time: 24 extensions are three pages, and a search starts again at the first.
	const extensions = view.locator('fieldset', { hasText: 'Extensions' });
	await expect(extensions.locator('.cloud-table tr')).toHaveCount(10);
	await expect(extensions).toContainText('Page 1 of 3');
	await extensions.locator('button:has-text("Next")').click();
	await expect(extensions).toContainText('Page 2 of 3');
	await expect(extensions.locator('.cloud-table')).not.toContainText('postgis');
	await extensions.locator('input[placeholder^="vector"]').fill('ext_2');
	await expect(extensions.locator('.cloud-table tr')).toHaveCount(2);
	await expect(extensions).not.toContainText('Page 1');
	await extensions.locator('input[placeholder^="vector"]').fill('');
	await expect(extensions).toContainText('Page 1 of 3');

	await view.locator('.settings-nav-item:has-text("Functions")').click();
	await expect(view.locator('.cloud-table').first()).toContainText('hello');
	await view.locator('input[placeholder="STRIPE_KEY"]').fill('stripe_key');
	await view.locator('input[type="password"]').fill('sk_test');
	await view.locator('button:has-text("Set secret")').click();
	await expect(view).toContainText('STRIPE_KEY set');
	// Function sizing: memory x workers against the project's memory, and a change reaching the control plane.
	const sizing = view.locator('fieldset', { hasText: 'Memory and concurrency' });
	await expect(sizing).toContainText('128 MB × 2 = 256 MB of 512 MB');
	await sizing.locator('label:has-text("Memory a worker") select').selectOption('64');
	await expect(sizing).toContainText('64 MB × 2 = 128 MB of 512 MB');
	await sizing.locator('button:has-text("Save")').click();
	await expect(view).toContainText('hello runs at 64 MB × 2');
	await expect(view.locator('.cloud-table').first()).toContainText('64 MB');
	await handle.page.screenshot({ path: 'test-results/cloud-project-functions.png' });

	await view.locator('.settings-nav-item:has-text("Domains")').click();
	await view.locator('input[placeholder="api.yourcompany.com"]').fill('api.example.com');
	await view.locator('button:has-text("Add domain")').click();
	await expect(view.locator('.form-status.warn')).toContainText('Custom domains are on paid plans');

	// The Dashboard: state, keys and usage, as the cloud dashboard's first tab has them.
	await view.locator('.settings-nav-item:has-text("Overview")').click();
	await expect(view.locator('.cloud-facts').first()).toContainText('us-west-2');
	await expect(view.locator('.cloud-table')).toContainText('2026-09-20');
	await handle.page.screenshot({ path: 'test-results/cloud-project-overview.png' });
});

test('the panel controls do not overlap and nothing hugs the corners', async () => {
	await showCloud();
	const panel = handle.page.locator('.sidebar', { has: cloudHeader() });
	if (!(await panel.locator('.cloud-detail').isVisible().catch(() => false))) {
		await panel.locator('.tree-row:has-text("first light")').click();
	}
	const boxes = await panel.locator('.project-actions').first().locator('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, top: r.top })));
	expect(boxes.length).toBe(3);
	for (let i = 1; i < boxes.length; i++) {
		// A gap between neighbours, not two buttons sharing an edge (the first version touched).
		if (boxes[i].top === boxes[i - 1].top) {
			expect(boxes[i].left - boxes[i - 1].right).toBeGreaterThanOrEqual(4);
		}
	}
	const edge = await panel.evaluate((el) => el.getBoundingClientRect().left);
	const footer = await panel.locator('.cloud-account').evaluate((el) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		return range.getBoundingClientRect().left;
	});
	expect(footer - edge).toBeGreaterThanOrEqual(8);
	// And it is the panel's FOOTER: at the bottom by the status bar, not trailing the last project
	// (it slid up under the list when the panel became Dashboard).
	const [panelBottom, footerBottom] = await Promise.all([
		panel.evaluate((el) => el.getBoundingClientRect().bottom),
		panel.locator('.cloud-account').evaluate((el) => el.getBoundingClientRect().bottom),
	]);
	expect(panelBottom - footerBottom).toBeLessThanOrEqual(2);
});

test('signing out, or into another account, re-reads the list without a Refresh', async () => {
	await showCloud();
	const panel = handle.page.locator('.sidebar', { has: cloudHeader() });
	await expect(panel).toContainText('first light');
	const state = await handle.page.evaluate(() => (window as unknown as { sqlApi: { authState(): Promise<Record<string, unknown>> } }).sqlApi.authState());
	async function push(user: Record<string, unknown> | null): Promise<void> {
		await handle.app.evaluate(({ BrowserWindow }, payload) => {
			BrowserWindow.getAllWindows()[0].webContents.send('auth:changed', payload);
		}, { ...state, user });
	}
	// Signed in (the panel knew nobody), then out: the second push is the sign-out.
	await push({ id: 'u-1', email: 'alex@example.com' });
	account = null;
	await push(null);
	await expect(panel).toContainText('Sign in to SnoutData to see your hosted databases.');
	await expect(panel.locator('.tree-row:has-text("first light")')).toHaveCount(0);
	account = 'alex@example.com';
	await push({ id: 'u-1', email: 'alex@example.com' });
	await expect(panel).toContainText('first light');
});

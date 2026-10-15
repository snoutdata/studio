/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

// Users & Privileges, through the real app.
//
// SQLite is the connection here on purpose. It is file-based (no server, no credentials) AND it is
// the engine that has no users at all, which makes it the right thing to point the two rules at
// that can be proven without a live Postgres:
//
//  - the HONEST DECLINE: an engine with no accounts says so in a sentence, rather than showing an
//    empty list that reads as "there is nobody here";
//  - the REDACTION: a statement carrying a password must not reach query history in cleartext.
//    That one is engine-independent — it is the app's recording chokepoint being tested, and it
//    only needs a connection that will run (and reject) the statement.
//
// Everything vendor-specific — the catalog SQL, the emitted GRANTs — is unit-tested in
// `src/shared/engine/security/plan.test.ts`, and still wants a hand-test against a real server.

let handle: AppHandle;
let dir: string;
let dbFile: string;

/** Save a SQLite connection through the real IPC and connect it. Returns its id. */
async function addConnection(page: Page, label: string, file: string): Promise<string> {
	return page.evaluate(async (input) => {
		const api = (window as unknown as {
			sqlApi: {
				saveConnection(form: unknown): Promise<{ id: string }>;
				connect(id: string): Promise<{ ok?: boolean; error?: string }>;
			};
		}).sqlApi;
		const saved = await api.saveConnection({
			label: input.label, driver: 'sqlite', host: '', port: 0,
			database: input.file, username: '', ssl: false, readOnly: false,
		});
		const result = await api.connect(saved.id);
		if (result.error) {
			throw new Error(`connect failed: ${result.error}`);
		}
		return saved.id;
	}, { label, file });
}

/** Select the SQLite connection in the sidebar and expand it. The sidebar is what binds a tool
 *  tab to a connection, so anything opened afterwards lands on this database. */
async function selectShop(page: Page): Promise<void> {
	const row = page.locator('.tree-row.depth-0').filter({ has: page.locator('.tree-label', { hasText: /^Shop$/ }) });
	await row.click();
	if (await page.locator('.tree-row.depth-1').count() === 0) {
		await row.locator('.twisty').click();
	}
}

test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-security-'));
	dbFile = join(dir, 'shop.sqlite');
	const db = new DatabaseSync(dbFile);
	db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)');
	db.close();

	handle = await launchApp('security');
	await addConnection(handle.page, 'Shop', dbFile);
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('the connection tree does not offer it on an engine that has no accounts', async () => {
	// A permanent row that only ever says "SQLite has no users" is clutter. The node appears on
	// engines that HAVE accounts, read or not; SQLite is the case where the concept does not exist.
	const page = handle.page;
	await selectShop(page);
	// The database row appearing is how we know the connection really expanded, so the absence
	// below is an absence and not an unexpanded tree.
	await expect(page.locator('.tree-row.depth-1').first()).toBeVisible();
	await expect(page.locator('.tree-label', { hasText: /^Users & Privileges$/ })).toHaveCount(0);
});

test('opened deliberately, it says WHY there is nothing to show', async () => {
	// "There is nobody here" and "this engine has no such thing" look identical as a blank list,
	// and only one of them is ever true.
	const page = handle.page;
	await selectShop(page);
	await page.keyboard.press(`${MOD}+Shift+KeyP`);
	await page.getByPlaceholder(/command/i).fill('Users');
	await page.keyboard.press('Enter');
	await expect(page.getByText(/SQLite has no users or privileges/i)).toBeVisible();
	// It is a tool tab, so it TAKES the workbench: the editor and the results grid are hidden
	// while it is up, rather than the view being appended under them.
	await expect(page.locator('.sql-body')).toBeHidden();
});

test('the read refuses the same way through the IPC, with the same sentence', async () => {
	const outcome = await handle.page.evaluate(async () => {
		const api = (window as unknown as {
			sqlApi: {
				state(): Promise<{ connections: { id: string; label: string }[] }>;
				securitySupport(id: string): Promise<{ supported: boolean; reason?: string }>;
				securityRead(id: string): Promise<unknown>;
			};
		}).sqlApi;
		const state = await api.state();
		const id = state.connections.find((c) => c.label === 'Shop')!.id;
		const support = await api.securitySupport(id);
		let readError = '';
		try {
			await api.securityRead(id);
		} catch (err) {
			readError = err instanceof Error ? err.message : String(err);
		}
		return { support, readError };
	});
	expect(outcome.support.supported).toBe(false);
	expect(outcome.support.reason).toMatch(/SQLite has no users/i);
	expect(outcome.readError).toMatch(/SQLite has no users/i);
});

test('a password never reaches query history, and what lands there cannot be re-run', async () => {
	const page = handle.page;
	const history = await page.evaluate(async () => {
		const api = (window as unknown as {
			sqlApi: {
				state(): Promise<{ connections: { id: string; label: string }[] }>;
				execute(params: { connectionId: string; sql: string }): Promise<{ ok: boolean }>;
				history(): Promise<{ sql: string }[]>;
			};
		}).sqlApi;
		const state = await api.state();
		const id = state.connections.find((c) => c.label === 'Shop')!.id;
		// SQLite rejects this, which is the point: history records failures too, so the redaction
		// has to happen on the way IN rather than only on a successful run.
		await api.execute({ connectionId: id, sql: "CREATE USER app IDENTIFIED BY 'hunter2'" });
		return api.history();
	});

	const entry = history.find((e) => e.sql.includes('CREATE USER app'));
	expect(entry, 'the statement should be in history').toBeTruthy();
	expect(entry!.sql).not.toContain('hunter2');
	expect(entry!.sql).toBe('CREATE USER app IDENTIFIED BY <redacted>');
	// `<redacted>` is not a valid literal anywhere, so re-running a history row fails loudly
	// instead of quietly setting the password to the redaction text.
	expect(entry!.sql).not.toMatch(/IDENTIFIED BY '[^']*'/);
});

test('the agent tools are published, and the create-user tool has no password field', async () => {
	const specs = await handle.page.evaluate(() => {
		const list = (window as unknown as {
			__snoutDebugCapabilities?: () => { name: string; mutates: boolean; parameters: { properties?: Record<string, unknown> } }[];
		}).__snoutDebugCapabilities;
		return list ? list() : null;
	});
	test.skip(specs === null, 'this build does not expose the capability registry to the page');
	const names = specs!.map((spec) => spec.name);
	expect(names).toContain('list_db_users');
	expect(names).toContain('list_db_grants');
	expect(names).toContain('propose_db_user');
	expect(names).toContain('propose_db_access_change');
	expect(specs!.find((spec) => spec.name === 'list_db_users')!.mutates).toBe(false);
	const proposeUser = specs!.find((spec) => spec.name === 'propose_db_user')!;
	expect(proposeUser.mutates).toBe(true);
	expect(Object.keys(proposeUser.parameters.properties ?? {})).not.toContain('password');
});

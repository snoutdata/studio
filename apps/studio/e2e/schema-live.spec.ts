/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// The LIVE SCHEMA INDEX, end to end through the real app: the server polls a cheap structural
// digest per connection every 15s, re-introspects when it changes, and the explorer is supposed to
// follow WITHOUT the user pressing Refresh. The project notes carried this as built-but-never-verified-in-
// the-GUI, and it was dead: `boot()` bound the SchemaUpdated notification inside
// `if (this.schemaUpdatedHandler)`, and boot runs synchronously past that line during
// `sqlServer.start(...)` — i.e. before the very next statement in main installed the handler. So
// the `if` never passed, `schema:changed` never reached the renderer, and the tree showed the
// schema it had at connect time until a manual refresh.
//
// It looked fine from every angle that was being checked: the server's own cache DID update, so
// completion and hover (served server-side) stayed current. Only the tree was stale, and only
// against a database somebody changed while the app was open.
//
// SQLite is used because it is file-based (no server, no credentials) and implements
// structuralDigest, and because `node:sqlite` lets the test make DDL happen BEHIND the app's back —
// which is the only way to prove the poll is what noticed, rather than the app's own write path.
let handle: AppHandle;
let dir: string;
let dbFile: string;

/** Run DDL against the file directly. Deliberately not through the app: nothing in the app is told
 *  this happened, so only the live schema index can surface it. */
function ddl(statements: string[]): void {
	const db = new DatabaseSync(dbFile);
	try {
		for (const statement of statements) {
			db.exec(statement);
		}
	} finally {
		db.close();
	}
}

async function addConnection(page: Page, label: string, file: string): Promise<string> {
	return page.evaluate(async (input) => {
		const api = (window as unknown as {
			sqlApi: {
				saveConnection(form: unknown): Promise<{ id: string }>;
				connect(id: string): Promise<{ error?: string }>;
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

test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-schema-live-'));
	dbFile = join(dir, 'live.db');
	// One table to start with, so the tree has a database node to expand and the assertion below is
	// "the NEW table appeared" rather than "the tree stopped being empty".
	ddl(['CREATE TABLE first_table (id INTEGER PRIMARY KEY)']);
	handle = await launchApp('schema-live');
	await addConnection(handle.page, 'live', dbFile);
});

test.afterAll(async () => {
	await closeApp(handle);
	rmSync(dir, { recursive: true, force: true });
});

test('a table created while the app is open appears in the explorer with no manual refresh', async () => {
	// The poll interval is 15s; allow for a tick landing just after the change plus introspection.
	test.setTimeout(120_000);
	const { page } = handle;

	// Expand the connection, then the database, so the table list is on screen and STAYS on screen.
	const root = page.locator('.tree-row.depth-0', { hasText: 'live' });
	await expect(root).toBeVisible();
	await root.locator('.twisty').click();
	await expect(page.locator('.tree-row.depth-1', { hasText: 'live.db' })).toBeVisible({ timeout: 30_000 });
	await page.locator('.tree-row.depth-1', { hasText: 'live.db' }).click();
	await expect(page.locator('.tree-label', { hasText: 'first_table' })).toBeVisible();

	// Now change the schema behind the app's back. Nothing clicks Refresh after this point.
	ddl(['CREATE TABLE arrived_later (id INTEGER PRIMARY KEY, note TEXT)']);

	await expect(page.locator('.tree-label', { hasText: 'arrived_later' })).toBeVisible({ timeout: 60_000 });

	// A DROP has to travel the same way — a tree that only ever grows is still stale.
	ddl(['DROP TABLE arrived_later']);
	await expect(page.locator('.tree-label', { hasText: 'arrived_later' })).toHaveCount(0, { timeout: 60_000 });
});

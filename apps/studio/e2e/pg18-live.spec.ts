/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, type Page } from '@playwright/test';
import { closeApp, dbEnv, launchApp, type AppHandle } from './helpers';

/* ------------------------------------------------------------------------------------------
 * Postgres 18, in the real app.
 *
 * What Studio learned for 18, driven against a real 18 server: introspection reads the server's
 * major (`serverVersionNum`, which the advice that is only true on 18 keys on), a generated
 * column says which kind it is in the DDL view (18 made VIRTUAL the default, so a STORED column
 * written without the word would change meaning), a query runs and its row reaches the grid, and
 * completion knows the tables. Gated on the SNOUTDATA_TEST_* env, Postgres only, and skips on a
 * server older than 18. A SnoutData Cloud project needs SNOUTDATA_TEST_SSL=1:
 *
 *   SNOUTDATA_TEST_DRIVER=postgres SNOUTDATA_TEST_HOST=<ref>.db.snoutdata.com SNOUTDATA_TEST_PORT=5432 \
 *   SNOUTDATA_TEST_NAME=<ref> SNOUTDATA_TEST_USER=<ref>_owner SNOUTDATA_TEST_PASSWORD=… \
 *   SNOUTDATA_TEST_SSL=1 npx playwright test pg18-live --project=app
 * ------------------------------------------------------------------------------------------ */

const db = dbEnv();
const LABEL = 'pg18';

test.skip(!db || db.driver !== 'postgres', 'set SNOUTDATA_TEST_* to a Postgres 18 server (SNOUTDATA_TEST_DRIVER=postgres)');

let handle: AppHandle;
let connectionId = '';

/** Save the SNOUTDATA_TEST_* connection through the real IPC and connect it. */
async function addLiveConnection(page: Page): Promise<string> {
	return page.evaluate(async (input) => {
		const saved = await window.sqlApi.saveConnection({
			label: input.label, driver: input.driver, host: input.host, port: Number(input.port) || undefined,
			database: input.database, username: input.username, password: input.password,
			ssl: input.ssl === true, sslMode: input.ssl === true ? 'system' : undefined, readOnly: false,
		} as Parameters<typeof window.sqlApi.saveConnection>[0]);
		const result = (await window.sqlApi.connect(saved.id)) as unknown as { error?: string };
		if (result.error) {
			throw new Error(`connect failed: ${result.error}`);
		}
		return saved.id;
	}, { ...db!, label: LABEL });
}

/** Run one statement, for setting the tables up. */
async function exec(page: Page, sql: string): Promise<void> {
	const error = await page.evaluate(async (input) => {
		const result = await window.sqlApi.execute({ connectionId: input.connectionId, sql: input.sql } as Parameters<typeof window.sqlApi.execute>[0]);
		return (result as { error?: string }).error;
	}, { connectionId, sql });
	if (error) {
		throw new Error(`${sql}: ${error}`);
	}
}

/** Open a table's Properties tab through the tree, expanding the tree only the first time. */
async function openTable(page: Page, table: string): Promise<void> {
	const row = page.locator('.tree-row', { hasText: table }).first();
	if (!(await row.isVisible())) {
		const root = page.locator('.tree-row.depth-0', { hasText: LABEL });
		await expect(root).toBeVisible({ timeout: 30_000 });
		await root.locator('.twisty').click();
		// Postgres groups the tree by schema, so the node under the connection is `public`.
		const schema = page.locator('.tree-row.depth-1', { hasText: 'public' });
		await expect(schema).toBeVisible({ timeout: 30_000 });
		await schema.click();
	}
	await expect(row).toBeVisible({ timeout: 30_000 });
	await row.dblclick();
	await page.getByRole('button', { name: 'Properties' }).click();
	await expect(page.locator('.designer-grid:visible')).toBeVisible({ timeout: 30_000 });
}

/** What the DDL view says for the open table. */
async function ddlOf(page: Page): Promise<string> {
	await page.locator('.prop-nav-item:visible', { hasText: 'DDL' }).click();
	const view = page.locator('.ddl-view:visible');
	await expect(view).toBeVisible({ timeout: 30_000 });
	return view.innerText();
}

test.beforeAll(async () => {
	handle = await launchApp('pg18-live');
	connectionId = await addLiveConnection(handle.page);
	await exec(handle.page, 'DROP TABLE IF EXISTS pg18_virtual, pg18_stored');
	await exec(handle.page, 'CREATE TABLE pg18_virtual (id int PRIMARY KEY, price numeric, qty int, total numeric GENERATED ALWAYS AS (price * qty) VIRTUAL)');
	await exec(handle.page, 'CREATE TABLE pg18_stored (id int PRIMARY KEY, price numeric, qty int, total numeric GENERATED ALWAYS AS (price * qty) STORED)');
	await handle.page.evaluate(async (id) => {
		await window.sqlApi.refresh(id);
	}, connectionId);
});

test.afterAll(async () => {
	if (handle && connectionId) {
		await exec(handle.page, 'DROP TABLE IF EXISTS pg18_virtual, pg18_stored').catch(() => undefined);
	}
	await closeApp(handle);
});

test('introspection reads the server as Postgres 18', async () => {
	const version = await handle.page.evaluate(async (id) => (await window.sqlApi.getSchema(id))?.serverVersionNum ?? 0, connectionId);
	test.skip(version > 0 && version < 180000, `the server is ${version}, older than 18`);
	expect(version).toBeGreaterThanOrEqual(180000);
});

test('a query runs on 18 and its row reaches the grid', async () => {
	const { page } = handle;
	const row = page.locator('.tree-row.depth-0', { hasText: LABEL });
	await expect(row).toBeVisible({ timeout: 30_000 });
	await row.click();
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.type('SELECT uuidv7() AS id');
	await page.locator('[data-tour="run-button"]').click();
	await expect(page.locator('.cell.head-cell', { hasText: 'id' })).toBeVisible({ timeout: 30_000 });
	// A version 7 UUID: the third group starts with 7.
	await expect(page.locator('.cell-text').filter({ hasText: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/ }).first()).toBeVisible();
	await page.screenshot({ path: 'e2e/.artifacts/pg18-uuidv7.png' });
});

test('completion knows the tables', async () => {
	await expect.poll(async () => handle.page.evaluate(async (id) => {
		const uri = 'file:///pg18-probe.sql';
		await window.sqlApi.didOpen(uri, 'SELECT * FROM pg18_v', 1);
		const answer = await window.sqlApi.completion(uri, { line: 0, character: 20 }, id);
		return answer.items.some((item) => item.label === 'pg18_virtual');
	}, connectionId), { timeout: 30_000 }).toBe(true);
});

test('the DDL view says VIRTUAL for a virtual generated column and STORED for a stored one', async () => {
	const { page } = handle;
	await openTable(page, 'pg18_virtual');
	const virtual = await ddlOf(page);
	expect(virtual).toMatch(/GENERATED ALWAYS AS \(.*\) VIRTUAL/i);
	await page.screenshot({ path: 'e2e/.artifacts/pg18-ddl-virtual.png' });

	await openTable(page, 'pg18_stored');
	const stored = await ddlOf(page);
	expect(stored).toMatch(/GENERATED ALWAYS AS \(.*\) STORED/i);
});

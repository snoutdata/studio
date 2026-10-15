/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, dbEnv, fillSsl, launchApp, type AppHandle } from './helpers';

// Live-database round trip, the full user path: create a connection in the form, connect,
// type a query, run it, read the result out of the grid. Gated on SNOUTDATA_TEST_* env
// (host/name/user required; optional _PASSWORD, _DRIVER, _PORT) and skips cleanly without it:
//   SNOUTDATA_TEST_HOST=127.0.0.1 SNOUTDATA_TEST_NAME=mydb SNOUTDATA_TEST_USER=me \
//   SNOUTDATA_TEST_PASSWORD=secret SNOUTDATA_TEST_DRIVER=postgres npm run e2e
const db = dbEnv();

/** What the driver picker calls the drivers this spec is usually pointed at. */
const DRIVER_LABELS: Record<string, string> = {
	postgres: 'PostgreSQL',
	'mysql-aurora': 'MySQL / Aurora MySQL',
	mariadb: 'MariaDB',
};

test.skip(!db, 'set SNOUTDATA_TEST_HOST / SNOUTDATA_TEST_NAME / SNOUTDATA_TEST_USER to run the live-DB specs');

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('db');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('create a connection, connect, run SELECT 1, see the row', async () => {
	const { page } = handle;
	const cfg = db!;

	// New connection through the real form.
	await page.locator('[data-tour="add-connection"]').click();
	await page.getByLabel('Label', { exact: true }).fill('e2e');
	// The driver picker is an IconSelect, a combobox button over a listbox of display names
	// (orbit-live.spec.ts does the same), so it is clicked rather than selectOption'd.
	await page.locator('.icon-select-button[aria-label="Driver"]').click();
	await page.locator('[role="option"]', { hasText: DRIVER_LABELS[cfg.driver] ?? cfg.driver }).first().click();
	await page.getByLabel('Host', { exact: true }).fill(cfg.host);
	if (cfg.port) {
		await page.getByLabel('Port', { exact: true }).fill(cfg.port);
	}
	await page.getByLabel('Database', { exact: true }).fill(cfg.database);
	await page.getByLabel('Username', { exact: true }).fill(cfg.username);
	if (cfg.password) {
		await page.getByLabel('Password', { exact: true }).fill(cfg.password);
	}
	await fillSsl(page, cfg);
	await page.getByRole('button', { name: 'Save', exact: true }).click();

	// The connection shows in the tree; select it and connect (row actions show on hover).
	const row = page.locator('.tree-row.depth-0', { hasText: 'e2e' });
	await expect(row).toBeVisible();
	await row.click();
	// Saving a connection also connects it, so the Connect button is usually already gone.
	const connect = row.locator('button[aria-label="Connect"]');
	if (await connect.count()) {
		await row.hover();
		await connect.click();
	}
	await expect(row.locator('.dot.on')).toBeVisible({ timeout: 30_000 });

	// Type and run; SELECT 1 works on every SQL driver the env can point at.
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.type('SELECT 1 AS one');
	await page.locator('[data-tour="run-button"]').click();

	// The grid shows the column header and the row value.
	await expect(page.locator('.cell.head-cell', { hasText: 'one' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.cell-text', { hasText: '1' }).first()).toBeVisible();
	await page.screenshot({ path: 'e2e/.artifacts/db-select1.png' });
});

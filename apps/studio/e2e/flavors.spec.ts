/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// A wire-compatible engine (CockroachDB on the Postgres driver) picked from the connection form's
// own picker: it offers the engine by name, defaults to the engine's port, and saves a connection
// that carries the flavor. The connect half runs only against a live CockroachDB:
//   docker run -d -p 26257:26257 cockroachdb/cockroach start-single-node --insecure
//   SNOUTDATA_TEST_COCKROACH_PORT=26257 npx playwright test flavors --project=app

const LIVE_PORT = process.env.SNOUTDATA_TEST_COCKROACH_PORT;

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('flavors');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('the picker offers CockroachDB, with its own port, and the saved connection carries it', async () => {
	const { page } = handle;
	await page.locator('[data-tour="add-connection"]').click();
	const form = page.locator('.modal');
	await form.getByRole('combobox', { name: "Driver" }).click();
	await page.getByRole('option', { name: "CockroachDB" }).click();
	await expect(form.getByRole('combobox', { name: "Driver" })).toHaveText("CockroachDB");
	await expect(form.locator('label.port input')).toHaveAttribute('placeholder', '26257');

	await form.getByLabel("Label").fill('crdb');
	await form.getByLabel("Host").fill('127.0.0.1');
	if (LIVE_PORT) {
		await form.locator('label.port input').fill(LIVE_PORT);
	}
	await form.getByLabel("Database", { exact: true }).fill('defaultdb');
	await form.getByLabel("Username").fill('root');
	await form.getByRole('button', { name: "Save" }).click();
	await expect(form).toBeHidden();

	const saved = await page.evaluate(async () => (await window.sqlApi.state()).connections.find((c) => c.label === 'crdb'));
	expect(saved?.driver).toBe('postgres');
	expect(saved?.flavor).toBe('cockroachdb');
	expect(saved?.port).toBe(Number(LIVE_PORT ?? 26257));

	const row = page.locator('.tree-row.depth-0', { hasText: 'crdb' });
	await expect(row.locator('.driver-mark')).toHaveAttribute('title', /^CockroachDB/);
});

test('it connects and introspects through the Postgres driver', async () => {
	test.skip(!LIVE_PORT, 'set SNOUTDATA_TEST_COCKROACH_PORT to run against a live CockroachDB');
	const { page } = handle;
	const row = page.locator('.tree-row.depth-0', { hasText: 'crdb' });
	await row.click();
	await row.hover();
	if (await row.locator('button[aria-label="Connect"]').count() > 0) {
		await row.locator('button[aria-label="Connect"]').click();
	}
	await expect(row.locator('button[aria-label="Disconnect"]')).toBeVisible({ timeout: 30_000 });
});

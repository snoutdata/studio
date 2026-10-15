/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// Boot smoke: the app launches, paints its UI, and the preload bridge is wired. One shared
// instance for the whole file — these assertions are read-only.
let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('boot');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('opens one window with the app UI', async () => {
	const windows = await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
	expect(windows).toBe(1);
	await expect(handle.page).toHaveTitle('SnoutData Studio');
	await expect(handle.page.locator('[data-tour="activity-bar"]')).toBeVisible();
});

test('shows the empty connections tree in a fresh profile', async () => {
	await expect(handle.page.locator('.tree-empty')).toContainText('No connections yet');
});

test('exposes the preload sqlApi bridge', async () => {
	const bridge = await handle.page.evaluate(() => typeof (window as { sqlApi?: unknown }).sqlApi);
	expect(bridge).toBe('object');
});

test('editor is up (Monaco mounted)', async () => {
	await expect(handle.page.locator('.monaco-editor').first()).toBeVisible();
	await handle.page.screenshot({ path: 'e2e/.artifacts/boot.png' });
});

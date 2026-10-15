/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

// Editor + tabs: typing reaches Monaco, and the renderer's global keybindings work
// (synthesized keys hit the renderer's keydown handler, not native menu accelerators).
let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('editor');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('typing lands in the Monaco buffer', async () => {
	const { page } = handle;
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.type('SELECT 1 AS one');
	await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('SELECT 1 AS one');
});

test('Mod+N opens a second tab, Mod+W closes it', async () => {
	const { page } = handle;
	await expect(page.locator('.tab-item')).toHaveCount(1);
	await page.keyboard.press(`${MOD}+n`);
	await expect(page.locator('.tab-item')).toHaveCount(2);
	// The new tab is active and empty; the first tab's buffer is untouched.
	await page.keyboard.press(`${MOD}+w`);
	await expect(page.locator('.tab-item')).toHaveCount(1);
	await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('SELECT 1 AS one');
});

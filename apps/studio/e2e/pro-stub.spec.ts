/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, PRO_BUILD, type AppHandle } from './helpers';

// Studio WITHOUT Data Flows: the open-source build, which compiles packages/studio-pro-stub in its
// place. The Flows view says where the feature is, the palette offers nothing that would open it,
// Settings has no Data Flows pages, and the status bar has no model reading. Runs only against
// such a build: the same rule as scripts/pro.mjs (the real half absent, or SNOUT_PRO=0), which is
// what decided the build. Here, `SNOUT_PRO=0 npm run build` then this spec; in the public repo it
// always runs.

const PALETTE = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';

test.describe.configure({ mode: 'serial' });
test.skip(PRO_BUILD, 'an official build has Data Flows; the flows specs cover it');

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('pro-stub');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('the Flows view says where Data Flows is', async () => {
	const { page } = handle;
	await page.locator('.activity-item[aria-label="Data flows"]').click();
	await expect(page.locator('[data-test="pro-placeholder"]')).toBeVisible();
	await expect(page.locator('[data-test="pro-placeholder"]')).toContainText('official SnoutData Studio build');
});

test('nothing offers to create or import a flow', async () => {
	const { page } = handle;
	await page.keyboard.press(PALETTE);
	await page.keyboard.type('Data Flow');
	await expect(page.locator('.palette-item, [role="option"]').filter({ hasText: /New Data Flow|Import Data Flow/ })).toHaveCount(0);
	await page.keyboard.press('Escape');
});

test('no model reading in the status bar', async () => {
	await expect(handle.page.locator('[data-status="neural"]')).toHaveCount(0);
});

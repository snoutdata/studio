/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, LIBY_BUILD, type AppHandle } from './helpers';

// Studio WITHOUT Liby: the open-source build, which compiles packages/liby-stub in her place.
// Nothing of hers may mount, and the help shortcut, which brings her in the official build, opens
// the assistant instead. Runs only against such a build: the same rule as scripts/liby.mjs (her
// package absent, or SNOUT_PRO=0), which is what decided the build.
// Here, `SNOUT_PRO=0 npm run build` then this spec; in the public repo it always runs.

const SUMMON = process.platform === 'darwin' ? 'Meta+Shift+H' : 'Control+Shift+H';

test.describe.configure({ mode: 'serial' });
test.skip(LIBY_BUILD, 'an official build has Liby, and her own specs cover her');

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('liby-stub');
	// Start with the assistant hidden, so the shortcut has something to show.
	await handle.page.evaluate(() => {
		localStorage.setItem('positron-db.layout', JSON.stringify({ docks: { right: { tools: ['assistant'], active: 'assistant', size: 320, collapsed: true } } }));
		localStorage.setItem('positron-db.appSettings', JSON.stringify({ disableOnboarding: true, disableMascot: false }));
	});
	await handle.page.reload();
	await handle.page.waitForSelector('[data-tour="activity-bar"]');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('nothing of hers mounts, even with her switched on', async () => {
	const { page } = handle;
	await page.waitForTimeout(1500);
	await expect(page.locator('[data-test^="liby"], .liby-figure, .liby-flight-bug, .liby-peek')).toHaveCount(0);
});

test('the help shortcut opens the assistant', async () => {
	const { page } = handle;
	await expect(page.locator('.chat-panel')).toBeHidden();
	await page.keyboard.press(SUMMON);
	await expect(page.locator('.chat-panel')).toBeVisible();
	await expect(page.locator('[data-test^="liby"]')).toHaveCount(0);
});

test('the assistant is called AI, not by her name', async () => {
	const { page } = handle;
	await expect(page.locator('.chat-title')).toHaveText('AI');
	await expect(page.locator('.activity-item[data-tool="assistant"]')).toHaveAttribute('aria-label', 'AI');
	await expect(page.locator('.chat-panel')).not.toContainText('Liby');
});

test('About draws a neutral mark where the official build draws her, and none of her paths', async () => {
	const { page } = handle;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.keyboard.type('About SnoutData Studio');
	await page.keyboard.press('Enter');
	const art = page.locator('.modal.about svg.about-art');
	await expect(art).toBeVisible();
	// Where she flies over the four things the app holds: the stub's disc and spark, and nothing else
	// (her two wing pairs and body would be five; the gate refuses her paths in this tree anyway).
	const mark = art.locator('g[transform="translate(190 2) scale(0.5)"] > *');
	await expect(mark).toHaveCount(2);
	await expect(mark.nth(0)).toHaveAttribute('class', 'ill-tint');
	await expect(mark.nth(1)).toHaveAttribute('class', 'ill-spark');
	await page.screenshot({ path: 'e2e/.results/liby-stub-about.png' });
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// The custom title bar. The window is frameless, so this strip is the caption: if it fails to
// draw, the user has no title, no drag region and — on Windows and Linux — no menu at all, since
// the native menu bar goes with the native frame.
//
// The load-bearing assertion is that a drawn menu item RUNS. The menu is serialized out of the
// same template main hands to Electron, and the failure mode of that design is a model that
// looks right and dispatches nothing.
let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('titlebar');
});

test.afterAll(async () => {
	await closeApp(handle);
});

const isMac = process.platform === 'darwin';

test('the strip is the caption: it names the app and can drag the window', async () => {
	const page = handle.page;
	await expect(page.locator('.titlebar')).toBeVisible();
	await expect(page.locator('.titlebar-title')).toContainText('SnoutData Studio');
	// Without this the window cannot be moved at all, which is the one thing the OS caption
	// used to give us for free.
	const region = await page.locator('.titlebar-drag').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
	expect(region).toBe('drag');
});

test('the title follows the active tab', async () => {
	await expect(handle.page.locator('.titlebar-title')).toHaveText('Untitled-1 · SnoutData Studio');
});

test.describe('the drawn menu bar', () => {
	test.skip(isMac, 'macOS keeps its native menu bar in the system bar, so nothing is drawn here');

	test('carries the application menu, capitalized, in template order', async () => {
		const labels = await handle.page.locator('.titlebar-menu-btn').allInnerTexts();
		expect(labels).toEqual(['File', 'Edit', 'View', 'Query', 'Data', 'AI', 'Tools', 'Window', 'Help']);
	});

	test('opens, shows accelerators, and closes on Escape', async () => {
		const page = handle.page;
		await page.locator('.titlebar-menu-btn', { hasText: 'File' }).click();
		const menu = page.locator('.titlebar-dropdown');
		await expect(menu).toBeVisible();
		await expect(menu.locator('.ctx-menu-item', { hasText: 'New Query' })).toBeVisible();
		// The hint comes from the keybinding store via main, in Electron accelerator spelling,
		// and has to arrive rendered for this platform rather than as "CmdOrCtrl+N".
		await expect(menu.locator('.ctx-menu-item', { hasText: 'New Query' }).locator('.shortcut')).toHaveText(isMac ? '⌘N' : 'Ctrl+N');
		await page.screenshot({ path: 'e2e/.artifacts/titlebar-menu.png' });
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
	});

	test('every item does something, and all but Cut carry an icon', async () => {
		// The Help menu's three web links once had neither a command nor a role, so on Windows and
		// Linux they drew and did nothing. Nothing in the model may be in that state again.
		const model = await handle.page.evaluate(() => window.sqlApi.menuModel());
		const dead: string[] = [];
		const bare: string[] = [];
		for (const menu of model) {
			for (const item of menu.items) {
				if (item.separator) {
					continue;
				}
				if (!item.commandId && !item.role) {
					dead.push(`${menu.label} > ${item.label}`);
				}
				if (!item.icon && item.role !== 'cut') {
					bare.push(`${menu.label} > ${item.label}`);
				}
			}
		}
		expect(dead).toEqual([]);
		expect(bare).toEqual([]);
		const help = model.find((m) => m.label === 'Help');
		expect(help?.items.find((i) => i.label === 'Documentation')?.role).toBe('link:docs');
		await handle.page.locator('.titlebar-menu-btn', { hasText: 'Data' }).click();
		await expect(handle.page.locator('.titlebar-dropdown .ctx-menu-item', { hasText: 'New Data Flow' }).locator('.codicon-add')).toBeVisible();
		await handle.page.screenshot({ path: 'e2e/.artifacts/titlebar-menu-data.png' });
		await handle.page.keyboard.press('Escape');
	});

	test('a menu item actually runs its command', async () => {
		const page = handle.page;
		const before = await page.locator('.tab-item').count();
		await page.locator('.titlebar-menu-btn', { hasText: 'File' }).click();
		await page.locator('.titlebar-dropdown .ctx-menu-item', { hasText: 'New Query' }).click();
		await expect(page.locator('.tab-item')).toHaveCount(before + 1);
		// It also closed itself on the way out.
		await expect(page.locator('.titlebar-dropdown')).toHaveCount(0);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// Icon-only buttons say what they are on hover (components/HoverTip.tsx): the activity bar's, and
// every `.icon-btn` in the app. They used to
// carry a native `title`, which a frameless Electron window does not reliably show: on a Mac the
// strip said nothing until you clicked. Playwright cannot see a native tooltip, which is how that
// went unnoticed; this one is ours, so it can be asserted.

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('hover-tip');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('resting on an icon names it, beside the icon', async () => {
	const { page } = handle;
	const icon = page.locator('.activity-item[aria-label="Dashboard"]');
	await icon.hover();
	const tip = page.locator('.hover-tip');
	await expect(tip).toHaveText('Dashboard');
	// Beside it, not over the next icon along.
	const [i, t] = [await icon.boundingBox(), await tip.boundingBox()];
	expect(t && i && t.x >= i.x + i.width).toBe(true);
});

test('sweeping along the strip names each icon at once', async () => {
	const { page } = handle;
	await page.locator('.activity-item[aria-label="Connections"]').hover();
	await expect(page.locator('.hover-tip')).toHaveText('Connections', { timeout: 300 });
});

test('leaving the strip or pressing an icon puts it away', async () => {
	const { page } = handle;
	await page.mouse.move(800, 400);
	await expect(page.locator('.hover-tip')).toHaveCount(0);
	const icon = page.locator('.activity-item[aria-label="Data flows"]');
	await icon.hover();
	await expect(page.locator('.hover-tip')).toHaveText('Data flows');
	await page.mouse.down();
	await expect(page.locator('.hover-tip')).toHaveCount(0);
	await page.mouse.up();
});

test('the Dashboard icon is tiles, not the speedometer the app uses for speed', async () => {
	const icon = handle.page.locator('.activity-item[aria-label="Dashboard"]');
	await expect(icon.locator('.codicon-dashboard')).toHaveCount(0);
	await expect(icon.locator('svg')).toHaveCount(1);
});

test('a panel header icon names itself too, below the icon', async () => {
	const { page } = handle;
	await page.locator('.activity-item[aria-label="Connections"]').click();
	await page.mouse.move(800, 400);
	const button = page.locator('.sidebar-header .icon-btn[aria-label^="Import connections"]');
	await button.hover();
	const tip = page.locator('.hover-tip');
	await expect(tip).toHaveText(/^Import connections from DBeaver/);
	await expect(tip).toHaveClass(/\bbelow\b/);
	const [b, t] = [await button.boundingBox(), await tip.boundingBox()];
	expect(t && b && t.y >= b.y + b.height).toBe(true);
	// And it stays inside the window, however close to the edge its button is.
	const width = await page.evaluate(() => window.innerWidth);
	expect(t && t.x >= 0 && t.x + t.width <= width).toBe(true);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { addSqliteConnection, seedShopDb } from './sqliteShop';
import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

/*
 * Move Database. What breaks here is the wiring, not the rules: the rules are `packages/move`'s and
 * tested there, and the check service is tested in `src/main/moveService.test.ts`.
 * So this asserts that the view opens from the palette on its first step, that its route diagram
 * really moves, and that a check travels view → preload → main → preflight → view and comes back as
 * a finding card. Two SQLite databases are enough for that: the strategy refuses the pair in a
 * sentence, which is a real finding from the real path, with no Postgres server needed.
 */

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('move');
});

test.afterAll(async () => {
	await closeApp(handle);
});

async function openMove(): Promise<void> {
	if (await handle.page.locator('.move-view').isVisible()) {
		return;
	}
	await handle.page.keyboard.press(`${MOD}+Shift+P`);
	await expect(handle.page.locator('.palette')).toBeVisible();
	await handle.page.keyboard.type('Move Database');
	await handle.page.keyboard.press('Enter');
	await expect(handle.page.locator('.move-view')).toBeVisible();
}

test('opens from the command palette on the first of four steps', async () => {
	await openMove();
	const steps = handle.page.locator('.move-view .flow-wizard-step');
	await expect(steps).toHaveCount(4);
	await expect(steps.first()).toHaveClass(/active/);
	await expect(handle.page.getByRole('button', { name: /Check both databases/ })).toBeDisabled();
	await handle.page.locator('.move-view').screenshot({ path: 'e2e/.results/move-choose.png' });
});

test('the route diagram moves (three frames, not one)', async () => {
	await openMove();
	const route = handle.page.locator('.move-route').first();
	const frames: Buffer[] = [];
	for (let i = 0; i < 3; i++) {
		frames.push(await route.screenshot());
		await handle.page.waitForTimeout(500);
	}
	expect(frames[0].equals(frames[1]) && frames[1].equals(frames[2])).toBe(false);
});

test('a check runs in main and comes back as a finding card, and swap trades the two ends', async () => {
	await addSqliteConnection(handle.page, 'shop', seedShopDb(mkdtempSync(join(tmpdir(), 'snout-move-a-'))));
	await addSqliteConnection(handle.page, 'shop copy', seedShopDb(mkdtempSync(join(tmpdir(), 'snout-move-b-'))));
	await openMove();

	const selects = handle.page.locator('.move-end select');
	await selects.nth(0).selectOption({ label: 'shop' });
	await selects.nth(1).selectOption({ label: 'shop copy' });
	await expect(handle.page.locator('.move-route-stage.start .move-route-label').first()).toHaveText('shop');

	await handle.page.getByRole('button', { name: 'Swap source and target' }).click();
	await expect(handle.page.locator('.move-route-stage.start .move-route-label').first()).toHaveText('shop copy');
	await handle.page.getByRole('button', { name: 'Swap source and target' }).click();
	await expect(handle.page.locator('.move-route-stage.start .move-route-label').first()).toHaveText('shop');

	await handle.page.getByRole('button', { name: /Check both databases/ }).click();
	const finding = handle.page.locator('.move-finding').first();
	await expect(finding).toBeVisible();
	await expect(finding).toHaveClass(/block/);
	await expect(finding).toContainText('Moving a sqlite database is not built yet');
	await expect(handle.page.getByRole('button', { name: /^Review/ })).toBeDisabled();
	await handle.page.locator('.move-view').screenshot({ path: 'e2e/.results/move-check.png' });
});

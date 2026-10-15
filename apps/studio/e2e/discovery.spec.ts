/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// First-run discovery, "Find your databases".
//
// `launchApp` seeds onboarding state WITHOUT `discoverySeen`, which is exactly what an existing
// user's profile looks like after an upgrade, so every other spec proves the popup never bothers
// them. This spec takes that seed away to be a FRESH install, and drives the popup itself: Skip,
// Esc, the tour waiting its turn, a scan with the network switch off, and the palette entry.
//
// The scan reads this machine for real (its tools, its containers, its ports), so what it finds
// varies; the assertions are about the SHAPE of the answer, never its contents. Nothing is
// imported here, so the scratch profile is all a run ever touches.

test.describe.configure({ mode: 'serial' });

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('discovery');
});

test.afterAll(async () => {
	await closeApp(handle);
});

const POPUP = '[data-test="discovery-modal"]';

/** Make this profile a fresh install again: no onboarding state, onboarding switched on. */
async function freshInstall(): Promise<void> {
	await handle.page.evaluate(() => {
		localStorage.removeItem('positron-db.onboarding');
		localStorage.setItem('positron-db.appSettings', JSON.stringify({ disableMascot: true }));
	});
	await handle.page.reload();
	await handle.page.waitForSelector('[data-tour="activity-bar"]');
}

async function stored(): Promise<{ discoverySeen?: boolean; tourSeen?: boolean }> {
	return handle.page.evaluate(() => JSON.parse(localStorage.getItem('positron-db.onboarding') ?? '{}'));
}

test('an existing profile (stored state without the field) is never shown the popup', async () => {
	await handle.page.waitForTimeout(500);
	await expect(handle.page.locator(POPUP)).toHaveCount(0);
});

test('a fresh install opens with the popup, before the tour; Skip counts as seen and the tour follows', async () => {
	await freshInstall();
	const popup = handle.page.locator(POPUP);
	await expect(popup).toBeVisible();
	await expect(popup.locator('h2')).toHaveText("Find your databases");
	await expect(popup).toContainText("Nothing leaves this computer.");
	await expect(popup.locator('[data-test="discovery-network"]')).not.toBeChecked();
	await expect(popup).toContainText("leave it off on a work network");
	// The tour waits for the popup.
	await expect(handle.page.locator('.tour-card')).toHaveCount(0);

	await popup.locator('[data-test="discovery-skip"]').click();
	await expect(popup).toHaveCount(0);
	await expect(handle.page.locator('.tour-card')).toBeVisible();
	expect((await stored()).discoverySeen).toBe(true);

	// Seen means seen: it does not come back on the next launch.
	await handle.page.locator('.tour-skip').click();
	await handle.page.reload();
	await handle.page.waitForSelector('[data-tour="activity-bar"]');
	await handle.page.waitForTimeout(500);
	await expect(handle.page.locator(POPUP)).toHaveCount(0);
});

test('Esc counts as seen too', async () => {
	await freshInstall();
	await expect(handle.page.locator(POPUP)).toBeVisible();
	await handle.page.keyboard.press('Escape');
	await expect(handle.page.locator(POPUP)).toHaveCount(0);
	expect((await stored()).discoverySeen).toBe(true);
	await handle.page.locator('.tour-skip').click();
});

test('Find databases with the network switch off: progress per source, then grouped results or the empty state', async () => {
	await freshInstall();
	const popup = handle.page.locator(POPUP);
	await popup.locator('[data-test="discovery-find"]').click();

	// Either the scan is still running (its per-source list), or it has already answered.
	const answered = popup.locator('[data-test="discovery-results"], [data-test="discovery-empty"]');
	await expect(popup.locator('[data-test="discovery-progress"]').or(answered)).toBeVisible();
	await expect(answered).toBeVisible({ timeout: 30_000 });

	// The switch was off, so the local network was never asked.
	await expect(popup.locator('[data-test="discovery-group-network"]')).toHaveCount(0);

	if (await popup.locator('[data-test="discovery-results"]').count()) {
		// Grouped by source: every group has a heading and either rows or a sentence.
		const groups = popup.locator('section.discovery-group');
		expect(await groups.count()).toBeGreaterThan(0);
		for (const group of await groups.all()) {
			await expect(group.locator('h3')).not.toBeEmpty();
		}
		// A guess is never selected for the user.
		for (const row of await popup.locator('.import-row:has(.import-tag:text-is("unconfirmed")) input').all()) {
			await expect(row).not.toBeChecked();
		}
		await popup.locator('[data-test="discovery-skip"]').click();
	} else {
		await expect(popup).toContainText("add a connection by hand");
		await popup.locator('button:text-is("Close")').click();
	}
	await expect(popup).toHaveCount(0);
	expect((await stored()).discoverySeen).toBe(true);
	await expect(handle.page.locator('.tour-card')).toBeVisible();
	await handle.page.locator('.tour-skip').click();
});

test('it can be run again from the command palette, and closing it then starts no tour', async () => {
	await handle.page.keyboard.press('ControlOrMeta+Shift+P');
	await handle.page.fill('.palette input', 'Find Databases');
	await handle.page.keyboard.press('Enter');
	const popup = handle.page.locator(POPUP);
	await expect(popup).toBeVisible();
	await expect(popup.locator('h2')).toHaveText("Find your databases");
	await popup.locator('[data-test="discovery-skip"]').click();
	await expect(popup).toHaveCount(0);
	await expect(handle.page.locator('.tour-card')).toHaveCount(0);
});

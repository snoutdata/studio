/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// The auto-update toast, and in particular what it does with a FAILURE.
//
// On 2026-09-21 GitHub's release-asset edge 504'd, and the card printed electron-updater's own
// error object: method, URL, an HTML body and every response header including a session cookie,
// on one nowrap line, which stretched the toast across the whole window and told the reader
// nothing they could do anything about. The sentence is decided in `shared/update.ts` (unit
// tested); what this asserts is the part only a real window can show: that the card is a card.
//
// The status is pushed the way a real one is, from main over `update:status`.

let handle: AppHandle;

const FEED_DOWN = {
	state: 'error',
	kind: 'feed-unavailable',
	message: "Updates could not be checked: GitHub is not answering. Nothing is wrong with your installation, and it will try again later.",
	detail: 'Cannot parse releases feed: Error: Unable to find latest version on GitHub: HttpError: 504',
};

test.beforeAll(async () => {
	handle = await launchApp('update-toast');
});

test.afterAll(async () => {
	await closeApp(handle);
});

async function pushStatus(status: Record<string, unknown>): Promise<void> {
	await handle.app.evaluate(({ BrowserWindow }, payload) => {
		BrowserWindow.getAllWindows()[0]?.webContents.send('update:status', payload);
	}, status);
}

/**
 * Ask for a check, the way a person does.
 *
 * The card is deliberately only shown for a check somebody ASKED for: a background check that
 * fails on a closed laptop lid is nobody's business, and this is the switch that decides it. So
 * the spec has to go through the palette before any pushed status will render, which is also the
 * assertion that the switch still works.
 */
async function askForACheck(): Promise<void> {
	await handle.page.keyboard.press('ControlOrMeta+Shift+P');
	await handle.page.fill('.palette input', 'Check for Updates');
	await handle.page.keyboard.press('Enter');
}

test('a check nobody asked for stays silent when it fails', async () => {
	// The other half of the rule, and the one a card is tempting to break: a background check that
	// cannot reach GitHub says nothing at all.
	await pushStatus(FEED_DOWN);
	await handle.page.waitForTimeout(500);
	await expect(handle.page.locator('.update-toast')).toBeHidden();
});

test('a failed check is one readable card, not the error object', async () => {
	const { page } = handle;
	await askForACheck();
	await pushStatus(FEED_DOWN);

	const toast = page.locator('.update-toast.update-toast-error');
	await expect(toast).toBeVisible({ timeout: 10_000 });
	await expect(toast).toContainText('GitHub is not answering');
	await expect(toast).toContainText('Nothing is wrong with your installation');

	// The raw error is for the log and the tooltip. None of it is on screen.
	await expect(toast).not.toContainText('HttpError');
	await expect(toast).not.toContainText('Headers');
	await expect(toast).not.toContainText('html');
	await expect(toast.locator('.update-toast-text')).toHaveAttribute('title', /HttpError: 504/);

	// The bug itself: the card has to stay a card. A 1200px-wide window and a toast as wide as the
	// error is what this is here to stop happening again.
	const box = await toast.boundingBox();
	const windowWidth = await page.evaluate(() => window.innerWidth);
	expect(box, 'the toast has a box').not.toBeNull();
	expect(box!.width).toBeLessThan(windowWidth * 0.7);
	// And it wraps rather than being clipped: more than one line, so nothing is cut off.
	expect(box!.height).toBeGreaterThan(30);

	await page.screenshot({ path: 'e2e/.results/update-toast-error.png' });
});

test('each kind of failure brings its own icon', async () => {
	const { page } = handle;
	await askForACheck();
	// Offline is the user's own network, and reads as a disconnection rather than an alarm.
	await pushStatus({ state: 'error', kind: 'offline', message: 'Updates could not be checked: this computer is offline. It will try again later.', detail: 'getaddrinfo ENOTFOUND github.com' });
	await expect(page.locator('.update-toast-error .update-toast-icon.codicon-debug-disconnect')).toBeVisible({ timeout: 10_000 });

	// A refused signature is the one that should look like something went wrong.
	await pushStatus({ state: 'error', kind: 'signature', message: 'An update was downloaded and refused: it did not match the signature it should have. Nothing was installed.', detail: 'sha512 checksum mismatch' });
	await expect(page.locator('.update-toast-error .update-toast-icon.codicon-shield')).toBeVisible();

	// And it can be dismissed, like every other state of this card.
	await page.locator('.update-toast-error .update-toast-close').click();
	await expect(page.locator('.update-toast')).toBeHidden();
});

test('a build from source says it updates by building again, not that it is up to date', async () => {
	const { page } = handle;
	await askForACheck();
	// What main answers in a build from the open-source tree, which never asks the official feed.
	await pushStatus({ state: 'not-available', version: '1.0.0', fromSource: true });
	const toast = page.locator('.update-toast.update-toast-not-available');
	await expect(toast).toBeVisible({ timeout: 10_000 });
	await expect(toast).toContainText('made from source');
	await expect(toast).toContainText('Build it again from the latest source');
	await expect(toast).not.toContainText("You're up to date");
	await page.locator('.update-toast-close').click();
	await expect(page.locator('.update-toast')).toBeHidden();
});

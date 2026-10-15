/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { closeApp, launchApp, type AppHandle } from './helpers';

/*
 * What a signed-out launch asks of our accounts backend: nothing.
 *
 * The README says a signed-out app talks only to the databases you configure. The assistant panel
 * is open on a fresh profile, and on mount it asks for the provider status, which used to read the
 * model catalog from accounts.snoutdata.com with no account and no key, so every signed-out launch
 * (and every CI run of this suite) reached production.
 *
 * Main's requests are watched from before the app's own code runs: a small script loaded with
 * `--require` hooks the default session once Electron is ready, records every request to the
 * accounts host and cancels it, so this spec never reaches production even when it fails.
 */

const RECORDER = `
const { app, session } = require('electron');
const seen = [];
globalThis.__snoutAccountsRequests = seen;
app.whenReady().then(() => {
	session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://accounts.snoutdata.com/*'] }, (details, callback) => {
		seen.push(details.url);
		callback({ cancel: true });
	});
});
`;

let handle: AppHandle;

test.beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'snout-signed-out-net-'));
	const recorder = join(dir, 'recorder.cjs');
	writeFileSync(recorder, RECORDER);
	handle = await launchApp('signed-out-network', { require: recorder });
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('a signed-out launch, assistant panel open, sends nothing to the accounts backend', async () => {
	const { app, page } = handle;
	// The recorder really is installed (a spec that watched nothing would pass on any build).
	expect(await app.evaluate(() => Array.isArray((globalThis as unknown as { __snoutAccountsRequests?: unknown }).__snoutAccountsRequests))).toBe(true);
	// Signed out: the panel shows its sign-in view, and it has asked for the provider status.
	await expect(page.locator('[data-test="chat-signin"]')).toBeVisible({ timeout: 20_000 });
	// Ask again, as the panel does whenever Settings closes, so the assertion does not hang on when
	// the mount's own call landed.
	const statuses = await page.evaluate(() => window.sqlApi.aiProviderStatus());
	expect(statuses.find((s) => s.provider === 'positron-cloud')?.models ?? []).toEqual([]);
	// Give anything that did go out time to be seen before asserting there was none.
	await page.waitForTimeout(1500);
	expect(await app.evaluate(() => (globalThis as unknown as { __snoutAccountsRequests: string[] }).__snoutAccountsRequests)).toEqual([]);
});

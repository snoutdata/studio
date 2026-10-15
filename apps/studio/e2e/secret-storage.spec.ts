/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeApp, expect, launchApp, test, type AppHandle } from './helpers';

// A Linux desktop with no password vault (main/secretStorageMode.ts). Under xvfb there is no Secret
// Service, so this spec IS that machine: Chromium picks `basic_text`, the app switches to the fixed
// key, passwords can be saved, and the user is told once per profile. Linux only: macOS and Windows
// always have their own vault and never take this path. The warning is withheld from the scratch
// profile unless a spec asks for it, which this one does.

const TITLE = "Passwords are saved without a password vault";
const ENV = { SNOUT_E2E_SECRET_WARNING: '1' };

test.skip(process.platform !== 'linux', 'only a Linux desktop can lack a password vault');

let handle: AppHandle | undefined;
// One profile for both launches, since "once" is a fact about a profile.
let profile = '';

test.beforeAll(() => {
	profile = mkdtempSync(join(tmpdir(), 'snout-e2e-secrets-'));
});

test.afterAll(() => {
	rmSync(profile, { recursive: true, force: true });
});

test.afterEach(async () => {
	await closeApp(handle);
	handle = undefined;
});

async function warnings(h: AppHandle): Promise<number> {
	return h.page.evaluate((title) => {
		const raw = localStorage.getItem('positron.notifications.v1');
		const list = raw ? (JSON.parse(raw) as { title: string }[]) : [];
		return list.filter((n) => n.title === title).length;
	}, TITLE);
}

test('no vault: passwords are saved and the user is told', async () => {
	handle = await launchApp('secret-storage-first', { profile, env: ENV });
	const sealed = await handle.app.evaluate(({ safeStorage }) => ({
		available: safeStorage.isEncryptionAvailable(),
		backend: safeStorage.getSelectedStorageBackend(),
		roundTrip: safeStorage.decryptString(safeStorage.encryptString('hunter2')),
	}));
	expect(sealed).toEqual({ available: true, backend: 'basic_text', roundTrip: 'hunter2' });
	await expect(handle.page.locator('.notif-toast-title', { hasText: TITLE })).toBeVisible({ timeout: 15_000 });
	expect(await warnings(handle)).toBe(1);
	expect(await handle.page.evaluate(() => window.sqlApi.secretStorage.status())).toEqual({ weak: true, warn: false });
});

test('the second launch on the same profile stays quiet', async () => {
	handle = await launchApp('secret-storage-second', { profile, env: ENV });
	// Past the idle read that would have raised it (5s at the latest).
	await handle.page.waitForTimeout(6_000);
	expect(await warnings(handle)).toBe(1);
	await expect(handle.page.locator('.notif-toast-title', { hasText: TITLE })).toHaveCount(0);
	expect(await handle.page.evaluate(() => window.sqlApi.secretStorage.status())).toEqual({ weak: true, warn: false });
});

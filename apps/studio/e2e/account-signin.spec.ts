/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '@playwright/test';

import { launchApp, closeApp, MOD, type AppHandle } from './helpers';

/*
 * A sign-in that cannot start says why ON THE SIGN-IN FORM.
 *
 * It used to go to a notification only, and that notification sits under the full-window
 * Settings page, so "Continue with SSO" for a domain with no identity provider looked like a
 * button that did nothing. The main-process handler is replaced with one that refuses the way
 * the real one does, so this needs no network and no account.
 */

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('account-signin');
	await handle.app.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('auth:signIn');
		ipcMain.handle('auth:signIn', (_event, provider: string) => {
			throw new Error(provider === 'sso'
				? 'No single sign-on is set up for example.com. Check the address, or ask whoever administers your team to connect your identity provider.'
				: 'Could not start sign-in.');
		});
	});
});

test.afterAll(async () => {
	await closeApp(handle);
});

async function openAccount(): Promise<void> {
	await handle.page.keyboard.press(`${MOD}+Shift+P`);
	await expect(handle.page.locator('.palette')).toBeVisible();
	await handle.page.keyboard.type('Settings…');
	await handle.page.keyboard.press('Enter');
	await handle.page.locator('.settings-nav-item:has(span:text-is("Account"))').click();
	await expect(handle.page.locator('.account-signin')).toBeVisible();
}

test('SSO for a domain with no identity provider says so inside the SSO box', async () => {
	await openAccount();
	await handle.page.click('.account-signin button:has-text("Continue with SSO")');
	await handle.page.fill('#account-sso-email', 'alex@example.com');
	await handle.page.click('.account-sso button[type="submit"]');
	await expect(handle.page.locator('.account-sso .form-status.warn')).toContainText('No single sign-on is set up for example.com');
	// And the form is usable again, not stuck on "Waiting for the browser".
	await expect(handle.page.locator('.account-sso button[type="submit"]')).toBeEnabled();
	await handle.page.screenshot({ path: 'test-results/account-sso-refused.png' });
});

test('an OAuth sign-in that cannot start says so under the providers', async () => {
	await handle.page.click('.account-sso button:has-text("Back")');
	await handle.page.click('.account-signin button:has-text("Continue with GitHub")');
	await expect(handle.page.locator('.account-signin > .form-status.warn')).toContainText('Could not start sign-in.');
});

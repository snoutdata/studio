/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';

import { closeApp, launchApp, MOD, type AppHandle } from './helpers';
import { checkLanguages, layoutLanguages } from './i18nLayout';

// The language field works, and a choice survives a launch. With SNOUTDATA_SHOTS_LANGUAGES and
// SNOUTDATA_SHOTS_DIR set, it also walks the screens that need no database and records what no longer
// fits (e2e/i18nLayout.ts).

const LANGUAGES = layoutLanguages();
const DIR = process.env.SNOUTDATA_SHOTS_DIR ?? '';

async function openSettings(handle: AppHandle): Promise<void> {
	// The palette matches a command's English name in every language.
	await handle.page.keyboard.press(`${MOD}+Shift+P`);
	await handle.page.fill('.palette input', 'Settings…');
	await handle.page.keyboard.press('Enter');
	await expect(handle.page.locator('.settings-nav-item').first()).toBeVisible();
}

async function look(handle: AppHandle, name: string): Promise<void> {
	if (LANGUAGES.length > 0) {
		await handle.page.mouse.move(720, 18);
		await handle.page.waitForTimeout(200);
		await checkLanguages(handle.page, name, LANGUAGES, DIR);
	}
}

test.describe('the language', () => {
	let handle: AppHandle | undefined;

	test.afterEach(async () => {
		await closeApp(handle);
		handle = undefined;
	});

	test('a scratch profile is English, whatever the computer speaks', async () => {
		handle = await launchApp('i18n-english');
		await expect(handle.page.locator('html')).toHaveAttribute('lang', 'en');
	});

	test('starts in the language asked for, and paints it from the first frame', async () => {
		handle = await launchApp('i18n-start', { env: { SNOUT_E2E_LANGUAGE: 'pt' } });
		await expect(handle.page.locator('html')).toHaveAttribute('lang', 'pt');
		await openSettings(handle);
		await handle.page.locator('.settings-nav-item').nth(1).click();
		await expect(handle.page.locator('.settings-content label', { hasText: 'Idioma' }).first()).toBeVisible();
	});

	test('Settings changes it live, without closing what is open', async () => {
		handle = await launchApp('i18n-switch');
		await openSettings(handle);
		await handle.page.locator('.settings-nav-item').nth(1).click();
		const field = handle.page.locator('[data-test="settings-language"]');
		await expect(field).toHaveValue('en');
		await field.selectOption('fr');
		await expect(handle.page.locator('html')).toHaveAttribute('lang', 'fr');
		await expect(handle.page.locator('.settings-content label', { hasText: 'Langue' }).first()).toBeVisible();
		await field.selectOption('system');
		await expect(field).toHaveValue('system');
	});

	test.describe('layout', () => {
		test.skip(LANGUAGES.length === 0, 'set SNOUTDATA_SHOTS_LANGUAGES=fr,es,pt and SNOUTDATA_SHOTS_DIR');

		test('the screens that need no database', async () => {
			test.setTimeout(600_000);
			handle = await launchApp('i18n-layout');
			await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800));
			await handle.page.waitForTimeout(500);
			await look(handle, 'welcome');

			await handle.page.keyboard.press(`${MOD}+Shift+P`);
			await expect(handle.page.locator('.palette input')).toBeVisible();
			await handle.page.waitForTimeout(300);
			await look(handle, 'palette');
			await handle.page.keyboard.press('Escape');

			await openSettings(handle);
			const items = handle.page.locator('.settings-nav-item');
			const count = await items.count();
			for (let i = 0; i < count; i += 1) {
				await items.nth(i).click();
				await handle.page.waitForTimeout(400);
				await look(handle, `settings-${i}`);
				const tabs = handle.page.locator('.settings-content .tabs button');
				// A tab can bring its own row of tabs, so the count is read each time round.
				for (let j = 1; j < await tabs.count(); j += 1) {
					await tabs.nth(j).click();
					await handle.page.waitForTimeout(300);
					await look(handle, `settings-${i}-${j}`);
				}
			}
			await handle.page.keyboard.press('Escape');
		});
	});
});

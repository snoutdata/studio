/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, pickConnection, type AppHandle } from './helpers';

// The editor toolbar's connection picker (components/ConnectionPicker.tsx). It replaced a native
// <select>, which could not show a PROD tag or the driver mark the sidebar row carries, so these
// pin that it does, and that it still changes the tab's connection ONLY on a real change: the
// toolbar hangs connect-on-select and the tab binding on that one event.

let handle: AppHandle;
let dir: string;

test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-conn-picker-'));
	handle = await launchApp('connection-picker');
	await handle.page.evaluate(async (folder) => {
		const api = (window as unknown as { sqlApi: { saveConnection(form: unknown): Promise<{ id: string }> } }).sqlApi;
		const base = { driver: 'sqlite', host: '', port: 0, username: '', ssl: false };
		await api.saveConnection({ ...base, label: 'Shop', database: `${folder}/shop.sqlite`, environment: 'prod', readOnly: false });
		await api.saveConnection({ ...base, label: 'Reports', database: `${folder}/reports.sqlite`, readOnly: true });
		await api.saveConnection({ ...base, label: 'Scratch', database: `${folder}/scratch.sqlite`, readOnly: false });
	}, dir);
});

test.afterAll(async () => {
	await closeApp(handle);
	rmSync(dir, { recursive: true, force: true });
});

test('the list draws each connection the way the sidebar does', async () => {
	const { page } = handle;
	const trigger = page.locator('.editor-toolbar .conn-picker-btn');
	await expect(trigger).toContainText('No connection');
	await trigger.click();
	const options = page.locator('.conn-picker-menu [role="option"]');
	await expect(options).toHaveCount(4);
	const row = (name: string) => options.filter({ has: page.locator('.conn-picker-label', { hasText: new RegExp(`^${name}$`) }) });
	// Every connection carries the driver mark; the empty row does not.
	await expect(page.locator('.conn-picker-menu .driver-mark')).toHaveCount(3);
	// PROD is a tag in the prod colour, and the name takes that colour too.
	await expect(row('Shop').locator('.env.prod')).toHaveText(/prod/i);
	await expect(row('Shop').locator('.conn-picker-label.prod')).toHaveCount(1);
	await expect(row('Reports').locator('.env.ro')).toHaveText('RO');
	await expect(row('Scratch').locator('.env')).toHaveCount(0);
	// Escape closes it without choosing anything.
	await page.keyboard.press('Escape');
	await expect(page.locator('.conn-picker-menu')).toHaveCount(0);
	await expect(trigger).toContainText('No connection');
});

test('choosing a production connection marks the trigger too', async () => {
	const { page } = handle;
	await pickConnection(page, 'Shop');
	const trigger = page.locator('.editor-toolbar .conn-picker-btn');
	await expect(trigger).toHaveClass(/\bprod\b/);
	await expect(trigger.locator('.env.prod')).toBeVisible();
	await expect(trigger.locator('.driver-mark')).toHaveCount(1);
	// Connect-on-select ran: the pick was a real change.
	await expect(trigger.locator('.dot.on')).toHaveCount(1, { timeout: 15_000 });
});

test('choosing the connection that is already chosen changes nothing', async () => {
	const { page } = handle;
	const trigger = page.locator('.editor-toolbar .conn-picker-btn');
	// Close it behind the picker's back. Re-picking it must NOT reconnect: the native select never
	// fired a change for the same value, and the callers depend on that.
	await page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: { state(): Promise<{ connections: { id: string; label: string }[] }>; disconnect(id: string): Promise<unknown> } }).sqlApi;
		const shop = (await api.state()).connections.find((c) => c.label === 'Shop');
		if (shop) {
			await api.disconnect(shop.id);
		}
	});
	await expect(trigger.locator('.dot.on')).toHaveCount(0);
	await pickConnection(page, 'Shop');
	// Opening on the chosen row and pressing Enter is the same no-op.
	await trigger.click();
	await expect(page.locator('.conn-picker-row.cursor')).toContainText('Shop');
	await page.keyboard.press('Enter');
	await expect(page.locator('.conn-picker-menu')).toHaveCount(0);
	await page.waitForTimeout(1_000);
	await expect(trigger.locator('.dot.on')).toHaveCount(0);
	await expect(trigger).toContainText('Shop');
});

test('the keyboard opens the list on the chosen row, moves, and picks', async () => {
	const { page } = handle;
	const trigger = page.locator('.editor-toolbar .conn-picker-btn');
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	await expect(page.locator('.conn-picker-menu')).toBeVisible();
	// It opens on what is chosen, so Enter straight away changes nothing.
	await expect(page.locator('.conn-picker-row.cursor')).toContainText('Shop');
	// Home is the "no connection" row; one down is the first connection, whatever the order.
	await page.keyboard.press('Home');
	await expect(page.locator('.conn-picker-row.cursor')).toContainText('No connection');
	await page.keyboard.press('ArrowDown');
	const first = (await page.locator('.conn-picker-row').nth(1).locator('.conn-picker-label').innerText()).trim();
	await expect(page.locator('.conn-picker-row.cursor .conn-picker-label')).toHaveText(first);
	// Up from the top wraps to the bottom.
	await page.keyboard.press('Home');
	await page.keyboard.press('ArrowUp');
	await expect(page.locator('.conn-picker-row.cursor')).toHaveAttribute('data-index', '3');
	await page.keyboard.press('Home');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(page.locator('.conn-picker-menu')).toHaveCount(0);
	await expect(trigger.locator('.conn-picker-label')).toHaveText(first);
	await expect(trigger).toBeFocused();
});

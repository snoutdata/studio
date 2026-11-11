/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// The right-click menu of a table in the schema tree, whose one item drops the table: what offers
// it, what refuses it, and that nothing runs until the table's name has been typed.

let handle: AppHandle;
let dir: string;

interface Api {
	saveConnection(form: unknown): Promise<{ id: string }>;
	connect(id: string): Promise<unknown>;
	execute(params: { connectionId: string; sql: string }): Promise<{ ok: boolean; rows?: unknown[] }>;
	refresh(id: string): Promise<unknown>;
}

test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-table-menu-'));
	handle = await launchApp('table-context-menu');
	await handle.page.evaluate(async (folder) => {
		const api = (window as unknown as { sqlApi: Api }).sqlApi;
		const base = { driver: 'sqlite', host: '', port: 0, username: '', ssl: false };
		const statements = ['create table orders (id integer primary key)', 'create table keepers (id integer primary key)', 'create view keeper_ids as select id from keepers'];
		const seed = async (id: string): Promise<void> => {
			await api.connect(id);
			for (const sql of statements) {
				await api.execute({ connectionId: id, sql });
			}
			await api.refresh(id);
		};
		await seed((await api.saveConnection({ ...base, label: 'Scratch', database: `${folder}/scratch.sqlite`, readOnly: false })).id);
		await seed((await api.saveConnection({ ...base, label: 'Shop', database: `${folder}/shop.sqlite`, environment: 'prod', readOnly: false })).id);
		// Read-only over a file that already holds the tables.
		await api.connect((await api.saveConnection({ ...base, label: 'Reports', database: `${folder}/scratch.sqlite`, readOnly: true })).id);
	}, dir);
});

test.afterAll(async () => {
	await closeApp(handle);
	rmSync(dir, { recursive: true, force: true });
});

/** A connection's block in the tree, open, with its database open too. */
async function openConnection(page: Page, label: string): Promise<Locator> {
	const block = page.locator('.sidebar div:has(> .tree-row.depth-0)').filter({ has: page.locator('.tree-row.depth-0', { hasText: label }) });
	if (await block.locator('.tree-row.depth-1').count() === 0) {
		await block.locator('.tree-row.depth-0 .twisty').click();
	}
	const database = block.locator('.tree-row.depth-1').first();
	await expect(database).toBeVisible();
	if (await block.locator('.tree-row.depth-2').count() === 0) {
		await database.click();
	}
	await expect(block.locator('.tree-row.depth-2').first()).toBeVisible();
	return block;
}

function tableRow(block: Locator, name: string): Locator {
	return block.locator('.tree-row.depth-2').filter({ has: block.page().locator('.tree-label', { hasText: new RegExp(`^${name}$`) }) });
}

test('nothing runs until the name is typed, and Cancel leaves the table', async () => {
	const { page } = handle;
	const block = await openConnection(page, 'Scratch');
	await tableRow(block, 'keepers').click({ button: 'right' });
	await page.locator('.ctx-menu .ctx-menu-item', { hasText: 'Drop table' }).click();
	await expect(page.locator('.modal h3')).toHaveText('Drop table keepers?');
	await expect(page.locator('.modal .ddl-preview')).toContainText('DROP TABLE');
	const submit = page.locator('.modal button[type="submit"]');
	await expect(submit).toBeDisabled();
	await page.locator('.modal input').fill('keeper');
	await expect(submit).toBeDisabled();
	await page.locator('.modal input').press('Enter');
	await expect(page.locator('.modal h3')).toBeVisible();
	await page.locator('.modal button.secondary').click();
	await expect(page.locator('.modal h3')).toHaveCount(0);
	await expect(tableRow(block, 'keepers')).toBeVisible();
});

test('typing the name drops the table, and its open tab goes with it', async () => {
	const { page } = handle;
	const block = await openConnection(page, 'Scratch');
	await tableRow(block, 'orders').locator('.tree-label').dblclick();
	await expect(page.locator('.tabbar .tab-item', { hasText: 'orders' })).toBeVisible();
	await tableRow(block, 'orders').click({ button: 'right' });
	await page.locator('.ctx-menu .ctx-menu-item', { hasText: 'Drop table' }).click();
	await page.locator('.modal input').fill('orders');
	await page.locator('.modal button[type="submit"]').click();
	await expect(page.locator('.modal h3')).toHaveCount(0);
	await expect(tableRow(block, 'orders')).toHaveCount(0);
	await expect(page.locator('.tabbar .tab-item', { hasText: 'orders' })).toHaveCount(0);
	await expect(tableRow(block, 'keepers')).toBeVisible();
});

test('a view has no menu', async () => {
	const { page } = handle;
	const block = await openConnection(page, 'Scratch');
	await tableRow(block, 'keeper_ids').click({ button: 'right' });
	await expect(page.locator('.ctx-menu')).toHaveCount(0);
});

test('a read-only connection has no menu', async () => {
	const { page } = handle;
	const block = await openConnection(page, 'Reports');
	await tableRow(block, 'keepers').click({ button: 'right' });
	await expect(page.locator('.ctx-menu')).toHaveCount(0);
});

test('a locked production connection shows the item switched off, and Escape closes the menu', async () => {
	const { page } = handle;
	const block = await openConnection(page, 'Shop');
	await tableRow(block, 'keepers').click({ button: 'right' });
	const item = page.locator('.ctx-menu .ctx-menu-item', { hasText: 'Drop table' });
	await expect(item).toBeDisabled();
	await expect(item).toHaveAttribute('title', /production/);
	await page.keyboard.press('Escape');
	await expect(page.locator('.ctx-menu')).toHaveCount(0);
});

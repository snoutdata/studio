/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addSqliteConnection } from './sqliteShop';
import { closeApp, dbEnv, launchApp, type AppHandle, type DbConfig } from './helpers';

// The table designer, driven in the real app. It had NO e2e coverage at all, which is how a
// dead Constraints section and an unverifiable PK checkbox both went unnoticed: everything
// about the designer was tested as pure SQL generation (ddl.test.ts) and nothing about it was
// ever clicked. These tests answer the two questions a screenshot cannot: does ticking PK
// change the draft, and does the Constraints section let you do anything.
//
// SQLite because it is file-based (no server, no credentials) and `node:sqlite` ships with the
// runtime. It is also the engine that CANNOT alter a primary key, which is a case worth pinning
// on its own; the SQL every other vendor gets is covered by ddl.test.ts.

let handle: AppHandle;
let dir: string;

function seed(): string {
	const file = join(dir, 'designer.db');
	const db = new DatabaseSync(file);
	try {
		// Deliberately no primary key: the shape that makes the Data tab refuse edits.
		db.exec('CREATE TABLE hello (said TEXT, id INTEGER)');
		db.exec("INSERT INTO hello (said, and_id) VALUES ('hi', 1)".replace('and_id', 'id'));
	} finally {
		db.close();
	}
	return file;
}

/** Save a connection from the SNOUTDATA_TEST_* env through the real IPC and connect it. */
async function addLiveConnection(page: Page, cfg: DbConfig): Promise<string> {
	return page.evaluate(async (input) => {
		const api = (window as unknown as {
			sqlApi: {
				saveConnection(form: unknown): Promise<{ id: string }>;
				connect(id: string): Promise<{ error?: string }>;
			};
		}).sqlApi;
		const saved = await api.saveConnection({
			label: 'designer', driver: input.driver, host: input.host, port: Number(input.port) || undefined,
			database: input.database, username: input.username, password: input.password,
			ssl: input.ssl === true, sslMode: input.ssl === true ? 'system' : undefined, readOnly: false,
		});
		const result = await api.connect(saved.id);
		if (result.error) {
			throw new Error(`connect failed: ${result.error}`);
		}
		return saved.id;
	}, cfg as unknown as Record<string, string | boolean>);
}

/** Run one statement, for setting the table up. */
async function exec(page: Page, connectionId: string, sql: string): Promise<void> {
	const error = await page.evaluate(async (input) => {
		const result = await (window as unknown as {
			sqlApi: { execute(params: unknown): Promise<{ error?: string }> };
		}).sqlApi.execute({ connectionId: input.connectionId, sql: input.sql });
		return result.error;
	}, { connectionId, sql });
	if (error) {
		throw new Error(`${sql}: ${error}`);
	}
}

/** Open a table's Properties tab through the tree, the way a person does. */
async function openTable(page: Page, table: string, databaseNode = 'designer.db'): Promise<void> {
	const row = page.locator('.tree-row', { hasText: table }).first();
	// Expand only when the table is not already showing: a second call in the same app would
	// otherwise click the twisty of an OPEN tree and collapse it.
	if (!(await row.isVisible())) {
		const root = page.locator('.tree-row.depth-0', { hasText: 'designer' });
		await expect(root).toBeVisible({ timeout: 30_000 });
		await root.locator('.twisty').click();
		const database = page.locator('.tree-row.depth-1', { hasText: databaseNode });
		await expect(database).toBeVisible({ timeout: 30_000 });
		await database.click();
	}
	await expect(row).toBeVisible({ timeout: 30_000 });
	await row.dblclick();
	// A table opens on Data; the designer is the Properties tab beside it.
	await page.getByRole('button', { name: 'Properties' }).click();
	await expect(page.locator('.designer-grid:visible')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-designer-'));
	handle = await launchApp('table-designer');
	await addSqliteConnection(handle.page, 'designer', seed());
	await openTable(handle.page, 'hello');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('the PK box is there, and ticking it changes the draft', async () => {
	const { page } = handle;
	// Rows are located by position, not by text: a column's name lives in an input's VALUE, which
	// is not text content, so `hasText` matches nothing here.
	const idRow = page.locator('.designer-grid .dg-row:not(.dg-head)').nth(1);
	const pk = idRow.locator('.dg-pk input[type="checkbox"]');

	await expect(pk).toBeVisible();
	await expect(pk).toBeEnabled();
	await expect(pk).not.toBeChecked();

	// Save is dead until something actually changes, which is the honest test that the click
	// reached the draft rather than only the checkbox's own DOM state.
	const save = page.getByRole('button', { name: 'Save changes' });
	await expect(save).toBeDisabled();
	await pk.check();
	await expect(pk).toBeChecked();
	await expect(save).toBeEnabled();

	await page.getByRole('button', { name: 'Revert' }).click();
	await expect(pk).not.toBeChecked();
});

test('SQLite: the Auto box on an existing column is disabled, not silently broken', async () => {
	const { page } = handle;
	const rows = page.locator('.designer-grid .dg-row:not(.dg-head)');
	const auto = rows.nth(0).locator('.dg-auto input[type="checkbox"]');
	await expect(auto).toBeVisible();
	await expect(auto).toBeDisabled();
	await expect(auto).toHaveAttribute('title', /only be set when the column is created/);
});

test('on a NEW table Auto ticks, clears the default, forces NOT NULL, and takes the key with it', async () => {
	const { page } = handle;
	// The "New table" designer, from the + beside the database in the tree — create mode is the
	// only mode SQLite offers this in.
	await page.locator('.tree-row.depth-1', { hasText: 'designer.db' }).hover();
	await page.locator('.tree-row.depth-1', { hasText: 'designer.db' }).locator('button[aria-label="New table"]').click();
	await expect(page.locator('.designer-grid:visible')).toBeVisible({ timeout: 30_000 });

	const first = page.locator('.designer-grid .dg-row:not(.dg-head)').nth(0);
	await first.locator('.dg-name input').fill('id');
	await first.locator('.dg-type input').fill('INTEGER');
	await first.locator('.dg-default input[type="text"]').fill('7');

	const auto = first.locator('.dg-auto input[type="checkbox"]');
	await expect(auto).toBeEnabled();
	await auto.check();

	// The sequence IS the value, so the default goes and cannot be typed into again.
	await expect(first.locator('.dg-default input[type="text"]')).toHaveValue('');
	await expect(first.locator('.dg-default input[type="text"]')).toBeDisabled();
	await expect(first.locator('.dg-null input[type="checkbox"]')).not.toBeChecked();
	// SQLite requires the generated column to BE the key, so ticking Auto ticks PK with it.
	await expect(first.locator('.dg-pk input[type="checkbox"]')).toBeChecked();

	// And the statement it would run writes the key inline, once.
	await page.locator('.prop-header input').first().fill('made_here');
	await page.locator('.prop-nav-item', { hasText: 'DDL' }).click();
	const ddl = await page.locator('.ddl-view').innerText();
	expect(ddl).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
	expect(ddl.match(/PRIMARY KEY/g)).toHaveLength(1);
});

test('a column with no type says so, instead of a dead button and no explanation', async () => {
	const { page } = handle;
	// Reported from the real app on a hosted project: table named, column named, "Create table"
	// stayed grey and nothing anywhere said why. The TYPE placeholder reads "int", which looks
	// exactly like a value that is already there, so a column with no type at all looks finished.
	await page.locator('.tree-row.depth-1', { hasText: 'designer.db' }).hover();
	await page.locator('.tree-row.depth-1', { hasText: 'designer.db' }).locator('button[aria-label="New table"]').click();
	await expect(page.locator('.designer-grid:visible')).toBeVisible({ timeout: 30_000 });

	const create = page.getByRole('button', { name: 'Create table' });
	const first = page.locator('.designer-grid .dg-row:not(.dg-head)').nth(0);

	// Set the state this test is about rather than assuming a blank designer: the specs in this
	// file drive ONE app in file order, and the one above leaves a filled-in draft behind.
	await page.locator('.prop-header input').first().fill('');
	await first.locator('.dg-name input').fill('');
	await first.locator('.dg-type input').fill('');

	// Nothing filled in: the table's own name is the first thing missing.
	await expect(create).toBeDisabled();
	await expect(page.locator('.prop-blocker')).toHaveText(/name/i);

	await page.locator('.prop-header input').first().fill('test');
	await first.locator('.dg-name input').fill('id');

	// The exact reported state. The button is still dead, but now it says which column and why.
	await expect(create).toBeDisabled();
	await expect(page.locator('.prop-blocker')).toHaveText(/Column "id" needs a type/);
	// And the field the sentence points at is marked, so it can be found without reading.
	await expect(first.locator('.dg-type input')).toHaveClass(/needs-value/);

	// Typing one clears both and lets the save through.
	await first.locator('.dg-type input').fill('INTEGER');
	await expect(page.locator('.prop-blocker')).toHaveCount(0);
	await expect(first.locator('.dg-type input')).not.toHaveClass(/needs-value/);
	await expect(create).toBeEnabled();
});

test('Constraints is not a dead list: it reports the key and says why it cannot change it here', async () => {
	const { page } = handle;
	// Back to the persisted table: the test above left the "New table" tab in front, and these
	// tests share one app instance in file order.
	await page.locator('.tab-item', { hasText: 'hello' }).first().click();
	await page.getByRole('button', { name: 'Properties' }).click();
	await page.locator('.prop-nav-item', { hasText: 'Constraints' }).click();
	await expect(page.locator('.prop-empty', { hasText: 'No primary key' })).toBeVisible();
	// SQLite fixes the key at CREATE TABLE, so the button is deliberately absent and the reason
	// is on screen instead of nothing at all.
	await expect(page.getByRole('button', { name: 'Add primary key' })).toHaveCount(0);
	await expect(page.locator('.prop-note', { hasText: 'rebuilding the table' })).toBeVisible();
});

/* ---------------------------------------------------------------------------------------------
 * The half SQLite cannot answer: adding a primary key to a table that already exists.
 *
 * Gated on SNOUTDATA_TEST_* like the other live-DB specs and skips cleanly without it. It is
 * here rather than in ddl.test.ts because the SQL was never the doubtful part — whether the
 * Constraints section lets anybody reach it was. Verified against Postgres 17.
 * ------------------------------------------------------------------------------------------ */

const db = dbEnv();

test.describe('adding a primary key on a live database', () => {
	test.skip(!db, 'set SNOUTDATA_TEST_HOST / SNOUTDATA_TEST_NAME / SNOUTDATA_TEST_USER to run this');

	let live: AppHandle;

	test.beforeAll(async () => {
		live = await launchApp('table-designer-live');
		const id = await addLiveConnection(live.page, db!);
		// The shape from the bug report: a column that generates its own value but was never
		// made the key, so the Data tab refuses to add a row.
		await exec(live.page, id, 'DROP TABLE IF EXISTS designer_pk');
		await exec(live.page, id, 'CREATE TABLE designer_pk (said text, id integer GENERATED BY DEFAULT AS IDENTITY)');
		await exec(live.page, id, "INSERT INTO designer_pk (said) VALUES ('hi')");
		await exec(live.page, id, 'DROP TABLE IF EXISTS designer_pk2');
		await exec(live.page, id, 'CREATE TABLE designer_pk2 (said text, id integer GENERATED BY DEFAULT AS IDENTITY)');
		await live.page.evaluate(async (cid) => {
			await (window as unknown as { sqlApi: { refresh(id: string): Promise<unknown> } }).sqlApi.refresh(cid);
		}, id);
	});

	test.afterAll(async () => {
		await closeApp(live);
	});

	test('the Columns PK box ticks, saves, and the key lands on the database', async () => {
		const { page } = live;
		await openTable(page, 'designer_pk', db!.driver === 'postgres' ? 'public' : db!.database);
		const idRow = page.locator('.designer-grid .dg-row:not(.dg-head)').nth(1);
		const pk = idRow.locator('.dg-pk input[type="checkbox"]');
		await expect(pk).toBeEnabled();
		await pk.check();
		await expect(pk).toBeChecked();

		// It survives the live-schema poll, which is the difference between this engine and the
		// SQLite tests above: Postgres and MySQL re-introspect on a digest change every 15s.
		await page.waitForTimeout(20_000);
		await expect(pk).toBeChecked();

		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.locator('.ddl-preview')).toContainText('ADD PRIMARY KEY ("id")');
		await page.getByRole('button', { name: 'Run' }).click();

		await page.locator('.prop-nav-item', { hasText: 'Constraints' }).click();
		await expect(page.locator('.pt-row', { hasText: 'designer_pk_pkey' })).toBeVisible({ timeout: 30_000 });
	});

	test('Constraints adds the key, and the Data tab stops refusing', async () => {
		const { page } = live;
		// Postgres groups the tree by SCHEMA, not by database, so the node under the connection is
		// `public` rather than the database name.
		await openTable(page, 'designer_pk2', db!.driver === 'postgres' ? 'public' : db!.database);
		await page.locator('.prop-nav-item', { hasText: 'Constraints' }).click();
		await expect(page.locator('.prop-empty', { hasText: 'No primary key' })).toBeVisible();

		await page.getByRole('button', { name: 'Add primary key' }).click();
		await page.locator('.index-cols').getByRole('checkbox', { name: 'id', exact: true }).check();
		await page.getByRole('button', { name: 'Set primary key' }).click();

		// The statement is shown before it runs, as every other DDL action here is.
		await expect(page.locator('.ddl-preview')).toContainText('ADD PRIMARY KEY ("id")');
		await page.getByRole('button', { name: 'Run' }).click();

		// It comes back from the database, not from local state.
		await expect(page.locator('.pt-row', { hasText: 'PRIMARY KEY' })).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('.pt-row', { hasText: 'designer_pk2_pkey' })).toBeVisible();

		// Which was the point: the grid will now let a row be added.
		await page.getByRole('button', { name: 'Data', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Add row' })).toBeVisible({ timeout: 30_000 });
		await expect(page.locator('.grid-edit-note')).toHaveCount(0);
	});
});

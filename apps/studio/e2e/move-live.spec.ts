/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

/*
 * A real move through the real app: the Postgres tools downloaded from the public feed on the
 * "tools missing" card, then a Postgres database into a new database the move creates on the same
 * server, started from the review sheet, verified by row counts, reported on the screen. Opt-in,
 * like the package's own live test:
 *
 *   SNOUT_MOVE_TEST_TOOLS=<a Postgres 17 bin directory, for this spec's own psql>
 *   SNOUT_MOVE_TEST_PG=<host>:<port>:<user>:<password>
 *   SNOUT_MOVE_TEST_SOURCE=<a database on that server with tables in it>
 *
 * The APP is given no tools: it downloads them into its scratch profile, which is the point. It
 * creates `move_e2e_copy` and drops it at the end.
 */

const tools = process.env.SNOUT_MOVE_TEST_TOOLS;
const server = process.env.SNOUT_MOVE_TEST_PG;
const sourceDb = process.env.SNOUT_MOVE_TEST_SOURCE;
const COPY = 'move_e2e_copy';

test.skip(!tools || !server || !sourceDb, 'set SNOUT_MOVE_TEST_TOOLS, SNOUT_MOVE_TEST_PG and SNOUT_MOVE_TEST_SOURCE to run');

const [host, port, user, ...rest] = (server ?? '').split(':');
const password = rest.join(':');

function psql(database: string, sql: string): string {
	return execFileSync(join(tools ?? '', process.platform === 'win32' ? 'psql.exe' : 'psql'), ['-X', '-A', '-t', '-c', sql], {
		env: { ...process.env, PGHOST: host, PGPORT: port, PGUSER: user, PGPASSWORD: password, PGDATABASE: database },
		encoding: 'utf8'
	}).trim();
}

let handle: AppHandle;

test.beforeAll(async () => {
	psql('postgres', `drop database if exists ${COPY}`);
	handle = await launchApp('move-live', { env: { SNOUT_PG_TOOLS_DIR: '' } });
});

test.afterAll(async () => {
	await closeApp(handle);
	psql('postgres', `drop database if exists ${COPY}`);
});

test('a database moves into a new one from the review sheet, and the report says every table matches', async () => {
	test.setTimeout(240_000);
	const { page } = handle;
	await page.evaluate(async (input) => {
		const api = (window as unknown as { sqlApi: { saveConnection(form: unknown): Promise<{ id: string }>; connect(id: string): Promise<{ error?: string }> } }).sqlApi;
		const saved = await api.saveConnection({ label: 'shop (local)', driver: 'postgres', host: input.host, port: Number(input.port), database: input.database, username: input.user, password: input.password, ssl: false, readOnly: false });
		const result = await api.connect(saved.id);
		if (result.error) {
			throw new Error(`connect failed: ${result.error}`);
		}
	}, { host, port, user, password, database: sourceDb });

	await page.keyboard.press(`${MOD}+Shift+P`);
	await page.keyboard.type('Move Database');
	await page.keyboard.press('Enter');
	await expect(page.locator('.move-view')).toBeVisible();

	const selects = page.locator('.move-end select');
	await selects.nth(0).selectOption({ label: 'shop (local)' });
	await selects.nth(1).selectOption({ label: 'New database on the server of shop (local)' });
	await page.getByLabel('New database name').fill(COPY);
	await page.getByRole('button', { name: /Check both databases/ }).click();

	// A fresh profile has no tools: the card says so and downloads them from the feed.
	const toolsCard = page.locator('.move-finding', { hasText: 'Postgres tools this move runs are not installed' });
	await expect(toolsCard).toBeVisible();
	await toolsCard.getByRole('button', { name: /Download them/ }).click();
	await expect(toolsCard).toBeHidden({ timeout: 120_000 });

	await expect(page.locator('.move-finding.note').first()).toContainText(`"${COPY}" is created on that server`);
	await page.getByRole('button', { name: /^Review/ }).click();
	await page.getByRole('button', { name: /Start the move/ }).click();

	const report = page.locator('.move-result');
	await expect(report).toBeVisible({ timeout: 180_000 });
	await page.locator('.move-view').screenshot({ path: 'e2e/.results/move-live-done.png' });
	await expect(report).toHaveClass(/success/);
	await expect(report).toContainText('match the source');
	await expect(page.locator('.move-table.done').first()).toBeVisible();

	const expected = psql(sourceDb ?? '', 'select count(*) from orders');
	expect(psql(COPY, 'select count(*) from orders')).toBe(expected);
});

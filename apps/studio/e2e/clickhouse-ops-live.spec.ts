/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// ClickHouse Operations against a live server that has something wrong with it: a partition with
// hundreds of parts (merges stopped), a mutation that cannot finish, and a long query to stop.
//   docker run -d -p 58123:8123 -e CLICKHOUSE_PASSWORD=pw clickhouse/clickhouse-server
//   (then create shop.events, SYSTEM STOP MERGES it, insert 500+ times, and ALTER ... UPDATE it)
//   SNOUTDATA_TEST_CLICKHOUSE_PORT=58123 SNOUTDATA_TEST_CLICKHOUSE_PASSWORD=pw npx playwright test clickhouse-ops-live --project=app

const PORT = process.env.SNOUTDATA_TEST_CLICKHOUSE_PORT;
const PASSWORD = process.env.SNOUTDATA_TEST_CLICKHOUSE_PASSWORD ?? '';

test.skip(!PORT, 'set SNOUTDATA_TEST_CLICKHOUSE_PORT to run against a live ClickHouse');

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('clickhouse-ops-live');
	await handle.page.evaluate(async ({ port, password }: { port: number; password: string }) => {
		await window.sqlApi.saveConnection({ label: 'ch ops', driver: 'clickhouse', host: '127.0.0.1', port, database: 'shop', username: 'default', password, ssl: false, readOnly: false });
	}, { port: Number(PORT), password: PASSWORD });
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('Operations opens from the connection and says what is wrong', async () => {
	const { page } = handle;
	const row = page.locator('.tree-row.depth-0', { hasText: 'ch ops' });
	await row.click();
	await row.hover();
	if (await row.locator('button[aria-label="Connect"]').count() > 0) {
		await row.locator('button[aria-label="Connect"]').click();
	}
	await expect(row.locator('button[aria-label="Disconnect"]')).toBeVisible({ timeout: 30_000 });
	const operations = page.locator('.tree-row.depth-1', { hasText: 'Operations' });
	if (!(await operations.isVisible())) {
		await row.locator('.twisty').click();
	}
	await operations.click();

	const panel = page.locator('.ch-ops');
	await expect(panel.locator('.tv-title')).toHaveText('ClickHouse Operations');
	await expect(panel.locator('.ch-ops-card.warn', { hasText: 'Parts piling up' })).toBeVisible({ timeout: 30_000 });
	await expect(panel.locator('.ch-ops-card.warn', { hasText: 'Mutations pending' })).toBeVisible();
	await expect(panel.locator('.ch-ops-card.ok', { hasText: 'No replicated tables' })).toBeVisible();
	await page.screenshot({ path: 'test-results/clickhouse-ops-health.png' });

	// The card opens the rows behind it.
	await panel.locator('.ch-ops-card', { hasText: 'Parts piling up' }).click();
	await expect(panel.locator('.tab.active')).toHaveText('Storage');
	await expect(panel.locator('.ch-ops-view.active')).toHaveText('Parts');
	await expect(panel.locator('.cell.head-cell', { hasText: 'max_parts_in_a_partition' })).toBeVisible();
	await expect(panel.locator('.cell-text', { hasText: /^events$/ }).first()).toBeVisible();
});

test('objects, storage and cluster views read what is there, and say plainly what is not', async () => {
	const { page } = handle;
	const panel = page.locator('.ch-ops');
	await panel.locator('.tab', { hasText: 'Objects' }).click();
	await expect(panel.locator('.ch-ops-view.active')).toHaveText('Materialized views');
	// Only when the demo database has a view; a bare server shows the empty sentence instead.
	await expect(panel.locator('.qp-grid')).toContainText(/materialized_view|No materialized views/);
	await panel.locator('.ch-ops-view', { hasText: 'Dictionaries' }).click();
	await expect(panel.locator('.qp-grid')).toContainText(/status|No dictionaries/);
	await panel.locator('.tab', { hasText: 'Storage' }).click();
	await panel.locator('.ch-ops-view', { hasText: 'Disks' }).click();
	await expect(panel.locator('.cell.head-cell', { hasText: 'used_percent' })).toBeVisible();
	await panel.locator('.tab', { hasText: 'Cluster' }).click();
	await panel.locator('.ch-ops-view', { hasText: 'DDL queue' }).click();
	// A single server with no Keeper: said as a fact about the server, not shown as an error.
	await expect(panel.locator('.qp-grid')).toContainText(/no Keeper configured|has finished on every host/);
	await expect(panel.locator('.results-error')).toHaveCount(0);
	await page.screenshot({ path: 'test-results/clickhouse-ops-cluster.png' });
	await panel.locator('.tab', { hasText: 'Queries' }).click();
});

test('a running query can be stopped from the panel', async () => {
	const { page } = handle;
	// A query that would run for minutes, started outside the app, marked so this test stops IT and
	// not something else the server happens to be running.
	const marker = `ops_e2e_${Date.now()}`;
	const outside = spawn('curl', ['-s', '-u', `default:${PASSWORD}`, `http://127.0.0.1:${PORT}/`, '--data-binary', `SELECT count() AS ${marker} FROM numbers(100000000000000)`], { stdio: 'ignore' });
	try {
		const panel = page.locator('.ch-ops');
		await panel.locator('.tab', { hasText: 'Queries' }).click();
		await panel.locator('.ch-ops-view', { hasText: 'Running queries' }).click();
		const longRow = panel.locator('.row', { hasText: marker });
		await expect(longRow).toBeVisible({ timeout: 15_000 });
		await page.screenshot({ path: 'test-results/clickhouse-ops-running.png' });
		await longRow.locator('button[aria-label="Stop"]').click();
		await page.locator('.modal.confirm button', { hasText: 'Stop' }).click();
		await expect(longRow).toBeHidden({ timeout: 15_000 });
	} finally {
		outside.kill();
	}
});

// The server's own log. The official image logs to a table already (2.5M rows on a container
// nobody configured), which is the opposite of what the tracker assumed, so what this asserts is
// the view WORKING on a plain install: the recent problems, and then one query's whole story.
//
// The level filter is the part worth driving. `level` is an Enum8 ordered Fatal .. Trace and
// `level <= 'Warning'` compares the STRING, so it silently lets Trace and Debug through; a unit
// test can only assert the text of whichever version was written.
test('the server log shows problems, then everything for one query', async () => {
	const { page } = handle;
	const panel = page.locator('.ch-ops');
	const marker = `opslog_e2e_${Date.now()}`;
	const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: `SELECT throwIf(1, '${marker}')`, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
	expect(res.ok).toBe(false);

	await panel.locator('.tab', { hasText: 'Server' }).click();
	await panel.locator('.ch-ops-view', { hasText: 'Server log' }).click();
	await expect(panel.locator('.cell.head-cell', { hasText: /^level$/ })).toBeVisible({ timeout: 30_000 });
	// Warnings and worse, and nothing below: the whole point of the unfiltered read.
	const levels = await panel.locator('.row .cell').filter({ hasText: /^(Trace|Debug|Information|Notice|Warning|Error|Critical|Fatal)$/ }).allInnerTexts();
	expect(levels.length).toBeGreaterThan(0);
	expect(levels.every((level) => ['Fatal', 'Critical', 'Error', 'Warning'].includes(level.trim())), `levels: ${levels.join(',')}`).toBe(true);

	// Narrowed: every line the failing query produced, at any level.
	await panel.locator('.ch-ops-filter input').fill(marker);
	await expect(panel.locator('.row', { hasText: marker }).first()).toBeVisible({ timeout: 30_000 });

	// A crash log that does not exist is the GOOD outcome, and says that rather than "not found".
	await panel.locator('.ch-ops-filter .icon-btn').click();
	await panel.locator('.ch-ops-view', { hasText: 'Crashes' }).click();
	await expect(panel.locator('.results-message')).toContainText('No crash', { timeout: 20_000 });
});

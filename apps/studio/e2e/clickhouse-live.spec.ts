/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { closeApp, launchApp, MOD, runButton, type AppHandle, pickConnection } from './helpers';

// ClickHouse picked from the connection form, connected over its HTTP interface, and queried.
// Runs only against a live server:
//   docker run -d -p 58123:8123 -e CLICKHOUSE_PASSWORD=pw clickhouse/clickhouse-server
//   SNOUTDATA_TEST_CLICKHOUSE_PORT=58123 SNOUTDATA_TEST_CLICKHOUSE_PASSWORD=pw npx playwright test clickhouse-live --project=app

const PORT = process.env.SNOUTDATA_TEST_CLICKHOUSE_PORT;
const PASSWORD = process.env.SNOUTDATA_TEST_CLICKHOUSE_PASSWORD ?? '';

test.skip(!PORT, 'set SNOUTDATA_TEST_CLICKHOUSE_PORT to run against a live ClickHouse');

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('clickhouse-live');
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('create, connect and run a query', async () => {
	const { page } = handle;
	await page.locator('[data-tour="add-connection"]').click();
	const form = page.locator('.modal');
	await form.getByRole('combobox', { name: "Driver" }).click();
	await page.getByRole('option', { name: "ClickHouse" }).click();
	await expect(form.locator('label.port input')).toHaveAttribute('placeholder', '8123');
	await form.getByLabel("Label").fill('ch');
	await form.getByLabel("Host").fill('127.0.0.1');
	await form.locator('label.port input').fill(PORT ?? '');
	await form.getByLabel("Username").fill('default');
	await form.getByLabel("Password").fill(PASSWORD);
	await form.getByRole('button', { name: "Save" }).click();
	await expect(form).toBeHidden();

	const row = page.locator('.tree-row.depth-0', { hasText: 'ch' });
	await row.click();
	await row.hover();
	// It may already be connecting on its own, so a Connect button that goes away is fine.
	await row.locator('button[aria-label="Connect"]').click({ timeout: 2_000 }).catch(() => undefined);
	await expect(row.locator('button[aria-label="Disconnect"]')).toBeVisible({ timeout: 30_000 });

	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT number * 2 AS doubled FROM system.numbers LIMIT 3');
	await runButton(page).click();
	await expect(page.locator('.cell.head-cell', { hasText: 'doubled' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.cell-text', { hasText: /^4$/ }).first()).toBeVisible();
	// What the statement read, which on ClickHouse is what it cost.
	await expect(page.locator('.limit-badge', { hasText: /scanned$/ })).toBeVisible();
	await expect(page.locator('.limit-badge', { hasText: / read$/ })).toBeVisible();
});

test('a statement with its own FORMAT shows its output, and auto-LIMIT goes before a SETTINGS', async () => {
	const { page } = handle;
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT number, toString(number) AS s FROM numbers(3) FORMAT CSV');
	await runButton(page).click();
	await expect(page.locator('.cell.head-cell', { hasText: 'CSV' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.cell-text', { hasText: '2,"2"' }).first()).toBeVisible();

	// No LIMIT of its own and a trailing SETTINGS: the app's auto-LIMIT must land before it.
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT number AS n FROM numbers(100000) SETTINGS max_threads = 1');
	await runButton(page).click();
	await expect(page.locator('.cell.head-cell', { hasText: /^n$/ })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.results-error')).toHaveCount(0);
});

test('SET survives to the next statement, though every HTTP request is a new session', async () => {
	const { page } = handle;
	for (const sql of ['SET max_threads = 3', "SELECT getSetting('max_threads') AS mt"]) {
		await page.locator('.monaco-editor').first().click();
		await page.keyboard.press(`${MOD}+a`);
		await page.keyboard.type(sql);
		await runButton(page).click();
	}
	await expect(page.locator('.cell.head-cell', { hasText: 'mt' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.cell-text', { hasText: /^3$/ }).first()).toBeVisible();
});

test('{name:Type} placeholders are asked for, bound on the server, and remembered', async () => {
	const { page } = handle;
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type("SELECT {n:UInt8} + 1 AS next, {who:String} AS who, length({who:String}) AS len FROM numbers({rows:UInt8})");
	await runButton(page).click();
	const dialog = page.locator('.modal.query-params');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('.query-param')).toHaveCount(3);
	await expect(dialog.locator('.query-param', { hasText: 'who' })).toContainText('String');
	await dialog.getByLabel('n', { exact: true }).fill('41');
	// Typed as the value itself: a quote and a backslash reach the server intact.
	await dialog.getByLabel('who', { exact: true }).fill("O'Brien\\x");
	await dialog.getByLabel('rows', { exact: true }).fill('2');
	await page.screenshot({ path: 'test-results/clickhouse-params.png' });
	await dialog.getByRole('button', { name: 'Run' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator('.cell.head-cell', { hasText: 'next' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.cell-text', { hasText: /^42$/ }).first()).toBeVisible();
	await expect(page.locator('.cell-text', { hasText: "O'Brien\\x" }).first()).toBeVisible();
	await expect(page.locator('.cell-text', { hasText: /^9$/ }).first()).toBeVisible();
	await expect(page.locator('.results-error')).toHaveCount(0);

	// Run again: asked again, starting from what was typed last.
	await runButton(page).click();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('n', { exact: true })).toHaveValue('41');
	await dialog.getByLabel('n', { exact: true }).fill('9');
	await dialog.getByLabel('n', { exact: true }).press('Enter');
	await expect(page.locator('.cell-text', { hasText: /^10$/ }).first()).toBeVisible({ timeout: 30_000 });
});

test('the explorer knows the key, the codec and what each column takes on disk', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.visits');
	await admin('CREATE TABLE depth.visits (user UInt64, ts DateTime CODEC(Delta, ZSTD(3)), v Float64) ENGINE = MergeTree PRIMARY KEY user ORDER BY (user, ts) SAMPLE BY user SETTINGS min_bytes_for_wide_part = 0');
	await admin('INSERT INTO depth.visits SELECT number % 100, toDateTime(1700000000 + number), number / 7 FROM numbers(100000)');

	const visits = await page.evaluate(async () => {
		const id = (await window.sqlApi.state()).connections.find((c) => c.label === 'ch')!.id;
		await window.sqlApi.refresh(id);
		return (await window.sqlApi.getSchema(id))?.tables.find((t) => t.schema === 'depth' && t.name === 'visits');
	});
	expect(visits?.stats?.engine).toBe('MergeTree PRIMARY KEY (user) ORDER BY (user, ts) SAMPLE BY (user)');
	expect(visits?.columns.map((c) => c.sortKey ?? null)).toEqual(['primary', 'sort', null]);
	expect(visits?.columns[1].codec).toBe('CODEC(Delta(4), ZSTD(3))');
	expect(visits?.columns[0].storedBytes?.uncompressed).toBe(800000);
	expect(visits?.columns.every((c) => !c.isPrimaryKey)).toBe(true);

	// In the tree: a key column has its own icon, and hover says where it sits in the key, its codec
	// and its size.
	const conn = page.locator('.tree-row.depth-0', { hasText: 'ch' });
	if (!(await page.locator('.tree-row.depth-1', { hasText: 'depth' }).isVisible())) {
		await conn.locator('.twisty').click();
	}
	await page.locator('.tree-row.depth-1', { hasText: /^depth/ }).first().click();
	await page.locator('.tree-row.depth-2', { hasText: 'visits' }).click();
	await page.locator('.tree-row', { hasText: /^Columns/ }).last().click();
	const user = page.locator('.tree-row.depth-4', { hasText: /^user/ });
	await expect(user.locator('.tree-label')).toBeVisible();
	await expect(user).toHaveAttribute('title', /primary index/);
	await expect(page.locator('.tree-row.depth-4', { hasText: /^ts/ })).toHaveAttribute('title', /In the sort key, after the primary index/);
	await expect(page.locator('.tree-row.depth-4', { hasText: /^v/ })).not.toHaveAttribute('title', /sort key/);
	await expect(page.locator('.tree-row.depth-4', { hasText: /^ts/ })).toHaveAttribute('title', /Codec: CODEC\(Delta\(4\), ZSTD\(3\)\)/);
	await expect(user).toHaveAttribute('title', /On disk: .* compressed, 781 KB raw/);
	await page.screenshot({ path: 'test-results/clickhouse-explorer-depth.png' });
});

test('a running query shows what it has read and the memory it holds, then stops', async () => {
	const { page } = handle;
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT count() AS n FROM numbers(100000000000) WHERE sipHash64(number) % 7 = 1');
	await runButton(page).click();
	const progress = page.locator('.run-elapsed .run-progress');
	// numbers(N) tells the server how much it will read, so there is a percentage too.
	await expect(progress).toHaveText(/ · [\d.]+[KMB]? rows \(\d+%\) · [\d.]+ [KMGT]?B read · [\d.]+ [KMGT]?B memory/, { timeout: 10_000 });
	await page.screenshot({ path: 'test-results/clickhouse-progress.png' });
	await page.locator('button.run.cancel').click();
	await expect(progress).toBeHidden({ timeout: 15_000 });
});

test('the plan advisor sizes a scan by the real row count, and flags FINAL on a large table', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	// A custom granularity: 195 granules here is 200,000 rows, where 8192 per granule would say 1.6M.
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.rep');
	await admin('CREATE TABLE depth.rep (id UInt64, ver UInt32, v Float64) ENGINE = ReplacingMergeTree(ver) ORDER BY id SETTINGS index_granularity = 1024');
	await admin('INSERT INTO depth.rep SELECT number, 1, number FROM numbers(200000)');
	await page.evaluate(async () => {
		const id = (await window.sqlApi.state()).connections.find((c) => c.label === 'ch')!.id;
		await window.sqlApi.refresh(id);
	});

	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT id, v FROM depth.rep FINAL WHERE v > 5');
	await runButton(page).click();
	const strip = page.locator('.advisory-strip');
	await expect(strip).toContainText('FINAL on rep (200k rows)', { timeout: 30_000 });
	await expect(strip).toContainText('(200k rows) were read');
	await page.screenshot({ path: 'test-results/clickhouse-advisor.png' });
});

test('Query Performance ranks the heaviest statements by data read or by memory', async () => {
	const { page } = handle;
	// Two statements from the query log's point of view: one reads much, one holds much.
	const admin = async (sql: string): Promise<void> => {
		await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
	};
	await admin('SELECT sum(number) AS reads_a_lot FROM numbers(50000000)');
	await admin('SELECT length(groupArray(number)) AS holds_a_lot FROM numbers(3000000)');
	await admin('SYSTEM FLUSH LOGS');

	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.fill('.palette input', 'Query Performance');
	await page.keyboard.press('Enter');
	await page.locator('.tv-collect', { hasText: 'Collect data' }).click();
	await expect(page.locator('.cell.head-cell', { hasText: 'peak_memory_mb' })).toBeVisible({ timeout: 30_000 });

	const rank = page.locator('.page-size', { hasText: 'Rank by' }).locator('select');
	await rank.selectOption('read');
	await expect(page.locator('.tv-head .muted', { hasText: 'heaviest statements by data read' })).toBeVisible();
	await expect(page.locator('.qp-grid .row').first()).toContainText('reads_a_lot', { timeout: 30_000 });
	await rank.selectOption('memory');
	await expect(page.locator('.qp-grid .row').first()).toContainText('holds_a_lot', { timeout: 30_000 });
	await page.screenshot({ path: 'test-results/clickhouse-workload-rank.png' });
});

test('on production, a mutation is confirmed as the DELETE it is, and says it is a rewrite', async () => {
	const { page } = handle;
	await page.evaluate(async ({ port, password }: { port: number; password: string }) => {
		await window.sqlApi.saveConnection({ label: 'ch prod', driver: 'clickhouse', host: '127.0.0.1', port, database: 'depth', username: 'default', password, ssl: false, readOnly: false, environment: 'prod' });
	}, { port: Number(PORT), password: PASSWORD });
	const row = page.locator('.tree-row.depth-0', { hasText: 'ch prod' });
	await row.click();
	await row.hover();
	await row.locator('button[aria-label="Connect"]').click({ timeout: 2_000 }).catch(() => undefined);
	await expect(row.locator('button[aria-label="Disconnect"]')).toBeVisible({ timeout: 30_000 });
	await page.locator('.tabbar .tab-item', { hasText: 'Untitled-1' }).click();
	await pickConnection(page, 'ch prod');

	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('ALTER TABLE depth.rep DELETE WHERE 1');
	await runButton(page).click();
	const dialog = page.locator('.modal.confirm');
	await expect(dialog).toContainText('Run DELETE on PRODUCTION?');
	await expect(dialog).toContainText('affect EVERY row');
	await expect(dialog.locator('.confirm-hazard-message')).toContainText('rewrites every part of depth.rep');
	await expect(dialog.locator('.confirm-hazard-rationale')).toContainText('DELETE FROM depth.rep WHERE');
	await page.screenshot({ path: 'test-results/clickhouse-mutation-confirm.png' });
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	// Nothing ran: the rows are all still there.
	const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: 'SELECT count() FROM depth.rep', headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
	expect((await res.text()).trim()).toBe('200000');
});

// The editor knows what THIS server knows: its functions with their own descriptions, its
// combinators, its settings, its formats and its engines, read from `system.*` on connect.
test('completion and hover come from the server\'s own catalog', async () => {
	const { page } = handle;
	const editor = page.locator('.monaco-editor').first();
	const suggest = page.locator('.suggest-widget.visible');
	const rows = suggest.locator('.monaco-list-row');

	// The catalog is read in the background after connecting, so give it its moment.
	await expect.poll(async () => page.evaluate(async () => {
		const id = (await window.sqlApi.state()).connections.find((c) => c.label === 'ch')!.id;
		const uri = 'file:///catalog-probe.sql';
		await window.sqlApi.didOpen(uri, 'SELECT toStartOfH', 1);
		const answer = await window.sqlApi.completion(uri, { line: 0, character: 17 }, id);
		return answer.items.some((item) => item.label === 'toStartOfHour');
	}), { timeout: 30_000 }).toBe(true);

	// Suggestions are manual by default in this app (Ctrl+Space), so each one is asked for.
	// A function, in the suggest widget, with the server's own prose behind it.
	await editor.click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT toStartOfH');
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'toStartOfHour' }).first()).toBeVisible({ timeout: 10_000 });
	await page.screenshot({ path: 'test-results/clickhouse-completion-function.png' });
	await page.keyboard.press('Escape');

	// An aggregate wearing a combinator: in no system table, built from the aggregate.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT uniqExactI');
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'uniqExactIf' }).first()).toBeVisible({ timeout: 10_000 });
	await page.screenshot({ path: 'test-results/clickhouse-completion-combinator.png' });
	await page.keyboard.press('Escape');

	// A settings name, where nothing but a settings name can be right.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT 1 SETTINGS max_thr');
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'max_threads' }).first()).toBeVisible({ timeout: 10_000 });
	await page.screenshot({ path: 'test-results/clickhouse-completion-setting.png' });
	await page.keyboard.press('Escape');

	// A format after FORMAT, and a table engine after ENGINE =.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT 1 FORMAT JSONEachR');
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'JSONEachRow' }).first()).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Escape');
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('CREATE TABLE t (id UInt64) ENGINE = Replacing');
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'ReplacingMergeTree' }).first()).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Escape');

	// A table function, at a table position.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT * FROM numbe');
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: /^numbers/ }).first()).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Escape');

	// The words this vendor adds are coloured as KEYWORDS, not left as plain identifiers: the
	// tokenizer follows the active connection's dialect.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT * FROM visits FINAL PREWHERE user = 1');
	const token = await page.evaluate(() => {
		const spans = [...document.querySelectorAll('.view-lines .view-line span span')];
		const classOf = (text: string): string => spans.find((span) => span.textContent?.trim() === text)?.className ?? '';
		return { select: classOf('SELECT'), final: classOf('FINAL'), prewhere: classOf('PREWHERE'), name: classOf('visits') };
	});
	expect(token.select).not.toBe('');
	expect(token.final).toBe(token.select);
	expect(token.prewhere).toBe(token.select);
	expect(token.name).not.toBe(token.select);
	await page.screenshot({ path: 'test-results/clickhouse-keywords.png' });

	// And hover: the server's own description of one of its functions.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT toYYYYMM(now())');
	await page.locator('.view-lines .mtk1, .view-lines span').filter({ hasText: 'toYYYYMM' }).first().hover();
	const hover = page.locator('.monaco-hover .hover-contents');
	await expect(hover.first()).toBeVisible({ timeout: 10_000 });
	await expect(hover.first()).toContainText(/toYYYYMM/);
	await page.screenshot({ path: 'test-results/clickhouse-hover-function.png' });
	// Leave the mouse off the editor: a hover card left open swallows the next test's first click.
	await page.mouse.move(10, 500);
	await expect(hover.first()).toBeHidden();
});

// A value with structure inside it: one grid line cannot show an Array, a Map, a Tuple or a JSON,
// so the cell says how much is in there and opens it as a tree.
test('a composite value says how much is inside, and opens as a tree with its declared types', async () => {
	const { page } = handle;
	await page.mouse.move(10, 500);
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type("SELECT [10,20,30] AS arr, map('a',1,'b',2) AS m, cast(tuple(7,'x'), 'Tuple(id UInt8, name String)') AS t, '{\"items\":[{\"n\":1}]}'::JSON AS j");
	await runButton(page).click();
	await expect(page.locator('.cell.head-cell', { hasText: /^arr$/ })).toBeVisible({ timeout: 30_000 });

	// The count, in the cell, without opening anything.
	const counts = page.locator('.grid-body .cell-count');
	await expect(counts).toHaveCount(4);
	await expect(counts.nth(0)).toHaveText('3');
	await expect(counts.nth(1)).toHaveText('2');
	await page.screenshot({ path: 'test-results/clickhouse-cell-counts.png' });

	// The tuple: the server declared its field names and types, so the tree shows them.
	await counts.nth(2).click();
	const modal = page.locator('.modal.cell-editor');
	await expect(modal).toBeVisible();
	// By the row's own KEY: the root row carries the whole type, so "id" is in its text too.
	const row = (key: string) => modal.locator('.value-row').filter({ has: page.locator('.value-key').filter({ hasText: new RegExp(`^${key}$`) }) });
	await expect(row('id').locator('.value-type')).toHaveText('UInt8');
	await expect(row('name').locator('.value-leaf')).toHaveText('x');
	await page.screenshot({ path: 'test-results/clickhouse-value-tree.png' });

	// The text is still there, and still what would be edited.
	await modal.getByRole('tab', { name: 'Text' }).click();
	await expect(modal.locator('.cell-editor-text')).toHaveValue(/"id"\s*:\s*7/);
	await modal.getByRole('button', { name: 'Close' }).click();
	await expect(modal).toBeHidden();

	// A JSON column nests: the tree goes as deep as the value does.
	await counts.nth(3).click();
	await expect(row('items')).toBeVisible();
	await expect(row('n').locator('.value-leaf')).toHaveText('1');
	await page.screenshot({ path: 'test-results/clickhouse-json-tree.png' });
	await modal.getByRole('button', { name: 'Close' }).click();
});

// What is INSIDE a column: a Tuple's fields come from the declared type, a JSON column's paths
// from a sample of the data taken at introspection.
test('completion reaches inside a Tuple, a Map and a JSON column', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.comp');
	await admin('CREATE TABLE depth.comp (id UInt64, who Tuple(uid UInt64, name String), tags Map(String, UInt8), payload JSON) ENGINE = MergeTree ORDER BY id');
	await admin(`INSERT INTO depth.comp VALUES (1, (7,'x'), map('k',1), '{"user":{"email":"a@b.c"},"total":2}')`);
	// Every ClickHouse connection, not just the first: the editor's active tab is on whichever one
	// the earlier tests left selected, and completion reads THAT connection's schema.
	await page.evaluate(async () => {
		const state = await window.sqlApi.state();
		for (const connection of state.connections.filter((c) => c.driver === 'clickhouse')) {
			await window.sqlApi.refresh(connection.id).catch(() => undefined);
		}
	});

	const rows = page.locator('.suggest-widget.visible .monaco-list-row');
	await page.mouse.move(10, 500);
	await page.locator('.monaco-editor').first().click();

	// A Tuple's fields, with their types, from the type alone.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT c.who. FROM depth.comp c');
	// The cursor is at the end after typing, so put it back after the dot.
	await page.keyboard.press('Home');
	for (let i = 0; i < 'SELECT c.who.'.length; i++) {
		await page.keyboard.press('ArrowRight');
	}
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'uid' }).first()).toBeVisible({ timeout: 10_000 });
	await page.screenshot({ path: 'test-results/clickhouse-subcolumn-tuple.png' });
	await page.keyboard.press('Escape');

	// A Map offers what can really be selected off it.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT c.tags. FROM depth.comp c');
	await page.keyboard.press('Home');
	for (let i = 0; i < 'SELECT c.tags.'.length; i++) {
		await page.keyboard.press('ArrowRight');
	}
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'keys' }).first()).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Escape');

	// A JSON column offers the paths the sample held, one segment at a time.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT c.payload. FROM depth.comp c');
	await page.keyboard.press('Home');
	for (let i = 0; i < 'SELECT c.payload.'.length; i++) {
		await page.keyboard.press('ArrowRight');
	}
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'user' }).first()).toBeVisible({ timeout: 10_000 });
	await expect(rows.filter({ hasText: 'total' }).first()).toBeVisible();
	await page.screenshot({ path: 'test-results/clickhouse-subcolumn-json.png' });
	await page.keyboard.press('Escape');
});

// The Explain panel: the five forms ClickHouse offers, each read in the shape it answers with, in a
// result tab beside the rows.
test('Explain shows the plan, the estimate, the pipeline, the rewrite and the query tree', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.plan_events');
	await admin("CREATE TABLE depth.plan_events (ts DateTime, kind LowCardinality(String), user_id UInt64) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (kind, ts)");
	// Enough rows for several granules, so the key has something to prune.
	await admin("INSERT INTO depth.plan_events SELECT toDateTime('2026-01-01 00:00:00') + number, ['a','b','c','d'][(number % 4) + 1], number FROM numbers(200000)");

	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type("SELECT kind, count() FROM depth.plan_events WHERE kind = 'a' GROUP BY kind");

	await page.locator('button.run-caret').click();
	await page.locator('.run-item', { hasText: 'Explain' }).click();

	// Plan: the reading above the tree is what the indexes left to read, and the index table says
	// which one did it.
	const panel = page.locator('.explain-panel');
	await expect(panel.locator('.explain-variant.active')).toHaveText('Plan', { timeout: 30_000 });
	await expect(panel.locator('.explain-read')).toContainText(/depth\.plan_events: [\d,]+ of [\d,]+ \(\d+%\) granules/);
	await expect(panel.locator('.explain-node-type', { hasText: 'ReadFromMergeTree' })).toBeVisible();
	await expect(panel.locator('.explain-indexes td', { hasText: 'PrimaryKey' })).toBeVisible();
	await page.screenshot({ path: 'test-results/clickhouse-explain-plan.png' });

	// Estimate: what running it would read, before it has run, against what the table holds.
	await panel.getByRole('tab', { name: 'Estimate' }).click();
	await expect(panel.locator('.explain-read')).toContainText(/Would read about [\d,]+ rows from 1 table/);
	await expect(panel.locator('.explain-estimate td', { hasText: 'depth.plan_events' })).toBeVisible();
	await page.screenshot({ path: 'test-results/clickhouse-explain-estimate.png' });

	// Pipeline: the processors, with the indentation that is the information.
	await panel.getByRole('tab', { name: 'Pipeline' }).click();
	await expect(panel.locator('.explain-text')).toContainText('MergeTreeSelect');

	// Syntax: the query as the optimizer wrote it back.
	await panel.getByRole('tab', { name: 'Syntax' }).click();
	await expect(panel.locator('.sql-code')).toContainText('FROM depth.plan_events');

	// Query tree: the analyzer's own reading.
	await panel.getByRole('tab', { name: 'Query tree' }).click();
	await expect(panel.locator('.explain-text')).toContainText('QUERY id');

	// Running again puts the rows back: a plan borrows the result tab, it does not keep it.
	await runButton(page).click();
	await expect(page.locator('.cell.head-cell', { hasText: 'kind' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.explain-panel')).toHaveCount(0);
});

// A statement carrying its own FORMAT still explains: the FORMAT belongs to the SELECT, and left on
// an EXPLAIN it would reformat the PLAN so nothing could read it.
test('Explain drops a trailing FORMAT rather than answering in it', async () => {
	const { page } = handle;
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type("SELECT kind FROM depth.plan_events WHERE kind = 'b' FORMAT CSV");
	await page.locator('button.run-caret').click();
	await page.locator('.run-item', { hasText: 'Explain' }).click();
	const panel = page.locator('.explain-panel');
	await expect(panel.locator('.explain-node-type', { hasText: 'ReadFromMergeTree' })).toBeVisible({ timeout: 30_000 });
	await expect(panel.locator('.explain-error')).toHaveCount(0);
});

/** The `depth` database row of the `ch` connection, expanded into view. Expanding is done by
 *  asking whether the row is already there: a click on a tree row TOGGLES, so "just click it"
 *  closes one an earlier test left open. */
async function depthDatabase(page: AppHandle['page']) {
	const conn = page.locator('.tree-row.depth-0', { hasText: /^ch/ }).first();
	const database = page.locator('.tree-row.depth-1', { hasText: /^depth/ }).first();
	if (!(await database.isVisible())) {
		await conn.click();
	}
	await expect(database).toBeVisible({ timeout: 30_000 });
	return database;
}

/** Double-click a table of the `ch` connection's `depth` database. */
async function openTable(page: AppHandle['page'], name: string): Promise<void> {
	const database = await depthDatabase(page);
	const table = page.locator('.tree-row.depth-2', { hasText: name }).first();
	if (!(await table.isVisible())) {
		await database.click();
	}
	await expect(table).toBeVisible({ timeout: 30_000 });
	await table.dblclick();
}

// The Storage tab on a ClickHouse table: what a MergeTree table IS, rather than what its columns
// are.
test('the table page says how the table is stored, and a partition can be merged', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		const body = await res.text();
		expect(res.ok, body).toBe(true);
		return body.trim();
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.anatomy');
	await admin("CREATE TABLE depth.anatomy (ts DateTime, uid UInt64, country String, amount Float64, INDEX amt amount TYPE minmax GRANULARITY 4, PROJECTION by_country (SELECT country, sum(amount) GROUP BY country)) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (intHash64(uid), ts) SAMPLE BY intHash64(uid) TTL ts + INTERVAL 2 YEAR SETTINGS index_granularity = 8192");
	// Several parts in ONE partition, so "Merge now" has something to do.
	await admin('SYSTEM STOP MERGES depth.anatomy');
	for (let i = 0; i < 4; i++) {
		await admin(`INSERT INTO depth.anatomy SELECT toDateTime('2026-01-01') + number, number, 'gb', number / 7 FROM numbers(${i}, 1000)`);
	}
	await admin('SYSTEM START MERGES depth.anatomy');
	await page.evaluate(async () => {
		const state = await window.sqlApi.state();
		for (const connection of state.connections.filter((c) => c.driver === 'clickhouse')) {
			await window.sqlApi.refresh(connection.id).catch(() => undefined);
		}
	});

	// Open the table page from the explorer. Expanding is done by asking whether the row is
	// already there: a blind click TOGGLES, and by this point in the file an earlier test has
	// usually left the database open.
	await openTable(page, 'anatomy');

	const view = page.locator('.table-view');
	await expect(view.locator('.tv-title')).toContainText('anatomy', { timeout: 30_000 });
	await view.locator('.tv-tabs .tab', { hasText: 'Storage' }).click();

	// The engine line, from the columns the server broke out plus the TTL parsed off the clause.
	const anatomy = page.locator('.ch-anatomy');
	await expect(anatomy.locator('.ch-anatomy-engine')).toHaveText('MergeTree', { timeout: 30_000 });
	await expect(anatomy).toContainText('toYYYYMM(ts)');
	await expect(anatomy).toContainText('intHash64(uid), ts');
	await expect(anatomy).toContainText('ts + toIntervalYear(2)');
	await expect(anatomy).toContainText('index_granularity');
	// A PRIMARY KEY equal to the ORDER BY is not worth a line of its own.
	await expect(anatomy).not.toContainText('PRIMARY KEY');

	// The partition, its parts, and the projection and skip index beside it.
	const storage = page.locator('.ch-storage');
	await expect(storage.locator('.ch-storage-table td code', { hasText: '202601' })).toBeVisible();
	await expect(storage.locator('.ch-storage-table td code', { hasText: 'by_country' })).toBeVisible();
	await expect(storage.locator('.ch-storage-table td code', { hasText: /^amt$/ })).toBeVisible();
	await page.screenshot({ path: 'test-results/clickhouse-storage.png' });

	// Merge now: the confirm shows the statement, and after it runs the partition is one part.
	const partitionRow = storage.locator('.ch-storage-table tbody tr').first();
	await partitionRow.locator('.ch-storage-action').first().click();
	const dialog = page.locator('.modal.confirm');
	await expect(dialog).toContainText('OPTIMIZE TABLE `depth`.`anatomy` PARTITION ID');
	await page.screenshot({ path: 'test-results/clickhouse-storage-confirm.png' });
	await dialog.getByRole('button', { name: 'Merge now' }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => admin("SELECT count() FROM system.parts WHERE database = 'depth' AND table = 'anatomy' AND active"), { timeout: 30_000 }).toBe('1');
	await expect(partitionRow.locator('td').nth(1)).toHaveText('1', { timeout: 30_000 });
});

// A table with no parts on disk is not a broken MergeTree page: it says what it is instead.
test('a Memory table says it has no partitions rather than showing three empty lists', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	await admin('DROP TABLE IF EXISTS depth.in_memory');
	await admin('CREATE TABLE depth.in_memory (a UInt8) ENGINE = Memory');
	await page.evaluate(async () => {
		const state = await window.sqlApi.state();
		for (const connection of state.connections.filter((c) => c.driver === 'clickhouse')) {
			await window.sqlApi.refresh(connection.id).catch(() => undefined);
		}
	});
	await openTable(page, 'in_memory');
	const view = page.locator('.table-view');
	await expect(view.locator('.tv-title')).toContainText('in_memory', { timeout: 30_000 });
	await view.locator('.tv-tabs .tab', { hasText: 'Storage' }).click();
	await expect(page.locator('.ch-anatomy-engine')).toHaveText('Memory', { timeout: 30_000 });
	await expect(page.locator('.ch-storage')).toContainText('A Memory table keeps no parts on disk');
	await expect(page.locator('.ch-storage-table')).toHaveCount(0);
});

// The designer knows the engine: a new ClickHouse table is no longer always a plain MergeTree
// ordered by its key and nothing else.
test('the designer creates a table with its engine, partitioning, TTL and codecs', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		const body = await res.text();
		expect(res.ok, body).toBe(true);
		return body.trim();
	};
	await admin('DROP TABLE IF EXISTS depth.designed');

	// The "New table" designer, from the + beside the database in the tree.
	const database = await depthDatabase(page);
	await database.hover();
	await database.locator('button[aria-label="New table"]').click();
	await expect(page.locator('.designer-grid')).toBeVisible({ timeout: 30_000 });
	await page.locator('.prop-header input').first().fill('designed');

	// Two columns, one of them the sort key, each with a codec. Rows are located by position: a
	// column's name lives in an input's VALUE, which `hasText` cannot see.
	const rows = page.locator('.designer-grid .dg-row:not(.dg-head)');
	await rows.nth(0).locator('.dg-name input').fill('ts');
	await rows.nth(0).locator('.dg-type input').fill('DateTime');
	await rows.nth(0).locator('.dg-pk input[type="checkbox"]').check();
	await rows.nth(0).locator('.dg-codec input').fill('Delta, ZSTD(3)');
	await page.getByRole('button', { name: 'Add column' }).click();
	await rows.nth(1).locator('.dg-name input').fill('body');
	await rows.nth(1).locator('.dg-type input').fill('String');
	await rows.nth(1).locator('.dg-codec input').fill('ZSTD(1)');

	// The Engine section: the engine itself, what it is partitioned by, and a TTL.
	await page.locator('.prop-nav-item', { hasText: 'Engine' }).click();
	await page.locator('.ch-engine-choice', { hasText: 'ReplacingMergeTree' }).click();
	const field = (label: string) => page.locator('.ch-engine-field').filter({ hasText: label }).locator('input');
	await expect(field('Version column')).toBeVisible();
	await field('Version column').fill('ts');
	await field('Partition by').fill('toYYYYMM(ts)');
	await field('TTL').fill('ts + INTERVAL 90 DAY');
	// The sort key is not typed here: it is the columns ticked in Columns.
	await expect(field('Sort key')).toHaveValue('(ts)');
	await page.screenshot({ path: 'test-results/clickhouse-designer-engine.png' });

	// The statement, before it runs.
	await page.locator('.prop-nav-item', { hasText: 'DDL' }).click();
	const ddl = await page.locator('.ddl-view').innerText();
	expect(ddl).toContain('ENGINE = ReplacingMergeTree(ts)');
	expect(ddl).toContain('PARTITION BY toYYYYMM(ts)');
	expect(ddl).toContain('TTL ts + INTERVAL 90 DAY');
	expect(ddl).toContain('CODEC(Delta, ZSTD(3))');

	await page.getByRole('button', { name: 'Create table' }).click();
	const confirm = page.locator('.modal').filter({ hasText: 'CREATE TABLE' });
	await expect(confirm).toBeVisible({ timeout: 10_000 });
	await confirm.locator('.modal-actions button').last().click();

	// What the server actually made.
	await expect.poll(async () => admin("SELECT engine_full FROM system.tables WHERE database = 'depth' AND name = 'designed'"), { timeout: 30_000 })
		.toMatch(/ReplacingMergeTree\(ts\)/);
	const created = await admin("SELECT create_table_query FROM system.tables WHERE database = 'depth' AND name = 'designed'");
	expect(created).toContain('PARTITION BY toYYYYMM(ts)');
	expect(created).toContain('TTL ts + toIntervalDay(90)');
	// The server normalises a codec as it stores it: `Delta` comes back as `Delta(4)`, its default
	// byte size. What matters is that the codec reached the column, not its spelling.
	expect(created).toMatch(/CODEC\(Delta(\(\d+\))?, ZSTD\(3\)\)/);
});

// A choice that is legal, does exactly what it says, and is essentially never what was meant.
test('the designer says so when a deduplicating engine has no sort key', async () => {
	const { page } = handle;
	const database = await depthDatabase(page);
	await database.hover();
	await database.locator('button[aria-label="New table"]').click();
	await expect(page.locator('.designer-grid')).toBeVisible({ timeout: 30_000 });
	await page.locator('.prop-nav-item', { hasText: 'Engine' }).click();
	await page.locator('.ch-engine-choice', { hasText: 'CollapsingMergeTree' }).first().click();
	// Two problems at once: no sign column (which refuses), and no sort key (which warns).
	await expect(page.locator('.ch-engine-problem.results-error')).toContainText('sign column');
	await expect(page.locator('.ch-engine-problem.muted')).toContainText('whole table merges into one');
	await page.screenshot({ path: 'test-results/clickhouse-designer-problems.png' });
});

// Lineage and dictionaries in the explorer tree. ClickHouse has no foreign keys, so a materialized
// view is the whole of what connects two tables, and until now the tree showed a table with no hint
// that writing to it also wrote somewhere else.
test('a materialized view draws both ends of its wiring, and dictionaries have their own folder', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	for (const name of ['lin_mv', 'lin_refresh_mv', 'lin_target', 'lin_src', 'lin_dict', 'lin_codes']) {
		await admin(`DROP ${name === 'lin_dict' ? 'DICTIONARY' : name.endsWith('_mv') ? 'VIEW' : 'TABLE'} IF EXISTS depth.${name}`);
	}
	await admin('CREATE TABLE depth.lin_src (ts DateTime, kind String, amount Float64) ENGINE = MergeTree ORDER BY ts');
	await admin('CREATE TABLE depth.lin_target (day Date, total Float64) ENGINE = SummingMergeTree ORDER BY day');
	await admin('CREATE MATERIALIZED VIEW depth.lin_mv TO depth.lin_target AS SELECT toDate(ts) AS day, sum(amount) AS total FROM depth.lin_src GROUP BY day');
	await admin('CREATE MATERIALIZED VIEW depth.lin_refresh_mv REFRESH EVERY 1 HOUR ENGINE = MergeTree ORDER BY kind AS SELECT kind, count() AS n FROM depth.lin_src GROUP BY kind');
	await admin('CREATE TABLE depth.lin_codes (code String, label String) ENGINE = MergeTree ORDER BY code');
	await admin("CREATE DICTIONARY depth.lin_dict (code String, label String) PRIMARY KEY code SOURCE(CLICKHOUSE(TABLE 'lin_codes' DB 'depth')) LIFETIME(MIN 0 MAX 300) LAYOUT(COMPLEX_KEY_HASHED())");

	const model = await page.evaluate(async () => {
		const id = (await window.sqlApi.state()).connections.find((c) => c.label === 'ch')!.id;
		await window.sqlApi.refresh(id);
		const tables = (await window.sqlApi.getSchema(id))?.tables ?? [];
		const pick = (name: string) => tables.find((t) => t.schema === 'depth' && t.name === name);
		return { mv: pick('lin_mv'), refresh: pick('lin_refresh_mv'), src: pick('lin_src'), target: pick('lin_target'), dict: pick('lin_dict') };
	});
	expect(model.mv?.viewEngine).toBe('MaterializedView');
	expect(model.mv?.lineage?.readsFrom).toEqual([{ schema: 'depth', name: 'lin_src' }]);
	expect(model.mv?.lineage?.writesTo).toEqual({ schema: 'depth', name: 'lin_target' });
	expect(model.src?.lineage?.feeds).toEqual([{ schema: 'depth', name: 'lin_mv' }]);
	expect(model.target?.lineage?.writtenBy).toEqual([{ schema: 'depth', name: 'lin_mv' }]);
	// A refreshable view is a scheduled job, not an insert trigger, so the server records no
	// source for it and the tree says which kind it is rather than drawing an empty list.
	expect(model.refresh?.lineage?.refreshable).toBe(true);
	expect(model.refresh?.lineage?.readsFrom).toBeUndefined();
	// A dictionary is not a table: no stats line, and its key is what dictGet takes.
	expect(model.dict?.kind).toBe('dictionary');
	expect(model.dict?.stats).toBeUndefined();
	expect(model.dict?.dictionary).toEqual({ keyColumns: ['code'], attributes: [{ name: 'label', dataType: 'String' }], layout: 'COMPLEX_KEY_HASHED', sourceKind: 'CLICKHOUSE' });

	const database = await depthDatabase(page);
	if (!(await page.locator('.tree-row.depth-2', { hasText: 'lin_mv' }).first().isVisible())) {
		await database.click();
	}
	const mvRow = page.locator('.tree-row.depth-2', { hasText: /^lin_mv/ }).first();
	await expect(mvRow).toContainText('materialized view');
	await expect(page.locator('.tree-row.depth-2', { hasText: /^lin_refresh_mv/ }).first()).toContainText('refreshable view');

	await mvRow.click();
	await page.locator('.tree-row.depth-3', { hasText: /^Lineage/ }).first().click();
	const edges = page.locator('.tree-row.depth-4', { hasText: /reads from|writes to/ });
	await expect(edges).toHaveCount(2);
	await expect(edges.filter({ hasText: 'reads from' })).toContainText('lin_src');
	await expect(edges.filter({ hasText: 'writes to' })).toContainText('lin_target');
	await mvRow.click();

	// The same edge from the source's side: writing here also writes somewhere else.
	const srcRow = page.locator('.tree-row.depth-2', { hasText: /^lin_src/ }).first();
	await srcRow.click();
	await page.locator('.tree-row.depth-3', { hasText: /^Lineage/ }).first().click();
	await expect(page.locator('.tree-row.depth-4', { hasText: 'feeds' })).toContainText('lin_mv');
	await srcRow.click();

	// Dictionaries are their own folder, beside Procedures, with the key dictGet takes.
	const dicts = page.locator('.tree-row.depth-2', { hasText: /^Dictionaries/ }).first();
	await expect(dicts).toBeVisible();
	await dicts.click();
	const dictRow = page.locator('.tree-row.depth-3', { hasText: /^lin_dict/ }).first();
	await expect(dictRow).toContainText('code');
	await expect(dictRow).toHaveAttribute('title', /Loaded from: CLICKHOUSE/);
	await expect(dictRow).toHaveAttribute('title', /Layout: COMPLEX_KEY_HASHED/);
	await dictRow.click();
	await expect(page.locator('.tree-row.depth-4', { hasText: /^code/ })).toContainText('key');
	await expect(page.locator('.tree-row.depth-4', { hasText: /^label/ })).toContainText('String');
	await page.screenshot({ path: 'test-results/clickhouse-lineage-tree.png' });
});

// dictGet is the only place in ClickHouse where a schema object is addressed by a quoted STRING,
// so nothing offered it and a name typed wrong there failed at runtime instead of under a squiggle.
// Runs after the lineage test, which is what creates depth.lin_dict.
test('dictGet offers the dictionaries and then that dictionary\'s attributes', async () => {
	const { page } = handle;
	const editor = page.locator('.monaco-editor').first();
	const suggest = page.locator('.suggest-widget.visible');
	const rows = suggest.locator('.monaco-list-row');

	// The tests before this one leave the table designer open, and a designer has no SQL editor.
	await page.keyboard.press(`${MOD}+n`);
	await expect(editor).toBeVisible({ timeout: 10_000 });
	await editor.click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type("SELECT dictGet('lin_d");
	await page.keyboard.press(`${MOD}+Space`);
	const name = rows.filter({ hasText: 'depth.lin_dict' }).first();
	await expect(name).toBeVisible({ timeout: 10_000 });
	await expect(name).toContainText('keyed by code');
	await page.screenshot({ path: 'test-results/clickhouse-completion-dictget.png' });
	// Accepting it writes a qualified name into the literal the user had begun, not beside it.
	await page.keyboard.press('Tab');
	await expect(page.locator('.monaco-editor .view-lines').first()).toContainText("dictGet('depth.lin_dict");

	// And the attribute, which only that one dictionary can answer.
	await page.keyboard.type("', '");
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: 'label' }).first()).toBeVisible({ timeout: 10_000 });
	await expect(rows.filter({ hasText: 'code' })).toHaveCount(0);
	await page.keyboard.press('Escape');

	// A database typed inside the quote narrows to it and is not written twice.
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type("SELECT dictGet('depth.");
	await page.keyboard.press(`${MOD}+Space`);
	await expect(rows.filter({ hasText: /^lin_dict/ }).first()).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('Tab');
	await expect(page.locator('.monaco-editor .view-lines').first()).toContainText("dictGet('depth.lin_dict");
	await page.keyboard.press('Escape');
});

// The ClickHouse starter monitor. Operations says what the server is doing NOW; a system table
// holds no history, so "when did the parts start piling up" is a question only an accumulated
// series can answer. One button, and the existing poller does it.
test('Operations makes a starter monitor of the numbers it is showing', async () => {
	const { page } = handle;
	const conn = page.locator('.tree-row.depth-0', { hasText: /^ch/ }).first();
	const operations = page.locator('.tree-row.depth-1', { hasText: /^Operations/ }).first();
	if (!(await operations.isVisible())) {
		await conn.click();
	}
	await operations.click();
	await expect(page.locator('.ch-ops .tv-title')).toHaveText('ClickHouse Operations');

	const monitor = page.getByRole('button', { name: 'Monitor over time' });
	await expect(monitor).toBeEnabled({ timeout: 30_000 });
	await monitor.click();

	// The monitor it made is the one on screen, not whichever one happened to be first.
	const tiles = page.locator('.widget-tile-title');
	await expect(page.locator('.monitor-tab.active')).toContainText('ClickHouse');
	await expect(tiles).toHaveCount(7, { timeout: 15_000 });
	await expect(tiles.first()).toHaveText('Queries per second');
	await expect(page.locator('.widget-tile', { hasText: 'Parts in the largest partition' })).toBeVisible();
	// Every tile is a real query against the live server. The poller ticks a new widget once
	// immediately, so waiting for the last "waiting for the first sample" to go is waiting for all
	// seven to have RUN; only then does a count of zero errors mean anything.
	await expect(page.locator('.widget-tile-empty', { hasText: 'Waiting for the first sample' })).toHaveCount(0, { timeout: 30_000 });
	await expect(page.locator('.widget-tile-error')).toHaveCount(0);
	await page.screenshot({ path: 'test-results/clickhouse-starter-dashboard.png' });

	// Clicking it again shows the same monitor rather than making a second one. `.monitor-tab`
	// is also the class on the "+" button beside the tabs, hence the :not().
	await operations.click();
	await page.getByRole('button', { name: 'Monitor over time' }).click();
	await expect(page.locator('.monitor-tab:not(.add)')).toHaveCount(1);
});

// Users, roles and grants, against a live ClickHouse. This is the item that decides whether a DBA
// can stay in the app: before it, access control was refused by name. Needs
// CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 on the container so `default` may run CREATE USER, which
// the tracker's docker line sets.
test('users, roles and grants read back, and a plan is reviewed before it runs', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<void> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		expect(res.ok, await res.text()).toBe(true);
	};
	await admin('DROP USER IF EXISTS sec_app');
	await admin('DROP ROLE IF EXISTS sec_readers');
	await admin('CREATE ROLE sec_readers');
	await admin("CREATE USER sec_app IDENTIFIED WITH sha256_password BY 'pw'");
	await admin('GRANT sec_readers TO sec_app');
	await admin('GRANT SELECT ON depth.* TO sec_readers');
	await admin('GRANT SELECT ON depth.visits TO sec_app');
	// A partial revoke is ClickHouse's DENY: it does not delete the grant above, it beats it.
	await admin('REVOKE SELECT(v) ON depth.visits FROM sec_app');

	const read = await page.evaluate(async () => {
		const api = window.sqlApi as unknown as {
			state(): Promise<{ connections: { id: string; label: string }[] }>;
			securitySupport(id: string): Promise<{ supported: boolean; reason?: string; grantScopes: string[] }>;
			securityRead(id: string): Promise<{ principals: unknown[]; grants: unknown[]; warnings: string[] }>;
		};
		const id = (await api.state()).connections.find((c) => c.label === 'ch')!.id;
		return { support: await api.securitySupport(id), snapshot: await api.securityRead(id) };
	});
	expect(read.support.supported).toBe(true);
	// There is no level between a database and a table on ClickHouse: a database IS the namespace.
	expect(read.support.grantScopes).not.toContain('schema');

	type P = { name: string; kind: string; canLogin: boolean; isSuperuser: boolean; memberOf: string[]; attributes?: Record<string, string> };
	type G = { grantee: string; scope: string; database?: string; object?: string; column?: string; privilege: string; deny?: boolean };
	const principals = read.snapshot.principals as P[];
	const grants = read.snapshot.grants as G[];
	expect(read.snapshot.warnings).toEqual([]);

	const app = principals.find((p) => p.name === 'sec_app')!;
	expect(app.kind).toBe('user');
	expect(app.canLogin).toBe(true);
	expect(app.memberOf).toContain('sec_readers');
	expect(app.attributes?.['Authentication']).toBe('sha256_password');
	// A role is a principal in its own right, read from a different system table.
	expect(principals.find((p) => p.name === 'sec_readers')?.kind).toBe('role');
	// ClickHouse's own `default` holds ~60 separate global grants and no ALL row at all, so an
	// is_superuser that looked for ALL would report the server's administrator as an ordinary user.
	expect(principals.find((p) => p.name === 'default')?.isSuperuser).toBe(true);
	expect(principals.find((p) => p.name === 'default')?.attributes?.['Defined in']).toMatch(/users\.xml/);

	// A role's own grants, and the scope read off which level the row fills in.
	expect(grants.find((g) => g.grantee === 'sec_readers' && g.database === 'depth')).toMatchObject({ scope: 'database', privilege: 'SELECT' });
	expect(grants.find((g) => g.grantee === 'sec_app' && g.object === 'visits' && !g.column)).toMatchObject({ scope: 'table', privilege: 'SELECT' });
	const partial = grants.find((g) => g.grantee === 'sec_app' && g.column === 'v')!;
	expect(partial.deny).toBe(true);
	expect(partial.scope).toBe('column');

	// The write half: a plan is text until somebody approves it, so this asserts the SQL and runs
	// nothing. `planFor` is what the review sheet renders.
	const plan = await page.evaluate(async () => {
		const api = window.sqlApi as unknown as {
			state(): Promise<{ connections: { id: string; label: string }[] }>;
			securityPlan(id: string, changes: unknown[]): Promise<{ statements: { sql: string; description: string; destructive: boolean; carriesSecret: boolean }[] }>;
		};
		const id = (await api.state()).connections.find((c) => c.label === 'ch')!.id;
		return api.securityPlan(id, [
			{ kind: 'grant', principal: { name: 'sec_app' }, target: { scope: 'table', database: 'depth', object: 'plan_events' }, privileges: ['SELECT'] },
			{ kind: 'revoke', principal: { name: 'sec_app' }, target: { scope: 'database', database: 'depth' }, privileges: ['INSERT'] },
		]);
	});
	expect(plan.statements.map((s) => s.sql)).toEqual([
		'GRANT SELECT ON `depth`.`plan_events` TO `sec_app`',
		'REVOKE INSERT ON `depth`.* FROM `sec_app`',
	]);
	expect(plan.statements.map((s) => s.destructive)).toEqual([false, true]);

	// And the screen: Users & Privileges is offered on the connection and lists what was read.
	const conn = page.locator('.tree-row.depth-0', { hasText: /^ch/ }).first();
	const users = page.locator('.tree-row.depth-1', { hasText: /^Users & Privileges/ }).first();
	if (!(await users.isVisible())) {
		await conn.click();
	}
	await users.click();
	await expect(page.locator('.sec-row-name', { hasText: /^sec_app$/ })).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.sec-row-name', { hasText: /^sec_readers$/ })).toBeVisible();
	await page.locator('.sec-row', { hasText: 'sec_app' }).first().click();
	await expect(page.locator('.sec-grant-table')).toContainText('DENY');
	await page.screenshot({ path: 'test-results/clickhouse-security.png' });

	await admin('DROP USER IF EXISTS sec_app');
	await admin('DROP ROLE IF EXISTS sec_readers');
});

// Loading a FILE into a table: the statement in the URL, the file as the body. Three things this is
// here to prove and a unit test cannot: that the format ClickHouse is told matches what it is
// actually sent, that a NAMED format really is matched by name (the file's columns are in a
// different order from the table's on purpose), and that a compressed file crosses the wire
// compressed and is expanded by the SERVER, which is a request header we had only read about.
test('a file is loaded into a table as the statement body', async () => {
	const { page, app } = handle;
	const admin = async (sql: string): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		const body = await res.text();
		expect(res.ok, body).toBe(true);
		return body.trim();
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.loaded');
	await admin('CREATE TABLE depth.loaded (id UInt64, name String, amount Float64) ENGINE = MergeTree ORDER BY id');
	await page.evaluate(async () => {
		const id = (await window.sqlApi.state()).connections.find((c) => c.label === 'ch')!.id;
		await window.sqlApi.refresh(id);
	});

	// Deliberately NOT the table's column order: a header row is what makes that safe, and it is
	// the whole reason CSVWithNames is the default guess for a .csv rather than CSV.
	const dir = mkdtempSync(join(tmpdir(), 'snout-load-'));
	const csv = join(dir, 'events.csv');
	writeFileSync(csv, 'amount,id,name\n1.5,1,alpha\n2.5,2,beta\n3.5,3,gamma\n');
	await app.evaluate(({ dialog }, chosen) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
	}, csv);

	await openTable(page, 'loaded');
	await page.locator('.grid-load-file').click();
	const sheet = page.locator('.modal.load-file');
	await expect(sheet).toBeVisible();
	await expect(sheet.locator('.load-file-name')).toHaveText('events.csv');
	// The guess, the statement it makes, and the sentence about what cannot be undone.
	await expect(sheet.locator('select')).toHaveValue('CSVWithNames');
	await expect(sheet.locator('.sql-code')).toContainText('INSERT INTO `depth`.`loaded` FORMAT CSVWithNames');
	await expect(sheet.locator('.confirm-hazard-message', { hasText: 'not inside a transaction' })).toBeVisible();
	await page.screenshot({ path: 'test-results/clickhouse-load-file.png' });
	await sheet.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(sheet.locator('.confirm-detail')).toContainText('3 rows written', { timeout: 30_000 });
	await sheet.getByRole('button', { name: 'Done' }).click();
	await expect(sheet).toBeHidden();

	// Matched by NAME: the file's first column is `amount` and the table's is `id`.
	expect(await admin('SELECT id, name, amount FROM depth.loaded ORDER BY id FORMAT CSV')).toBe('1,"alpha",1.5\n2,"beta",2.5\n3,"gamma",3.5');
	// And it is on the user's own query history, because a load is the user's statement.
	const history = await page.evaluate(async () => (await window.sqlApi.history()).slice(0, 5).map((e) => e.sql));
	expect(history.some((sql) => sql.includes('FORMAT CSVWithNames') && sql.includes('events.csv'))).toBe(true);

	// The compressed path: the same rows again, gzipped, sent AS gzip. The server expands it, so
	// nothing here writes an expanded copy anywhere.
	const gz = join(dir, 'more.csv.gz');
	writeFileSync(gz, gzipSync(Buffer.from('amount,id,name\n4.5,4,delta\n5.5,5,epsilon\n')));
	await app.evaluate(({ dialog }, chosen) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
	}, gz);
	await page.locator('.grid-load-file').click();
	await expect(sheet.locator('.load-file-name')).toHaveText('more.csv.gz');
	await expect(sheet.locator('.limit-badge', { hasText: 'gzip' })).toBeVisible();
	await expect(sheet.locator('.confirm-hazard-message', { hasText: 'sent compressed' })).toBeVisible();
	await sheet.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(sheet.locator('.confirm-detail')).toContainText('2 rows written', { timeout: 30_000 });
	await sheet.getByRole('button', { name: 'Done' }).click();

	// And Parquet, which is the format this feature exists for. The server writes the file itself,
	// so the test needs no Parquet library and the bytes are certainly real.
	const parquet = join(dir, 'rows.parquet');
	const res = await fetch(`http://127.0.0.1:${PORT}/`, {
		method: 'POST',
		body: 'SELECT toUInt64(6) AS id, \'zeta\' AS name, toFloat64(6.5) AS amount FORMAT Parquet',
		headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` },
	});
	writeFileSync(parquet, Buffer.from(await res.arrayBuffer()));
	await app.evaluate(({ dialog }, chosen) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
	}, parquet);
	await page.locator('.grid-load-file').click();
	await expect(sheet.locator('select')).toHaveValue('Parquet');
	await sheet.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(sheet.locator('.confirm-detail')).toContainText('1 row written', { timeout: 30_000 });
	await sheet.getByRole('button', { name: 'Done' }).click();

	expect(await admin('SELECT count(), sum(amount) FROM depth.loaded FORMAT CSV')).toBe('6,24');
	rmSync(dir, { recursive: true, force: true });
});

// And back out: the SERVER writes the whole result to a file, in one of its own formats, with no
// row passing through the app. Proved by loading what it wrote straight back in, which is the
// only check that says the bytes are really a Parquet file and not a text file full of an error.
test('a result is written to a file by the server, and reads back in', async () => {
	const { page, app } = handle;
	const admin = async (sql: string): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		const body = await res.text();
		expect(res.ok, body).toBe(true);
		return body.trim();
	};
	await admin('DROP TABLE IF EXISTS depth.exported');
	await admin('CREATE TABLE depth.exported (id UInt64, name String, amount Float64) ENGINE = MergeTree ORDER BY id');

	const dir = mkdtempSync(join(tmpdir(), 'snout-export-'));
	const out = join(dir, 'out.parquet');
	await app.evaluate(({ dialog }, chosen) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen });
	}, out);

	// The statement is the one in the editor, and this one returns more rows than the grid would
	// have been given: an export is not limited to what was displayed. The test before this one
	// leaves a TABLE tab open, and a table page has no editor, so take a fresh one first.
	await page.keyboard.press(`${MOD}+n`);
	await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 10_000 });
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.type('SELECT number AS id, toString(number) AS name, number / 4 AS amount FROM numbers(5000)');
	await page.locator('.export-trigger').click();
	await page.locator('.export-item', { hasText: /^Parquet$/ }).click();
	await expect(page.locator('.status')).toContainText('out.parquet', { timeout: 30_000 });
	expect(statSync(out).size).toBeGreaterThan(1000);

	// The proof: ClickHouse reads its own file back, through the app's load path.
	await app.evaluate(({ dialog }, chosen) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
	}, out);
	await openTable(page, 'exported');
	await page.locator('.grid-load-file').click();
	const sheet = page.locator('.modal.load-file');
	await expect(sheet.locator('select')).toHaveValue('Parquet');
	await sheet.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(sheet.locator('.confirm-detail')).toContainText('5,000 rows written', { timeout: 30_000 });
	await sheet.getByRole('button', { name: 'Done' }).click();
	expect(await admin('SELECT count(), max(id) FROM depth.exported FORMAT CSV')).toBe('5000,4999');

	rmSync(dir, { recursive: true, force: true });
});

// Remote data: a table function as a form.
//
// `remote()` pointed at the container ITSELF is what this drives, because it needs nothing outside
// the machine and because it is the function with a PASSWORD in the middle of it, which is the part
// that matters: the statement runs with the real one and everything that shows or records it must
// carry `<redacted>` instead.
test('a table function is filled in as a form, described, previewed and turned into a table', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		const body = await res.text();
		expect(res.ok, body).toBe(true);
		return body.trim();
	};
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.remote_copy');

	// The tree row, which is the way anybody would find this. Expanding is the twisty, and the
	// connection is already open from the tests above, so ask before clicking.
	const conn = page.locator('.tree-row.depth-0', { hasText: /^ch/ }).first();
	const row = page.locator('.tree-row.depth-1', { hasText: /^Remote data/ }).first();
	if (!(await row.isVisible())) {
		await conn.click();
	}
	await row.click();

	const view = page.locator('.ch-remote');
	await expect(view).toBeVisible({ timeout: 20_000 });
	// Every function we know how to ask for is offered, and S3 is the first.
	await expect(view.locator('.ch-remote-nav .settings-nav-item').first()).toContainText('Files in S3');
	await view.locator('.ch-remote-nav .settings-nav-item', { hasText: 'Another ClickHouse server' }).click();

	// Nothing can run until the required arguments are there, and it says which are missing.
	await expect(view.locator('.ch-remote-actions button', { hasText: 'Describe' })).toBeDisabled();
	await view.getByLabel('Address').fill('127.0.0.1:9000');
	await view.getByLabel('Database', { exact: true }).fill('system');
	await view.getByLabel('Table', { exact: true }).fill('one');
	await view.getByLabel('User', { exact: true }).fill('default');
	await view.getByLabel('Password', { exact: true }).fill(PASSWORD);

	// The statement on screen never holds the password, from the moment it is typed. Visible, not
	// merely present: this is the whole assurance the screen gives, so a box with the right text
	// and no height would be worse than not showing it at all.
	await expect(view.locator('.sql-code')).toBeVisible();
	await expect(view.locator('.sql-code')).toContainText('<redacted>');
	expect(await view.locator('.sql-code').boundingBox().then((b) => b?.height ?? 0)).toBeGreaterThan(10);
	await expect(view.locator('.sql-code')).not.toContainText(PASSWORD);

	await view.locator('.ch-remote-actions button', { hasText: 'Describe' }).click();
	await expect(view.locator('.ch-remote-column-name')).toHaveText('dummy', { timeout: 30_000 });
	await expect(view.locator('.ch-remote-columns')).toContainText('UInt8');

	await view.locator('.ch-remote-actions button', { hasText: 'Preview' }).click();
	await expect(view.locator('.ch-remote-grid .cell.head-cell', { hasText: 'dummy' })).toBeVisible({ timeout: 30_000 });
	await page.screenshot({ path: 'test-results/clickhouse-remote.png' });

	// And the one click that was always the point: somebody else's data as a table of this
	// database's own.
	await view.getByLabel('Database for the new table').selectOption('depth');
	await view.getByLabel('New table name').fill('remote_copy');
	await view.locator('.ch-remote-create button', { hasText: 'Create table' }).click();
	const sheet = page.locator('.modal.confirm');
	await expect(sheet).toContainText('CREATE TABLE');
	await expect(sheet.locator('.sql-code')).toContainText('<redacted>');
	await sheet.getByRole('button', { name: 'Create table' }).click();
	await expect(sheet).toBeHidden({ timeout: 30_000 });
	// The dialog closing is the statement STARTING. What says it finished is the thing the view
	// does next: it opens an editor on the table that now exists.
	await expect(page.locator('.monaco-editor').first()).toContainText('depth.remote_copy', { timeout: 30_000 });
	expect(await admin('SELECT count(), any(dummy) FROM depth.remote_copy FORMAT CSV')).toBe('1,0');
	// MergeTree, sorted by the first column the DESCRIBE reported. ClickHouse reads `ORDER BY (a)`
	// back as `(a)`, parentheses and all, which is the same key.
	expect(await admin("SELECT engine, sorting_key FROM system.tables WHERE database = 'depth' AND name = 'remote_copy' FORMAT CSV")).toBe('"MergeTree","(dummy)"');

	// The whole reason the statement is built in main: what is on the user's own query history is
	// the redacted twin, and the password is nowhere in it.
	const history = await page.evaluate(async () => (await window.sqlApi.history()).slice(0, 10).map((e) => e.sql));
	const recorded = history.filter((sql) => sql.includes('remote('));
	expect(recorded.length).toBeGreaterThan(0);
	expect(recorded.some((sql) => sql.includes('<redacted>'))).toBe(true);
	for (const sql of recorded) {
		expect(sql).not.toContain(`'${PASSWORD}'`);
	}
});

// Row policies, quotas and settings profiles: the half of RBAC that is neither a principal nor a
// grant.
//
// Driven against a real server because the three system tables are the whole feature: what a
// policy DOES is a sentence composed in SQL out of fifteen mostly-null columns, and the only way
// to find out whether that sentence is right is to read one back. The write half goes through the
// SCREEN rather than through `securityApply`, because the thing worth proving is that a person can
// build a row policy without writing SQL and still reads the statement before it runs.
test('row policies, quotas and settings profiles are read, made on the screen, and dropped', async () => {
	const { page } = handle;
	const admin = async (sql: string): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: sql, headers: { Authorization: `Basic ${Buffer.from(`default:${PASSWORD}`).toString('base64')}` } });
		const body = await res.text();
		expect(res.ok, body).toBe(true);
		return body.trim();
	};
	await admin('DROP ROW POLICY IF EXISTS pol_seen ON depth.pol_rows');
	await admin('DROP ROW POLICY IF EXISTS pol_made ON depth.pol_rows');
	await admin('DROP QUOTA IF EXISTS pol_quota');
	await admin('DROP SETTINGS PROFILE IF EXISTS pol_profile');
	await admin('DROP USER IF EXISTS pol_app');
	await admin('DROP ROLE IF EXISTS pol_readers');
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.pol_rows');
	await admin('CREATE TABLE depth.pol_rows (tenant String, n UInt32) ENGINE = MergeTree ORDER BY tenant');
	await admin("INSERT INTO depth.pol_rows VALUES ('a', 1), ('b', 2)");
	await admin('CREATE ROLE pol_readers');
	await admin('CREATE USER pol_app');
	await admin('GRANT pol_readers TO pol_app');
	// Applied to the ROLE, not to the user: what an account can see is decided by the roles it
	// holds, and a read that only matched names would report this policy as acting on nobody.
	await admin("CREATE ROW POLICY pol_seen ON depth.pol_rows USING tenant = 'a' TO pol_readers");
	await admin('CREATE QUOTA pol_quota KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 100, read_rows = 5000 TO pol_app');
	await admin('CREATE SETTINGS PROFILE pol_profile SETTINGS max_memory_usage = 1000000000 TO pol_app');

	const snapshot = await page.evaluate(async () => {
		const api = window.sqlApi as unknown as {
			state(): Promise<{ connections: { id: string; label: string }[] }>;
			securitySupport(id: string): Promise<{ policyKinds: string[] }>;
			securityRead(id: string): Promise<{ policies: unknown[]; warnings: string[] }>;
		};
		const id = (await api.state()).connections.find((c) => c.label === 'ch')!.id;
		return { support: await api.securitySupport(id), read: await api.securityRead(id) };
	});
	expect(snapshot.support.policyKinds).toEqual(['row-policy', 'quota', 'settings-profile']);
	expect(snapshot.read.warnings).toEqual([]);

	type Pol = { kind: string; name: string; database?: string; object?: string; appliesTo: string[]; appliesToAll: boolean; exceptFor: string[]; detail?: string; restrictive?: boolean; attributes?: Record<string, string> };
	const policies = snapshot.read.policies as Pol[];

	const rowPolicy = policies.find((policy) => policy.name === 'pol_seen')!;
	expect(rowPolicy.kind).toBe('row-policy');
	expect(rowPolicy.database).toBe('depth');
	expect(rowPolicy.object).toBe('pol_rows');
	expect(rowPolicy.detail).toBe("tenant = 'a'");
	expect(rowPolicy.restrictive).toBe(false);
	expect(rowPolicy.appliesTo).toEqual(['pol_readers']);

	// The sentence composed out of `system.quota_limits`, which is the part no unit test can check.
	const quota = policies.find((policy) => policy.name === 'pol_quota')!;
	expect(quota.detail).toContain('every 1 hour');
	expect(quota.detail).toContain('queries 100');
	expect(quota.detail).toContain('read_rows 5000');
	expect(quota.attributes?.['Counted per']).toBe('user_name');
	// The server's own `default` quota has an interval and no caps at all, which is ClickHouse's
	// TRACKING ONLY. It must not read as a limit of zero, and it must not read as blank.
	expect(policies.find((policy) => policy.kind === 'quota' && policy.name === 'default')?.detail).toMatch(/tracking only|queries/);

	const profile = policies.find((policy) => policy.name === 'pol_profile')!;
	expect(profile.detail).toBe('max_memory_usage = 1000000000');
	// Shipped with the server and defined in its config file, so it says it cannot be changed here.
	expect(policies.find((policy) => policy.kind === 'settings-profile' && policy.name === 'readonly')?.attributes?.['Defined in']).toMatch(/users\.xml/);

	// The SCREEN. Users & Privileges lists the policies beside the users, and the account they act
	// on says so on its own pane, which is the question a grant list cannot answer.
	const conn = page.locator('.tree-row.depth-0', { hasText: /^ch/ }).first();
	const users = page.locator('.tree-row.depth-1', { hasText: /^Users & Privileges/ }).first();
	if (!(await users.isVisible())) {
		await conn.click();
	}
	await users.click();
	await expect(page.locator('.sec-group-title', { hasText: 'Row policies' })).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.sec-group-title', { hasText: 'Quotas' })).toBeVisible();
	await expect(page.locator('.sec-group-title', { hasText: 'Settings profiles' })).toBeVisible();

	await page.locator('.sec-row', { hasText: 'pol_app' }).first().click();
	const applies = page.locator('.sec-card', { hasText: 'What else applies to this account' });
	await expect(applies).toContainText('pol_seen');
	await expect(applies).toContainText("tenant = 'a'");
	await expect(applies).toContainText('pol_quota');

	// Make one, without writing SQL. The filter is the only field that IS SQL.
	await page.getByRole('button', { name: 'New policy' }).click();
	const dialog = page.locator('.modal.sec-modal');
	await dialog.getByLabel('Kind').selectOption('row-policy');
	await dialog.getByLabel('Name', { exact: true }).fill('pol_made');
	await dialog.getByLabel('Database', { exact: true }).fill('depth');
	await dialog.getByLabel('Table', { exact: true }).fill('pol_rows');
	await dialog.getByLabel('Rows it allows').fill("tenant = 'b'");
	await dialog.locator('.sec-check', { hasText: 'pol_app' }).locator('input').check();
	await dialog.getByRole('button', { name: 'Review statement' }).click();

	// A CREATE that takes access away: everyone it applies to now sees only the rows it allows, so
	// it is marked like a revoke and the button says so.
	const sheet = page.locator('.modal.sec-review');
	await expect(sheet.locator('.sec-plan-sql')).toHaveText("CREATE ROW POLICY `pol_made` ON `depth`.`pol_rows` USING tenant = 'b' TO `pol_app`");
	await expect(sheet.locator('.sec-warn-banner')).toBeVisible();
	await sheet.getByRole('button', { name: 'Run anyway' }).click();
	await expect(sheet).toBeHidden({ timeout: 20_000 });

	// JSON rather than TSV: ClickHouse's tab-separated escaping backslash-escapes the quotes in
	// the filter, and comparing against the escaped form would assert the escaping, not the policy.
	expect(await admin("SELECT arrayStringConcat(apply_to_list, ','), select_filter FROM system.row_policies WHERE short_name = 'pol_made' FORMAT JSONCompactEachRow")).toBe(`["pol_app", "tenant = 'b'"]`);
	await expect(page.locator('.sec-row-name', { hasText: /^pol_made$/ })).toBeVisible({ timeout: 20_000 });

	// And the policy's own pane: who it applies to is editable there because the statement that
	// changes it replaces the whole list, so the screen holding the list is the one that sends it.
	await page.locator('.sec-row', { hasText: 'pol_made' }).first().click();
	await expect(page.locator('.sec-detail')).toContainText("tenant = 'b'");
	await page.screenshot({ path: 'test-results/clickhouse-policies.png' });
	await page.locator('.sec-detail .sec-chip', { hasText: 'pol_app' }).locator('button').click();
	await expect(sheet.locator('.sec-plan-sql')).toHaveText('ALTER ROW POLICY `pol_made` ON `depth`.`pol_rows` TO NONE');
	await sheet.getByRole('button', { name: /^Run/ }).click();
	await expect(sheet).toBeHidden({ timeout: 20_000 });
	expect(await admin("SELECT length(apply_to_list) FROM system.row_policies WHERE short_name = 'pol_made' FORMAT TSV")).toBe('0');

	// Drop it from the screen.
	await page.locator('.sec-row', { hasText: 'pol_made' }).first().click();
	await page.locator('.sec-detail').getByRole('button', { name: 'Drop' }).click();
	await expect(sheet.locator('.sec-plan-sql')).toHaveText('DROP ROW POLICY `pol_made` ON `depth`.`pol_rows`');
	await sheet.getByRole('button', { name: 'Run anyway' }).click();
	await expect(sheet).toBeHidden({ timeout: 20_000 });
	expect(await admin("SELECT count() FROM system.row_policies WHERE short_name = 'pol_made' FORMAT TSV")).toBe('0');

	await admin('DROP ROW POLICY IF EXISTS pol_seen ON depth.pol_rows');
	await admin('DROP QUOTA IF EXISTS pol_quota');
	await admin('DROP SETTINGS PROFILE IF EXISTS pol_profile');
	await admin('DROP USER IF EXISTS pol_app');
	await admin('DROP ROLE IF EXISTS pol_readers');
	await admin('DROP TABLE IF EXISTS depth.pol_rows');
});

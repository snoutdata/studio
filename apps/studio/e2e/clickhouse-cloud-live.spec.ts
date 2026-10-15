/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

// ClickHouse CLOUD, which is a different thing from a ClickHouse server and had never been tested.
//
// Everything here is something a single container cannot prove. Cloud load-balances each HTTP
// request to either of two replicas, its system tables are per node, its `default` user holds no
// grant of its own, and `ENGINE = MergeTree` is stored as `SharedMergeTree`. The local
// `clickhouse-live` spec covers the rest and is not repeated.
//
// Credentials stay out of the repository, in an env file of your own (the four
// SNOUTDATA_TEST_CLICKHOUSE_CLOUD_* variables below):
//   set -a; . "$SNOUTDATA_TEST_CLICKHOUSE_CLOUD_ENV"; set +a
//   npx playwright test clickhouse-cloud-live --project=app
// Skips cleanly without them.

const HOST = process.env.SNOUTDATA_TEST_CLICKHOUSE_CLOUD_HOST;
const PORT = Number(process.env.SNOUTDATA_TEST_CLICKHOUSE_CLOUD_PORT ?? 8443);
const USER = process.env.SNOUTDATA_TEST_CLICKHOUSE_CLOUD_USER ?? 'default';
const PASSWORD = process.env.SNOUTDATA_TEST_CLICKHOUSE_CLOUD_PASSWORD ?? '';

test.skip(!HOST, 'set SNOUTDATA_TEST_CLICKHOUSE_CLOUD_HOST to run against a real ClickHouse Cloud service');

// A round trip to a hosted service in another region is not a round trip to localhost.
test.setTimeout(120_000);

let handle: AppHandle;

/** Run a statement on the service directly, for fixtures and for checking what the server stored. */
async function admin(sql: string): Promise<string> {
	const res = await fetch(`https://${HOST}:${PORT}/`, {
		method: 'POST',
		body: sql,
		headers: { Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}` },
	});
	const text = await res.text();
	expect(res.ok, text).toBe(true);
	return text.trim();
}

test.beforeAll(async () => {
	handle = await launchApp('clickhouse-cloud-live');
	await handle.page.evaluate(async (input) => {
		const api = (window as unknown as { sqlApi: { saveConnection(form: unknown): Promise<{ id: string }>; connect(id: string): Promise<{ error?: string }> } }).sqlApi;
		const saved = await api.saveConnection({
			label: 'ch cloud', driver: 'clickhouse', host: input.host, port: input.port,
			database: 'default', username: input.user, password: input.password, ssl: true, readOnly: false,
		});
		const result = await api.connect(saved.id);
		if (result.error) {
			throw new Error(`connect failed: ${result.error}`);
		}
	}, { host: HOST!, port: PORT, user: USER, password: PASSWORD });
});

test.afterAll(async () => {
	await closeApp(handle);
});

/**
 * Make sure `child` (a row under the connection) is on screen.
 *
 * Two things this gets right that cost a run each. Expanding a connection is the TWISTY, not the
 * row: clicking the row only selects it, so "click the connection and look for its databases"
 * waits forever. And the twisty TOGGLES, so it is only clicked when the child is not already
 * there, or it closes what an earlier test opened.
 */
async function reveal(child: ReturnType<AppHandle['page']['locator']>): Promise<void> {
	if (!(await child.isVisible())) {
		await handle.page.locator('.tree-row.depth-0', { hasText: /^ch cloud/ }).first().locator('.twisty').click();
	}
	await expect(child).toBeVisible({ timeout: 60_000 });
}

/** The `ch cloud` connection's id, for the API-level assertions. */
async function connectionId(): Promise<string> {
	return handle.page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: { state(): Promise<{ connections: { id: string; label: string }[] }> } }).sqlApi;
		return (await api.state()).connections.find((c) => c.label === 'ch cloud')!.id;
	});
}

test('connects over TLS on 8443 and runs a query', async () => {
	const { page } = handle;
	const version = await admin('SELECT version()');
	expect(version).toMatch(/^\d+\./);

	const rows = await page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: { state(): Promise<{ connections: { id: string; label: string }[] }>; execute(input: unknown): Promise<{ ok: boolean; error?: string; result?: { rows: unknown[][] } }> } }).sqlApi;
		const id = (await api.state()).connections.find((c) => c.label === 'ch cloud')!.id;
		return api.execute({ connectionId: id, sql: 'SELECT 1 AS one' });
	});
	expect(rows.ok, rows.error).toBe(true);
	expect(rows.result?.rows[0][0]).toBe(1);
});

// The oldest untested claim about ClickHouse Cloud: every node-local system table is read
// with clusterAllReplicas because Cloud answers each request from whichever replica it likes, so
// without it a view shows one replica and a different one each refresh.
test('reads every replica, because Cloud answers from whichever it likes', async () => {
	const { page } = handle;
	const replicas = Number(await admin("SELECT count() FROM system.clusters WHERE cluster = 'default'"));
	expect(replicas).toBeGreaterThan(1);

	const operations = page.locator('.tree-row.depth-1', { hasText: /^Operations/ }).first();
	await reveal(operations);
	await operations.click();
	await expect(page.locator('.ch-ops .tv-title')).toHaveText('ClickHouse Operations');

	// The header states the scope it resolved. "1 of N" would mean the READ ON REMOTE grant is
	// missing, which is a real answer but not the one this service should give.
	await expect(page.locator('.ch-ops-scope')).toContainText(`All ${replicas} replicas`, { timeout: 60_000 });

	// And the rows carry which node each came from, so two different hostnames are visible.
	const hosts = await page.evaluate(async (id) => {
		const api = (window as unknown as { sqlApi: { explain(input: unknown): Promise<{ ok: boolean; error?: string; result?: { rows: unknown[][] } }> } }).sqlApi;
		const res = await api.explain({ connectionId: id, sql: "SELECT hostName() AS replica FROM clusterAllReplicas('default', system.one)" });
		return res.ok ? (res.result?.rows ?? []).map((r) => String(r[0])) : [];
	}, await connectionId());
	expect(new Set(hosts).size).toBe(replicas);
	await page.screenshot({ path: 'test-results/clickhouse-cloud-operations.png' });
});

// The defect this service found. Cloud's `default` holds NO grant of its own: `default_role` holds
// them and `default` is a member of it, so a read that only looks at direct grants reports the
// administrator of the service as an ordinary account.
test('finds the administrator through the role that actually holds the grant', async () => {
	const direct = await admin("SELECT count() FROM system.grants WHERE user_name = 'default'");
	expect(direct, 'Cloud grants its default user nothing directly; if that changed, so has this test').toBe('0');
	expect(await admin("SELECT count() FROM system.grants WHERE role_name = 'default_role' AND toString(access_type) = 'CREATE USER'")).toBe('1');

	const snapshot = await handle.page.evaluate(async (id) => {
		const api = (window as unknown as { sqlApi: { securityRead(id: string): Promise<{ principals: unknown[]; warnings: string[] }> } }).sqlApi;
		return api.securityRead(id);
	}, await connectionId());
	type P = { name: string; kind: string; isSuperuser: boolean; superuserVia?: string; memberOf: string[]; attributes?: Record<string, string> };
	const principals = snapshot.principals as P[];

	const role = principals.find((p) => p.name === 'default_role')!;
	expect(role.kind).toBe('role');
	expect(role.isSuperuser, 'the ROLE holds it directly').toBe(true);

	const def = principals.find((p) => p.name === 'default')!;
	expect(def.memberOf).toContain('default_role');
	expect(def.isSuperuser, 'and the user has it through the role').toBe(true);
	expect(def.superuserVia).toBe('default_role');

	// Cloud stores its accounts in a replicated store, not local_directory and not users.xml.
	expect(def.attributes?.['Defined in']).toBe('replicated');
	// The service's own internal accounts ARE accounts and are shown rather than hidden; they come
	// from users.xml, which the detail pane says cannot be changed with SQL.
	const internal = principals.find((p) => p.attributes?.['Defined in']?.includes('users.xml'));
	expect(internal, 'Cloud runs internal service accounts from users.xml').toBeTruthy();
});

// Cloud rewrites the engine under you: `ENGINE = MergeTree` is stored as SharedMergeTree, with a
// Keeper path. Anything that tests the engine by name rather than by shape breaks here.
test('a table created as MergeTree comes back as SharedMergeTree, and still has a Storage tab', async () => {
	const { page } = handle;
	await admin('CREATE DATABASE IF NOT EXISTS depth');
	await admin('DROP TABLE IF EXISTS depth.cloud_visits');
	await admin('CREATE TABLE depth.cloud_visits (user UInt64, ts DateTime CODEC(Delta, ZSTD(3)), v Float64) ENGINE = MergeTree PRIMARY KEY user ORDER BY (user, ts)');
	await admin('INSERT INTO depth.cloud_visits SELECT number % 100, toDateTime(1700000000 + number), number / 7 FROM numbers(50000)');
	expect(await admin("SELECT engine FROM system.tables WHERE database = 'depth' AND name = 'cloud_visits'")).toBe('SharedMergeTree');

	const table = await page.evaluate(async (id) => {
		const api = (window as unknown as { sqlApi: { refresh(id: string): Promise<unknown>; getSchema(id: string): Promise<{ tables: unknown[] } | null> } }).sqlApi;
		await api.refresh(id);
		const schema = await api.getSchema(id);
		return (schema?.tables as { schema?: string; name: string; kind: string; stats?: { engine?: string; rowCount?: number }; columns: { name: string; sortKey?: string; codec?: string }[] }[])
			.find((t) => t.schema === 'depth' && t.name === 'cloud_visits');
	}, await connectionId());

	expect(table?.kind).toBe('table');
	// The engine line is the server's word, not ours, and the keys survive the rewrite.
	expect(table?.stats?.engine).toMatch(/^SharedMergeTree PRIMARY KEY \(user\) ORDER BY \(user, ts\)/);
	expect(table?.columns.map((c) => c.sortKey ?? null)).toEqual(['primary', 'sort', null]);
	expect(table?.columns[1].codec).toBe('CODEC(Delta(4), ZSTD(3))');

	// The Storage tab is offered by SHAPE (`/MergeTree$/`), which is what makes it right here.
	const database = page.locator('.tree-row.depth-1', { hasText: /^depth/ }).first();
	await reveal(database);
	const row = page.locator('.tree-row.depth-2', { hasText: /^cloud_visits/ }).first();
	if (!(await row.isVisible())) {
		await database.click();
	}
	await expect(row).toBeVisible({ timeout: 60_000 });
	await row.dblclick();
	await page.getByRole('button', { name: 'Storage' }).click();
	await expect(page.locator('.table-view')).toContainText('SharedMergeTree', { timeout: 60_000 });
	await page.screenshot({ path: 'test-results/clickhouse-cloud-storage.png' });

	await admin('DROP TABLE IF EXISTS depth.cloud_visits');
});

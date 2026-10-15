/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test, type Page } from '@playwright/test';
import { closeApp, dbEnv, fillSsl, launchApp, MOD, type AppHandle } from './helpers';

/*
 * Orbit's Pulse 3b against a REAL database.
 *
 * `orbit.spec.ts` proves the tab, the WebGL context and that Pulse stays OFF until asked. It cannot
 * prove the part that was written from vendor documentation and never run: that the activity query
 * parses on the engine, that its aliases come back under the fixed column contract, that the
 * sampler never shows itself, and that a statement running in SOMEBODY ELSE'S session reaches the
 * feed. Only a live server can answer those, so this spec starts a slow statement on a second
 * connection of its own and waits for Orbit to draw it.
 *
 * READ-ONLY. It creates a connection in the app and runs one sleeping SELECT and one COUNT(*)
 * against a table that is already there. It writes nothing and changes no server setting.
 *
 * OPT-IN, on the same SNOUTDATA_TEST_* env as the other live-DB specs:
 *
 *     SNOUTDATA_TEST_DRIVER=postgres SNOUTDATA_TEST_HOST=127.0.0.1 SNOUTDATA_TEST_PORT=5432 \
 *     SNOUTDATA_TEST_NAME=orbitdb SNOUTDATA_TEST_USER=orbit SNOUTDATA_TEST_PASSWORD=orbitpw \
 *     npx playwright test orbit-live
 *
 * Two things the database has to give this login, or the assertions cannot hold and the failure is
 * the server's answer rather than a bug:
 *
 *   - AT LEAST ONE TABLE. Orbit lights the objects a statement names, so the feed only moves for a
 *     statement that names something the schema has. The spec picks a table off the live schema
 *     rather than assuming one.
 *   - PERMISSION TO SEE OTHER SESSIONS. On Postgres that is `pg_read_all_stats` or a superuser: a
 *     role without it gets a row per session with `query` set to '<insufficient privilege>', which
 *     Pulse counts and reports rather than drawing. On MySQL and MariaDB it is the PROCESS
 *     privilege. Both were measured on 2026-09-06.
 */

const db = dbEnv();

/** The engines whose activity view Pulse can read AND this spec knows how to dial a second
 *  connection to. The other three supported engines (SQL Server, Oracle, Redshift) are refused
 *  here rather than half-tested, because a spec that skips silently on them would read as coverage. */
const DIALABLE = new Set(['postgres', 'mysql-aurora', 'mariadb']);

/** What the driver picker CALLS each of them. It is a listbox of display names, so the driver id
 *  alone cannot pick a row. Kept beside DIALABLE so the two can only go out of step together. */
const DRIVER_LABELS: Record<string, string> = {
	postgres: 'PostgreSQL',
	'mysql-aurora': 'MySQL / Aurora MySQL',
	mariadb: 'MariaDB',
};

test.skip(!db, 'set SNOUTDATA_TEST_HOST / SNOUTDATA_TEST_NAME / SNOUTDATA_TEST_USER to run the live-DB specs');
test.skip(!!db && !DIALABLE.has(db.driver), `orbit-live drives ${[...DIALABLE].join(', ')}; ${db?.driver} is not one of them`);

let handle: AppHandle;

/** One live connection of the spec's OWN, kept apart from the app's, so the statement Pulse must
 *  see is genuinely somebody else's session and not the app's own pool. */
interface Sidecar {
	/** A schema-qualified table this database really has, for the statement to name. */
	pickTable(): Promise<string>;
	/** Start a statement that runs for `seconds` and names `table`, WITHOUT waiting for it. */
	startSlow(table: string, seconds: number): Promise<void>;
	close(): Promise<void>;
}

async function openSidecar(): Promise<Sidecar> {
	const cfg = db!;
	if (cfg.driver === 'postgres') {
		const { default: pg } = await import('pg');
		const client = new pg.Client({
			host: cfg.host, port: cfg.port ? Number(cfg.port) : 5432,
			database: cfg.database, user: cfg.username, password: cfg.password,
			// A SnoutData Cloud project (SNOUTDATA_TEST_SSL=1) refuses plaintext; the system trust
			// store verifies its certificate, as the app's own connection does.
			...(cfg.ssl ? { ssl: true } : {}),
		});
		await client.connect();
		let running: Promise<unknown> = Promise.resolve();
		return {
			async pickTable() {
				const res = await client.query(
					"SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name LIMIT 1",
				);
				const row = res.rows[0] as { table_schema: string; table_name: string } | undefined;
				if (!row) {
					throw new Error('the test database has no table for Orbit to light');
				}
				return `"${row.table_schema}"."${row.table_name}"`;
			},
			async startSlow(table, seconds) {
				// Named in a subquery so the statement TEXT carries the table (which is what Orbit
				// matches on) while pg_sleep runs once rather than once per row.
				running = client.query(`SELECT pg_sleep(${seconds}), (SELECT count(*) FROM ${table}) AS n`).catch(() => undefined);
			},
			async close() {
				await running;
				await client.end().catch(() => undefined);
			},
		};
	}
	const mysql = await import('mysql2/promise');
	const conn = await mysql.createConnection({
		host: cfg.host, port: cfg.port ? Number(cfg.port) : 3306,
		database: cfg.database, user: cfg.username, password: cfg.password,
	});
	let running: Promise<unknown> = Promise.resolve();
	return {
		async pickTable() {
			const [rows] = await conn.query(
				"SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME LIMIT 1",
			);
			const row = (rows as Array<{ TABLE_SCHEMA: string; TABLE_NAME: string }>)[0];
			if (!row) {
				throw new Error('the test database has no table for Orbit to light');
			}
			return `\`${row.TABLE_SCHEMA}\`.\`${row.TABLE_NAME}\``;
		},
		async startSlow(table, seconds) {
			running = conn.query(`SELECT SLEEP(${seconds}), (SELECT COUNT(*) FROM ${table}) AS n`).catch(() => undefined);
		},
		async close() {
			await running;
			await conn.end().catch(() => undefined);
		},
	};
}

/** Create the connection through the real form and connect it, exactly as `db.spec.ts` does. */
async function connectInApp(page: Page): Promise<void> {
	const cfg = db!;
	await page.locator('[data-tour="add-connection"]').click();
	await page.getByLabel('Label', { exact: true }).fill('orbit-live');
	// The driver picker is an IconSelect, not a native <select>: a combobox button that opens a
	// listbox of rows carrying a glyph each. So it is clicked, not selectOption'd, and the row is
	// found by the dialect's own display name.
	await page.locator('.icon-select-button[aria-label="Driver"]').click();
	await page.locator('[role="option"]', { hasText: DRIVER_LABELS[cfg.driver] }).first().click();
	await expect(page.locator('.icon-select-button[aria-label="Driver"] .icon-select-value')).toHaveText(DRIVER_LABELS[cfg.driver]);
	await page.getByLabel('Host', { exact: true }).fill(cfg.host);
	if (cfg.port) {
		await page.getByLabel('Port', { exact: true }).fill(cfg.port);
	}
	await page.getByLabel('Database', { exact: true }).fill(cfg.database);
	await page.getByLabel('Username', { exact: true }).fill(cfg.username);
	if (cfg.password) {
		await page.getByLabel('Password', { exact: true }).fill(cfg.password);
	}
	await fillSsl(page, cfg);
	await page.getByRole('button', { name: 'Save', exact: true }).click();

	const row = page.locator('.tree-row.depth-0', { hasText: 'orbit-live' });
	await expect(row).toBeVisible();
	await row.click();
	// Saving a connection also connects it, so the Connect button is usually already gone by now.
	// Clicking it when it is not there would be a 30s timeout for no reason, so it is offered rather
	// than required, and the dot is what the wait is actually on.
	await row.hover();
	const connect = row.locator('button[aria-label="Connect"]');
	if (await connect.count() > 0) {
		await connect.click();
	}
	await expect(row.locator('.dot.on')).toBeVisible({ timeout: 30_000 });
}

async function openOrbit(page: Page): Promise<void> {
	if (await page.locator('.orbit-view').isVisible()) {
		return;
	}
	await page.keyboard.press(`${MOD}+Shift+P`);
	await expect(page.locator('.palette')).toBeVisible();
	await page.keyboard.type('Orbit');
	await page.keyboard.press('Enter');
	await expect(page.locator('.orbit-view')).toBeVisible();
}

let sidecar: Sidecar;
/** Everything the renderer shouted while Pulse was live. Collected from the moment the window
 *  exists, because a bad row shape throws inside an animation frame where no assertion would see it. */
const shouted: string[] = [];

test.beforeAll(async () => {
	// Launching Electron, filling the form, introspecting a real schema and warming a 3D layout does
	// not fit the 60s a test gets, and this is setup rather than the thing under test.
	test.setTimeout(180_000);
	handle = await launchApp('orbit-live');
	handle.page.on('pageerror', (err) => shouted.push(`pageerror: ${err.message}`));
	handle.page.on('console', (message) => {
		if (message.type() === 'error') {
			shouted.push(`console: ${message.text()}`);
		}
	});
	sidecar = await openSidecar();
	await connectInApp(handle.page);
	await openOrbit(handle.page);
	// A tab carries its own connection, and a freshly opened Orbit tab carries none: clicking the
	// connection in the sidebar binds it to whatever tab has focus, which is how a user gives Orbit
	// a database and is why this click is not redundant with the one in connectInApp. Opening Orbit
	// also swapped the left dock to Orbit's own rail, so the Connections view has to be
	// brought back to reach the row, and the rail has to be brought back afterwards to reach Pulse.
	await handle.page.locator('.activity-item[aria-label="Connections"]').click();
	await handle.page.locator('.tree-row.depth-0', { hasText: 'orbit-live' }).click();
	await handle.page.locator('.activity-item[aria-label="Orbit: this database in 3D"]').click();
	await expect(handle.page.locator('.orbit-rail-host .orbit-rail')).toBeVisible();
	// Orbit needs the introspected schema before it has a world; the counts panel is the first
	// thing that only exists once it does.
	await expect(handle.page.locator('.orbit-counts')).toBeVisible({ timeout: 60_000 });
});

test.afterAll(async () => {
	await sidecar?.close();
	await closeApp(handle);
});

test('Pulse offers itself on this engine and names the view it would read', async () => {
	const { page } = handle;
	const toggle = page.locator('.orbit-toggle', { hasText: 'Live database activity' });
	// Enabled, because this driver HAS an activity view, and still off, because 3b is a query
	// against a database the user may pay for by the read.
	await expect(toggle).toBeEnabled();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('.orbit-note')).toContainText('what this app ran');

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');

	// The note now names the view, verbatim, because a feature that queries someone's database says
	// what it queries. It is also the assertion that catches a query the engine REFUSED: a syntax or
	// permission error replaces this sentence with the database's own words, and neither pattern
	// below can match those.
	//
	// Two sentences are legitimate, and the second is not a loophole. On MySQL, Pulse asks first
	// whether performance_schema is really recording and drops to the processlist when it is not,
	// SAYING so; driven against a `--performance-schema=OFF` MySQL 8 on 2026-09-06, which is the
	// server that proved a strict single-sentence assertion here passes while the feature has
	// silently changed view underneath it.
	//
	// Hence the dwell rather than a retrying matcher. The FIRST note is optimistic: it names the
	// primary view before a single poll has happened, so a matcher that passes on first sight passes
	// on a feature that is about to change view underneath it. Two and a half sampler intervals is
	// enough for the precondition and the first poll to have had their say.
	await page.waitForTimeout(5_000);
	await expect(page.locator('.orbit-note')).toHaveText(settledNote(), { timeout: 1_000 });
});

/** The sentences that mean "Pulse settled on a view of this engine's, and said which". */
function settledNote(): RegExp {
	const primary = db!.driver === 'postgres' ? 'pg_stat_activity'
		: db!.driver === 'mariadb' ? 'information_schema.processlist'
			: 'performance_schema.events_statements_current';
	const reading = `Reading ${escapeRe(primary)} on this database\\.`;
	if (db!.driver !== 'mysql-aurora') {
		// Nothing else has a fallback, so nothing else has a second acceptable answer.
		return new RegExp(`^${reading}$`);
	}
	return new RegExp(`^(${reading}|This server is not recording statements in performance_schema, so Pulse is reading information_schema\\.processlist instead\\. Durations there are whole seconds\\.)$`);
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test("a statement running in another session reaches the feed, and the sampler's own never does", async () => {
	const { page } = handle;
	const table = await sidecar.pickTable();
	// Long enough that a 2s sampler cannot miss it, short enough that the spec's 60s budget holds.
	await sidecar.startSlow(table, 8);

	const feed = page.locator('.orbit-feed');
	// `live` is the class the renderer puts on an entry that came from the DATABASE rather than
	// from this app's own run loop, which is the whole distinction Pulse 3b exists to make.
	await expect(feed.locator('li.live').first()).toBeVisible({ timeout: 30_000 });
	await expect(feed.locator('.orbit-eyebrow')).toHaveText('Pulse / this database');

	// The bare table name, however the server quoted it back.
	const bare = table.replace(/["`]/g, '').split('.').pop()!;
	await expect(feed.locator('li.live').first()).toContainText(bare);

	// Self-exclusion, seen from the far end: the sampler polls every couple of seconds, so if its
	// own statement were visible to itself the feed would be full of the activity view's own name.
	// This is the UI-level half of the guards orbitPulse.ts describes, which were checked against live databases.
	const texts = await feed.locator('li').allInnerTexts();
	for (const text of texts) {
		expect(text).not.toContain('snout_orbit_pulse');
		expect(text.toLowerCase()).not.toContain('pg_stat_activity');
		expect(text.toLowerCase()).not.toContain('events_statements_current');
	}

	await page.screenshot({ path: 'e2e/.artifacts/orbit-live-pulse.png' });
});

test('turning Pulse off stops it, and the feed goes back to this session', async () => {
	const { page } = handle;
	const toggle = page.locator('.orbit-toggle', { hasText: 'Live database activity' });
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	// The note goes back to the off sentence, which is also the app admitting what 3a alone shows.
	await expect(page.locator('.orbit-note')).toContainText('what this app ran');
	await expect(page.locator('.orbit-feed .orbit-eyebrow')).toHaveText('Pulse / this session');
});

test('a live Pulse session threw nothing at the renderer', () => {
	// Last, on purpose: by now Pulse has polled a real database, drawn packets from real rows and
	// been switched off again. Anything that threw in an animation frame lands here and nowhere else.
	expect(shouted).toEqual([]);
});

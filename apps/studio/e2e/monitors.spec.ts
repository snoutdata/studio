/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

/*
 * A monitor's widgets are queries the app runs by itself: every interval, in the background, after
 * a restart, with nobody looking and never past the production confirmation. So they only ever
 * READ. A widget saved with a write, by an older build or anyone else, is PAUSED with the reason
 * and kept; it is never run, by the poller or by the open view, and never deleted.
 */

interface MonitorApi {
	monitors: {
		list(): Promise<{ id: string; name: string; widgets: { id: string; sql: string; paused?: string }[] }[]>;
		save(monitor: unknown): Promise<void>;
		samples(widgetId: string): Promise<unknown[]>;
		status(widgetId: string): Promise<string | null>;
		runWidget(connectionId: string, sql: string): Promise<{ ok: boolean; error?: string }>;
	};
}

let handle: AppHandle;
let dbFile: string;

function rows(): Array<{ id: number }> {
	const db = new DatabaseSync(dbFile);
	try {
		return db.prepare('SELECT id FROM orders ORDER BY id').all() as Array<{ id: number }>;
	} finally {
		db.close();
	}
}

test.beforeAll(async () => {
	// A profile with a monitor saved before the rule existed: one widget reads, two write.
	const profile = mkdtempSync(join(tmpdir(), 'snout-e2e-monitors-'));
	dbFile = join(profile, 'shop.db');
	const db = new DatabaseSync(dbFile);
	db.exec('CREATE TABLE orders (id INTEGER); INSERT INTO orders VALUES (1)');
	db.close();
	writeFileSync(join(profile, 'connections.json'), JSON.stringify([
		{ id: 'mon-db', label: 'Shop', driver: 'sqlite', host: '', port: 0, database: dbFile, username: '', environment: 'prod' },
	]));
	const widget = { connectionId: 'mon-db', viz: 'number', intervalSec: 60 };
	writeFileSync(join(profile, 'monitors.json'), JSON.stringify({
		monitors: [{
			id: 'legacy', name: 'Legacy', createdAt: 0, updatedAt: 0,
			widgets: [
				{ ...widget, id: 'writer', title: 'Writer', kind: 'trend', sql: 'DELETE FROM orders' },
				{ ...widget, id: 'count', title: 'Count', kind: 'trend', sql: 'SELECT count(*) FROM orders' },
				{ ...widget, id: 'snap', title: 'Snap', kind: 'snapshot', viz: 'table', sql: 'UPDATE orders SET id = 2' },
			],
		}],
	}));
	handle = await launchApp('monitors', { profile });
});

test.afterAll(async () => {
	await closeApp(handle);
});

test('a saved widget that writes is paused with the reason, kept, and never run; a read still polls', async () => {
	const { page } = handle;
	// The poller starts after first paint and pauses what it finds.
	await expect.poll(async () => page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: MonitorApi }).sqlApi;
		const [legacy] = await api.monitors.list();
		return legacy.widgets.map((w) => [w.id, w.paused ? 'paused' : 'live']);
	}), { timeout: 20_000 }).toEqual([['writer', 'paused'], ['count', 'live'], ['snap', 'paused']]);

	const state = await page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: MonitorApi }).sqlApi;
		const [legacy] = await api.monitors.list();
		return { widgets: legacy.widgets, status: await api.monitors.status('writer') };
	});
	expect(state.widgets.find((w) => w.id === 'writer')?.paused).toMatch(/^Paused: a monitor only runs read-only queries/);
	expect(state.widgets.find((w) => w.id === 'writer')?.sql).toBe('DELETE FROM orders');
	expect(state.status).toMatch(/^Paused:/);

	// The read polled; the writes did not run.
	await expect.poll(async () => page.evaluate(async () => (window as unknown as { sqlApi: MonitorApi }).sqlApi.monitors.samples('count').then((s) => s.length)), { timeout: 20_000 }).toBeGreaterThan(0);
	expect(rows()).toEqual([{ id: 1 }]);
});

test('the view shows why a widget is paused, and does not run it', async () => {
	const { page } = handle;
	await page.keyboard.press(`${MOD}+Shift+P`);
	await page.fill('.palette input', 'Monitors');
	await page.keyboard.press('Enter');
	const paused = page.locator('.widget-tile-paused');
	await expect(paused).toHaveCount(2, { timeout: 10_000 });
	await expect(paused.first()).toContainText('only runs read-only queries');
	await page.screenshot({ path: 'e2e/.results/monitors-paused.png' });
	expect(rows()).toEqual([{ id: 1 }]);
});

test('a write is refused by main however it arrives, and a new one is saved paused', async () => {
	const { page } = handle;
	const out = await page.evaluate(async () => {
		const api = (window as unknown as { sqlApi: MonitorApi }).sqlApi;
		const run = await api.monitors.runWidget('mon-db', 'DELETE FROM orders');
		await api.monitors.save({
			id: 'fresh', name: 'Fresh', createdAt: 1, updatedAt: 1,
			widgets: [{ id: 'ins', title: 'Insert', connectionId: 'mon-db', kind: 'trend', viz: 'line', intervalSec: 60, sql: 'INSERT INTO orders VALUES (3)' }],
		});
		const fresh = (await api.monitors.list()).find((m) => m.id === 'fresh');
		const read = await api.monitors.runWidget('mon-db', 'SELECT count(*) FROM orders');
		return { run, paused: fresh?.widgets[0].paused, read: read.ok };
	});
	expect(out.run.ok).toBe(false);
	expect(out.run.error).toMatch(/^Paused:/);
	expect(out.paused).toMatch(/^Paused:/);
	expect(out.read).toBe(true);
	// Give a wrongly scheduled poll its immediate first tick before looking.
	await page.waitForTimeout(500);
	expect(rows()).toEqual([{ id: 1 }]);
});

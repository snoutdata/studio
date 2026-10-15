/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Monitor, MonitorWidget } from '../shared/monitor';
import type { ExecuteQueryResult } from '../shared/protocol';
import { MonitorPoller, type MonitorQueryRunner } from './monitorPoller';

/*
 * The poller runs a widget's query by itself, every interval, in the background and across
 * restarts. It must run only a read, and only through the database's read-only path; a widget
 * that is not a read is paused with the reason, never run and never deleted.
 */

function widget(id: string, sql: string, extra: Partial<MonitorWidget> = {}): MonitorWidget {
	return { id, title: id, connectionId: 'c1', sql, kind: 'trend', viz: 'line', intervalSec: 60, ...extra };
}

function harness(widgets: MonitorWidget[]) {
	const monitors: Monitor[] = [{ id: 'm', name: 'M', createdAt: 0, updatedAt: 0, widgets }];
	const ran: string[] = [];
	const statuses = new Map<string, string | null>();
	let changed = 0;
	const store = {
		list: () => monitors,
		setWidgetPaused(widgetId: string, reason: string | undefined): boolean {
			for (const monitor of monitors) {
				monitor.widgets = monitor.widgets.map((w) => (w.id === widgetId ? { ...w, paused: reason } : w));
			}
			return true;
		},
		insertSamples: () => undefined,
		pruneOlderThan: () => undefined,
	};
	// Only a read path exists: a poller that reached for `execute` would not compile, and would throw here.
	const runner: MonitorQueryRunner = {
		executeRead: async (_id, sql): Promise<ExecuteQueryResult> => {
			ran.push(sql);
			return { ok: true, result: { fields: [{ name: 'n' }], rows: [[1]], rowCount: 1, durationMs: 1 } } as unknown as ExecuteQueryResult;
		},
		driverFor: () => 'postgres',
	};
	const poller = new MonitorPoller(store as never, runner, () => undefined, (id, error) => statuses.set(id, error), () => { changed++; });
	return { poller, monitors, ran, statuses, changed: () => changed };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe('MonitorPoller', () => {
	test('a widget that writes is paused with the reason and never run; a read runs through executeRead', async () => {
		const h = harness([widget('w', 'delete from orders'), widget('r', 'select count(*) from orders')]);
		h.poller.start();
		await settle();
		h.poller.stop();
		assert.deepEqual(h.ran, ['select count(*) from orders']);
		const paused = h.monitors[0].widgets.find((w) => w.id === 'w');
		assert.match(paused?.paused ?? '', /^Paused: a monitor only runs read-only queries/);
		assert.equal(paused?.sql, 'delete from orders', 'kept, not deleted');
		assert.match(h.statuses.get('w') ?? '', /^Paused:/);
		assert.equal(h.changed(), 1, 'an open view is told to re-read');
	});

	test('a snapshot that writes is paused too, though the poller never runs snapshots', async () => {
		const h = harness([widget('s', 'insert into t values (1)', { kind: 'snapshot' })]);
		h.poller.start();
		await settle();
		h.poller.stop();
		assert.deepEqual(h.ran, []);
		assert.match(h.monitors[0].widgets[0].paused ?? '', /^Paused:/);
	});

	test('a widget saved paused that now reads is resumed', async () => {
		const h = harness([widget('r', 'select 1', { paused: 'Paused: old' })]);
		h.poller.start();
		await settle();
		h.poller.stop();
		assert.deepEqual(h.ran, ['select 1']);
		assert.equal(h.monitors[0].widgets[0].paused, undefined);
	});
});

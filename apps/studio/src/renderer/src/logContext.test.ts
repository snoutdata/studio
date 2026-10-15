/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogsQuery } from '../../shared/engine';
import { contextKey, eventsAfter, eventsBefore, type RunLogsQuery } from './logContext';

const FIELDS = [{ name: 'ts' }, { name: 'message' }, { name: 'stream' }, { name: 'id' }];

/** A fake scope: one event per second on stream `a` and `b`, over `[from, to)`. Honours the window,
 *  the stream predicate, the limit, and a scan cap like the executor's. */
function fakeScope(from: number, to: number, cap = 10_000): { run: RunLogsQuery; calls: LogsQuery[] } {
	const calls: LogsQuery[] = [];
	const run: RunLogsQuery = async (query) => {
		calls.push(query);
		const rows: unknown[][] = [];
		let truncated = false;
		for (let at = Math.ceil(Math.max(from, query.start) / 1000) * 1000; at < Math.min(to, query.end); at += 1000) {
			for (const stream of ['a', 'b']) {
				const wanted = query.where?.find((p) => p.field === 'stream');
				if (wanted && 'value' in wanted && wanted.value !== stream) {
					continue;
				}
				rows.push([at, `line ${stream} ${at}`, stream, `${stream}-${at}`]);
				if (query.limit !== undefined && rows.length >= query.limit) {
					return { fields: FIELDS, rows, truncated: false };
				}
				if (rows.length >= cap) {
					truncated = true;
					break;
				}
			}
			if (truncated) {
				break;
			}
		}
		return { fields: FIELDS, rows, truncated };
	};
	return { run, calls };
}

const T = 10_000_000;

test('eventsAfter reads the next page of the same stream, skipping what is already shown', async () => {
	const { run, calls } = fakeScope(T - 3_600_000, T + 3_600_000);
	const known = new Set([contextKey(`a-${T}`, T, '')]);
	const { events, exhausted } = await eventsAfter(run, { scope: '/g', stream: 'a' }, T, known, 5, T + 3_600_000);
	assert.deepEqual(events.map((e) => e.at), [T + 1000, T + 2000, T + 3000, T + 4000, T + 5000]);
	assert.ok(events.every((e) => e.stream === 'a'));
	assert.equal(exhausted, false);
	assert.equal(calls[0].streamPrefix, 'a');
});

test('eventsAfter says so when the stream ends', async () => {
	const { run } = fakeScope(T - 60_000, T + 3000);
	const { events, exhausted } = await eventsAfter(run, { scope: '/g', stream: 'a' }, T, new Set(), 25, T + 3000);
	assert.equal(events.length, 3);
	assert.equal(exhausted, true);
});

test('eventsBefore keeps the TAIL of the window, the events nearest the anchor', async () => {
	const { run } = fakeScope(T - 3_600_000, T + 3_600_000);
	const known = new Set([contextKey(`a-${T}`, T, '')]);
	const { events } = await eventsBefore(run, { scope: '/g', stream: 'a' }, T, known, 3);
	assert.deepEqual(events.map((e) => e.at), [T - 3000, T - 2000, T - 1000]);
});

test('eventsBefore widens a window that held too few', async () => {
	const { run, calls } = fakeScope(T - 3_600_000, T + 1);
	const { events } = await eventsBefore(run, { scope: '/g', stream: 'a' }, T, new Set(), 100);
	assert.equal(events.length, 100);
	assert.ok(calls.length >= 2);
	assert.equal(events[events.length - 1].at, T);
});

test('eventsBefore narrows a window that overflowed the scan cap instead of keeping its middle', async () => {
	const { run, calls } = fakeScope(T - 3_600_000, T + 1, 20);
	const { events } = await eventsBefore(run, { scope: '/g', stream: null }, T, new Set(), 4);
	// Capped at 20 over a minute (120 events) the tail would be ~50s before the anchor.
	assert.ok(calls.length >= 2);
	assert.equal(events[events.length - 1].at, T);
	assert.equal(events.length, 4);
});

test('no stream reads the whole scope, with no predicate', async () => {
	const { run, calls } = fakeScope(T - 60_000, T + 60_000);
	await eventsAfter(run, { scope: '/g', stream: null }, T, new Set(), 2, T);
	assert.equal(calls[0].where, undefined);
	assert.equal(calls[0].streamPrefix, undefined);
});

test('contextKey falls back to clock and text when there is no id', () => {
	assert.equal(contextKey('x', 1, 'm'), 'id:x');
	assert.equal(contextKey(null, 1, 'm'), 'at:1:m');
});

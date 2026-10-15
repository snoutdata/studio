/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { OrbitPulseSampler, type PulseRunner } from './orbitPulse';
import type { ExecuteQueryResult } from '../shared/protocol';
import type { PulseSample } from '../shared/orbitPulse';

/*
 * The sampler's own logic, which the live e2e run covers but no unit test did. Everything
 * asserted here is behaviour a real database drove out and that a refactor could silently undo:
 *
 *  - the one-shot precondition, which is what stops Pulse reading an empty `performance_schema`
 *    and reporting success (MariaDB ships it off; MySQL is one flag away from the same);
 *  - the STANDING note, because a fallback that announces itself and is then erased by the next
 *    successful poll leaves the rail naming a view Pulse is no longer reading;
 *  - background priority, which is the only thing keeping a 3D tab from starving a user's query.
 *
 * No Electron, no timers left running: every test stops its sampler.
 */

function rows(result: unknown[][]): ExecuteQueryResult {
	return {
		ok: true,
		result: {
			fields: [
				{ name: 'session_id' }, { name: 'statement_text' }, { name: 'duration_ms' },
				{ name: 'state' }, { name: 'user_name' },
			],
			rows: result,
			rowCount: result.length,
			durationMs: 1,
		},
	} as unknown as ExecuteQueryResult;
}

interface Call {
	sql: string;
	priority?: string;
}

/** A runner that answers each query by a predicate, and records what it was asked. */
function fakeRunner(driver: string, answer: (sql: string) => ExecuteQueryResult): { runner: PulseRunner; calls: Call[] } {
	const calls: Call[] = [];
	const runner: PulseRunner = {
		execute(_id, sql, _history, _ai, priority) {
			calls.push({ sql, priority });
			return Promise.resolve(answer(sql));
		},
		driverFor() {
			return driver;
		},
	};
	return { runner, calls };
}

/** Let the immediate first tick (and its precondition round trip) finish. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

test('a refused precondition takes the fallback and says so', async () => {
	const statuses: Array<string | null> = [];
	const { runner, calls } = fakeRunner('mysql-aurora', (sql) => {
		// The precondition asks about performance_schema; this server has it off.
		if (/performance_schema\b/i.test(sql) && /@@/.test(sql)) {
			return rows([[0]]);
		}
		return rows([]);
	});
	const sampler = new OrbitPulseSampler(runner, () => undefined, (_id, error) => statuses.push(error));
	const started = sampler.start('c1', 5000);
	assert.equal(started.started, true);
	await settle();
	sampler.stop('c1');

	const asked = calls.map((c) => c.sql);
	assert.ok(asked.some((sql) => /@@performance_schema/i.test(sql)), 'the precondition was asked');
	assert.ok(asked.some((sql) => /information_schema\.PROCESSLIST/i.test(sql)), 'the fallback view was read');
	const note = statuses.filter((s) => s !== null).pop();
	assert.ok(note && /processlist/i.test(note), `the note names what it fell back to, got ${note}`);
});

test('the fallback note is standing: a successful poll does not erase it', async () => {
	const statuses: Array<string | null> = [];
	const { runner } = fakeRunner('mysql-aurora', (sql) => {
		if (/performance_schema\b/i.test(sql) && /@@/.test(sql)) {
			return rows([[0]]);
		}
		// Every subsequent read succeeds, which is exactly the case that used to wipe the note.
		return rows([['7', 'SELECT * FROM orders', 120, 'executing', 'app']]);
	});
	const sampler = new OrbitPulseSampler(runner, () => undefined, (_id, error) => statuses.push(error));
	sampler.start('c1', 5000);
	await settle();
	await settle();
	sampler.stop('c1');

	assert.ok(statuses.length > 0, 'status was reported');
	assert.notEqual(statuses[statuses.length - 1], null, 'the last status still says which view is being read');
});

test('a met precondition reads the primary view and reports healthy', async () => {
	const statuses: Array<string | null> = [];
	const { runner, calls } = fakeRunner('mysql-aurora', (sql) => {
		if (/performance_schema\b/i.test(sql) && /@@/.test(sql)) {
			return rows([[1]]);
		}
		return rows([['7', 'SELECT 1', 5, 'executing', 'app']]);
	});
	const sampler = new OrbitPulseSampler(runner, () => undefined, (_id, error) => statuses.push(error));
	sampler.start('c1', 5000);
	await settle();
	sampler.stop('c1');

	assert.ok(calls.some((c) => /events_statements_current/i.test(c.sql)), 'the primary view was read');
	// `performance_schema.threads` carries a PROCESSLIST_ID column, so the fallback has to be
	// matched by its table rather than by the word.
	assert.ok(!calls.some((c) => /information_schema\.PROCESSLIST/i.test(c.sql)), 'the fallback was not taken');
	assert.equal(statuses[statuses.length - 1] ?? null, null, 'a healthy poll clears the status');
});

test('every query runs at background priority', async () => {
	const { runner, calls } = fakeRunner('postgres', () => rows([]));
	const sampler = new OrbitPulseSampler(runner, () => undefined, () => undefined);
	sampler.start('c1', 5000);
	await settle();
	sampler.stop('c1');

	assert.ok(calls.length > 0, 'something was asked');
	// Background priority: a 3D tab must never be able to starve an interactive query.
	for (const call of calls) {
		assert.equal(call.priority, 'background', `"${call.sql.slice(0, 40)}" ran at ${call.priority}`);
	}
});

test('an engine with no activity view refuses to start, with a reason', () => {
	const { runner, calls } = fakeRunner('sqlite', () => rows([]));
	const sampler = new OrbitPulseSampler(runner, () => undefined, () => undefined);
	const started = sampler.start('c1');

	assert.equal(started.started, false);
	assert.ok(started.reason && started.reason.length > 10, 'the refusal is a sentence');
	assert.ok(!/unsupported/i.test(started.reason), 'and not the word that explains nothing');
	assert.equal(calls.length, 0, 'nothing was asked of the database');
	assert.equal(sampler.isSampling('c1'), false);
});

test('samples reach the renderer, and stopping ends them', async () => {
	const batches: PulseSample[][] = [];
	const { runner } = fakeRunner('postgres', () => rows([['7', 'SELECT * FROM public.orders', 300, 'active', 'app']]));
	const sampler = new OrbitPulseSampler(runner, (_id, samples) => batches.push(samples), () => undefined);
	sampler.start('c1', 5000);
	await settle();
	assert.equal(batches.length, 1, 'the first tick fires immediately, so the world is not dark');
	assert.equal(batches[0][0].sql, 'SELECT * FROM public.orders');

	sampler.stopAll();
	assert.equal(sampler.isSampling('c1'), false);
});

test('restarting re-arms rather than stacking a second timer', async () => {
	const { runner } = fakeRunner('postgres', () => rows([]));
	const sampler = new OrbitPulseSampler(runner, () => undefined, () => undefined);
	sampler.start('c1', 5000);
	const again = sampler.start('c1', 1000);
	await settle();

	assert.equal(again.started, true);
	assert.equal(again.intervalMs, 1000, 'the new interval is the one in force');
	assert.equal(sampler.isSampling('c1'), true);
	sampler.stopAll();
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReadOnlyEnforcement } from '../../../shared/engine';
import { withReadOnlySession } from './readOnlySession';

const TX: ReadOnlyEnforcement = { mechanism: 'transaction', begin: ['B1', 'B2'], end: ['E1', 'E2'], summary: 'test' };

function fakeSession(failOn?: string): { log: string[]; discarded: () => boolean; session: { run(sql: string): Promise<void>; discard(): void } } {
	const log: string[] = [];
	let discarded = false;
	return {
		log,
		discarded: () => discarded,
		session: {
			run: async (sql) => {
				log.push(sql);
				if (sql === failOn) {
					throw new Error(`${sql} failed`);
				}
			},
			discard: () => { discarded = true; },
		},
	};
}

test('begin, the statement, end, in that order, and the session is kept', async () => {
	const f = fakeSession();
	const answer = await withReadOnlySession(TX, f.session, async () => { f.log.push('Q'); return 42; });
	assert.equal(answer, 42);
	assert.deepEqual(f.log, ['B1', 'B2', 'Q', 'E1', 'E2']);
	assert.equal(f.discarded(), false);
});

test('a statement the database refuses still puts the session back, and its error is the answer', async () => {
	const f = fakeSession();
	await assert.rejects(withReadOnlySession(TX, f.session, async () => { f.log.push('Q'); throw new Error('cannot execute INSERT in a read-only transaction'); }), /read-only transaction/);
	assert.deepEqual(f.log, ['B1', 'B2', 'Q', 'E1', 'E2']);
	assert.equal(f.discarded(), false);
});

test('a begin that fails means the statement is NOT sent, and the session is discarded', async () => {
	const f = fakeSession('B2');
	let ran = false;
	await assert.rejects(withReadOnlySession(TX, f.session, async () => { ran = true; }), /could not start a read-only run, so the query was not sent: B2 failed/);
	assert.equal(ran, false);
	assert.equal(f.discarded(), true);
});

test('an end that fails discards the session, so it never reaches a later write', async () => {
	const f = fakeSession('E1');
	assert.equal(await withReadOnlySession(TX, f.session, async () => 'rows'), 'rows');
	assert.equal(f.discarded(), true);
});

test('nothing runs around the statement for a setting or for the statement check alone', async () => {
	for (const mechanism of ['setting', 'none'] as const) {
		const f = fakeSession();
		await withReadOnlySession({ mechanism, begin: [], end: [], summary: 's' }, f.session, async () => { f.log.push('Q'); });
		assert.deepEqual(f.log, ['Q'], mechanism);
	}
});

// Postgres: a statement that ends the read-only transaction (a COMMIT the statement check missed)
// or switches it to read-write must not come back as a result. `verify` asks the session whether
// it is still inside what `begin` opened, read-only, before `end` rolls it back.
const VERIFIED: ReadOnlyEnforcement = { ...TX, verify: 'V' };

function checkedSession(answer: boolean | Error): ReturnType<typeof fakeSession> & { session: { check(sql: string): Promise<boolean> } } {
	const f = fakeSession();
	return {
		...f,
		session: {
			...f.session,
			check: async (sql: string) => {
				f.log.push(sql);
				if (answer instanceof Error) {
					throw answer;
				}
				return answer;
			},
		},
	};
}

test('verify: still inside the read-only transaction, the answer is the statement\'s', async () => {
	const f = checkedSession(true);
	assert.equal(await withReadOnlySession(VERIFIED, f.session, async () => { f.log.push('Q'); return 'rows'; }), 'rows');
	assert.deepEqual(f.log, ['B1', 'B2', 'Q', 'V', 'E1', 'E2']);
});

test('verify: a run that left the read-only transaction fails, and the session is still put back', async () => {
	const f = checkedSession(false);
	await assert.rejects(withReadOnlySession(VERIFIED, f.session, async () => { f.log.push('Q'); return 'rows'; }), /left the read-only transaction/);
	assert.deepEqual(f.log, ['B1', 'B2', 'Q', 'V', 'E1', 'E2']);
});

test('verify: a check that cannot run fails the run too', async () => {
	const f = checkedSession(new Error('boom'));
	await assert.rejects(withReadOnlySession(VERIFIED, f.session, async () => 'rows'), /could not confirm/);
	assert.deepEqual(f.log.slice(-2), ['E1', 'E2']);
});

test('verify: a session that cannot answer a check fails closed', async () => {
	const f = fakeSession();
	await assert.rejects(withReadOnlySession(VERIFIED, f.session, async () => 'rows'), /could not confirm/);
});

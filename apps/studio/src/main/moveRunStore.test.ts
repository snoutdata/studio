/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MoveRunStore } from './moveRunStore';
import type { MoveRunRecord } from '../shared/move';

/** Whether better-sqlite3 loads here: it is built for Electron, so under plain Node it usually does
 *  not, and these skip. */
function sqliteAvailable(): boolean {
	const dir = mkdtempSync(join(tmpdir(), 'moveruns-probe-'));
	try {
		const store = new MoveRunStore(dir);
		store.list('probe');
		store.close();
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function run(id: string, startedAt: string, status: MoveRunRecord['status']): MoveRunRecord {
	return { id, moveId: 'm1', startedAt, finishedAt: null, status, spec: {} as MoveRunRecord['spec'], findings: [], result: null };
}

describe('MoveRunStore', () => {
	test('records a run, updates it when it ends, and lists newest first', { skip: !sqliteAvailable() }, () => {
		const dir = mkdtempSync(join(tmpdir(), 'snout-moveruns-'));
		const store = new MoveRunStore(dir);
		try {
			store.record(run('a', '2026-10-01T00:00:00.000Z', 'running'));
			store.record(run('b', '2026-10-02T00:00:00.000Z', 'running'));
			store.record({ ...run('a', '2026-10-01T00:00:00.000Z', 'success'), finishedAt: '2026-10-01T00:05:00.000Z' });
			const runs = store.list('m1');
			assert.deepEqual(runs.map((r) => [r.id, r.status]), [['b', 'running'], ['a', 'success']]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a run the app died in is closed as failed', { skip: !sqliteAvailable() }, () => {
		const dir = mkdtempSync(join(tmpdir(), 'snout-moveruns-'));
		const store = new MoveRunStore(dir);
		try {
			store.record(run('a', '2026-10-01T00:00:00.000Z', 'running'));
			assert.equal(store.recoverInterrupted('2026-10-01T01:00:00.000Z'), 1);
			assert.equal(store.list('m1')[0].status, 'failed');
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

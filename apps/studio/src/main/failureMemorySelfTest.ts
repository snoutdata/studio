/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionManager } from './connectionManager';
import type { FailureMemory } from './failureMemory';
import type { FailureMemoryStore } from './failureMemoryStore';
import { removeConnection, writeConnection } from './configStore';

/**
 * A headless, in-Electron self-test of the failure-memory write + read paths — the two ends that
 * unit tests can't reach because the write path runs only inside Electron (its stores import `app`).
 * It drives the REAL wiring: a throwaway SQLite connection, the real ConnectionManager.execute(),
 * the real sink + store, and the real retrieveFailureNote(). Invoked from the boot flow ONLY when
 * SNOUT_MEMORY_SELFTEST=1 (dev only), then the app quits. Not shipped behaviour — a verification
 * harness that reuses production wiring.
 *
 * @returns true if every check passed.
 */
export async function runFailureMemorySelfTest(deps: {
	connections: ConnectionManager;
	store: FailureMemoryStore;
	failureMemory: FailureMemory;
}): Promise<boolean> {
	const { connections, store, failureMemory } = deps;
	const log = (message: string): void => console.log(`[memory-selftest] ${message}`);
	let ok = true;
	const check = (passed: boolean, label: string): void => {
		log(`${passed ? 'PASS' : 'FAIL'} — ${label}`);
		ok = ok && passed;
	};

	const dir = mkdtempSync(join(tmpdir(), 'snout-memtest-'));
	const dbFile = join(dir, 'probe.db');
	const id = 'memory-selftest-conn';
	const config: ConnectionConfig = { id, label: 'Memory Self-Test', driver: 'sqlite', host: '', port: 0, database: dbFile, username: '' };

	try {
		store.deleteAll(); // clean slate so the count assertions are exact
		writeConnection(config);
		await connections.connect(id);
		// Give the schema a table, then re-capture the digest so the fingerprint is meaningful and the
		// same value is used at both write time and retrieval time.
		await connections.execute(id, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
		await connections.refresh(id);
		log('connected to a throwaway sqlite db and created a table');

		// --- Write path: a real failing query must route through execute() into the store. ---
		const result = await connections.execute(id, 'SELECT * FROM ghost WHERE id = 1');
		check(!result.ok, 'execute() of a bad query returns a failure');
		await failureMemory.settled(); // the capture is fire-and-forget; wait for it

		const records = store.recent(10);
		check(records.length === 1, `exactly one failure persisted (got ${records.length})`);
		const r = records[0];
		if (r) {
			check(r.queryShape === 'select * from ghost where id=?', `query_shape canonicalized ("${r.queryShape}")`);
			check(r.schemaFingerprint.length > 0, `schema_fingerprint present ("${r.schemaFingerprint}")`);
			check(r.backend === 'relational', `backend recorded ("${r.backend}")`);
			// A missing-table error isn't one of the top-5 classes, so 'unclassified' is the correct,
			// honest outcome here (matches runbook Case A).
			check(r.errorClass === 'unclassified', `error_class derived ("${r.errorClass}")`);
			log(`stored: class=${r.errorClass} shape="${r.queryShape}" fp=${r.schemaFingerprint} error="${r.error.slice(0, 60)}"`);
		}

		// --- Read path: a structurally similar query on the same schema surfaces the memory note. ---
		const note = await connections.retrieveFailureNote(id, 'SELECT * FROM ghost WHERE id = 2');
		check(!!note, 'retrieveFailureNote returns a note for a structurally similar query');
		if (note) {
			log(`note: ${note}`);
		}

		// --- Negative: a novel query on the same schema must stay silent. ---
		const silent = await connections.retrieveFailureNote(id, 'SELECT count(*) FROM t');
		check(silent === null, 'retrieveFailureNote stays silent for a novel query');
	} catch (err) {
		check(false, `unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		await connections.disconnect(id).catch(() => undefined);
		try {
			removeConnection(id);
		} catch {
			// best-effort cleanup
		}
		try {
			store.deleteAll(); // leave no residue in the dev store
		} catch {
			// best-effort cleanup
		}
		rmSync(dir, { recursive: true, force: true });
		log(ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
	}
	return ok;
}

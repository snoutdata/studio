/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapeSimilarity, selectMemory, formatMemoryNote, retrieveMemory } from './failureRetrieval';
import type { BackendKind } from '../compile/native';
import type { FailureQuery, FailureRecord } from './failureMemory';

function rec(over: Partial<FailureRecord> = {}): FailureRecord {
	return {
		connectionId: 'c1',
		query: 'SELECT * FROM t WHERE id = 1',
		queryShape: 'select * from t where id=?',
		backend: 'relational',
		origin: 'execution',
		error: 'deadlock detected',
		errorClass: 'deadlock',
		schemaFingerprint: 'fp-1',
		at: 1,
		...over,
	};
}

/** An in-memory store for retrieval tests (the same shape the benchmark uses). */
class FakeStore implements FailureQuery {
	constructor(private readonly records: FailureRecord[]) {}
	match(schemaFingerprint: string, backend: BackendKind, limit = 25): FailureRecord[] {
		if (!schemaFingerprint) {
			return [];
		}
		return this.records
			.filter((r) => r.schemaFingerprint === schemaFingerprint && r.backend === backend)
			.slice()
			.reverse()
			.slice(0, limit);
	}
}

test('shapeSimilarity is 1.0 for identical shapes and 0 for disjoint', () => {
	assert.equal(shapeSimilarity('select * from t where id=?', 'select * from t where id=?'), 1);
	assert.equal(shapeSimilarity('alpha beta gamma', 'delta epsilon'), 0); // no shared tokens
	assert.equal(shapeSimilarity('', ''), 0);
});

test('shapeSimilarity is between 0 and 1 for partial overlap', () => {
	const s = shapeSimilarity('select * from t where id=?', 'select * from t where name=?');
	assert.ok(s > 0 && s < 1, `expected partial, got ${s}`);
});

test('selectMemory returns the best candidate over the threshold', () => {
	const near = rec({ queryShape: 'select * from t where id=?' });
	const far = rec({ queryShape: 'update z set a=?' });
	assert.equal(selectMemory([far, near], 'select * from t where id=?'), near);
});

test('selectMemory returns null when nothing clears the threshold', () => {
	const far = rec({ queryShape: 'update z set a=?' });
	assert.equal(selectMemory([far], 'select * from t where id=?'), null);
});

test('retrieveMemory gates on fingerprint + backend, then ranks', () => {
	const store = new FakeStore([
		rec({ schemaFingerprint: 'fp-1', backend: 'relational', queryShape: 'select * from t where id=?', errorClass: 'deadlock' }),
		rec({ schemaFingerprint: 'fp-2', backend: 'relational', queryShape: 'select * from t where id=?', errorClass: 'timeout' }),
	]);
	const hit = retrieveMemory(store, 'fp-1', 'relational', 'select * from t where id=?');
	assert.ok(hit);
	assert.equal(hit.record.errorClass, 'deadlock'); // the fp-2 twin is excluded by the gate
	assert.match(hit.note, /previously hit a deadlock/);
});

test('retrieveMemory excludes a same-shape failure from a DIFFERENT backend', () => {
	const store = new FakeStore([rec({ backend: 'document', queryShape: 'select * from t where id=?' })]);
	assert.equal(retrieveMemory(store, 'fp-1', 'relational', 'select * from t where id=?'), null);
});

test('retrieveMemory returns nothing for an empty fingerprint (unknown schema)', () => {
	const store = new FakeStore([rec({ schemaFingerprint: '' })]);
	assert.equal(retrieveMemory(store, '', 'relational', 'select * from t where id=?'), null);
});

test('formatMemoryNote includes the class phrase and a truncated detail', () => {
	assert.match(formatMemoryNote(rec({ errorClass: 'constraint-violation', error: 'duplicate key' })), /violated a constraint.*duplicate key/);
});

test('formatMemoryNote is actionable: a corrective clause + a do-not-repeat directive', () => {
	// A warning alone didn't move a modest model in the bench; the note must tell it what to DO
	// differently and forbid resubmitting the identical statement.
	const constraintNote = formatMemoryNote(rec({ errorClass: 'constraint-violation', error: 'duplicate key' }));
	assert.match(constraintNote, /INSERT OR IGNORE|ON CONFLICT|satisfy it/);
	assert.match(constraintNote, /Do not re-run the same statement unchanged/);
	// The unclassified path (triggers / hidden rules) points the model at the error text as the rule.
	assert.match(formatMemoryNote(rec({ errorClass: 'unclassified', error: 'overdraft not allowed' })), /not visible in the schema|trigger/);
});

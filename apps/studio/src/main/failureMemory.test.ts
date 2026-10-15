/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FailureMemory } from './failureMemory';
import { type FailureRecord, type FailureSink, type Verdict } from '../shared/engine';

/** A fake sink so the tests stay pure (no better-sqlite3 / native module in the test bundle). */
class FakeSink implements FailureSink {
	readonly inserted: FailureRecord[] = [];
	insert(record: FailureRecord): void {
		this.inserted.push(record);
	}
}

function fail(over: Partial<Verdict> = {}): Verdict {
	return { connectionId: 'c1', query: 'SELECT 1', backend: 'relational', ok: false, error: 'boom', origin: 'execution', ...over };
}

test('records a failure verdict with derived shape, class, and fingerprint', async () => {
	const sink = new FakeSink();
	const mem = new FailureMemory(sink, async () => 'digest-abc');
	mem.record(fail({ query: 'SELECT * FROM t', error: 'deadlock found' }));
	await mem.settled();

	assert.equal(sink.inserted.length, 1);
	const rec = sink.inserted[0];
	assert.equal(rec.query, 'SELECT * FROM t');
	assert.equal(rec.queryShape, 'select * from t'); // canonical, literal-free shape
	assert.equal(rec.error, 'deadlock found');
	assert.equal(rec.errorClass, 'deadlock'); // classified deterministically from the message
	assert.equal(rec.schemaFingerprint, 'digest-abc');
	assert.equal(rec.origin, 'execution');
});

test('ignores successful verdicts — failures only in v1', async () => {
	const sink = new FakeSink();
	const mem = new FailureMemory(sink, async () => 'd');
	mem.record(fail({ ok: true, error: undefined }));
	await mem.settled();
	assert.equal(sink.inserted.length, 0);
});

test('captures translation refusals as their own origin/class', async () => {
	const sink = new FakeSink();
	const mem = new FailureMemory(sink, async () => 'd');
	mem.record(fail({ backend: 'document', origin: 'translation', error: 'JOIN is not supported' }));
	await mem.settled();
	assert.equal(sink.inserted.length, 1);
	assert.equal(sink.inserted[0].origin, 'translation');
	assert.equal(sink.inserted[0].backend, 'document');
	assert.equal(sink.inserted[0].errorClass, 'unsupported-translation'); // origin decides it
});

test('degrades to no-fingerprint (never throws) when the digest resolver rejects', async () => {
	const sink = new FakeSink();
	const mem = new FailureMemory(sink, async () => { throw new Error('server down'); });
	assert.doesNotThrow(() => mem.record(fail()));
	await mem.settled();
	assert.equal(sink.inserted.length, 1);
	assert.equal(sink.inserted[0].schemaFingerprint, ''); // fingerprint unavailable, record still written
});

test('a store failure is swallowed and never breaks the query flow', async () => {
	const throwingSink: FailureSink = { insert() { throw new Error('disk full'); } };
	const mem = new FailureMemory(throwingSink, async () => 'd');
	assert.doesNotThrow(() => mem.record(fail()));
	await assert.doesNotReject(mem.settled());
});

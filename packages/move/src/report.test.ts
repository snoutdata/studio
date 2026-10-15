/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeRun, runStatus, verifySequences, verifyTables, type MoveRunResult } from './report.js';

test('a table missing on the target, or with other counts, does not match', () => {
	const tables = verifyTables(
		[
			{ schema: 'public', table: 'orders', rows: 10 },
			{ schema: 'public', table: 'broken', rows: 3 },
			{ schema: 'public', table: 'empty', rows: 0 }
		],
		[
			{ schema: 'public', table: 'orders', rows: 9 },
			{ schema: 'public', table: 'broken', rows: null },
			{ schema: 'public', table: 'empty', rows: 0 }
		]
	);
	assert.deepEqual(tables.map((table) => table.matches), [false, false, true]);
	assert.equal(tables[1].targetRows, null);
});

test('a sequence the target lacks does not match, even when neither was ever called', () => {
	const sequences = verifySequences(
		[
			{ schema: 'public', name: 'a', lastValue: '42' },
			{ schema: 'public', name: 'b', lastValue: null }
		],
		[{ schema: 'public', name: 'a', lastValue: '42' }]
	);
	assert.deepEqual(sequences.map((sequence) => sequence.matches), [true, false]);
});

test('success needs every object restored and every count matched; harmless noise does not count', () => {
	const harmless = [{ object: null, message: 'must be owner of extension x', command: null, harmless: true }];
	const real = [{ object: 'TABLE t', message: 'boom', command: null, harmless: false }];
	const ok = [{ schema: 'public', table: 't', sourceRows: 1, targetRows: 1, matches: true }];
	assert.equal(runStatus({ cancelled: false, failed: false, failures: harmless, tables: ok, sequences: [] }), 'success');
	assert.equal(runStatus({ cancelled: false, failed: false, failures: real, tables: ok, sequences: [] }), 'partial');
	assert.equal(runStatus({ cancelled: false, failed: false, failures: [], tables: [{ ...ok[0], matches: false }], sequences: [] }), 'partial');
	assert.equal(runStatus({ cancelled: false, failed: true, failures: [], tables: [], sequences: [] }), 'failed');
	assert.equal(runStatus({ cancelled: true, failed: true, failures: [], tables: [], sequences: [] }), 'cancelled');
});

test('the sentence says what went wrong and that a created target is left', () => {
	const base: MoveRunResult = {
		runId: 'r',
		moveId: 'm',
		status: 'partial',
		startedAt: '',
		finishedAt: '',
		error: null,
		failures: [{ object: 'TABLE t', message: 'boom', command: null, harmless: false }],
		harmlessErrors: 0,
		tables: [{ schema: 'public', table: 't', sourceRows: 1, targetRows: null, matches: false }],
		sequences: [],
		created: null,
		backup: null,
		sourceAfter: null,
		bytes: 0,
		durationMs: 0
	};
	assert.equal(describeRun(base), 'The move finished, but 1 object did not restore, and 1 table do not match the source. The source was left as it was.');
	assert.match(describeRun({ ...base, status: 'failed', error: 'no route to host.', created: { label: 'shop', connectionId: 'c' } }), /no route to host\. "shop" was created and is left in place\./);
});

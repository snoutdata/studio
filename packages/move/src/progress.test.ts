/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { etaSeconds, formatDuration, overallFraction, tableFraction, type MoveProgress } from './progress.js';

function progress(overrides: Partial<MoveProgress> = {}): MoveProgress {
	return {
		runId: 'r',
		moveId: 'm',
		phase: 'data',
		message: null,
		tables: [],
		bytesDone: 0,
		bytesTotal: null,
		bytesPerSecond: null,
		objectsFailed: 0,
		...overrides
	};
}

test('the overall fraction is unknown without a total, never above one, and whole when done', () => {
	assert.equal(overallFraction(progress()), null);
	assert.equal(overallFraction(progress({ bytesDone: 50, bytesTotal: 200 })), 0.25);
	// Sizes on disk are estimates; a restore can write more than the estimate said.
	assert.equal(overallFraction(progress({ bytesDone: 300, bytesTotal: 200 })), 1);
	assert.equal(overallFraction(progress({ phase: 'done' })), 1);
});

test('a table falls back from bytes to rows, and is whole when done', () => {
	const table = { schema: 'public', table: 'orders', state: 'copying' as const, bytesDone: 0, bytesTotal: null, rowsDone: 500, rowsEstimate: 2000 };
	assert.equal(tableFraction(table), 0.25);
	assert.equal(tableFraction({ ...table, rowsEstimate: null }), null);
	assert.equal(tableFraction({ ...table, state: 'done' }), 1);
});

test('time left needs a total and a rate, and stops once the move is over', () => {
	assert.equal(etaSeconds(progress({ bytesDone: 0, bytesTotal: 1000, bytesPerSecond: 100 })), 10);
	assert.equal(etaSeconds(progress({ bytesDone: 0, bytesTotal: 1000 })), null);
	assert.equal(etaSeconds(progress({ phase: 'done', bytesTotal: 1000, bytesPerSecond: 100 })), null);
});

test('durations read like a person would say them', () => {
	assert.equal(formatDuration(42), '42 s');
	assert.equal(formatDuration(62), 'about 1 min');
	assert.equal(formatDuration(3900), 'about 1 h 5 min');
});

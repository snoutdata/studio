/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	decideMinimumVersion,
	isBelowMinimum,
	MINIMUM_VERSION_TTL_MS,
	parseMinimumVersion,
	parseMinimumVersionCache,
	shouldFetchMinimum,
} from './minimumVersion';

const NOW = 1_700_000_000_000;

test('the Worker body is read, and 0.0.0 or garbage means no minimum', () => {
	assert.equal(parseMinimumVersion({ minimum: '1.0.37' }), '1.0.37');
	assert.equal(parseMinimumVersion({ minimum: ' 1.0.37\n' }), '1.0.37');
	assert.equal(parseMinimumVersion({ minimum: '0.0.0' }), null);
	assert.equal(parseMinimumVersion({ minimum: '1.0' }), null);
	assert.equal(parseMinimumVersion({ minimum: 'latest' }), null);
	assert.equal(parseMinimumVersion({ minimum: 137 }), null);
	assert.equal(parseMinimumVersion({}), null);
	assert.equal(parseMinimumVersion(null), null);
	assert.equal(parseMinimumVersion('1.0.37'), null);
});

test('below compares numerically, and no minimum never blocks', () => {
	assert.equal(isBelowMinimum('1.0.9', '1.0.10'), true);
	assert.equal(isBelowMinimum('1.0.10', '1.0.10'), false);
	assert.equal(isBelowMinimum('1.1.0', '1.0.10'), false);
	assert.equal(isBelowMinimum('0.0.2', null), false);
});

test('a cache file that is not ours is ignored', () => {
	assert.deepEqual(parseMinimumVersionCache({ minimum: '1.0.37', fetchedAt: NOW }), { minimum: '1.0.37', fetchedAt: NOW });
	assert.deepEqual(parseMinimumVersionCache({ minimum: null, fetchedAt: NOW }), { minimum: null, fetchedAt: NOW });
	assert.equal(parseMinimumVersionCache({ minimum: '1.0.37' }), null);
	assert.equal(parseMinimumVersionCache({ minimum: 'x', fetchedAt: NOW }), null);
	assert.equal(parseMinimumVersionCache('nope'), null);
});

test('a fresh "you are fine" is reused, a stale one is re-asked', () => {
	assert.equal(shouldFetchMinimum(null, '1.0.36', NOW), true);
	assert.equal(shouldFetchMinimum({ minimum: '1.0.30', fetchedAt: NOW - 1000 }, '1.0.36', NOW), false);
	assert.equal(shouldFetchMinimum({ minimum: null, fetchedAt: NOW - MINIMUM_VERSION_TTL_MS + 1 }, '1.0.36', NOW), false);
	assert.equal(shouldFetchMinimum({ minimum: null, fetchedAt: NOW - MINIMUM_VERSION_TTL_MS }, '1.0.36', NOW), true);
});

test('a cached block is never trusted without asking again', () => {
	// Lowering the minimum must release a user at once, not a TTL later.
	assert.equal(shouldFetchMinimum({ minimum: '1.0.40', fetchedAt: NOW - 1 }, '1.0.36', NOW), true);
});

test('a clock that moved backwards re-asks', () => {
	assert.equal(shouldFetchMinimum({ minimum: null, fetchedAt: NOW + 60_000 }, '1.0.36', NOW), true);
});

test('it fails open: a failed request blocks nobody and leaves the cache alone', () => {
	assert.deepEqual(decideMinimumVersion('0.0.2', { ok: false }, NOW), { state: { required: false }, cache: null });
	assert.deepEqual(decideMinimumVersion('0.0.2', undefined, NOW), { state: { required: false }, cache: null });
});

test('a live answer above the running version requires the update, and is cached', () => {
	assert.deepEqual(decideMinimumVersion('1.0.36', { ok: true, minimum: '1.0.37' }, NOW), {
		state: { required: true, minimum: '1.0.37', current: '1.0.36' },
		cache: { minimum: '1.0.37', fetchedAt: NOW },
	});
});

test('a live answer at or below the running version does not', () => {
	assert.deepEqual(decideMinimumVersion('1.0.37', { ok: true, minimum: '1.0.37' }, NOW), {
		state: { required: false },
		cache: { minimum: '1.0.37', fetchedAt: NOW },
	});
	assert.deepEqual(decideMinimumVersion('1.0.37', { ok: true, minimum: null }, NOW), {
		state: { required: false },
		cache: { minimum: null, fetchedAt: NOW },
	});
});

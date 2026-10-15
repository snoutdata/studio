/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clampPoolMax, DEFAULT_POOL_MAX, MAX_POOL_MAX, MIN_POOL_MAX } from './connection';

describe('clampPoolMax', () => {
	test('returns the default when unset or non-finite', () => {
		assert.equal(clampPoolMax(undefined), DEFAULT_POOL_MAX);
		assert.equal(clampPoolMax(NaN), DEFAULT_POOL_MAX);
		assert.equal(clampPoolMax(Infinity), DEFAULT_POOL_MAX); // non-finite falls back to the default
	});

	test('clamps into [MIN, MAX]', () => {
		assert.equal(clampPoolMax(0), MIN_POOL_MAX);
		assert.equal(clampPoolMax(-5), MIN_POOL_MAX);
		assert.equal(clampPoolMax(1000), MAX_POOL_MAX);
		assert.equal(clampPoolMax(MIN_POOL_MAX), MIN_POOL_MAX);
		assert.equal(clampPoolMax(MAX_POOL_MAX), MAX_POOL_MAX);
	});

	test('passes valid values through, flooring fractionals', () => {
		assert.equal(clampPoolMax(8), 8);
		assert.equal(clampPoolMax(8.9), 8);
	});
});

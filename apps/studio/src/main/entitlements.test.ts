/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { entitlementsForTier, normalizeTier } from './entitlements';
import type { Entitlements, Tier } from '../shared/auth';

// The tier ladder in order, lowest first. Written out here rather than imported so that adding a
// rung to `Tier` without deciding where it sits fails a test instead of passing unnoticed.
const LADDER: Tier[] = ['free', 'plus', 'pro', 'business'];

const FLAGS: (keyof Entitlements)[] = ['aiLogging', 'agentMode', 'byok', 'scheduledFlows'];

describe('entitlementsForTier', () => {
	it('gives business everything pro gets', () => {
		assert.deepEqual(entitlementsForTier('business'), entitlementsForTier('pro'));
	});

	it('never takes a flag away as you go up the ladder', () => {
		for (const flag of FLAGS) {
			let granted = false;
			for (const tier of LADDER) {
				const has = entitlementsForTier(tier)[flag];
				assert.ok(!(granted && !has), `${flag} is granted below ${tier} and withdrawn at ${tier}`);
				granted = granted || has;
			}
		}
	});

	it('gates BYOK and scheduled flows on a paid plan, business included', () => {
		assert.equal(entitlementsForTier('free').byok, false);
		assert.equal(entitlementsForTier('free').scheduledFlows, false);
		for (const tier of ['plus', 'pro', 'business'] as const) {
			assert.equal(entitlementsForTier(tier).byok, true, `${tier} byok`);
			assert.equal(entitlementsForTier(tier).scheduledFlows, true, `${tier} scheduledFlows`);
		}
	});

	it('answers for every tier in the union, so no tier reads back as the free set', () => {
		for (const tier of LADDER) {
			assert.notEqual(entitlementsForTier(tier), undefined, tier);
			if (tier !== 'free') {
				assert.notDeepEqual(entitlementsForTier(tier), entitlementsForTier('free'), tier);
			}
		}
	});
});

describe('normalizeTier', () => {
	// The expensive bug this pins: a paid tier the coercion has not been taught is not ranked low,
	// it is read back as FREE, and the app then tells someone who is paying that they are not. It
	// is the shape of the cutover defect that authStore.fetchTier's null-on-failure rule exists
	// for, and it has to be caught here because nothing downstream can tell the two apart.
	it('keeps every tier the app knows, business included', () => {
		for (const tier of LADDER) {
			assert.equal(normalizeTier(tier), tier);
		}
	});

	it('falls back to free only for values that are not tiers', () => {
		assert.equal(normalizeTier('enterprise'), 'free'); // reserved, quote-only, nothing sells it
		assert.equal(normalizeTier('Team'), 'free'); // the column is lower case; a capital is not a tier
		assert.equal(normalizeTier(''), 'free');
		assert.equal(normalizeTier(null), 'free');
		assert.equal(normalizeTier(undefined), 'free');
	});

	it('is not fooled by inherited object properties', () => {
		assert.equal(normalizeTier('toString'), 'free');
		assert.equal(normalizeTier('constructor'), 'free');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { policyFor } from './policy';

/*
 * These lock in the behaviour the four call sites had BEFORE they were consolidated, so the
 * move is provably behaviour-preserving. If one of these changes, a prod surface changed with
 * it, and that should be a deliberate decision rather than a refactor's side effect.
 */

const DROP = 'DROP TABLE customers';
const SELECT = 'SELECT * FROM customers';
const UNFILTERED = 'DELETE FROM customers';

describe('production policy', () => {
	test('non-prod connections are unrestricted', () => {
		for (const env of ['dev', 'stage', undefined, 'anything-else'] as const) {
			const policy = policyFor(env);
			assert.equal(policy.isProduction, false, `${env} should not be production`);
			assert.equal(policy.allowsAutoConnect, true);
			assert.equal(policy.allowsGridActions(true), true);
			assert.equal(policy.confirmationFor(DROP), undefined, 'only prod confirms');
			assert.equal(policy.confirmsWrites(), false);
		}
	});

	test('prod is the safe reading when no preferences are supplied', () => {
		const policy = policyFor('prod');
		assert.equal(policy.isProduction, true);
		assert.equal(policy.allowsAutoConnect, false, 'prod is never reconnected unasked');
		assert.equal(policy.allowsGridActions(true), false, 'a prod grid is look-only by default');
		assert.deepEqual(policy.confirmationFor(DROP), { verb: 'DROP', unfiltered: false });
		assert.equal(policy.confirmsWrites(), true);
	});

	test('a dropped connection is look-only even where actions are allowed', () => {
		assert.equal(policyFor('prod', { allowGridActions: true }).allowsGridActions(false), false);
		assert.equal(policyFor('dev').allowsGridActions(false), false);
	});

	test('the grid opt-in only loosens prod, and only the grid', () => {
		const policy = policyFor('prod', { allowGridActions: true });
		assert.equal(policy.allowsGridActions(true), true);
		assert.equal(policy.allowsAutoConnect, false, 'the grid opt-in must not unlock autoconnect');
		assert.notEqual(policy.confirmationFor(DROP), undefined, 'nor skip the run confirm');
	});

	test('turning the confirm preference off skips the run gate but nothing else', () => {
		const policy = policyFor('prod', { confirmDestructive: false });
		assert.equal(policy.confirmationFor(DROP), undefined);
		assert.equal(policy.confirmsWrites(), false);
		assert.equal(policy.allowsGridActions(true), false, 'the grid lock is a separate preference');
		assert.equal(policy.allowsAutoConnect, false);
	});

	test('a read-only statement never needs confirming', () => {
		assert.equal(policyFor('prod').confirmationFor(SELECT), undefined);
	});

	test('the unfiltered flag survives, so the confirm can say it hits every row', () => {
		assert.deepEqual(policyFor('prod').confirmationFor(UNFILTERED), { verb: 'DELETE', unfiltered: true });
	});
});

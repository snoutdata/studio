/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditBalance, readCreditBalance } from './creditBalance';

test('the balance is the account service\'s answer, unchanged', async () => {
	const names: string[] = [];
	const credits = await readCreditBalance(async (name) => {
		names.push(name);
		return { data: { balance: 10, purchasedTotal: 15, spend: 5 }, error: null };
	});
	assert.deepEqual(credits, { balance: 10, purchasedTotal: 15, spend: 5 });
	assert.deepEqual(names, ['ai-credits']);
});

test('nothing bought shows no credits block', async () => {
	assert.equal(await readCreditBalance(async () => ({ data: { balance: 0, purchasedTotal: 0, spend: 0 }, error: null })), null);
});

test('a failed call shows no balance', async () => {
	assert.equal(await readCreditBalance(async () => ({ data: null, error: new Error('503') })), null);
	assert.equal(await readCreditBalance(() => Promise.reject(new Error('offline'))), null);
});

test('a call that never answers shows no balance once the wait is over', async () => {
	assert.equal(await readCreditBalance(() => new Promise(() => undefined), 20), null);
});

test('a malformed answer shows no balance', () => {
	assert.equal(parseCreditBalance(null), null);
	assert.equal(parseCreditBalance('10'), null);
	assert.equal(parseCreditBalance({ balance: '10', purchasedTotal: 15, spend: 5 }), null);
	assert.equal(parseCreditBalance({ balance: -1, purchasedTotal: 15, spend: 5 }), null);
	assert.equal(parseCreditBalance({ balance: 10, purchasedTotal: Number.NaN, spend: 5 }), null);
	assert.equal(parseCreditBalance({ error: 'Invalid token' }), null);
});

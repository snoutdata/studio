/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BackgroundGate } from './backgroundGate';

describe('BackgroundGate', () => {
	test('acquires immediately while under the limit', async () => {
		const gate = new BackgroundGate();
		await gate.acquire('c1', 3);
		await gate.acquire('c1', 3);
		assert.equal(gate.inFlightCount('c1'), 2);
		assert.equal(gate.waitingCount('c1'), 0);
	});

	test('parks the query that would exceed the limit until a slot frees', async () => {
		const gate = new BackgroundGate();
		await gate.acquire('c1', 2);
		await gate.acquire('c1', 2); // at limit
		let thirdRan = false;
		const third = gate.acquire('c1', 2).then(() => { thirdRan = true; });
		// Give the microtask queue a turn; the third acquire must still be parked.
		await Promise.resolve();
		assert.equal(thirdRan, false);
		assert.equal(gate.waitingCount('c1'), 1);
		assert.equal(gate.inFlightCount('c1'), 2);

		gate.release('c1'); // hands the slot straight to the waiter
		await third;
		assert.equal(thirdRan, true);
		assert.equal(gate.waitingCount('c1'), 0);
		assert.equal(gate.inFlightCount('c1'), 2); // count conserved through the hand-off
	});

	test('releases waiters FIFO', async () => {
		const gate = new BackgroundGate();
		await gate.acquire('c1', 1); // limit 1: only one at a time
		const order: number[] = [];
		const a = gate.acquire('c1', 1).then(() => order.push(1));
		const b = gate.acquire('c1', 1).then(() => order.push(2));
		await Promise.resolve();
		assert.equal(gate.waitingCount('c1'), 2);

		gate.release('c1');
		await a;
		gate.release('c1');
		await b;
		assert.deepEqual(order, [1, 2]);
	});

	test('drops to idle once all slots release with no waiters', async () => {
		const gate = new BackgroundGate();
		await gate.acquire('c1', 3);
		await gate.acquire('c1', 3);
		gate.release('c1');
		gate.release('c1');
		assert.equal(gate.inFlightCount('c1'), 0);
		assert.equal(gate.waitingCount('c1'), 0);
	});

	test('a limit below 1 is floored to 1', async () => {
		const gate = new BackgroundGate();
		await gate.acquire('c1', 0);
		assert.equal(gate.inFlightCount('c1'), 1);
		let secondRan = false;
		void gate.acquire('c1', 0).then(() => { secondRan = true; });
		await Promise.resolve();
		assert.equal(secondRan, false); // the second is parked, not run
		assert.equal(gate.waitingCount('c1'), 1);
	});

	test('tracks connections independently', async () => {
		const gate = new BackgroundGate();
		await gate.acquire('c1', 1);
		await gate.acquire('c2', 1);
		assert.equal(gate.inFlightCount('c1'), 1);
		assert.equal(gate.inFlightCount('c2'), 1);
		let c1SecondRan = false;
		void gate.acquire('c1', 1).then(() => { c1SecondRan = true; });
		await Promise.resolve();
		assert.equal(c1SecondRan, false); // c1 is at its limit
		assert.equal(gate.waitingCount('c2'), 0); // c2 unaffected
	});
});

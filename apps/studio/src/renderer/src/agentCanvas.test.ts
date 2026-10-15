/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { canvasFor, clearCanvas, pushCanvas, resetCanvas, subscribeCanvas } from './agentCanvas';

/*
 * What each coding agent has shown. DOM-free on purpose, like the capability registry: the store
 * is a module, and what it has to get right is ownership — one agent must never be able to wipe or
 * reorder another's thread — which is testable without React.
 */

beforeEach(() => resetCanvas());

describe('pushCanvas', () => {
	test('keeps arrival order, per agent', () => {
		pushCanvas('claude', { markdown: 'first' });
		pushCanvas('claude', { markdown: 'second' });
		assert.deepEqual(canvasFor('claude').map((e) => e.markdown), ['first', 'second']);
	});

	test('each agent has its OWN thread, which is the whole point of the surface', () => {
		pushCanvas('claude', { markdown: 'mine' });
		pushCanvas('codex', { markdown: 'theirs' });
		assert.deepEqual(canvasFor('claude').map((e) => e.markdown), ['mine']);
		assert.deepEqual(canvasFor('codex').map((e) => e.markdown), ['theirs']);
	});

	test('clear replaces one agent thread and leaves the others alone', () => {
		pushCanvas('claude', { markdown: 'old' });
		pushCanvas('codex', { markdown: 'untouched' });
		pushCanvas('claude', { markdown: 'fresh', clear: true });
		assert.deepEqual(canvasFor('claude').map((e) => e.markdown), ['fresh']);
		assert.deepEqual(canvasFor('codex').map((e) => e.markdown), ['untouched']);
	});

	test('ids are unique, so two identical pushes are two cards', () => {
		const a = pushCanvas('claude', { markdown: 'same' });
		const b = pushCanvas('claude', { markdown: 'same' });
		assert.notEqual(a.id, b.id);
	});

	test('an agent with nothing drawn reads as empty, with a stable identity', () => {
		// The console renders nothing at all in that state, and the empty array is a render
		// dependency: a new one every read would re-render every console on every unrelated push.
		assert.deepEqual(canvasFor('opencode'), []);
		assert.equal(canvasFor('opencode'), canvasFor('opencode'));
	});

	test('subscribers are told, which is how a push from main reaches the screen', () => {
		let calls = 0;
		const off = subscribeCanvas(() => { calls += 1; });
		pushCanvas('claude', { markdown: 'a' });
		clearCanvas('claude');
		off();
		pushCanvas('claude', { markdown: 'after unsubscribe' });
		assert.equal(calls, 2);
	});
});

describe('clearCanvas', () => {
	test('empties one agent and notifies only when there was something to clear', () => {
		let calls = 0;
		const off = subscribeCanvas(() => { calls += 1; });
		clearCanvas('claude');
		assert.equal(calls, 0);
		pushCanvas('claude', { markdown: 'a' });
		clearCanvas('claude');
		off();
		assert.deepEqual(canvasFor('claude'), []);
		assert.equal(calls, 2);
	});
});

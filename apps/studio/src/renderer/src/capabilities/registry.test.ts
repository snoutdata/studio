/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry, type CapabilityContext, type CapabilityHandler } from './registry';

// A throwaway context — the registry only passes it through to handlers, so an empty object
// cast to the type is enough for these unit tests (no handler here actually touches the app).
const ctx = {} as CapabilityContext;

function handler(name: string, run?: CapabilityHandler['run']): CapabilityHandler {
	return {
		spec: { name, description: name, parameters: { type: 'object', properties: {} }, domain: 'test', mutates: false, implicitConnection: 'none', returnsData: 'none' },
		run: run ?? (() => ({ ok: true, summary: `${name} ran` })),
	};
}

describe('CapabilityRegistry', () => {
	test('register exposes the spec in the manifest and returns an unregister', () => {
		const reg = new CapabilityRegistry();
		const off = reg.register(handler('alpha'));
		assert.deepEqual(reg.list().map((s) => s.name), ['alpha']);
		assert.equal(reg.has('alpha'), true);
		off();
		assert.equal(reg.has('alpha'), false);
		assert.deepEqual(reg.list(), []);
	});

	test('rejects a reserved (built-in tool) name', () => {
		const reg = new CapabilityRegistry();
		assert.throws(() => reg.register(handler('run_query')), /collides/);
	});

	test('rejects a duplicate name', () => {
		const reg = new CapabilityRegistry();
		reg.register(handler('alpha'));
		assert.throws(() => reg.register(handler('alpha')), /already registered/);
	});

	test('invoke runs the matching handler and returns its result', async () => {
		const reg = new CapabilityRegistry();
		reg.register(handler('alpha', (args) => ({ ok: true, summary: 'ok', data: args })));
		const result = await reg.invoke({ id: '1', name: 'alpha', arguments: { x: 2 } }, ctx);
		assert.equal(result.ok, true);
		assert.deepEqual(result.data, { x: 2 });
	});

	test('invoke on an unknown name returns an unsuccessful result (never throws)', async () => {
		const reg = new CapabilityRegistry();
		const result = await reg.invoke({ id: '1', name: 'missing', arguments: {} }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /Unknown capability/);
	});

	test('a handler that throws becomes an unsuccessful result', async () => {
		const reg = new CapabilityRegistry();
		reg.register(handler('boom', () => { throw new Error('nope'); }));
		const result = await reg.invoke({ id: '1', name: 'boom', arguments: {} }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /nope/);
	});
});

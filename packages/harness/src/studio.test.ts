/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, emptyGrants } from './grants.ts';
import { ASKED_EVERY_TIME, capabilityTool, studioPrompt, studioScreen, studioSurfaceDigest, studioSurfaceText, studioTools } from './studio.ts';

/** Every value a surface module exports, by name. */
function exportsOf(): Array<[string, unknown]> {
	return [studioPrompt, studioScreen, studioTools].flatMap((module) => Object.entries(module));
}

describe("Studio's surface is text", () => {
	test('every export is a string, lines, descriptions, or a template of plain values', () => {
		for (const [name, value] of exportsOf()) {
			if (typeof value === 'function') {
				const out = (value as (...args: string[]) => unknown)(...Array.from({ length: value.length }, () => 'x'));
				assert.ok(typeof out === 'string' || (Array.isArray(out) && out.every((l) => typeof l === 'string')), `${name} renders text`);
			} else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
				const walk = (o: Record<string, unknown>): void => {
					for (const [key, v] of Object.entries(o)) {
						if (key === 'description') {
							assert.equal(typeof v, 'string', `${name}.${key}`);
						} else {
							assert.ok(typeof v === 'object' && v !== null, `${name}.${key} holds a description`);
							walk(v as Record<string, unknown>);
						}
					}
				};
				walk(value as Record<string, unknown>);
			} else {
				assert.ok(typeof value === 'string' || (Array.isArray(value) && value.every((l) => typeof l === 'string')), `${name} is text`);
			}
		}
	});

	test('the fingerprint covers the text and is stable', () => {
		assert.match(studioSurfaceDigest(), /^[0-9a-f]{8}$/);
		assert.equal(studioSurfaceDigest(), studioSurfaceDigest());
		// The text is JSON, so a string is found as JSON writes it.
		const has = (text: string): boolean => studioSurfaceText().includes(JSON.stringify(text).slice(1, -1));
		assert.ok(has(studioPrompt.THINKING));
		assert.ok(has(studioTools.RUN_QUERY.description));
		assert.ok(has(studioPrompt.SQL_INTRO('{0}', '{1}')));
	});
});

describe('a Studio capability under the tool contract', () => {
	const spec = { name: 'open_in_new_tab', description: 'Open SQL in a new tab.', parameters: { type: 'object', properties: {} }, domain: 'editor', mutates: true };

	test('keeps the spec the model is told, and its domain and mutates', () => {
		const tool = capabilityTool(spec);
		assert.deepEqual(tool.spec, { name: spec.name, description: spec.description, parameters: spec.parameters });
		assert.equal(tool.domain, 'editor');
		assert.equal(tool.mutates, true);
		assert.equal(tool.alwaysAsk?.({}, { production: false }), null);
	});

	test('a read runs; a change asks unless granted; one Studio asks every time asks whatever the grant', () => {
		const none = emptyGrants();
		const granted = emptyGrants([spec.name]);
		const context = { production: false };
		assert.equal(decide(capabilityTool({ ...spec, mutates: false }), {}, none, context), 'run');
		assert.equal(decide(capabilityTool(spec), {}, none, context), 'ask');
		assert.equal(decide(capabilityTool(spec), {}, granted, context), 'run');
		const every = capabilityTool(spec, () => true);
		assert.equal(decide(every, {}, granted, context), 'ask');
		assert.equal(every.alwaysAsk?.({}, context), ASKED_EVERY_TIME);
	});
});

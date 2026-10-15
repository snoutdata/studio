/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSurface } from './chatSurface';

/*
 * The surface table. A domain that silently stops being blocked is exactly the kind of
 * regression nothing else would catch: the assistant would simply gain a tool nobody decided to
 * give it, and it would work.
 */

describe('resolveSurface', () => {
	test('the assistant never gets the editor or the canvas, on either variant', () => {
		// `editor`: writing SQL into the editor is the user's choice via the card's buttons.
		// `canvas`: the assistant already renders its reply INTO the surface show_in_app draws on,
		// so a second way to draw is only a way to be confusing. It belongs to a coding agent.
		for (const variant of ['docked', 'full'] as const) {
			const config = resolveSurface(variant, 'general');
			assert.ok(config.blockedDomains.includes('editor'), `${variant} must block editor`);
			assert.ok(config.blockedDomains.includes('canvas'), `${variant} must block canvas`);
		}
	});

	test('full chat also drops results, because it has no grid in view', () => {
		assert.ok(resolveSurface('full', 'general').blockedDomains.includes('results'));
		assert.ok(!resolveSurface('docked', 'general').blockedDomains.includes('results'));
	});

	test('only the docked general chat offers insert affordances', () => {
		assert.deepEqual(resolveSurface('docked', 'general').insertTargets, ['editor', 'newTab', 'pipeline', 'run']);
		// Full chat has no editor in view; a perf chat is advice you copy, not edits to drop in.
		assert.deepEqual(resolveSurface('full', 'general').insertTargets, []);
		assert.deepEqual(resolveSurface('docked', 'perf').insertTargets, []);
	});

	test('a perf session locks its attachment', () => {
		assert.equal(resolveSurface('docked', 'perf').allowAttach, false);
		assert.equal(resolveSurface('docked', 'general').allowAttach, true);
	});

	test('editor ambient context is docked-general only', () => {
		assert.equal(resolveSurface('docked', 'general').editorAmbient, true);
		assert.equal(resolveSurface('full', 'general').editorAmbient, false);
		assert.equal(resolveSurface('docked', 'perf').editorAmbient, false);
	});
});

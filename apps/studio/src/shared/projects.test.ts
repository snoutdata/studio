/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openProjectCommand, parseOpenProjectCommand } from './projects';

describe('openProjectCommand', () => {
	test('carries a target and a name through a command id and back', () => {
		const local = openProjectCommand({ kind: 'local', id: 'p-1' }, "My: app");
		assert.deepEqual(parseOpenProjectCommand(local), { target: { kind: 'local', id: 'p-1' }, name: "My: app" });
		const cloud = openProjectCommand({ kind: 'cloud', ref: 'abcdefghijklm' }, "Shop");
		assert.deepEqual(parseOpenProjectCommand(cloud), { target: { kind: 'cloud', ref: 'abcdefghijklm' }, name: "Shop" });
	});

	test('any other command, or a malformed one, is not a project', () => {
		assert.equal(parseOpenProjectCommand('flowsPanel'), null);
		assert.equal(parseOpenProjectCommand('openProject:{not json'), null);
		assert.equal(parseOpenProjectCommand('openProject:{"target":{"kind":"cloud","ref":"NOPE"},"name":"x"}'), null);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { asProjectName, isProjectName } from './projectName';

test('a project name is letters, digits, hyphens and underscores, from a letter or digit', () => {
	for (const ok of ['orders', 'Orders-2', 'my_side-project', '9lives', 'a'.repeat(60)]) {
		assert.equal(isProjectName(ok), true, ok);
	}
	for (const bad of ['', 'my project', 'café', 'a.b', 'a/b', '-lead', '_lead', 'tab\tname', 'a'.repeat(61), "o'brien"]) {
		assert.equal(isProjectName(bad), false, bad);
	}
});

test('asProjectName turns an existing name into the nearest acceptable one', () => {
	assert.equal(asProjectName('My Side Project'), 'My-Side-Project');
	assert.equal(asProjectName('  orders @ 2026-11-14 10:00 '), 'orders-2026-11-14-10-00');
	assert.equal(asProjectName('--x--'), 'x');
	assert.equal(asProjectName('***'), '');
	assert.equal(asProjectName('a'.repeat(70)).length, 60);
	assert.equal(isProjectName(asProjectName('Ünïcode name!')), true);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { consumeRelaunchHidden, RELAUNCH_HIDDEN_TTL_MS, writeRelaunchHidden } from './relaunchHidden';

const NOW = 1_700_000_000_000;

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'relaunch-hidden-'));
}

test('no note means a normal launch', () => {
	const dir = scratch();
	try {
		assert.equal(consumeRelaunchHidden(dir, NOW), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a fresh note hides exactly one launch', () => {
	const dir = scratch();
	try {
		writeRelaunchHidden(dir, NOW);
		assert.equal(consumeRelaunchHidden(dir, NOW + 30_000), true);
		assert.equal(existsSync(join(dir, 'relaunch-hidden.json')), false);
		assert.equal(consumeRelaunchHidden(dir, NOW + 31_000), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a stale, future or garbled note is removed and ignored', () => {
	const dir = scratch();
	try {
		writeRelaunchHidden(dir, NOW);
		assert.equal(consumeRelaunchHidden(dir, NOW + RELAUNCH_HIDDEN_TTL_MS + 1), false);
		writeRelaunchHidden(dir, NOW + 60_000);
		assert.equal(consumeRelaunchHidden(dir, NOW), false);
		writeFileSync(join(dir, 'relaunch-hidden.json'), 'not json');
		assert.equal(consumeRelaunchHidden(dir, NOW), false);
		assert.equal(existsSync(join(dir, 'relaunch-hidden.json')), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

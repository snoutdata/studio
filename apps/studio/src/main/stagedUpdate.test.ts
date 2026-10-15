/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fallbackInstallerArgs, MAX_SWAP_ATTEMPTS, noteSwapAttempt, parseStageMarker, readSwapRecord, settleSwapRecord, stagePaths, swapAllowed } from './stagedUpdate';

function withProfile(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'staged-update-'));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('the stage and the swapped-out copy are siblings of the install folder', () => {
	// stagePaths uses the platform's dirname; on Windows these are the real paths, elsewhere the
	// shape is the same with the platform's separator.
	const exe = process.platform === 'win32' ? win32.join('C:\\Users\\a\\AppData\\Local\\Programs\\snoutdata', 'SnoutData.exe') : '/opt/snoutdata/SnoutData.exe';
	const install = process.platform === 'win32' ? 'C:\\Users\\a\\AppData\\Local\\Programs\\snoutdata' : '/opt/snoutdata';
	assert.deepEqual(stagePaths(exe), { install, next: `${install}.next`, old: `${install}.old` });
});

test('a marker carries the version, the uninstall key and the display name', () => {
	assert.deepEqual(parseStageMarker('1.0.50\r\n11111111-2222-3333-4444-555555555555\r\nSnoutData 1.0.50\r\n'), {
		version: '1.0.50',
		uninstallKey: '11111111-2222-3333-4444-555555555555',
		displayName: 'SnoutData 1.0.50',
	});
});

test('a marker missing a line is not a whole stage', () => {
	assert.equal(parseStageMarker('1.0.50\r\n'), null);
	assert.equal(parseStageMarker(''), null);
});

test('the fallback runs the stock installer the way electron-updater would', () => {
	assert.deepEqual(fallbackInstallerArgs('restart'), ['--updated', '--force-run']);
	assert.deepEqual(fallbackInstallerArgs('background'), ['--updated', '/S', '--force-run']);
	// A plain quit installs silently and does not bring the app back.
	assert.deepEqual(fallbackInstallerArgs('quit'), ['--updated', '/S']);
});

test('a swap that never happens stops being tried, and the stock installer takes over', () => {
	withProfile((dir) => {
		assert.equal(swapAllowed(readSwapRecord(dir), '1.0.51'), true);
		for (let i = 1; i < MAX_SWAP_ATTEMPTS; i++) {
			noteSwapAttempt(dir, '1.0.51');
			assert.equal(swapAllowed(readSwapRecord(dir), '1.0.51'), true);
		}
		noteSwapAttempt(dir, '1.0.51');
		assert.deepEqual(readSwapRecord(dir), { version: '1.0.51', attempts: MAX_SWAP_ATTEMPTS });
		assert.equal(swapAllowed(readSwapRecord(dir), '1.0.51'), false);
		// A newer version starts its own count.
		assert.equal(swapAllowed(readSwapRecord(dir), '1.0.52'), true);
		noteSwapAttempt(dir, '1.0.52');
		assert.deepEqual(readSwapRecord(dir), { version: '1.0.52', attempts: 1 });
	});
});

test('a launch on the version a swap was for clears the record; a launch still on the old one keeps it', () => {
	withProfile((dir) => {
		noteSwapAttempt(dir, '1.0.51');
		assert.deepEqual(settleSwapRecord(dir, '1.0.50'), { version: '1.0.51', attempts: 1 });
		assert.notEqual(readSwapRecord(dir), null);
		assert.equal(settleSwapRecord(dir, '1.0.51'), null);
		assert.equal(readSwapRecord(dir), null);
		// The stock installer delivered something newer still: the record is moot.
		noteSwapAttempt(dir, '1.0.51');
		assert.equal(settleSwapRecord(dir, '1.0.53'), null);
		assert.equal(readSwapRecord(dir), null);
	});
});

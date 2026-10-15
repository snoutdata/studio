/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkedPath, mergePath, resolveUserPath, wellKnownBinDirs } from './loginPath';

describe('mergePath', () => {
	test('keeps the first mention of a directory and drops empties', () => {
		const merged = mergePath(['/a:/b', '', '/b:/c', undefined], ':');
		assert.equal(merged, '/a:/b:/c');
	});

	test('preserves the order of the first fragment', () => {
		const merged = mergePath(['/home/u/.local/bin:/usr/bin', '/usr/bin:/bin'], ':');
		assert.equal(merged, '/home/u/.local/bin:/usr/bin:/bin');
	});
});

describe('extractMarkedPath', () => {
	test('reads the PATH out from between the markers, past any rc-file noise', () => {
		const output = 'nvm: using node 22\n__SNOUTDATA_PATH__/a:/b__SNOUTDATA_PATH__\n';
		assert.equal(extractMarkedPath(output), '/a:/b');
	});

	test('is null when the shell printed no markers', () => {
		assert.equal(extractMarkedPath('command not found\n'), null);
		assert.equal(extractMarkedPath('__SNOUTDATA_PATH__/a'), null);
	});
});

describe('wellKnownBinDirs', () => {
	test('offers the user directories before the system ones', () => {
		const dirs = wellKnownBinDirs('/Users/alex', 'darwin');
		assert.ok(dirs.indexOf('/Users/alex/.local/bin') < dirs.indexOf('/usr/local/bin'));
	});

	test('is empty on Windows, whose GUI PATH is already the full one', () => {
		assert.deepEqual(wellKnownBinDirs('C:\\Users\\alex', 'win32'), []);
	});
});

describe('resolveUserPath', () => {
	/** The PATH launchd hands a macOS app started from Finder. This is the whole bug. */
	const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

	test('widens the launchd PATH with the login shell and the well-known directories', async () => {
		const path = await resolveUserPath({
			platform: 'darwin',
			env: { PATH: LAUNCHD_PATH, SHELL: '/bin/zsh', HOME: '/Users/alex' },
			askShell: async () => '/Users/alex/.nvm/versions/node/v24.13.0/bin:/usr/bin',
			exists: (p) => p === '/Users/alex/.local/bin' || p === '/opt/homebrew/bin',
		});
		const dirs = path.split(':');
		// What we were HANDED leads: a PATH somebody set on this process is not outranked by one we
		// inferred from a shell. The launchd four hold nothing, so the shell's entries still answer.
		assert.equal(dirs.slice(0, 4).join(':'), LAUNCHD_PATH);
		assert.ok(dirs.includes('/Users/alex/.nvm/versions/node/v24.13.0/bin'));
		assert.ok(dirs.includes('/Users/alex/.local/bin'));
		assert.ok(dirs.includes('/opt/homebrew/bin'));
		// Nothing inherited is lost, and nothing absent is added.
		for (const dir of LAUNCHD_PATH.split(':')) {
			assert.ok(dirs.includes(dir), `${dir} survived`);
		}
		assert.ok(!dirs.includes('/Users/alex/bin'));
		assert.equal(new Set(dirs).size, dirs.length, 'no duplicates');
	});

	test('uses the passwd login shell when the environment carries no $SHELL', async () => {
		let askedShell = '';
		await resolveUserPath({
			platform: 'darwin',
			env: { PATH: LAUNCHD_PATH, HOME: '/Users/alex' },
			loginShell: () => '/bin/zsh',
			askShell: async (shell) => { askedShell = shell; return null; },
			exists: () => false,
		});
		assert.equal(askedShell, '/bin/zsh');
	});

	test('falls back to the well-known directories when the shell answers nothing', async () => {
		const path = await resolveUserPath({
			platform: 'darwin',
			env: { PATH: LAUNCHD_PATH, SHELL: '/bin/zsh', HOME: '/Users/alex' },
			askShell: async () => null,
			exists: (p) => p === '/Users/alex/.local/bin',
		});
		assert.equal(path, `${LAUNCHD_PATH}:/Users/alex/.local/bin`);
	});

	test('survives a login shell that throws', async () => {
		const path = await resolveUserPath({
			platform: 'linux',
			env: { PATH: '/usr/bin', SHELL: '/bin/bash', HOME: '/home/alex' },
			askShell: async () => { throw new Error("no shell"); },
			exists: () => false,
		});
		assert.equal(path, '/usr/bin');
	});

	test('asks no shell on Windows and returns the inherited PATH', async () => {
		let asked = false;
		const path = await resolveUserPath({
			platform: 'win32',
			env: { PATH: 'C:\\Windows;C:\\tools', SHELL: '/bin/bash' },
			askShell: async () => { asked = true; return null; },
			exists: () => true,
		});
		assert.equal(path, 'C:\\Windows;C:\\tools');
		assert.equal(asked, false);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPrivateFile, ensurePrivateDir, PRIVATE_USER_DATA_FILES, tightenPrivateFiles, writePrivateFile } from './privateFile';

// File modes are a POSIX thing; on Windows the profile folder's ACL protects these files.
const posix = process.platform !== 'win32';

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'privatefile-'));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

describe('writePrivateFile', () => {
	test('writes the content, owner-only, and leaves no temporary file behind', { skip: !posix }, () => {
		withDir((dir) => {
			const path = join(dir, 'nested', 'mcp.json');
			writePrivateFile(path, '{"token":"t"}');
			assert.equal(readFileSync(path, 'utf8'), '{"token":"t"}');
			assert.equal(modeOf(path), 0o600);
			assert.deepEqual(readdirSync(join(dir, 'nested')), ['mcp.json']);
		});
	});

	test('a file that was world-readable is private after the next write', { skip: !posix }, () => {
		withDir((dir) => {
			const path = join(dir, 'secrets.json');
			writeFileSync(path, '{}');
			chmodSync(path, 0o644);
			writePrivateFile(path, '{"a":"b"}');
			assert.equal(modeOf(path), 0o600);
			assert.equal(readFileSync(path, 'utf8'), '{"a":"b"}');
		});
	});
});

describe('tightenPrivateFiles', () => {
	test('takes group and other access off the credential files that exist', { skip: !posix }, () => {
		withDir((dir) => {
			mkdirSync(join(dir, 'agent-console'));
			for (const name of ['mcp.json', 'auth.json', join('agent-console', 'mcp.json')]) {
				writeFileSync(join(dir, name), '{}');
				chmodSync(join(dir, name), 0o644);
			}
			writeFileSync(join(dir, 'secrets.json'), '{}');
			chmodSync(join(dir, 'secrets.json'), 0o600);
			writeFileSync(join(dir, 'chats.json'), '{}');
			chmodSync(join(dir, 'chats.json'), 0o644);

			const changed = tightenPrivateFiles(dir, 'linux');
			assert.deepEqual(changed.sort(), ['auth.json', join('agent-console', 'mcp.json'), 'mcp.json'].sort());
			for (const name of PRIVATE_USER_DATA_FILES) {
				try {
					assert.equal(modeOf(join(dir, name)), 0o600, name);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw err;
					}
				}
			}
			// Not a credential file: untouched.
			assert.equal(modeOf(join(dir, 'chats.json')), 0o644);
			// A second pass has nothing left to do.
			assert.deepEqual(tightenPrivateFiles(dir, 'linux'), []);
		});
	});

	test('does nothing on Windows', () => {
		withDir((dir) => {
			writeFileSync(join(dir, 'mcp.json'), '{}');
			assert.deepEqual(tightenPrivateFiles(dir, 'win32'), []);
		});
	});

	test('names every userData file that holds a credential', () => {
		for (const name of ['mcp.json', 'secrets.json', 'cloud.json', 'auth.json', join('agent-console', 'mcp.json')]) {
			assert.ok(PRIVATE_USER_DATA_FILES.includes(name), name);
		}
	});
});

// Database exports (a local project's backups/) and pasted screenshots: folders only their owner
// can enter, files only their owner can read (an outside review, 2026-10-14).
describe('ensurePrivateDir and createPrivateFile', () => {
	test('a new folder is owner-only, and an existing open one is tightened', { skip: !posix }, () => {
		withDir((dir) => {
			const fresh = join(dir, 'a', 'backups');
			ensurePrivateDir(fresh);
			assert.equal(modeOf(fresh), 0o700);
			const open = join(dir, 'open');
			mkdirSync(open);
			chmodSync(open, 0o755);
			ensurePrivateDir(open);
			assert.equal(modeOf(open), 0o700);
		});
	});

	test('a link where the folder should be is refused, not followed', { skip: !posix }, () => {
		withDir((dir) => {
			const elsewhere = join(dir, 'elsewhere');
			mkdirSync(elsewhere);
			const link = join(dir, 'pasted-images');
			symlinkSync(elsewhere, link);
			assert.throws(() => ensurePrivateDir(link), /not a folder/);
		});
	});

	test('a file made for a stream is empty and owner-only, and so is one that was there', { skip: !posix }, () => {
		withDir((dir) => {
			const path = join(dir, 'x.dump');
			createPrivateFile(path);
			assert.equal(modeOf(path), 0o600);
			assert.equal(readFileSync(path, 'utf8'), '');
			writeFileSync(path, 'old');
			chmodSync(path, 0o644);
			createPrivateFile(path);
			assert.equal(modeOf(path), 0o600);
			assert.equal(readFileSync(path, 'utf8'), '');
		});
	});

	test('bytes are written as they are, owner-only', { skip: !posix }, () => {
		withDir((dir) => {
			const path = join(dir, 'paste.png');
			writePrivateFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
			assert.deepEqual([...readFileSync(path)], [0x89, 0x50, 0x4e, 0x47, 0xff]);
			assert.equal(modeOf(path), 0o600);
		});
	});
});

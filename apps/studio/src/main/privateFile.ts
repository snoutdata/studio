/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// A file that holds a token, a secret or its ciphertext is readable by its owner and nobody else.
// The default mode (0644 under the usual umask) lets every other account on a shared machine read
// it whenever the folder above it is world-readable, which is the default for ~/.config on Linux.

/** Owner read and write, nothing for group or others. */
export const PRIVATE_MODE = 0o600;

/** A folder only its owner can list or enter. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * The userData files that hold a credential: the local broker's token, the keychain-encrypted
 * secrets, the cloud accounts, the signed-in session, and the coding agent's copy of the broker
 * token. Relative to the userData folder.
 */
export const PRIVATE_USER_DATA_FILES = [
	'mcp.json',
	'secrets.json',
	'cloud.json',
	'auth.json',
	join('agent-console', 'mcp.json'),
	join('agent-console', 'settings.json'),
];

/**
 * Write `data` to `path` readable by its owner only. The bytes go to a fresh sibling first, which
 * is created with the private mode, and then replace the target in one rename, so a reader never
 * sees half a file and the target ends with the sibling's mode whatever mode it had before. On
 * Windows the mode is not a thing (the profile folder's ACL is what protects it) and the rename
 * still makes the write whole.
 */
export function writePrivateFile(path: string, data: string | Uint8Array, platform: NodeJS.Platform = process.platform): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
	const encoding = typeof data === 'string' ? 'utf8' : undefined;
	try {
		writeFileSync(temp, data, { encoding, mode: PRIVATE_MODE });
		if (platform !== 'win32') {
			// `mode` is masked by the umask on create; set it outright so the result does not depend on it.
			chmodSync(temp, PRIVATE_MODE);
		}
		renameSync(temp, path);
	} catch (err) {
		rmSync(temp, { force: true });
		// A rename can be refused on Windows while another program holds the target open (a virus
		// scanner, a sync client). Write in place then, still private, rather than lose the write.
		if (platform === 'win32' && existsSync(path)) {
			writeFileSync(path, data, { encoding, mode: PRIVATE_MODE });
			return;
		}
		throw err;
	}
	if (platform !== 'win32') {
		chmodSync(path, PRIVATE_MODE);
	}
}

/**
 * Take group and other access off every existing credential file under `userDataDir`, for files a
 * build that wrote them with the default mode left behind. Returns the files whose mode changed.
 * Does nothing on Windows. Never throws: a file it cannot change is left as it is and the next
 * write of that file replaces it with a private one anyway.
 */
export function tightenPrivateFiles(userDataDir: string, platform: NodeJS.Platform = process.platform, files: readonly string[] = PRIVATE_USER_DATA_FILES): string[] {
	if (platform === 'win32') {
		return [];
	}
	const changed: string[] = [];
	for (const name of files) {
		const path = join(userDataDir, name);
		try {
			if (!existsSync(path)) {
				continue;
			}
			if ((statSync(path).mode & 0o077) !== 0) {
				chmodSync(path, PRIVATE_MODE);
				changed.push(name);
			}
		} catch {
			// Left as it is; see above.
		}
	}
	return changed;
}

/**
 * Make `path` a folder only its owner can enter: created with the private mode, or, when it is
 * already there, checked and tightened. An existing one is trusted only when it is a real folder
 * (not a link to somewhere else) that belongs to this user, so a folder another account made first
 * in a shared place is never written into; that throws. On Windows the folder is created and the
 * profile's ACL is what protects it.
 */
export function ensurePrivateDir(path: string, platform: NodeJS.Platform = process.platform): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
	if (platform === 'win32') {
		return;
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${path} is not a folder`);
	}
	if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
		throw new Error(`${path} belongs to another account`);
	}
	if ((stat.mode & 0o777) !== PRIVATE_DIR_MODE) {
		chmodSync(path, PRIVATE_DIR_MODE);
	}
}

/**
 * Create `path` empty and readable by its owner only, for a writer that streams into it (a
 * `pg_dump`, say). An existing file is emptied and made private.
 */
export function createPrivateFile(path: string, platform: NodeJS.Platform = process.platform): void {
	closeSync(openSync(path, 'w', PRIVATE_MODE));
	if (platform !== 'win32') {
		chmodSync(path, PRIVATE_MODE);
	}
}

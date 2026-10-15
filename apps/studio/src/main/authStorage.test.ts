/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuthStorage, type AuthCrypto } from './authStorage';

/** A stand-in for safeStorage: reversible, and visibly not the plaintext. */
function crypto(available: boolean): AuthCrypto {
	return {
		available: () => available,
		encrypt: (value) => Buffer.from(`enc:${value}`, 'utf8'),
		decrypt: (data) => {
			const text = data.toString('utf8');
			if (!text.startsWith('enc:')) {
				throw new Error('not ours');
			}
			return text.slice(4);
		},
	};
}

function scratch(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), 'snout-auth-'));
	return { dir, path: join(dir, 'auth.json') };
}

const SESSION = '{"access_token":"eyJ.access","refresh_token":"r-123"}';

test('with encryption, the session is written encrypted and read back', () => {
	const { dir, path } = scratch();
	try {
		const store = new AuthStorage(path, crypto(true));
		store.setItem('positron-db-auth', SESSION);
		const disk = readFileSync(path, 'utf8');
		assert.ok(!disk.includes('r-123'));
		assert.ok(!disk.includes(Buffer.from(SESSION).toString('base64')));
		assert.equal(new AuthStorage(path, crypto(true)).getItem('positron-db-auth'), SESSION);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('without encryption, the session is kept for this run only and never written to disk', () => {
	const { dir, path } = scratch();
	const warned: string[] = [];
	try {
		const store = new AuthStorage(path, crypto(false), (m) => warned.push(m));
		store.setItem('positron-db-auth', SESSION);
		// Signed in for this run...
		assert.equal(store.getItem('positron-db-auth'), SESSION);
		// ...and nothing of it on disk, plain or encoded.
		const disk = existsSync(path) ? readFileSync(path, 'utf8') : '';
		assert.ok(!disk.includes('r-123'));
		assert.ok(!disk.includes(Buffer.from(SESSION).toString('base64')));
		// A new run starts signed out.
		assert.equal(new AuthStorage(path, crypto(false)).getItem('positron-db-auth'), null);
		assert.match(warned.join('\n'), /OS secret encryption is unavailable/);
		store.removeItem('positron-db-auth');
		assert.equal(store.getItem('positron-db-auth'), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a plain base64 session an older build left on disk is removed when the session is next written', () => {
	const { dir, path } = scratch();
	try {
		writeFileSync(path, JSON.stringify({ 'positron-db-auth': Buffer.from(SESSION).toString('base64') }));
		const store = new AuthStorage(path, crypto(false));
		store.setItem('positron-db-auth', SESSION);
		assert.ok(!readFileSync(path, 'utf8').includes(Buffer.from(SESSION).toString('base64')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

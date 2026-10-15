/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { markWeakSecretsWarned, usePlainTextSecrets, weakSecretsWarned } from './secretStorageMode';

test('Linux with no vault saves with the fixed key', () => {
	assert.equal(usePlainTextSecrets({ platform: 'linux', backend: 'basic_text', available: false }), true);
});

test('Linux with a working vault behaves as before', () => {
	for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
		assert.equal(usePlainTextSecrets({ platform: 'linux', backend, available: true }), false, backend);
	}
});

test('a vault that is present but unavailable is not downgraded', () => {
	assert.equal(usePlainTextSecrets({ platform: 'linux', backend: 'gnome_libsecret', available: false }), false);
	assert.equal(usePlainTextSecrets({ platform: 'linux', backend: 'unknown', available: false }), false);
});

test('basic_text that already reports available needs nothing', () => {
	assert.equal(usePlainTextSecrets({ platform: 'linux', backend: 'basic_text', available: true }), false);
});

test('never on macOS or Windows, whatever they report', () => {
	for (const platform of ['darwin', 'win32'] as const) {
		for (const available of [true, false]) {
			assert.equal(usePlainTextSecrets({ platform, backend: 'basic_text', available }), false, `${platform} ${available}`);
			assert.equal(usePlainTextSecrets({ platform, backend: 'unknown', available }), false, `${platform} ${available}`);
		}
	}
});

test('the warning is remembered per profile', () => {
	const dir = mkdtempSync(join(tmpdir(), 'secret-storage-'));
	try {
		assert.equal(weakSecretsWarned(dir), false);
		markWeakSecretsWarned(dir);
		assert.equal(weakSecretsWarned(dir), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

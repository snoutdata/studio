/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createClient } from './index.js';
import { fakeFetch } from './testing.js';
import { VERSION } from './version.js';

// The compiled test runs from dist/, so the package root is one folder up.
const root = new URL('../', import.meta.url);
const packageVersion = (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string }).version;

test('the version the client states is package.json\'s (npm version runs scripts/version.mjs)', () => {
	assert.equal(VERSION, packageVersion);
});

test('every request names this version in X-Client-Info', async () => {
	const { fetch, sent } = fakeFetch(() => ({ body: [] }));
	const db = createClient('https://abc123.api.snoutdata.com', 'anon-key', { global: { fetch }, auth: { autoRefreshToken: false, detectSessionInUrl: false } });
	await db.from('todos').select('id');
	assert.equal(sent[0].headers['x-client-info'], `snoutdata-js/${packageVersion}`);
});

test('the README pins its CDN import to this version', () => {
	const readme = readFileSync(new URL('README.md', root), 'utf8');
	const pinned = [...readme.matchAll(/@snoutdata\/client@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
	assert.ok(pinned.length > 0);
	assert.deepEqual([...new Set(pinned)], [packageVersion]);
});

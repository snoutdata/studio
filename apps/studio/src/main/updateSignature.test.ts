/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { signatureRefusal, WINDOWS_PUBLISHER_NAMES } from './updateSignature';

/** apps/studio/electron-builder.yml, found by walking up from wherever the test bundle sits. */
function builderConfig(): string {
	let dir = resolve(__dirname);
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, 'electron-builder.yml');
		if (existsSync(candidate)) {
			// A Windows checkout has CRLF line endings; the patterns below are written for LF.
			return readFileSync(candidate, 'utf8').replace(/\r\n/g, '\n');
		}
		dir = resolve(dir, '..');
	}
	const fromCwd = join(process.cwd(), 'electron-builder.yml');
	return readFileSync(fromCwd, 'utf8');
}

/** The quoted entries of the `publisherName:` list under `publish:`. */
function publishPublisherNames(yml: string): string[] {
	const publish = /^publish:\n((?:[ \t]+.*\n|\n)*)/m.exec(yml);
	assert.ok(publish, 'electron-builder.yml has a publish block');
	const list = /^[ \t]+publisherName:\n((?:[ \t]+-[ \t]+.*\n)+)/m.exec(publish[1]);
	assert.ok(list, 'the publish block lists publisherName');
	return list[1].split('\n').filter((line) => line.trim() !== '').map((line) => line.replace(/^[ \t]+-[ \t]+/, '').trim().replace(/^"(.*)"$/, '$1'));
}

describe('WINDOWS_PUBLISHER_NAMES', () => {
	test('matches what electron-builder writes into app-update.yml', () => {
		assert.deepEqual(publishPublisherNames(builderConfig()), [...WINDOWS_PUBLISHER_NAMES]);
	});

	test('is not set on the win block, where the signing module would reject it', () => {
		const win = /^win:\n((?:[ \t]+.*\n|\n)*)/m.exec(builderConfig());
		assert.ok(win);
		assert.ok(!/^[ \t]+publisherName:/m.test(win[1]));
	});

	test('names the organisation, not only a common name', () => {
		for (const name of WINDOWS_PUBLISHER_NAMES) {
			assert.match(name, /\bCN=/);
			assert.match(name, /\bO=/);
		}
	});
});

describe('signatureRefusal', () => {
	test('says the update was not installed, and keeps the detail short', () => {
		const message = signatureRefusal('1.0.50', 'x'.repeat(1000));
		assert.match(message, /v1\.0\.50 is not signed by SnoutData/);
		assert.ok(message.length < 450);
	});
});

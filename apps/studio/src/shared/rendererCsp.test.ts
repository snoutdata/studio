/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { rendererCsp } from './rendererCsp';

function directives(policy: string): Map<string, string[]> {
	return new Map(policy.split(';').map((part) => {
		const [name, ...sources] = part.trim().split(/\s+/);
		return [name, sources];
	}));
}

describe('rendererCsp', () => {
	const built = directives(rendererCsp(false));

	test('remote images cannot be loaded, so a reply cannot beacon data out', () => {
		const img = built.get('img-src') ?? [];
		assert.ok(!img.includes('https:'), 'no blanket https: images');
		assert.ok(!img.includes('*'), 'no wildcard images');
		assert.ok(img.every((source) => !source.includes('*')), 'no wildcard host');
		assert.deepEqual(img.filter((source) => source.startsWith('https://')), [
			'https://lh3.googleusercontent.com',
			'https://lh4.googleusercontent.com',
			'https://lh5.googleusercontent.com',
			'https://lh6.googleusercontent.com',
			'https://avatars.githubusercontent.com',
		]);
	});

	test('no file: image can load, so a markdown image cannot open an SMB connection to a host', () => {
		// The packaged page is a file: URL, where 'self' matches every file: URL, host included.
		const img = built.get('img-src') ?? [];
		assert.ok(!img.includes("'self'"), "no 'self' images in a packaged build");
		assert.ok(img.every((source) => !source.startsWith('file:')), 'no file: images');
		assert.ok(img.includes('data:'), 'the app\'s own pictures are inlined');
	});

	test('the page itself makes no remote connections, and runs no inline or eval script', () => {
		assert.deepEqual(built.get('script-src'), ["'self'"]);
		assert.ok((built.get('connect-src') ?? []).every((source) => !/^(https?|wss?):/.test(source)));
		assert.deepEqual(built.get('object-src'), ["'none'"]);
		assert.deepEqual(built.get('base-uri'), ["'none'"]);
		assert.deepEqual(built.get('form-action'), ["'none'"]);
	});

	test('what the app needs stays allowed', () => {
		assert.ok(built.get('worker-src')?.includes('blob:'), 'Monaco can fall back to a blob worker');
		assert.ok(built.get('connect-src')?.includes('sentry-ipc:'), 'Sentry reaches main');
		assert.ok(built.get('style-src')?.includes("'unsafe-inline'"), 'inline styles');
		assert.ok(built.get('font-src')?.includes("'self'"), 'the codicon font');
	});

	test('only a dev run allows the inline refresh preamble and the HMR socket', () => {
		const dev = directives(rendererCsp(true));
		assert.ok(dev.get('script-src')?.includes("'unsafe-inline'"));
		assert.ok(dev.get('connect-src')?.some((source) => source.startsWith('ws://localhost')));
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { appPageUrl, isAllowedSubframeUrl, isAppPageUrl, isExternalOpenable, isPermissionAllowed } from './appOrigin';

const FILE_APP = 'file:///Applications/SnoutData%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html';
const DEV_APP = 'http://localhost:5173';

describe('appPageUrl', () => {
	test('is the dev server in a dev run', () => {
		assert.equal(appPageUrl('http://localhost:5173', '/x/index.html'), 'http://localhost:5173');
	});
	test('is the built index.html as a file URL otherwise', () => {
		// On Windows a rooted path gains the current drive (file:///C:/x/…), so only the shape is fixed.
		assert.match(appPageUrl(undefined, '/x/out renderer/index.html'), /^file:\/\/\/(?:[A-Za-z]:\/)?x\/out%20renderer\/index\.html$/);
	});
});

describe('isAppPageUrl', () => {
	test('the built page, with or without a hash or query', () => {
		assert.equal(isAppPageUrl(FILE_APP, FILE_APP), true);
		assert.equal(isAppPageUrl(`${FILE_APP}#/tab`, FILE_APP), true);
		assert.equal(isAppPageUrl(`${FILE_APP}?x=1`, FILE_APP), true);
		assert.equal(isAppPageUrl('file:///Applications/SnoutData Studio.app/Contents/Resources/app.asar/out/renderer/index.html', FILE_APP), true);
	});
	test('another local file is not the app', () => {
		assert.equal(isAppPageUrl('file:///tmp/evil.html', FILE_APP), false);
		assert.equal(isAppPageUrl('file:///Applications/SnoutData%20Studio.app/Contents/Resources/app.asar/out/renderer/other.html', FILE_APP), false);
	});
	test('a remote page is never the app', () => {
		assert.equal(isAppPageUrl('https://evil.example/x', FILE_APP), false);
		assert.equal(isAppPageUrl('https://evil.example/x', DEV_APP), false);
		assert.equal(isAppPageUrl('http://localhost:5174/', DEV_APP), false);
		assert.equal(isAppPageUrl('data:text/html,<h1>x</h1>', FILE_APP), false);
		assert.equal(isAppPageUrl('about:blank', FILE_APP), false);
	});
	test('the dev server, on any path', () => {
		assert.equal(isAppPageUrl('http://localhost:5173/', DEV_APP), true);
		assert.equal(isAppPageUrl('http://localhost:5173/index.html#x', DEV_APP), true);
	});
	test('nothing, or garbage, is not the app', () => {
		assert.equal(isAppPageUrl(undefined, FILE_APP), false);
		assert.equal(isAppPageUrl(null, FILE_APP), false);
		assert.equal(isAppPageUrl('', FILE_APP), false);
		assert.equal(isAppPageUrl('not a url', FILE_APP), false);
	});
	test('Windows paths compare without case', () => {
		const win = 'file:///C:/Program%20Files/SnoutData/resources/app.asar/out/renderer/index.html';
		assert.equal(isAppPageUrl('file:///c:/program files/snoutdata/resources/app.asar/out/renderer/index.html', win, 'win32'), true);
		assert.equal(isAppPageUrl('file:///c:/program files/snoutdata/resources/app.asar/out/renderer/index.html', win, 'darwin'), false);
	});
});

describe('isExternalOpenable', () => {
	test('http, https and mailto are opened', () => {
		assert.equal(isExternalOpenable('https://snoutdata.com/docs'), true);
		assert.equal(isExternalOpenable('http://example.com'), true);
		assert.equal(isExternalOpenable('mailto:someone@example.com'), true);
	});
	test('every other scheme is refused', () => {
		for (const url of [
			'file:///etc/passwd',
			'javascript:alert(1)',
			'data:text/html,x',
			'search-ms:query=x',
			'ms-settings:',
			'smb://host/share',
			'vscode://x',
			'snoutdata://auth',
			'https://',
			'',
			'not a url',
		]) {
			assert.equal(isExternalOpenable(url), false, url);
		}
		assert.equal(isExternalOpenable(undefined), false);
		assert.equal(isExternalOpenable(`https://x.example/${'a'.repeat(9000)}`), false);
	});
});

describe('isAllowedSubframeUrl', () => {
	test('inline documents and the app page only', () => {
		assert.equal(isAllowedSubframeUrl('about:srcdoc', FILE_APP), true);
		assert.equal(isAllowedSubframeUrl('about:blank', FILE_APP), true);
		assert.equal(isAllowedSubframeUrl(FILE_APP, FILE_APP), true);
		assert.equal(isAllowedSubframeUrl('https://evil.example/', FILE_APP), false);
	});
});

describe('isPermissionAllowed', () => {
	test('the app page keeps the clipboard and notifications', () => {
		assert.equal(isPermissionAllowed('clipboard-read', FILE_APP, FILE_APP), true);
		assert.equal(isPermissionAllowed('clipboard-sanitized-write', FILE_APP, FILE_APP), true);
		assert.equal(isPermissionAllowed('notifications', FILE_APP, FILE_APP), true);
	});
	test('the app page is refused devices, capture and protocol handlers', () => {
		for (const permission of ['media', 'geolocation', 'display-capture', 'hid', 'serial', 'usb', 'openExternal']) {
			assert.equal(isPermissionAllowed(permission, FILE_APP, FILE_APP), false, permission);
		}
	});
	test('any other page is refused everything', () => {
		assert.equal(isPermissionAllowed('clipboard-read', 'https://evil.example/', FILE_APP), false);
		assert.equal(isPermissionAllowed('notifications', undefined, FILE_APP), false);
	});
});

describe('isExternalOpenable, https only', () => {
	test('a sign-in address handed back by the auth server opens only over https', () => {
		assert.equal(isExternalOpenable('https://accounts.snoutdata.com/sso/saml?x=1', { httpsOnly: true }), true);
		for (const url of ['http://idp.example.com/login', 'mailto:x@example.com', 'file:///etc/passwd', 'snoutdata://auth-callback', 'javascript:alert(1)', 'https://']) {
			assert.equal(isExternalOpenable(url, { httpsOnly: true }), false, url);
		}
	});
});

/** apps/studio/src/main, found by walking up from wherever the test bundle sits. */
function mainSourceDir(): string {
	for (let dir = resolve(__dirname); ; dir = resolve(dir, '..')) {
		const candidate = join(dir, 'src', 'main');
		if (existsSync(join(candidate, 'navigationGuard.ts'))) {
			return candidate;
		}
		if (resolve(dir, '..') === dir) {
			return join(process.cwd(), 'src', 'main');
		}
	}
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

test('nothing in main hands a URL to the OS except through navigationGuard', () => {
	const dir = mainSourceDir();
	const offenders = sourceFiles(dir)
		.filter((file) => !file.endsWith('navigationGuard.ts'))
		.filter((file) => /shell\s*\.\s*openExternal\s*\(/.test(readFileSync(file, 'utf8')));
	assert.deepEqual(offenders.map((f) => f.slice(dir.length + 1)), []);
});

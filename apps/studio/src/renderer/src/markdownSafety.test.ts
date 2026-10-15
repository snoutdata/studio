/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { blockedImageLabel, externalLinkTarget, isInlineResourceUrl, referencesRemoteUrl } from './markdownSafety';

describe('isInlineResourceUrl', () => {
	test('data images and blobs need no request', () => {
		assert.equal(isInlineResourceUrl('data:image/png;base64,AAAA'), true);
		assert.equal(isInlineResourceUrl(' DATA:image/svg+xml,<svg/>'), true);
		assert.equal(isInlineResourceUrl('blob:file:///abc'), true);
	});
	test('anything that would fetch is not inline', () => {
		for (const url of [
			'https://attacker.example/p?d=secret',
			'http://attacker.example/p',
			'//attacker.example/p',
			'file:///etc/passwd',
			'relative/path.png',
			'data:text/html,<script>1</script>',
			'',
		]) {
			assert.equal(isInlineResourceUrl(url), false, url);
		}
		assert.equal(isInlineResourceUrl(null), false);
	});
});

describe('externalLinkTarget', () => {
	test('http, https and mailto go to the system browser', () => {
		assert.equal(externalLinkTarget('https://snoutdata.com/docs'), 'https://snoutdata.com/docs');
		assert.equal(externalLinkTarget('http://example.com'), 'http://example.com/');
		assert.equal(externalLinkTarget('mailto:a@example.com'), 'mailto:a@example.com');
	});
	test('relative links, anchors and other schemes go nowhere', () => {
		for (const href of ['#section', 'other.html', '/etc/passwd', 'file:///etc/passwd', 'javascript:alert(1)', 'search-ms:query=x', 'data:text/html,x', '']) {
			assert.equal(externalLinkTarget(href), undefined, href);
		}
		assert.equal(externalLinkTarget(null), undefined);
	});
});

describe('blockedImageLabel', () => {
	test('names the image and the host it would have come from', () => {
		assert.equal(blockedImageLabel('https://attacker.example/p?d=1', 'chart'), '"chart" not loaded, from attacker.example');
		assert.equal(blockedImageLabel('https://attacker.example/p', ''), 'Image not loaded, from attacker.example');
		assert.equal(blockedImageLabel('relative.png', null), 'Image not loaded');
	});
});

// An SVG paint, filter, mask, clip path or marker can name a URL in any attribute (`fill="url(...)"`),
// and the renderer fetches it as it paints. Only a reference to something on the page itself
// (`url(#gradient)`) is kept.
describe('referencesRemoteUrl', () => {
	test('a url() that leaves the page is caught, however it is written', () => {
		for (const value of [
			'url(https://attacker.example/p?d=secret)',
			'url("https://attacker.example/f.svg#x")',
			"url( 'http://attacker.example/m' )",
			'URL(//attacker.example/c)',
			'red url(https://attacker.example/x) none',
			'u\\72l(https://attacker.example/x)',
			'url/**/(https://attacker.example/x)',
			'url(data:image/svg+xml,<svg/>)',
			'url(#ok) url(https://attacker.example/x)',
			'url()',
		]) {
			assert.equal(referencesRemoteUrl(value), true, value);
		}
	});
	test('a reference to the page itself, or no url() at all, is left alone', () => {
		for (const value of ['url(#gradient)', 'url( "#clip" )', 'red', 'M0 0 L10 10', 'https://example.com/not-a-css-url', '']) {
			assert.equal(referencesRemoteUrl(value), false, value);
		}
	});
});

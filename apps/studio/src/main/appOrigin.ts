/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which page is the app, and which links may leave it. Pure, so it is tested without Electron.
//
// The main window carries the preload, and so `window.sqlApi`: every IPC handler in main, which
// together can run SQL on every saved connection, write any file and start a process. That power
// belongs to exactly one page, the app's own index.html (or the dev server in a dev run). A link in
// a chat reply must not take the window anywhere else, since the page it landed on would inherit
// the preload. So:
//
// - the window may only ever show the app page (navigationGuard.ts refuses everything else and
//   hands an http(s)/mailto link to the system browser instead), and
// - main answers IPC only from a frame showing the app page (ipcSenderGuard.ts), so even a page
//   that somehow got in is answered by nothing.

import { pathToFileURL } from 'node:url';

/** The URL the main window loads: the dev server in a dev run, otherwise the built index.html. */
export function appPageUrl(devServerUrl: string | undefined, indexHtmlPath: string): string {
	if (devServerUrl) {
		return devServerUrl;
	}
	return pathToFileURL(indexHtmlPath).href;
}

/**
 * True when `url` is the app's own page. A file page must be the same file (its query and hash
 * may differ); a dev-server page must be on the same origin. Anything unparseable is not the app.
 * File paths are compared decoded and, on Windows, case-insensitively, since Chromium and Node do
 * not always agree on the spelling of the same path.
 */
export function isAppPageUrl(url: string | undefined | null, appUrl: string, platform: string = process.platform): boolean {
	if (!url) {
		return false;
	}
	let candidate: URL;
	let app: URL;
	try {
		candidate = new URL(url);
		app = new URL(appUrl);
	} catch {
		return false;
	}
	if (app.protocol === 'file:') {
		if (candidate.protocol !== 'file:' || candidate.host !== app.host) {
			return false;
		}
		const a = filePath(candidate.pathname);
		const b = filePath(app.pathname);
		if (a === undefined || b === undefined) {
			return false;
		}
		return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
	}
	if (app.protocol === 'http:' || app.protocol === 'https:') {
		return candidate.origin === app.origin;
	}
	return false;
}

function filePath(pathname: string): string | undefined {
	try {
		return decodeURIComponent(pathname).replace(/\\/g, '/');
	} catch {
		return undefined;
	}
}

/** The schemes a link may be handed to the operating system with. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * True when `url` may be opened in the system browser / mail client: http, https or mailto only.
 * `httpsOnly` narrows that to https, for an address the app did not write itself (the sign-in
 * address the auth server hands back).
 */
export function isExternalOpenable(url: string | undefined | null, options: { httpsOnly?: boolean } = {}): boolean {
	if (typeof url !== 'string' || url.length > 8192) {
		return false;
	}
	try {
		const parsed = new URL(url);
		if (!EXTERNAL_SCHEMES.has(parsed.protocol) || (options.httpsOnly && parsed.protocol !== 'https:')) {
			return false;
		}
		// An http(s) URL must name a host.
		return parsed.protocol === 'mailto:' || parsed.hostname !== '';
	} catch {
		return false;
	}
}

/** A subframe may show the app page or an inline document (`about:blank`, `about:srcdoc`), nothing else. */
export function isAllowedSubframeUrl(url: string, appUrl: string): boolean {
	return url === 'about:blank' || url === 'about:srcdoc' || isAppPageUrl(url, appUrl);
}

/**
 * Permissions refused even to the app's OWN page: nothing in the app needs a camera, a
 * microphone, the location, a USB, HID, serial, MIDI or Bluetooth device, screen capture, or to
 * launch an OS protocol handler from a navigation (links leave through shell.openExternal, which
 * is not a page permission). Every permission for any OTHER page is refused outright.
 */
const REFUSED_TO_APP = new Set([
	'media',
	'mediaKeySystem',
	'geolocation',
	'display-capture',
	'hid',
	'serial',
	'usb',
	'midi',
	'midiSysex',
	'bluetooth',
	'speaker-selection',
	'idle-detection',
	'openExternal',
]);

/** True when a permission request or check should be granted. `requestingUrl` is the page asking. */
export function isPermissionAllowed(permission: string, requestingUrl: string | undefined | null, appUrl: string): boolean {
	return !REFUSED_TO_APP.has(permission) && isAppPageUrl(requestingUrl, appUrl);
}

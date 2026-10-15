/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Electron half of appOrigin.ts: keep the main window on the app page, answer IPC only from
// it, and refuse the permissions nothing in the app needs.

import { app, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isAllowedSubframeUrl, isAppPageUrl, isExternalOpenable, isPermissionAllowed } from './appOrigin';

/**
 * Every web contents the app creates refuses `<webview>` and, unless the window that owns it says
 * otherwise (the main window opens http(s) links in the browser; the page-render window has its
 * own rules), refuses to open a child window. Installed once, before any window exists.
 */
export function installGlobalWebContentsGuard(): void {
	app.on('web-contents-created', (_event, contents) => {
		contents.on('will-attach-webview', (event) => {
			event.preventDefault();
		});
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
	});
}

/**
 * Hand a link to the system browser or mail client, if its scheme is one we allow (https only with
 * `httpsOnly`). The ONLY place main calls shell.openExternal; appOrigin.test.ts holds it to that.
 */
export function openExternalIfAllowed(url: string, options: { httpsOnly?: boolean } = {}): Promise<void> | undefined {
	if (isExternalOpenable(url, options)) {
		return shell.openExternal(url);
	}
	return undefined;
}

/**
 * Keep `contents` (the main window) on the app page. A navigation anywhere else is cancelled; when
 * it was the top frame going to an http(s) or mailto link, the link opens in the system browser
 * instead, so a link the renderer failed to intercept still does what the user meant. A request
 * for a new window is always refused, and handed to the browser the same way.
 */
export function guardAppWindow(contents: WebContents, appUrl: string): void {
	contents.on('will-navigate', (event, url) => {
		if (!isAppPageUrl(url, appUrl)) {
			event.preventDefault();
			void openExternalIfAllowed(url);
		}
	});
	contents.on('will-frame-navigate', (event) => {
		const { url, isMainFrame } = event;
		if (isMainFrame ? isAppPageUrl(url, appUrl) : isAllowedSubframeUrl(url, appUrl)) {
			return;
		}
		event.preventDefault();
	});
	contents.on('will-redirect', (event) => {
		const { url, isMainFrame } = event;
		if (isMainFrame ? isAppPageUrl(url, appUrl) : isAllowedSubframeUrl(url, appUrl)) {
			return;
		}
		event.preventDefault();
	});
	contents.setWindowOpenHandler(({ url }) => {
		void openExternalIfAllowed(url);
		return { action: 'deny' };
	});
}

/**
 * Refuse, on the default session, every permission a page other than the app asks for, and the
 * sensitive ones (camera, microphone, devices, protocol handlers) even to the app.
 */
export function installDefaultSessionPermissions(appUrl: string): void {
	const ses = session.defaultSession;
	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		callback(isPermissionAllowed(permission, details?.requestingUrl ?? contents?.getURL(), appUrl));
	});
	ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
		return isPermissionAllowed(permission, details?.requestingUrl ?? contents?.getURL(), appUrl);
	});
}

/** Thrown into an `invoke` from a page that is not the app. */
const REFUSED = 'Refused: this request did not come from the SnoutData Studio window.';

function fromApp(event: IpcMainEvent | IpcMainInvokeEvent, appUrl: () => string | undefined): boolean {
	const expected = appUrl();
	if (!expected) {
		return false;
	}
	let frameUrl: string | undefined;
	try {
		// `senderFrame` is null once the frame has navigated away or been destroyed, and that
		// is a frame we no longer trust either.
		frameUrl = event.senderFrame?.url;
	} catch {
		frameUrl = undefined;
	}
	return isAppPageUrl(frameUrl, expected);
}

/**
 * Make every IPC handler registered from here on answer only the app page. One wrapper around
 * `ipcMain.handle` / `handleOnce` / `on` / `once` covers every channel, including ones added
 * later, without each handler having to remember the check. `appUrl` is read on each call, so it
 * may be set after the handlers are registered (the window is created after registerIpc).
 */
export function installIpcSenderGuard(appUrl: () => string | undefined): void {
	const handle = ipcMain.handle.bind(ipcMain);
	const handleOnce = ipcMain.handleOnce.bind(ipcMain);
	const on = ipcMain.on.bind(ipcMain);
	const once = ipcMain.once.bind(ipcMain);
	type Invoke = Parameters<typeof ipcMain.handle>[1];
	type Listener = Parameters<typeof ipcMain.on>[1];
	function guardInvoke(listener: Invoke): Invoke {
		return (event, ...args) => {
			if (!fromApp(event, appUrl)) {
				throw new Error(REFUSED);
			}
			return listener(event, ...args);
		};
	}
	function guardListener(listener: Listener): Listener {
		return (event, ...args) => {
			if (!fromApp(event, appUrl)) {
				event.returnValue = undefined;
				return;
			}
			listener(event, ...args);
		};
	}
	ipcMain.handle = (channel, listener) => handle(channel, guardInvoke(listener));
	ipcMain.handleOnce = (channel, listener) => handleOnce(channel, guardInvoke(listener));
	ipcMain.on = (channel, listener) => on(channel, guardListener(listener));
	ipcMain.once = (channel, listener) => once(channel, guardListener(listener));
}

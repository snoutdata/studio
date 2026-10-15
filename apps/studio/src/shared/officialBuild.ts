/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which build this is: the OFFICIAL one (made from a checkout that carries the private code, the
// one published to the release feed) or a build from the open-source tree. Compiled in by
// scripts/pro.mjs (`define`), the same way the Sentry DSN is; a bundle without the define, which is
// what a stranger's build of the open tree would be if the define were ever dropped, counts as NOT
// official, so the safe answer is the default.
//
// What an open build does differently is decided here, pure, so a test can hold it:
//   * it never sends the install heartbeat or the daily activity ping (main/installHeartbeat.ts),
//   * it never asks the official feed for an update, never installs one, and never enforces the
//     official build's minimum version (main/updater.ts, main/index.ts). A build from source is
//     updated by building the source again.
//   * it keeps its own profile (OPEN_BUILD_PROFILE), never registers the official `snoutdata://`
//     scheme, and so signs in through a one-shot listener on 127.0.0.1 (main/authStore.ts), so it
//     can neither open the official app's profile nor take its sign-in callback.

declare const __SNOUT_OFFICIAL_BUILD__: boolean | undefined;

export const OFFICIAL_BUILD: boolean = typeof __SNOUT_OFFICIAL_BUILD__ === 'boolean' ? __SNOUT_OFFICIAL_BUILD__ : false;

export interface PingGate {
	/** This is the official build. */
	official: boolean;
	/** A packaged install, not a dev run. */
	packaged: boolean;
	/** The user has not switched telemetry off. */
	telemetry: boolean;
}

/** Whether the install heartbeat and the activity ping may be sent at all. */
export function installPingAllowed(gate: PingGate): boolean {
	return gate.official && gate.packaged && gate.telemetry;
}

/** What "check for updates" does in this build:
 *  - `from-source`: an open build, which has no feed; the check says so and asks nothing.
 *  - `up-to-date`: a dev run, or Linux (apt owns updates); reported as up to date, nothing asked.
 *  - `feed`: the official, packaged build asks the release feed. */
export type UpdateCheckRoute = 'from-source' | 'up-to-date' | 'feed';

export function updateCheckRoute(o: { official: boolean; packaged: boolean; platform: string }): UpdateCheckRoute {
	if (!o.official) {
		return 'from-source';
	}
	if (!o.packaged || o.platform === 'linux') {
		return 'up-to-date';
	}
	return 'feed';
}

/** Whether the minimum-supported-version check runs. It is the official build's rule about the
 *  official feed's versions, and an open build's version means nothing to it. */
export function minimumVersionCheckAllowed(o: { official: boolean; packaged: boolean; devOverride: boolean }): boolean {
	return o.official && (o.packaged || o.devOverride);
}

/** The folder an OPEN build keeps its profile in, under the OS's app-data folder (a dev run adds
 *  `-dev`, as the official one does). Also the open tree's package name (scripts/open-source), so
 *  the executable, the Linux package and the window class all differ from the official app's. */
export const OPEN_BUILD_PROFILE = 'snoutdata-studio-oss';

/** Where the browser hands a sign-in back:
 *  - `site`: the official packaged app, through snoutdata.com/signed-in to `snoutdata://`.
 *  - `loopback`: a one-shot listener on 127.0.0.1, which a dev run uses and an open build always
 *    does, since it never registers `snoutdata://` (that scheme belongs to the official app). */
export type SignInReturn = 'site' | 'loopback';

export function signInReturn(o: { official: boolean; packaged: boolean }): SignInReturn {
	return o.official && o.packaged ? 'site' : 'loopback';
}

/** Whether this build registers the official `snoutdata://` scheme with the OS. */
export function registersAuthProtocol(official: boolean): boolean {
	return official;
}

/** Studio's repository: the source and the official releases live in one place, so both builds name it. */
export const REPOSITORY_URL = 'https://github.com/snoutdata/studio';

/** Where "Report an issue" goes, from either build. */
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;

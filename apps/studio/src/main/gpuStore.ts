/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Hardware acceleration (GPU rendering), with a Settings escape hatch.
//
// Why this exists: Chromium renders through the GPU process, and when that process keeps crashing
// it walks down a fallback ladder (full accel -> partial -> software). If it runs out of rungs it
// deliberately aborts the whole app —
//   `IntentionallyCrashBrowserForUnusableGpuProcess`: "GPU process isn't usable. Goodbye."
// which reaches the user as a hard crash with no recourse, and reaches us as an EXCEPTION_BREAKPOINT
// minidump. It is not our bug (a stale/broken vendor driver is the usual cause) but it is our
// user's dead app, and the only lever that avoids it is refusing the GPU up front. Observed on
// Intel UHD 750 / driver 31.0.101.5334, Windows.
//
// Opt-OUT, exactly like telemetry: acceleration is ON by default, so nobody's rendering changes
// unless they ask. The toggle only matters for the minority on bad drivers.
//
// A Settings toggle alone doesn't actually rescue the user it's for: when Chromium aborts, the app
// is gone, so there is no UI left to open. That's why {@link recordGpuCrash} watches the GPU
// process and turns acceleration off for the NEXT launch on its own. The user is told why (see
// autoDisabled) and can always overrule it.
//
// The read has to be synchronous and pre-`ready`, because app.disableHardwareAcceleration() is
// only honored before the app is ready — there is no post-hoc switch. It's one small JSON read
// on the boot path (~1ms, same cost as the telemetry read next to it), which is the price of the
// setting existing at all; it must not grow beyond that.

interface GpuSettings {
	/** The effective choice. Absent reads as enabled. */
	enabled?: boolean;
	/** True when WE turned it off after repeated crashes, not the user. Drives the Settings
	 *  explanation, so the change never looks like the app silently deciding on its own. */
	autoDisabled?: boolean;
	/** Lifetime GPU crash tally. Diagnostic only: the auto-disable triggers on a burst within
	 *  one session, not on this. */
	crashes?: number;
}

// GPU crashes seen in THIS session. The trigger is a burst, not a lifetime total: Chromium walks
// its fallback ladder within a single run and aborts the app once it runs out, so repeated crashes
// close together are the signal that this machine's GPU is unusable. A lone crash months apart is
// a driver hiccup Chromium already recovered from, and downgrading someone's rendering for that
// would be a worse bug than the one we're fixing.
let sessionCrashes = 0;

// Two crashes in one session. Chromium needs at least two ladder steps before it gives up and
// kills the browser, so this lands before the fatal one while still ignoring a single hiccup.
const AUTO_DISABLE_THRESHOLD = 2;

// Test seam. The crash-counting below only ever runs on hardware whose GPU driver is failing, so
// it cannot be exercised by hand — but it's the code that decides whether a user's app is usable,
// so it needs to be tested. Under `node --test` the bundle has no live Electron `app` to ask for
// userData (same constraint netFetch.ts works around), hence the override. Nothing in the app
// calls this; production always resolves through `app`.
let userDataDirOverride: string | undefined;

/** Point the store at a temp dir and clear session state. Tests only. */
export function __resetGpuStoreForTests(dir: string): void {
	userDataDirOverride = dir;
	sessionCrashes = 0;
}

function filePath(): string {
	return join(userDataDirOverride ?? app.getPath('userData'), 'gpu.json');
}

function read(): GpuSettings {
	try {
		return JSON.parse(readFileSync(filePath(), 'utf8')) as GpuSettings;
	} catch {
		return {};
	}
}

function write(next: GpuSettings): void {
	const path = filePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
}

/** Whether GPU rendering is enabled. Defaults to true (opt-out); a missing or malformed file
 *  reads as enabled, so a corrupt settings file can never leave a user in software rendering. */
export function hardwareAccelerationEnabled(): boolean {
	return read().enabled !== false;
}

/** True when the app disabled acceleration itself after repeated crashes. */
export function hardwareAccelerationAutoDisabled(): boolean {
	const state = read();
	return state.enabled === false && state.autoDisabled === true;
}

/** Apply the saved choice. MUST be called before app `ready` — Electron ignores
 *  disableHardwareAcceleration() afterwards. No-op when acceleration is left on (the default),
 *  so the normal path costs one file read and nothing else. */
export function applyHardwareAcceleration(): void {
	if (hardwareAccelerationEnabled()) {
		return;
	}
	app.disableHardwareAcceleration();
}

/** Persist the user's toggle. Takes effect on the next launch (Electron fixes the GPU decision at
 *  startup), so the caller is responsible for telling the user a restart is needed — silently
 *  doing nothing until relaunch would read as a broken switch.
 *
 *  Turning it back ON clears the auto-disable state and the tally: the user is explicitly
 *  overruling us (new driver, new hardware), and they deserve a clean slate rather than being
 *  re-disabled by crashes we counted before they intervened. If the GPU really is still broken,
 *  this session's crashes will trip the threshold again on their own. */
export function setHardwareAccelerationEnabled(enabled: boolean): boolean {
	const state = read();
	if (enabled) {
		sessionCrashes = 0;
		write({ enabled: true, crashes: 0 });
	} else {
		write({ ...state, enabled: false, autoDisabled: false });
	}
	return enabled;
}

/** Record a GPU process crash. Returns true if this one tripped the threshold and turned
 *  acceleration off for the next launch.
 *
 *  Persisting immediately matters: when Chromium exhausts its fallback ladder it takes the whole
 *  browser process down with no unwind and no chance to save on exit, so the write has to happen
 *  on each crash rather than at quit. This is the path that reaches a user whose app dies on
 *  launch — they can't open Settings to fix it themselves. */
export function recordGpuCrash(): boolean {
	sessionCrashes++;
	const state = read();
	const crashes = (state.crashes ?? 0) + 1;
	// Already off (by us or by them): just keep the tally honest.
	if (state.enabled === false) {
		write({ ...state, crashes });
		return false;
	}
	if (sessionCrashes < AUTO_DISABLE_THRESHOLD) {
		write({ ...state, crashes });
		return false;
	}
	write({ enabled: false, autoDisabled: true, crashes });
	return true;
}

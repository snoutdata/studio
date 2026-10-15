/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { installPingAllowed, OFFICIAL_BUILD } from '../shared/officialBuild';
import { getCloudClient } from './cloudClient';
import { telemetryEnabled } from './telemetry';

// Anonymous install / first-run heartbeat: it counts installs, signed in or not. On each
// launch we send the install's random id + basic platform facts to the `record_install` RPC; the
// server inserts on first run and bumps last_seen/ping_count after that.
// Once the user signs in, the same call (now carrying their JWT) stitches the install to the
// account, so we can see the download -> install -> sign-in funnel in one place.
//
// Gated on the official build (a build from the open-source tree never sends it, as it ships no
// Sentry DSN), on the SAME opt-out as Sentry (telemetryEnabled) and on a packaged build, so a user
// who turned telemetry off is not tracked, and dev runs never inflate the numbers. Fully best-effort:
// any failure is swallowed and never touches startup (callers defer it off the boot path).

// Hard cap on the ping's network round-trip. The call is already fire-and-forget on an unref'd
// timer (so it never holds the process open), but bound it anyway so a hung/unreachable backend
// drops the request instead of leaving a socket dangling. On timeout the abort rejects the rpc,
// which the catch below swallows — no retry, no surfaced error.
const HEARTBEAT_TIMEOUT_MS = 8000;

interface InstallFile {
	id: string;
	createdAt: string;
	/** UTC day (YYYY-MM-DD) an activity ping was last sent, so we send at most one per day. */
	lastActiveOn?: string;
}

function filePath(): string {
	return join(app.getPath('userData'), 'install.json');
}

// The file, read once and kept in memory. markActive() is called from the query path, so it must
// not touch the disk on every call.
let cached: InstallFile | undefined;

function readInstallFile(): InstallFile {
	if (cached) {
		return cached;
	}
	const path = filePath();
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallFile>;
		if (typeof raw.id === 'string' && raw.id.length > 0) {
			cached = { id: raw.id, createdAt: raw.createdAt ?? new Date().toISOString(), lastActiveOn: raw.lastActiveOn };
			return cached;
		}
	} catch {
		// missing or malformed — fall through and create a fresh id
	}
	cached = { id: randomUUID(), createdAt: new Date().toISOString() };
	writeInstallFile(cached);
	return cached;
}

function writeInstallFile(file: InstallFile): void {
	try {
		mkdirSync(dirname(filePath()), { recursive: true });
		writeFileSync(filePath(), JSON.stringify(file, null, 2), 'utf8');
	} catch {
		// If we can't persist, carry on with the in-memory copy (next launch just regenerates).
	}
}

/** This install's stable random id, created once and persisted to userData/install.json. It is not
 *  tied to any account or hardware — just a per-installation marker so launches dedupe to one row. */
function installId(): string {
	return readInstallFile().id;
}

/** Today in UTC. The server stamps `current_date`, which is UTC, so matching on UTC here keeps the
 *  "already sent today" check aligned with the value actually stored. */
function utcToday(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Both pings' gate: the official build, packaged, telemetry not opted out. */
function pingAllowed(): boolean {
	return installPingAllowed({ official: OFFICIAL_BUILD, packaged: app.isPackaged, telemetry: telemetryEnabled() });
}

/** Record one heartbeat for this install. Safe to call on every launch and again right after
 *  sign-in (so user_id stitches immediately). No-op in an open build, when telemetry is opted out,
 *  or in dev. */
export async function sendInstallHeartbeat(): Promise<void> {
	if (!pingAllowed()) {
		return;
	}
	try {
		await getCloudClient()
			.procedure('record_install', {
				p_install_id: installId(),
				p_platform: process.platform,
				p_arch: process.arch,
				p_app_version: app.getVersion(),
				p_locale: app.getLocale() || null,
			})
			.abortSignal(AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS));
	} catch {
		// Best-effort analytics: never surface or retry. A missed ping just isn't counted.
	}
}

// --- Activity ("was the app actually USED today") ------------------------------------------------
//
// sendInstallHeartbeat() above answers "was it LAUNCHED". That is not the same question, and it is
// the wrong one for "has this account gone quiet": the window's close button HIDES the app (it
// lives in the tray), so somebody who uses it every day but never restarts pings once and then
// looks dormant forever.
//
// This is the smallest thing that fixes it. markActive() is called from the two places that mean a
// human is actually working — the window taking focus, and an INTERACTIVE query being dispatched
// (a background query is the dashboards poller or a schedule, which is the app working by itself
// and must never count). It records ONE fact, a day, at most ONCE per day:
//
//   * the payload is the install id and nothing else — no platform, version, locale or IP; the
//     launch heartbeat already has those and this has no reason to repeat them,
//   * the column is a DATE, so no working hours or time zone are revealed,
//   * `record_activity` is UPDATE-only, so a ping can never create a row,
//   * one write per day means the stored value cannot describe a session, only a day.
//
// Same gate as everything else here: the official build, packaged, telemetry not opted out,
// entirely best-effort. A missed ping just means the day is not counted.

// Wait this long after the first sign of activity before sending, so a burst of queries or a
// window being focused repeatedly collapses into one call.
const ACTIVITY_DEBOUNCE_MS = 45000;

let activityTimer: NodeJS.Timeout | undefined;

/** Note that a human did something. Cheap and safe to call on a hot path: after the first call of
 *  the day it is a string comparison and an early return. */
export function markActive(): void {
	if (!pingAllowed()) {
		return;
	}
	if (activityTimer) {
		return;
	}
	if (readInstallFile().lastActiveOn === utcToday()) {
		return;
	}
	activityTimer = setTimeout(() => {
		activityTimer = undefined;
		void sendActivityPing();
	}, ACTIVITY_DEBOUNCE_MS);
	// Never hold the process open for this.
	activityTimer.unref();
}

async function sendActivityPing(): Promise<void> {
	const file = readInstallFile();
	const day = utcToday();
	// Re-check: the debounce window may have crossed into a day we have already recorded.
	if (file.lastActiveOn === day) {
		return;
	}
	try {
		await getCloudClient()
			.procedure('record_activity', { p_install_id: file.id })
			.abortSignal(AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS));
		// Only remember the day once the server has actually taken it, so a failed ping is retried
		// by the next sign of activity rather than being silently marked done.
		file.lastActiveOn = day;
		writeInstallFile(file);
	} catch {
		// Best-effort: never surface, never retry on a timer.
	}
}

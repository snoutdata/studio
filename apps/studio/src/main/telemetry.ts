/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as Sentry from '@sentry/electron/main';

import { SENTRY_DSN, scrubEvent } from '../shared/telemetry';

// Crash/error reporting via Sentry. Wiring rules:
//  - Opt-OUT: on by default, with a Settings toggle. The choice persists to
//    userData/telemetry.json and is read at startup.
//  - Only ever active in a packaged build with a non-empty DSN. A dev run and a DSN-less build
//    never initialize the SDK (so local crashes don't spam the project, and an unconfigured
//    build is fully dormant).
//  - Everything outbound passes through scrubEvent() so SQL, connection strings, and the
//    gateway key can't leave the machine. We also disable PII at the SDK level.
// The DSN may also be supplied at build/run via SNOUTDATA_SENTRY_DSN, which overrides the
// committed constant (handy for CI without editing source).
//
// Sentry is THIRD-PARTY software (@sentry/electron and @sentry/core, MIT, listed in NOTICE). We
// use only its Electron SDK, initialized here and in the renderer. Its packages also carry
// integrations for many other products, which a packaged app includes because they ship inside
// the dependency; this app never loads or configures any of them, and their names are Sentry's,
// not ours.
//
// A build from this source carries NO DSN, so the SDK is never initialized and nothing is
// reported anywhere: errors stay in the app's local logs on your own machine. To get crash
// reports from your own build, supply your own Sentry DSN (SNOUTDATA_SENTRY_DSN) and they go
// to your Sentry project, never to ours. Only the official SnoutData build compiles in our DSN.

const dsn = (process.env.SNOUTDATA_SENTRY_DSN || SENTRY_DSN).trim();

let started = false;

function filePath(): string {
	return join(app.getPath('userData'), 'telemetry.json');
}

/** Whether the user has reporting enabled. Defaults to true (opt-out); a malformed or missing
 *  file reads as enabled. */
export function telemetryEnabled(): boolean {
	try {
		const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as { enabled?: boolean };
		return raw.enabled !== false;
	} catch {
		return true;
	}
}

/** True when a DSN is configured at all. The toggle is meaningless (and hidden as inert) when
 *  no DSN ships, so the renderer uses this to label the control. */
export function telemetryAvailable(): boolean {
	return dsn.length > 0;
}

/** True only once the main-process SDK has actually initialized. The renderer must gate its own
 *  init on this: @sentry/electron/renderer routes events over the `sentry-ipc://` protocol that
 *  the main SDK registers at startup, so initializing the renderer when main hasn't (e.g. a dev
 *  run, where startTelemetry() no-ops) throws "scheme not supported". */
export function telemetryActive(): boolean {
	return started;
}

function persist(enabled: boolean): void {
	const path = filePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ enabled }, null, 2), 'utf8');
}

function doInit(): void {
	if (started) {
		return;
	}
	Sentry.init({
		dsn,
		release: `snoutdata@${app.getVersion()}`,
		environment: 'production',
		// We never want Sentry attaching IPs, usernames, or machine identifiers.
		sendDefaultPii: false,
		// Errors only for now: no perf tracing (and no extra cost/quota burn) until we want it.
		tracesSampleRate: 0,
		beforeSend: (event) => scrubEvent(event),
		beforeBreadcrumb: (crumb) => scrubEvent({ breadcrumbs: [crumb] }).breadcrumbs?.[0] ?? crumb,
	});
	started = true;
}

/** Initialize reporting at app startup, honoring the persisted opt-out. No-op in dev or when
 *  no DSN is configured. */
export function startTelemetry(): void {
	if (!app.isPackaged || !dsn || !telemetryEnabled()) {
		return;
	}
	doInit();
}

/** Report a handled fault we care about — something the app recovered from, so it never
 *  reaches an unhandled handler, but which we still need to see (e.g. the SQL server child
 *  dying). No-op unless reporting is actually active. Extra context is scrubbed like any
 *  other event. */
export function reportHandled(error: Error, context?: Record<string, unknown>): void {
	if (!started) {
		return;
	}
	Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Apply a toggle from Settings: persist it, then start or stop the client so the change takes
 *  effect without a restart. Returns the (now-current) enabled state. */
export async function setTelemetryEnabled(enabled: boolean): Promise<boolean> {
	persist(enabled);
	if (!app.isPackaged || !dsn) {
		return enabled;
	}
	if (enabled) {
		doInit();
	} else if (started) {
		await Sentry.close();
		started = false;
	}
	return enabled;
}

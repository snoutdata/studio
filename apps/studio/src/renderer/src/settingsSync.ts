/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Cloud sync of non-secret app preferences, so a fresh machine picks up where the last one
// left off. The portable blob is the theme, the pane layout, and the app/editor/query prefs,
// all of which already live in localStorage. Secrets and connection details are deliberately
// NOT synced (passwords/keys are encrypted per-machine and undecryptable elsewhere).
//
// Merge policy is last-write-wins by the blob's own `updatedAt`: on sign-in we pull the cloud
// row and, if it is newer than what this machine last synced, apply it; otherwise this machine's
// prefs win and we push them up. Settings that belong to one machine (LOCAL_ONLY_SETTINGS in
// appSettings.ts, e.g. whether Liby is shown) are never in the blob, in either direction.
// App.tsx drives the pull (on sign-in) and a debounced push (on
// change); main (settingsSyncStore.ts) just shuttles the opaque blob to the user's RLS row.

import { DEFAULT_APP_SETTINGS, syncedAppSettings, type AppSettings, type SyncedAppSettings } from './appSettings';
import { DEFAULT_LAYOUT, type Layout } from './layout';
import { DEFAULT_THEME, isThemeId, type Theme } from './theme';

export const SYNC_VERSION = 1;

/** The portable preferences blob stored in the user's `user_settings` row. */
export interface SyncBlob {
	v: number;
	/** Epoch ms of the last pref change this blob represents; drives last-write-wins. */
	updatedAt: number;
	theme: Theme;
	layout: Layout;
	appSettings: SyncedAppSettings;
}

// A per-machine opt-out ("Sync my settings to my account"), default on, and the updatedAt stamp
// of the prefs this machine last synced (pushed or applied) so a sign-in can compare against the
// cloud row. Both live outside the synced blob so toggling sync off doesn't itself sync.
const ENABLED_KEY = 'positron-db.syncEnabled';
const STAMP_KEY = 'positron-db.syncUpdatedAt';

/** Whether preferences sync to the signed-in account (default on). */
export function syncEnabled(): boolean {
	return localStorage.getItem(ENABLED_KEY) !== 'off';
}

export function setSyncEnabled(on: boolean): void {
	localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off');
}

/** updatedAt of the prefs this machine last synced; 0 when it has never synced. */
export function localStamp(): number {
	return Number(localStorage.getItem(STAMP_KEY)) || 0;
}

export function setLocalStamp(ts: number): void {
	localStorage.setItem(STAMP_KEY, String(ts));
}

/** Bundle the live prefs into one versioned blob stamped with `updatedAt`. */
export function buildBlob(theme: Theme, layout: Layout, appSettings: AppSettings, updatedAt: number): SyncBlob {
	return { v: SYNC_VERSION, updatedAt, theme, layout, appSettings: syncedAppSettings(appSettings) };
}

/** Coerce an untrusted remote blob into a {@link SyncBlob}, or null if it isn't one. Defaults
 *  backfill any missing fields, so a row written by an older or newer client never crashes us. */
export function parseBlob(raw: unknown): SyncBlob | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const blob = raw as Partial<SyncBlob>;
	if (typeof blob.updatedAt !== 'number') {
		return null;
	}
	return {
		v: SYNC_VERSION,
		updatedAt: blob.updatedAt,
		theme: isThemeId(blob.theme) ? blob.theme : DEFAULT_THEME,
		layout: { ...DEFAULT_LAYOUT, ...(blob.layout ?? {}) },
		appSettings: syncedAppSettings({ ...DEFAULT_APP_SETTINGS, ...(blob.appSettings ?? {}) }),
	};
}

/** Content fingerprint that ignores `updatedAt`, to tell a real pref change from a no-op
 *  re-render (so we only push, and only bump the stamp, when something actually changed). */
export function fingerprint(theme: Theme, layout: Layout, appSettings: AppSettings | SyncedAppSettings): string {
	return JSON.stringify({ theme, layout, appSettings: syncedAppSettings(appSettings) });
}

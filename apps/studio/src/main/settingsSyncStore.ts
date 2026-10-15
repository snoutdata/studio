/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getCloudClient } from './cloudClient';

// The synced preferences blob is opaque to main: the renderer owns its shape (theme + pane
// layout + app/editor/query prefs, plus a version and an updatedAt stamp for last-write-wins).
// Main just shuttles it to and from the user's row in `public.user_settings`. See the renderer's
// settingsSync.ts for the concrete shape and merge policy.
export type SettingsBlob = Record<string, unknown>;

/**
 * Cloud sync for non-secret app preferences, keyed to the signed-in user. The client
 * attaches the user's JWT, so Row-Level Security scopes every query to their own row. Every
 * method is best-effort and a no-op when signed out: a transient failure must never disrupt the
 * app, and offline simply falls back to the local (localStorage) copy. Secrets and connection
 * details are never handled here.
 */
export class SettingsSyncStore {
	/** @param userId resolves the current signed-in user id (null when signed out). */
	constructor(private readonly userId: () => string | null) {}

	/** Read the user's synced prefs blob, or null when signed out / no row / unreachable. */
	async pull(): Promise<SettingsBlob | null> {
		const id = this.userId();
		if (!id) {
			return null;
		}
		try {
			const { data, error } = await getCloudClient().table('user_settings').read('data').eq('id', id).single();
			if (error || !data) {
				return null;
			}
			const blob = (data as { data?: unknown }).data;
			return blob && typeof blob === 'object' ? (blob as SettingsBlob) : null;
		} catch {
			return null;
		}
	}

	/** Upsert the user's prefs blob (stamping the server-side updated_at). No-op when signed out. */
	async push(blob: SettingsBlob): Promise<void> {
		const id = this.userId();
		if (!id) {
			return;
		}
		try {
			await getCloudClient()
				.table('user_settings')
				.put({ id, data: blob, updated_at: new Date().toISOString() });
		} catch {
			// Offline / unreachable — the local copy stays authoritative; we re-push on the next change.
		}
	}

	/** Erase the user's synced prefs row (GDPR/CCPA "delete my synced settings"). No-op when
	 *  signed out. RLS scopes the delete to the caller's own row. */
	async wipe(): Promise<void> {
		const id = this.userId();
		if (!id) {
			return;
		}
		try {
			await getCloudClient().table('user_settings').remove().eq('id', id);
		} catch {
			// Best-effort; the user can retry. Account deletion also cascades this row away.
		}
	}
}

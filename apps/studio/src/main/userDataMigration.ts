/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Rebrand (2026-06): the app name changed positron-db -> snoutdata, which moves Electron's
// userData dir (it derives from app.getName()). Without help, the renamed build would boot
// into a fresh empty dir and existing users would lose their connections/secrets/chats/etc.
//
// On first launch under the new name we copy the old dir's contents over once. secrets.json is
// safeStorage-encrypted with an OS-keychain key tied to the same OS user, so it decrypts fine
// after a plain copy. The legacy dir is left intact (untouched) so a not-yet-removed older
// install still works during the transition; we just stop reading it once data is present here.
const LEGACY_APP_NAME = 'positron-db';

// The flat JSON stores (+ the auth session and window geometry). auth.json is migrated so
// the user stays signed in; window.json keeps their window size. Logs/scratch are intentionally
// skipped. workspace.json is the root-folder POINTER — the default workspace's actual .sql files
// live in the userData/workspace DIRECTORY, copied separately below.
const FILES = [
	'connections.json',
	'secrets.json',
	'queries.json',
	'chats.json',
	'ai.json',
	'aiAudit.json',
	'workspace.json',
	'telemetry.json',
	'auth.json',
	'window.json',
];

/** Copy the legacy PositronDB userData into the new SnoutData dir, once, if the new dir is empty.
 *  Best-effort: any failure is swallowed so a migration hiccup can never block startup. */
export function migrateLegacyUserData(): void {
	try {
		const userData = app.getPath('userData');
		// Match the dev userData split (index.ts appends -dev before stores read), so a dev run
		// migrates from the legacy dev dir and the packaged app from the legacy packaged dir.
		const legacyName = app.isPackaged ? LEGACY_APP_NAME : `${LEGACY_APP_NAME}-dev`;
		const legacyDir = join(app.getPath('appData'), legacyName);
		if (legacyDir === userData || !existsSync(legacyDir)) {
			return;
		}
		// Don't clobber: if this dir already holds any of our data, the migration ran (or this is
		// a returning new-name user). A bare dir from a prior empty boot is treated as migratable.
		const alreadyPopulated = FILES.some((f) => existsSync(join(userData, f))) || existsSync(join(userData, 'workspace'));
		if (alreadyPopulated) {
			return;
		}
		mkdirSync(userData, { recursive: true });
		for (const name of FILES) {
			const src = join(legacyDir, name);
			if (existsSync(src)) {
				try {
					copyFileSync(src, join(userData, name));
				} catch {
					// skip an individual file that won't copy; the rest still migrate.
				}
			}
		}
		// The default workspace folder (only present if the user kept the default root — a custom
		// root is an absolute path in workspace.json and stays valid without copying).
		const legacyWorkspace = join(legacyDir, 'workspace');
		if (existsSync(legacyWorkspace) && readdirSync(legacyWorkspace).length > 0) {
			try {
				cpSync(legacyWorkspace, join(userData, 'workspace'), { recursive: true });
			} catch {
				// best-effort; a partial copy is better than none and never blocks boot.
			}
		}
	} catch {
		// Never let migration break startup.
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where saved passwords are sealed, on a Linux desktop with no password vault.
 *
 * Electron's safeStorage seals a secret with a key the OS keeps: DPAPI on Windows, the Keychain on
 * macOS, and on Linux whatever Secret Service the desktop runs (GNOME Keyring, KWallet). A minimal
 * Linux desktop runs none, Chromium falls back to its `basic_text` store, and Electron then reports
 * encryption as unavailable. Refusing every password there would leave the user with no saved
 * connections at all, so on such a machine the app saves the passwords anyway, sealed with Chromium's fixed `basic_text` key (so the file is only as private as the
 * user's account), and says so ONCE, in the notifications centre, with a line in Settings for later.
 *
 * Pure, so the rule is testable without Electron; index.ts asks it once, right after `ready`.
 *
 * What a vault installed LATER does: Chromium tags each sealed value with its scheme (`v10` is the
 * fixed key, `v11` the vault's), and it still opens `v10` values once a vault answers, so the
 * passwords saved here keep working and new ones go into the vault. Should one ever fail to open,
 * `SecretStore.get` reads it as "no password saved" and the user is asked for it again.
 */

/** What Electron reported, read after `ready` (`isEncryptionAvailable` first: on Linux that call is
 *  what makes Chromium pick its backend). */
export interface SecretStorageFacts {
	platform: NodeJS.Platform;
	/** `safeStorage.getSelectedStorageBackend()`; only meaningful on Linux. */
	backend: string;
	/** `safeStorage.isEncryptionAvailable()`. */
	available: boolean;
}

/** Whether to seal secrets with Chromium's fixed `basic_text` key. Linux only, and only when there
 *  really is no vault: a vault that is present but locked or broken (`gnome_libsecret` reporting
 *  unavailable) is left to refuse, as it always has, rather than quietly downgraded. */
export function usePlainTextSecrets(facts: SecretStorageFacts): boolean {
	return facts.platform === 'linux' && !facts.available && facts.backend === 'basic_text';
}

/** The note that the warning was shown, so it is shown once per profile. */
const WARNED_FILE = 'secret-storage-warned.json';

/** Whether this profile has already been told its passwords are saved without a vault. */
export function weakSecretsWarned(userData: string): boolean {
	return existsSync(join(userData, WARNED_FILE));
}

/** Record that the warning was shown. A note we cannot write only means it is shown again. */
export function markWeakSecretsWarned(userData: string, now: number = Date.now()): void {
	try {
		writeFileSync(join(userData, WARNED_FILE), JSON.stringify({ at: now }));
	} catch {
		// Nothing to do: the next launch says it again, which is the safe side.
	}
}

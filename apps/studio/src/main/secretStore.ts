/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, safeStorage } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writePrivateFile } from './privateFile';

// Connection secrets (DB password, SSH password/passphrase), encrypted with Electron
// safeStorage (OS-keychain-backed key: DPAPI on Windows, Keychain on macOS) and kept
// in a separate file from the non-secret config. Replaces the original VSCode extension's
// vscode.SecretStorage. Keys are namespaced by connection id. On Linux the key comes from the
// desktop's Secret Service; on a desktop with none, index.ts switches safeStorage to Chromium's fixed
// `basic_text` key at launch (secretStorageMode.ts) so secrets are still saved, and says so once.
// A value that no longer opens (a vault replaced, a profile copied to another machine) reads as
// "no secret saved", so the user is asked for it again rather than anything failing.

// `githubToken` is not a connection secret at all — it is Snoutbot's GitHub token, stored under
// the reserved id `__review_github__` (see main/review/reviewStore.ts). It lives here because the
// requirement is identical: OS-keychain-backed encryption, never in a plain config file.
export type SecretKind = 'password' | 'sshPassword' | 'sshPassphrase' | 'awsSecretAccessKey' | 'githubToken' | 'githubAppKey';

const ALL_KINDS: SecretKind[] = ['password', 'sshPassword', 'sshPassphrase', 'awsSecretAccessKey', 'githubToken', 'githubAppKey'];

function secretsPath(): string {
	return join(app.getPath('userData'), 'secrets.json');
}

function entryKey(connectionId: string, kind: SecretKind): string {
	return `${connectionId}:${kind}`;
}

export class SecretStore {
	private read(): Record<string, string> {
		const path = secretsPath();
		if (!existsSync(path)) {
			return {};
		}
		try {
			const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
			return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
		} catch {
			return {};
		}
	}

	private write(map: Record<string, string>): void {
		writePrivateFile(secretsPath(), JSON.stringify(map, null, 2));
	}

	get(connectionId: string, kind: SecretKind): string | undefined {
		const encoded = this.read()[entryKey(connectionId, kind)];
		if (!encoded) {
			return undefined;
		}
		try {
			return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
		} catch {
			return undefined;
		}
	}

	store(connectionId: string, kind: SecretKind, value: string): void {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error('OS secret encryption is unavailable; cannot store the secret securely.');
		}
		const map = this.read();
		map[entryKey(connectionId, kind)] = safeStorage.encryptString(value).toString('base64');
		this.write(map);
	}

	delete(connectionId: string, kind: SecretKind): void {
		const map = this.read();
		delete map[entryKey(connectionId, kind)];
		this.write(map);
	}

	/** Drop every secret for a connection (called when it is deleted). */
	deleteAll(connectionId: string): void {
		const map = this.read();
		for (const kind of ALL_KINDS) {
			delete map[entryKey(connectionId, kind)];
		}
		this.write(map);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { writePrivateFile } from './privateFile';

/** The part of Electron's safeStorage the session store uses. Handed in, so this file has no
 *  Electron import and the rule below is tested under plain node. */
export interface AuthCrypto {
	available(): boolean;
	encrypt(value: string): Buffer;
	decrypt(data: Buffer): string;
}

/** Said once when the session cannot be kept safely. secretStore.ts says the same of a password. */
export const SESSION_NOT_SAVED = 'OS secret encryption is unavailable; cannot store the session securely, so it is kept for this run only.';

/**
 * Where the accounts client keeps its session (and the transient PKCE verifier): `auth.json`,
 * each value encrypted with Electron safeStorage (OS-keychain-backed, the same scheme as
 * secretStore.ts), so tokens never sit on disk in plaintext. The client lives only in main, so
 * the renderer never sees them either.
 *
 * With no encryption available, the session is kept IN MEMORY for this run and never written:
 * signed in until the app quits, signed out on the next launch. It used to be written as plain
 * base64, a refresh token anyone who could read the profile could use, and one this store could
 * not even read back. A Linux desktop with no Secret Service is not such a box, since index.ts
 * switches it to Chromium's fixed `basic_text` key at launch (secretStorageMode.ts).
 */
export class AuthStorage {
	private map: Record<string, string>;
	/** Values held for this run only, when they could not be encrypted. */
	private readonly memory = new Map<string, string>();
	private warned = false;

	constructor(
		private readonly path: string,
		private readonly crypto: AuthCrypto,
		private readonly warn: (message: string) => void = (m) => console.warn(`[auth] ${m}`),
	) {
		this.map = this.load();
	}

	private load(): Record<string, string> {
		if (!existsSync(this.path)) {
			return {};
		}
		try {
			const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
			return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
		} catch {
			return {};
		}
	}

	private persist(): void {
		writePrivateFile(this.path, JSON.stringify(this.map, null, 2));
	}

	getItem(key: string): string | null {
		const held = this.memory.get(key);
		if (held !== undefined) {
			return held;
		}
		// Re-read from disk first. The map is a write-through cache, but the refresh token is
		// rotated on every refresh: if anything else wrote auth.json since we loaded (another
		// instance, or our own prior run), our cached copy is stale and the client would send
		// an already-used token, which the server rejects as non-retryable and wipes the
		// session. Reading fresh keeps us on the latest persisted token. Auth reads are rare.
		this.map = this.load();
		const encoded = this.map[key];
		if (!encoded || !this.crypto.available()) {
			return null;
		}
		try {
			return this.crypto.decrypt(Buffer.from(encoded, 'base64'));
		} catch {
			return null;
		}
	}

	setItem(key: string, value: string): void {
		if (!this.crypto.available()) {
			if (!this.warned) {
				this.warned = true;
				this.warn(SESSION_NOT_SAVED);
			}
			this.memory.set(key, value);
			// Whatever is on disk under this key is stale now, and may be an older build's plain
			// base64: take it off.
			if (key in this.map) {
				delete this.map[key];
				this.persist();
			}
			return;
		}
		this.memory.delete(key);
		this.map[key] = this.crypto.encrypt(value).toString('base64');
		this.persist();
	}

	removeItem(key: string): void {
		this.memory.delete(key);
		delete this.map[key];
		this.persist();
	}
}

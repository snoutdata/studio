/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, safeStorage } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { snout, type SnoutClient } from '@snoutdata/client';
import { ACCOUNTS_VOCABULARY, keyHeader, prefix } from '../shared/ownLayout';
import { AuthStorage } from './authStorage';
import { netFetch } from './netFetch';

// The client is `@snoutdata/client`. The session is stored under the key `positron-db-auth` in the
// same JSON shape older builds wrote, so an update keeps the user signed in. Main never subscribes
// to Realtime, and this client opens a socket only on subscribe().

// The accounts backend (sign-in, plans, the cloud control plane), at `accounts.snoutdata.com`.
// The app key is a JWT for that backend. It is client-safe by design (Row-Level Security guards
// the data), so it lives in source. The secret key must NEVER appear here; it bypasses RLS.
// `cloudClient.test.ts` pins all of this: nothing else did, and a typo here ships an app
// that cannot sign in.
const ACCOUNTS_URL = 'https://accounts.snoutdata.com';
/** Just the host (no scheme), for naming the domain in network-error diagnostics. */
export const ACCOUNTS_HOST = 'accounts.snoutdata.com';
const ACCOUNTS_APP_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzbm91dGRhdGEiLCJyb2xlIjoic25vdXRfYXBwIiwiaWF0IjoxNzkyMDc2NTQyLCJleHAiOjIxMDQ4NzU1MjR9.hWSbcDfbGuyDHHSFLoZzD8KVSg9bWVZzzQ_eftW6TPM';

/** The identity service's health, in the names the accounts backend speaks (shared/ownLayout.ts).
 *  The proxy test in index.ts probes the same URL. */
export const ACCOUNTS_HEALTH_URL = `${ACCOUNTS_URL}${prefix('identity', ACCOUNTS_VOCABULARY)}/health`;

function authFilePath(): string {
	return join(app.getPath('userData'), 'auth.json');
}

// The key the client persists its session under, the previous client's own and kept (see
// getCloudClient's auth.storageKey).
const AUTH_STORAGE_KEY = 'positron-db-auth';

/** Whether a persisted session is sitting on disk, WITHOUT touching the network or decrypting
 *  it. This is the difference between "signed out" and "signed in, still restoring": the auth
 *  state starts as logged-out either way, but only in the second case is that answer temporary.
 *  Lets the UI hold a skeleton instead of flashing a sign-in prompt at an already-signed-in user
 *  (see AuthStore.restoring). A true here is a hint, not a promise — the token may turn out to
 *  be revoked or undecryptable, which just resolves to signed out a moment later. */
export function hasPersistedSession(): boolean {
	try {
		const path = authFilePath();
		if (!existsSync(path)) {
			return false;
		}
		const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return Boolean(raw && typeof raw === 'object' && (raw as Record<string, string>)[AUTH_STORAGE_KEY]);
	} catch {
		return false;
	}
}

// Durable, filtered record of the auth events that matter for diagnosing an unexpected
// sign-out. The client routes its decisions (token refreshed, "refresh failed with a
// non-retryable error, removing the session", etc.) through this `debug` logger; we keep
// only the consequential lines so a future mid-session logout leaves a breadcrumb on disk
// (`userData/auth-debug.log`) instead of vanishing into a detached main-process console.
// The full firehose is dropped — we never want to persist tokens, and most ticks are noise.
// KEEP is deliberately broad (it has to catch wording we have not seen yet, since the whole
// point is diagnosing a logout nobody predicted); SKIP is what keeps that from becoming a
// firehose. The first version of SKIP was too narrow and this file reached **107 MB** on one
// machine in three months — 839,195 lines, of which 535,467 were `#_useSession` /
// `#__loadSession()` ticks that say only "a session was read from memory". KEEP matches them
// because they contain the word "session". Every pattern below was measured in that file.
const KEEP = /sign|session|refresh|token|expir|error|removing/i;
const SKIP = /auto refresh tick|visibilitychange|#getSession\(\) session from storage|#_useSession |#__loadSession\(\)|#_autoRefreshTokenTick\(\)|#_(start|stop)AutoRefresh\(\)|INITIAL_SESSION callback|#_recoverAndRefresh\(\) session has not expired/i;

// Hard ceiling, because a filter is a guess about wording and this file lives in the user's
// profile forever. Past the cap it is rolled once to `.1` and started fresh: a sign-out is
// diagnosed from the lines AROUND it, so the newest events are the ones worth keeping, and two
// files bound the whole thing at ~4 MB instead of growing without limit.
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function rollIfTooBig(path: string): void {
	try {
		if (statSync(path).size < MAX_LOG_BYTES) {
			return;
		}
		renameSync(path, `${path}.1`);
	} catch {
		// No file yet (the common case), or the roll lost a race with another instance. Either
		// way the append below is still correct; this must never throw into auth.
	}
}

function authDebugLog(...parts: unknown[]): void {
	try {
		// auth-js calls this as debug(logPrefix, message, ...detail), so flatten everything
		// to text and match the whole line — the prefix is always first and carries no signal.
		const text = parts
			.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : typeof p === 'string' ? p : ''))
			.filter(Boolean)
			.join(' ');
		if (!KEEP.test(text) || SKIP.test(text)) {
			return;
		}
		const line = `${new Date().toISOString()} ${text}\n`;
		const path = join(app.getPath('userData'), 'auth-debug.log');
		mkdirSync(dirname(path), { recursive: true });
		rollIfTooBig(path);
		appendFileSync(path, line, 'utf8');
	} catch {
		// Logging must never break auth.
	}
}

/** Resolve once the auth backend actually answers, polling with a short backoff up to
 *  `maxWaitMs`. Used on OS resume to gate the first post-sleep token refresh behind a
 *  confirmed-up network: a refresh fired into a still-reconnecting NIC can reach the server
 *  (which rotates + revokes the old token) but lose the response, and the subsequent retry of
 *  the now-rotated token trips the auth server's refresh-token reuse detection, revoking the whole
 *  session ("Invalid Refresh Token: Refresh Token Not Found"). Rejects if never reachable. */
export async function waitForAuthReachable(maxWaitMs = 60000): Promise<void> {
	const url = ACCOUNTS_HEALTH_URL;
	const deadline = Date.now() + maxWaitMs;
	let attempt = 0;
	for (;;) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 4000);
		try {
			const res = await netFetch(url, {
				headers: { [keyHeader(ACCOUNTS_VOCABULARY)]: ACCOUNTS_APP_KEY },
				signal: controller.signal,
			});
			if (res.ok) {
				return;
			}
		} catch {
			// Unreachable yet — fall through to the wait/retry below.
		} finally {
			clearTimeout(timer);
		}
		if (Date.now() >= deadline) {
			throw new Error('Auth backend not reachable.');
		}
		// Back off from 1s toward 4s so a long reconnect doesn't hammer the network.
		const delay = Math.min(1000 * 2 ** attempt++, 4000);
		await new Promise((r) => setTimeout(r, delay));
	}
}

let client: SnoutClient | null = null;

/** The shared accounts client. Created lazily on first use (after app ready, so safeStorage
 *  is available). PKCE flow + the encrypted storage adapter; no in-URL session detection,
 *  since the desktop redirect is handled by hand (see authStore.completeSignIn). */
export function getCloudClient(): SnoutClient {
	if (!client) {
		client = snout(ACCOUNTS_URL, ACCOUNTS_APP_KEY, {
			// The paths and key header the accounts backend serves today (shared/ownLayout.ts).
			vocabulary: ACCOUNTS_VOCABULARY,
			// Use Electron's network stack for every backend call (auth, the `profiles` query, and
			// Snout Function invokes) so they trust the OS cert store + proxy.
			// See netFetch for why this is what makes sign-in work behind corporate TLS inspection.
			global: { fetch: netFetch },
			auth: {
				flowType: 'pkce',
				persistSession: true,
				autoRefreshToken: true,
				detectSessionInUrl: false,
				// Encrypted on disk, or held for this run only when the OS cannot encrypt (authStorage.ts).
				storage: new AuthStorage(authFilePath(), {
					available: () => safeStorage.isEncryptionAvailable(),
					encrypt: (value) => safeStorage.encryptString(value),
					decrypt: (data) => safeStorage.decryptString(data),
				}),
				storageKey: AUTH_STORAGE_KEY,
				// Capture the consequential auth lines to disk so an unexpected sign-out is
				// diagnosable after the fact (see authDebugLog). Noise is filtered there.
				debug: authDebugLog,
			},
		});
	}
	return client;
}

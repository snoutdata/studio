/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// SSH host-key checking for the tunnel: trust on first use, then refuse a
// changed key. The key ssh2 hands a `hostVerifier` (with no `hostHash`) is the raw public-key
// blob, so its SHA-256 in unpadded base64 is the same `SHA256:...` string `ssh-keygen -lf` and
// OpenSSH's own prompt print, which lets a user compare it against the server.
//
// The fingerprint is remembered in main per SSH host and port (as `known_hosts` is), handed back
// on each connect as `SshTunnelConfig.hostKeyFingerprint`, and learned here when it is absent.

import { createHash } from 'node:crypto';

/** The OpenSSH-style fingerprint of a raw SSH public-key blob: `SHA256:<base64, no padding>`. */
export function hostKeyFingerprint(key: Buffer): string {
	return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export type HostKeyDecision =
	| { ok: true; learned: boolean }
	| { ok: false; error: string };

/**
 * Whether to accept the key the SSH server presented. With nothing remembered, the key is
 * trusted and reported as learned; with a remembered key, only the same one is accepted.
 */
export function checkHostKey(expected: string | undefined, seen: string, host: string, port: number): HostKeyDecision {
	if (!expected) {
		return { ok: true, learned: true };
	}
	if (expected === seen) {
		return { ok: true, learned: false };
	}
	const where = port === 22 ? host : `${host}:${port}`;
	return {
		ok: false,
		error: `The SSH server's host key for ${where} has changed (expected ${expected}, got ${seen}). `
			+ 'Someone may be intercepting the connection, so it was refused. If the server was rebuilt, '
			+ "turn on \"Forget the saved host key\" in the connection's SSH settings and connect again.",
	};
}

/** Where a learned host key is reported, so main can remember it. Wired once by the server. */
let learnedListener: ((host: string, port: number, fingerprint: string) => void) | undefined;

export function onHostKeyLearned(listener: (host: string, port: number, fingerprint: string) => void): void {
	learnedListener = listener;
}

export function reportHostKeyLearned(host: string, port: number, fingerprint: string): void {
	learnedListener?.(host, port, fingerprint);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// SSH host keys the tunnel has trusted, kept per SSH host and port the way
// OpenSSH's known_hosts is: userData/sshKnownHosts.json, `{ "<host>:<port>": "SHA256:..." }`.
// Keyed by the SSH server rather than the connection, so every connection and saved tunnel that
// goes through the same bastion is held to the same key, and a Test before Save already counts.
// A fingerprint is public, so nothing here is secret.

function storePath(): string {
	return join(app.getPath('userData'), 'sshKnownHosts.json');
}

/** The key a host and port are remembered under: lower-case host, port defaulting to 22. */
export function knownHostId(host: string, port: number | undefined): string {
	return `${host.trim().toLowerCase()}:${port ?? 22}`;
}

function readAll(): Record<string, string> {
	const path = storePath();
	if (!existsSync(path)) {
		return {};
	}
	try {
		const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {};
	} catch {
		return {};
	}
}

function writeAll(hosts: Record<string, string>): void {
	const path = storePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(hosts, null, '\t'), { mode: 0o600 });
}

/** The fingerprint remembered for this SSH server, if any. */
export function knownHostKey(host: string, port: number | undefined): string | undefined {
	const value = readAll()[knownHostId(host, port)];
	return typeof value === 'string' && value.startsWith('SHA256:') ? value : undefined;
}

/** Remember the key a tunnel trusted on first use. Never overwrites one already remembered: a
 *  change is refused by the tunnel and only ever cleared by {@link forgetHostKey}. */
export function rememberHostKey(host: string, port: number, fingerprint: string): void {
	const hosts = readAll();
	const id = knownHostId(host, port);
	if (hosts[id]) {
		return;
	}
	hosts[id] = fingerprint;
	writeAll(hosts);
}

/** Forget this SSH server's key, so the next connection trusts whatever key it presents. */
export function forgetHostKey(host: string, port: number | undefined): void {
	const hosts = readAll();
	const id = knownHostId(host, port);
	if (!(id in hosts)) {
		return;
	}
	delete hosts[id];
	writeAll(hosts);
}

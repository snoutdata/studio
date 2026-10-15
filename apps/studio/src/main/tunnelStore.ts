/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { SshTunnelProfile } from '../shared/connection';

// Reusable SSH tunnel profiles, persisted as JSON in the app data dir. These hold no
// secrets (key passphrase / SSH password live in secretStore, keyed by tunnelSecretId).
// A connection references a profile by id (ConnectionConfig.sshTunnelRef); the manager
// resolves it to a concrete SshTunnelConfig at connect time. Mirrors configStore.

/** Keychain id under which a tunnel profile's SSH secrets are stored. */
export function tunnelSecretId(profileId: string): string {
	return `tunnel:${profileId}`;
}

function tunnelsPath(): string {
	return join(app.getPath('userData'), 'tunnels.json');
}

export function readTunnels(): SshTunnelProfile[] {
	const path = tunnelsPath();
	if (!existsSync(path)) {
		return [];
	}
	try {
		const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!Array.isArray(raw)) {
			return [];
		}
		return (raw as SshTunnelProfile[]).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	} catch {
		return [];
	}
}

export function getTunnel(id: string): SshTunnelProfile | undefined {
	return readTunnels().find((entry) => entry.id === id);
}

function writeAll(profiles: SshTunnelProfile[]): void {
	const path = tunnelsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(profiles, null, 2), 'utf8');
}

/** Upsert a tunnel profile (matched by id). */
export function writeTunnel(profile: SshTunnelProfile): void {
	const others = readTunnels().filter((entry) => entry.id !== profile.id);
	writeAll([...others, profile]);
}

/** Remove a tunnel profile (matched by id). */
export function removeTunnel(id: string): void {
	writeAll(readTunnels().filter((entry) => entry.id !== id));
}

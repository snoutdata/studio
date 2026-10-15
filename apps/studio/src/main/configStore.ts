/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConnectionConfig } from '../shared/connection';

// Non-secret connection definitions, persisted as JSON in the app data dir. Secrets
// (DB password, SSH password/passphrase) never land here — they go to secretStore.
// Replaces the original VSCode extension's connections setting.

function configPath(): string {
	return join(app.getPath('userData'), 'connections.json');
}

/** Defensive strip of any secret fields before a config is written to disk. */
function sanitize(config: ConnectionConfig): ConnectionConfig {
	const clean: ConnectionConfig = { ...config };
	delete clean.password;
	if (clean.sshTunnel) {
		const { password, passphrase, ...rest } = clean.sshTunnel;
		clean.sshTunnel = rest;
	}
	return clean;
}

export function readConnections(): ConnectionConfig[] {
	const path = configPath();
	if (!existsSync(path)) {
		return [];
	}
	try {
		const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!Array.isArray(raw)) {
			return [];
		}
		// Always present connections ordered by label (case-insensitive). Sorting on read
		// keeps the list stable regardless of write order, so editing a connection no longer
		// shuffles it to the bottom (writeConnection appends).
		return (raw as ConnectionConfig[]).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
	} catch {
		return [];
	}
}

function writeAll(connections: ConnectionConfig[]): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(connections, null, 2), 'utf8');
}

/** Upsert a connection (matched by id). */
export function writeConnection(config: ConnectionConfig): void {
	const others = readConnections().filter((entry) => entry.id !== config.id);
	writeAll([...others, sanitize(config)]);
}

/** Remove a connection (matched by id). */
export function removeConnection(id: string): void {
	writeAll(readConnections().filter((entry) => entry.id !== id));
}

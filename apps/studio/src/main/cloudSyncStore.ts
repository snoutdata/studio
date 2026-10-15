/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The cloud projects each account's sync has already offered as connections
// (`cloudSync.ts`, "Seen, not merely missing"). Refs only, no secrets → userData/cloudSync.json.

type Seen = Record<string, string[]>;

function path(): string {
	return join(app.getPath('userData'), 'cloudSync.json');
}

function read(): Seen {
	if (!existsSync(path())) {
		return {};
	}
	try {
		const raw: unknown = JSON.parse(readFileSync(path(), 'utf8'));
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Seen) : {};
	} catch {
		return {};
	}
}

export function seenCloudRefs(account: string): string[] {
	return read()[account] ?? [];
}

export function rememberCloudRefs(account: string, refs: string[]): void {
	const all = read();
	all[account] = [...new Set([...(all[account] ?? []), ...refs])];
	writeFileSync(path(), JSON.stringify(all, null, '\t'));
}

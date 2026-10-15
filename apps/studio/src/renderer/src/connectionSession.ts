/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Remembers which connections were open between launches, so relaunching reconnects
// them instead of leaving everything cold. Persisted to localStorage (renderer-side,
// like session/layout/appSettings). Only non-prod connections are saved — prod always
// requires a deliberate, explicit connect.

const STORAGE_KEY = 'positron-db.openConnections';

export function loadOpenConnections(): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter((x): x is string => typeof x === 'string');
			}
		}
	} catch {
		// ignore malformed storage
	}
	return [];
}

export function saveOpenConnections(ids: string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
	} catch {
		// ignore write failures (quota / private mode)
	}
}

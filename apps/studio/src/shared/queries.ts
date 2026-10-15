/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// App-shell contracts (renderer <-> main) for query history and saved queries.
// Re-homed from the original VSCode extension's VSCode Memento stores to a JSON file in the app data
// dir (see src/main/queryStore.ts).

export interface QueryHistoryEntry {
	sql: string;
	connectionId: string;
	connectionLabel: string;
	environment?: string;
	/** Epoch ms when the query was run. */
	timestamp: number;
	outcome:
		| { ok: true; rowCount: number; durationMs: number }
		| { ok: false; error: string };
}

export interface SavedQuery {
	name: string;
	sql: string;
	/** Epoch ms when the query was saved. */
	savedAt: number;
}

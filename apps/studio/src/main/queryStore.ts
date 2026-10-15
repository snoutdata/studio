/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { redactSqlSecrets } from '../shared/engine';
import type { QueryHistoryEntry, SavedQuery } from '../shared/queries';

// Query history (newest-first, capped) and named saved queries, persisted as JSON in
// the app data dir. Ports the original VSCode extension's two Memento-backed stores into one file.

const MAX_HISTORY = 200;

interface QueryState {
	history: QueryHistoryEntry[];
	saved: SavedQuery[];
}

export class QueryStore {
	private filePath(): string {
		return join(app.getPath('userData'), 'queries.json');
	}

	private read(): QueryState {
		const path = this.filePath();
		if (!existsSync(path)) {
			return { history: [], saved: [] };
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<QueryState>;
			return { history: raw.history ?? [], saved: raw.saved ?? [] };
		} catch {
			return { history: [], saved: [] };
		}
	}

	private write(state: QueryState): void {
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
	}

	history(): QueryHistoryEntry[] {
		return this.read().history;
	}

	/**
	 * Prepend an entry; re-running the same SQL on the same connection floats it up.
	 *
	 * The SQL is redacted on the way in, not on the way out. History is written to
	 * `userData/queries.json` in cleartext, so `CREATE USER x IDENTIFIED BY 'hunter2'` would
	 * otherwise leave the password on disk next to the connection it opens, forever. This is the
	 * single chokepoint for automatic history, so every caller gets it (SAVED queries are NOT
	 * redacted — the user chose to keep those, and a redacted one would not run).
	 */
	record(entry: QueryHistoryEntry): void {
		const redacted = redactSqlSecrets(entry.sql);
		const safe = redacted === entry.sql ? entry : { ...entry, sql: redacted };
		const state = this.read();
		const withoutDuplicate = state.history.filter((e) => !(e.sql === safe.sql && e.connectionId === safe.connectionId));
		state.history = [safe, ...withoutDuplicate].slice(0, MAX_HISTORY);
		this.write(state);
	}

	clearHistory(): void {
		const state = this.read();
		state.history = [];
		this.write(state);
	}

	/** Saved queries, ordered by name. */
	saved(): SavedQuery[] {
		return [...this.read().saved].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Save (case-insensitive unique name; saving over an existing name replaces it). */
	saveQuery(name: string, sql: string): void {
		const state = this.read();
		state.saved = [...state.saved.filter((q) => q.name.toLowerCase() !== name.toLowerCase()), { name, sql, savedAt: Date.now() }];
		this.write(state);
	}

	deleteQuery(name: string): void {
		const state = this.read();
		state.saved = state.saved.filter((q) => q.name.toLowerCase() !== name.toLowerCase());
		this.write(state);
	}
}

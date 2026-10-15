/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Remembers the SQL editor tabs between launches, so relaunching reopens what you were
// working on instead of a placeholder query. Persisted to localStorage (renderer-side,
// like theme/layout/appSettings). Only SQL editor tabs are saved — table-browser tabs are
// connection- and introspection-bound, so they're reopened by clicking the table again.

export interface SavedTab {
	title: string;
	content: string;
	filePath?: string;
	/** The connection this tab was bound to, restored on relaunch (may be offline). */
	connectionId?: string;
	/** Authoring surface: 'native' for a MongoDB pipeline tab, else SQL. */
	surface?: 'sql' | 'native';
	/** Monaco language of the tab's model ('json' for a native pipeline tab). */
	language?: string;
	/** Target collection of a native pipeline tab. */
	collection?: string;
}

export interface SavedSession {
	tabs: SavedTab[];
	/** Index (into `tabs`) of the tab that was focused. */
	activeIndex: number;
}

const STORAGE_KEY = 'positron-db.session';

export function loadSession(): SavedSession | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as Partial<SavedSession>;
		if (!Array.isArray(parsed.tabs)) {
			return null;
		}
		const tabs = parsed.tabs.filter(
			(t): t is SavedTab => typeof t?.content === 'string' && typeof t?.title === 'string',
		);
		const activeIndex = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0;
		return { tabs, activeIndex };
	} catch {
		return null;
	}
}

export function saveSession(session: SavedSession): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
	} catch {
		// ignore write failures (quota / private mode)
	}
}

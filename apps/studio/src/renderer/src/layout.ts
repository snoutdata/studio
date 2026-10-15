/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_DOCKS, cloneDocks, migrateLegacy, normalise, type DockLayout, type LegacyPlacement } from './docking';

/** Which view the left side bar shows; chosen from the activity bar. Still the id a side panel
 *  is known by, but WHERE it shows is now the dock layout's business. */
export type SideView = 'connections' | 'workspace' | 'flows' | 'history' | 'mcplog' | 'dashboard';

export interface Layout {
	/**
	 * Where every tool window lives, which one each area is showing, and how big it is.
	 * This REPLACED the flat `sidebarWidth`/`sideView`/`chatWidth`/`console*` fields: a persisted
	 * layout from before it existed is migrated on load and the old fields are dropped, because two
	 * places that both know where the assistant is will disagree within a week.
	 */
	docks: DockLayout;
	resultsHeight: number;
	resultsCollapsed: boolean;
	/** Height of the chat composer (the input box); drag the divider above it to grow. */
	composerHeight: number;
	/** Width of the brief panel on the generation workbench (Data Flows). Its own size, not the
	 *  sidebar's: a long brief and a wide grid want opposite things, and the user sits on that
	 *  screen for a whole authoring session. */
	generatePanelWidth: number;
	/** Height of the render surface above a coding agent's terminal, when it has drawn something.
	 *  One number for every console: the user is reading one at a time, and a per-agent height is a
	 *  setting nobody wants to keep straight. */
	agentCanvasHeight: number;
}

const STORAGE_KEY = 'positron-db.layout';

export const DEFAULT_LAYOUT: Layout = {
	docks: DEFAULT_DOCKS,
	resultsHeight: 300,
	// Closed until there is something in it: a new user meets the editor, not an empty pane. The
	// first run opens it (resolveResultTarget in App.tsx).
	resultsCollapsed: true,
	composerHeight: 120,
	generatePanelWidth: 360,
	agentCanvasHeight: 220,
};

export function loadLayout(): Layout {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const stored = JSON.parse(raw) as Partial<Layout> & LegacyPlacement;
			// Field by field, deliberately: spreading `stored` would carry the pre-docking flat
			// fields (sidebarWidth, sideView, console*) straight back into the object we save next,
			// which is the second source of truth this migration exists to remove.
			return {
				docks: normalise(stored.docks ?? migrateLegacy(stored)),
				resultsHeight: stored.resultsHeight ?? DEFAULT_LAYOUT.resultsHeight,
				resultsCollapsed: stored.resultsCollapsed ?? DEFAULT_LAYOUT.resultsCollapsed,
				composerHeight: stored.composerHeight ?? DEFAULT_LAYOUT.composerHeight,
				generatePanelWidth: stored.generatePanelWidth ?? DEFAULT_LAYOUT.generatePanelWidth,
				agentCanvasHeight: stored.agentCanvasHeight ?? DEFAULT_LAYOUT.agentCanvasHeight,
			};
		}
	} catch {
		// ignore malformed storage
	}
	return { ...DEFAULT_LAYOUT, docks: cloneDocks(DEFAULT_DOCKS) };
}

export function saveLayout(layout: Layout): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
	} catch {
		// ignore write failures (private mode, quota)
	}
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

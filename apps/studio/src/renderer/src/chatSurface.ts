/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What each assistant surface exposes.
 *
 * A chat surface is two axes: the layout `variant` (`docked`/`full`) and the active session kind
 * (`general`, or `perf` for a query-optimization chat). {@link resolveSurface} merges them into one
 * config the panel reads, so what each surface exposes lives in one table instead of `isFull` /
 * `perfSession` checks scattered through the body — adding a surface is an entry here, not a new
 * boolean threaded everywhere. (Model selection is deliberately NOT gated: the picker shows on
 * every surface.)
 *
 * Pure and DOM-free, so the table is node-testable: a domain that silently stops being blocked is
 * exactly the kind of regression nothing else would catch.
 */

/** What a SQL or pipeline card may offer, beyond Copy (which is always there). */
export type InsertTarget = 'editor' | 'newTab' | 'pipeline' | 'run';

export type SessionKind = 'general' | 'perf';

export interface SurfaceConfig {
	/** Insert affordances on a proposed SQL / pipeline block (Copy is always shown). `[]` = copy-only
	 *  (full chat, which has no editor in view; and a perf chat, which is advice you copy, not edits to
	 *  drop into a tab). The `pipeline` target is additionally gated on the active connection being a
	 *  document backend. */
	insertTargets: InsertTarget[];
	/** Feed the on-screen editor query/grid/selection/error as ambient context. Off for full chat (a
	 *  standalone DB surface, nothing on screen to anchor on) and for a perf session (it's about the
	 *  staged statement, not whatever the editor shows). */
	editorAmbient: boolean;
	/**
	 * Capability domains withheld for this surface, BEFORE the `dbRestricted` domains are layered on
	 * at send time.
	 *
	 * `editor` (insert_sql / open_in_new_tab / run_current) is always here: writing SQL into the
	 * editor is the user's manual choice via the buttons, never the assistant's.
	 *
	 * `canvas` (show_in_app) is always here too: the assistant already renders its own reply into
	 * the very surface that tool draws on, so a second way to do one thing is only a way to be
	 * confusing. It belongs to a coding agent in a console, which has no reply to render.
	 *
	 * Full chat also drops `results` (no grid in view).
	 */
	blockedDomains: string[];
	/** Whether the document-attach button is enabled (a perf chat is locked to its one statement). */
	allowAttach: boolean;
}

export function resolveSurface(variant: 'docked' | 'full', session: SessionKind): SurfaceConfig {
	const full = variant === 'full';
	const perf = session === 'perf';
	return {
		insertTargets: (full || perf) ? [] : ['editor', 'newTab', 'pipeline', 'run'],
		editorAmbient: !full && !perf,
		blockedDomains: full ? ['editor', 'canvas', 'results'] : ['editor', 'canvas'],
		allowAttach: !perf,
	};
}

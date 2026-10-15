/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityResult } from '../../shared/capabilities';

/*
 * The result grid, as the agent's `get_query_result` sees it.
 *
 * Why this exists: `get_query_result` used to be registered TWICE — a basic version in
 * capabilities/results.ts (statically, at App init) and a much better one in ResultsGrid.tsx
 * (component-scoped: offset/limit, a column subset, and the grid's current filter and sort order).
 * `capabilityRegistry.register` throws on a duplicate name, so exactly one of them survived and
 * which one depended on mount order. That collision is what produced the black-window crash on
 * 2026-08-21; making `useCapabilities` log-and-skip turned the crash into a SILENT loss of the
 * better implementation.
 *
 * The fix is one registration, always static (so an external agent connected at launch can see it —
 * `mcpServer.ts` snapshots the tool list at `initialize`), reading through this slot when a grid is
 * on screen and falling back to the app bridge when none is. The grid keeps its own internals: what
 * it publishes here is the finished answer, not its state.
 */

/** What a mounted result grid offers the capability. */
export interface LiveGrid {
	/** Read the loaded rows, in the order the user is looking at them. */
	getQueryResult(args: Record<string, unknown>): CapabilityResult;
}

let live: LiveGrid | null = null;

/** Publish (or, with null, withdraw) the grid the agent should read. One at a time: only the main
 *  results pane sets `aiActions`, so there is never a second claimant. */
export function publishGrid(grid: LiveGrid | null): void {
	live = grid;
}

/** The grid on screen, or null when none is mounted. */
export function liveGrid(): LiveGrid | null {
	return live;
}

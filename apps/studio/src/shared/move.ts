/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The app's side of moving a database: what the view asks main for. The spec, the findings and
 * the progress shape are the shared package's (`@snout/move`), because the CLI reads exactly the
 * same ones.
 */

import type { Finding, MoveProgress, MoveRunResult, MoveRunStatus, MoveSpec } from '@snout/move';

export interface MoveCheck {
	readonly findings: readonly Finding[];
	/** Nothing blocks and every decision is made. */
	readonly ready: boolean;
	/** What `replace` drops from the target first, by name, for the review sheet. */
	readonly drops: readonly string[];
	/** Why the check could not run at all, in a sentence. Null when it ran. */
	readonly error: string | null;
}

export type MoveFixOutcome =
	| { readonly ok: true; readonly spec: MoveSpec; readonly check: MoveCheck }
	| { readonly ok: false; readonly error: string };

/** The names a person typed on the review sheet, checked again in main. */
export interface MoveConfirmations {
	readonly target?: string;
	readonly source?: string;
}

export type MoveStartOutcome = { readonly ok: true; readonly runId: string } | { readonly ok: false; readonly error: string };

/** A move as it stands in main: running with its latest progress, or finished with its report. */
export interface MoveRunState {
	readonly running: boolean;
	readonly progress: MoveProgress | null;
	readonly result: MoveRunResult | null;
}

/** One row of the ledger (`flows.db`, `move_runs`). */
export interface MoveRunRecord {
	readonly id: string;
	readonly moveId: string;
	readonly startedAt: string;
	readonly finishedAt: string | null;
	readonly status: 'running' | MoveRunStatus;
	readonly spec: MoveSpec;
	readonly findings: readonly Finding[];
	readonly result: MoveRunResult | null;
}

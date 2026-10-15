/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a running move reports, and the arithmetic on it.
 *
 * The runner fills this from `pg_stat_progress_copy` on both servers, the bytes through the pipe
 * and `pg_restore --verbose`; every surface that shows a move (the view, the assistant's render
 * block, the tray, `snoutdata move` in a terminal) reads the same shape.
 */

export type MovePhase =
	| 'starting'
	/** A hosted endpoint is being resumed, before any tool starts. */
	| 'waking'
	/** The target the move makes is being created. */
	| 'creating'
	/** A copy of a hosted target is being saved before it is replaced. */
	| 'saving'
	/** The target is being emptied. */
	| 'replacing'
	| 'schema'
	| 'data'
	| 'indexes'
	| 'verifying'
	/** The source is being paused or deleted. */
	| 'finishing'
	| 'done'
	| 'failed'
	| 'cancelled';

export interface MoveTableProgress {
	readonly schema: string;
	readonly table: string;
	readonly state: 'waiting' | 'copying' | 'done' | 'failed';
	readonly bytesDone: number;
	readonly bytesTotal: number | null;
	readonly rowsDone: number;
	readonly rowsEstimate: number | null;
}

export interface MoveProgress {
	readonly runId: string;
	readonly moveId: string;
	readonly phase: MovePhase;
	/** A sentence about right now: "Waking exampleref003", "Copying public.orders". */
	readonly message: string | null;
	readonly tables: readonly MoveTableProgress[];
	readonly bytesDone: number;
	readonly bytesTotal: number | null;
	readonly bytesPerSecond: number | null;
	readonly objectsFailed: number;
}

export function isActivePhase(phase: MovePhase): boolean {
	return phase !== 'done' && phase !== 'failed' && phase !== 'cancelled';
}

/** 0..1 when the total is known, null otherwise. Never above 1: estimates undershoot. */
export function overallFraction(progress: MoveProgress): number | null {
	if (progress.phase === 'done') {
		return 1;
	}
	if (progress.bytesTotal === null || progress.bytesTotal <= 0) {
		return null;
	}
	return Math.min(1, progress.bytesDone / progress.bytesTotal);
}

export function tableFraction(table: MoveTableProgress): number | null {
	if (table.state === 'done') {
		return 1;
	}
	if (table.bytesTotal !== null && table.bytesTotal > 0) {
		return Math.min(1, table.bytesDone / table.bytesTotal);
	}
	if (table.rowsEstimate !== null && table.rowsEstimate > 0) {
		return Math.min(1, table.rowsDone / table.rowsEstimate);
	}
	return null;
}

/** Seconds left at the current rate, or null when either is unknown. */
export function etaSeconds(progress: MoveProgress): number | null {
	if (!isActivePhase(progress.phase) || progress.bytesTotal === null || !progress.bytesPerSecond || progress.bytesPerSecond <= 0) {
		return null;
	}
	return Math.max(0, Math.round((progress.bytesTotal - progress.bytesDone) / progress.bytesPerSecond));
}

export function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${seconds} s`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `about ${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	return `about ${hours} h ${minutes % 60} min`;
}

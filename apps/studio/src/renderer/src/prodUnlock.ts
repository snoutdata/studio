/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react';

/*
 * "Allow editing" on a production connection, for this session only.
 *
 * A prod grid is look-only by default, and the Settings switch lifts that for EVERY prod
 * connection, forever. Neither fits fixing one row: the user should not have to relabel the
 * connection or open the floodgates to change a token. So the lock can be lifted per
 * connection from the grid itself, held in memory and gone at restart. Saving still opens the
 * statement preview, which is the review a prod write gets either way.
 *
 * Kept per CONNECTION rather than per grid so the table tab and the results grid agree, which
 * is the same rule `policy.allowsGridActions` exists to keep.
 */

let unlocked: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) {
		l();
	}
}

export function unlockProdEditing(connectionId: string): void {
	if (unlocked.has(connectionId)) {
		return;
	}
	unlocked = new Set([...unlocked, connectionId]);
	emit();
}

export function lockProdEditing(connectionId: string): void {
	if (!unlocked.has(connectionId)) {
		return;
	}
	const next = new Set(unlocked);
	next.delete(connectionId);
	unlocked = next;
	emit();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function snapshot(): ReadonlySet<string> {
	return unlocked;
}

/** React hook: the connections whose prod edit lock is lifted for this session. */
export function useProdUnlocked(): ReadonlySet<string> {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ShardsProposal } from '../../shared/cloudShards';

/**
 * An operation the assistant (or a coding agent) PROPOSED for a project's cluster, waiting for
 * the Cluster section to show it. The capability opens the section and leaves the proposal here;
 * the section takes it, plans it, and a person presses Run or does not. Nothing in this file, or
 * in the capability, runs anything: no surprise cutovers.
 *
 * In the launch chunk on purpose: it is a few lines, and the capability that writes it is static.
 */

const pending = new Map<string, ShardsProposal>();
const listeners = new Set<(ref: string) => void>();

/** Leave a proposal for `ref`'s Cluster section, replacing any it had not shown yet. */
export function proposeShardsOperation(ref: string, proposal: ShardsProposal): void {
	pending.set(ref, proposal);
	for (const listener of listeners) {
		listener(ref);
	}
}

/** Take the proposal waiting for `ref`, once. */
export function takeShardsProposal(ref: string): ShardsProposal | null {
	const proposal = pending.get(ref) ?? null;
	pending.delete(ref);
	return proposal;
}

/** Be told when a proposal arrives; returns the unsubscribe. */
export function onShardsProposal(listener: (ref: string) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

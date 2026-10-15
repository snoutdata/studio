/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-connection concurrency gate for BACKGROUND queries.
 *
 * App-driven polling (the monitors poller) runs at background priority. Left unchecked, a busy
 * monitor could hold every connection in a small pool and stall the user's own query. This gate
 * caps how many background queries a connection runs at once — always one below the interactive
 * pool size — so at least one pooled connection is forever reachable by an interactive query.
 * Interactive queries never go through the gate; they are never throttled.
 *
 * Waiters are released FIFO. A released slot is handed straight to the next waiter (the in-flight
 * count is conserved, not bounced through zero), so a steady stream of background polls can't
 * starve an earlier-parked one.
 *
 * Pure and dependency-free (no Electron) so it can be unit-tested directly.
 */
export class BackgroundGate {
	private readonly inFlight = new Map<string, number>();
	private readonly waiters = new Map<string, Array<() => void>>();

	/** Reserve a slot for `id`, parking (FIFO) until one frees if the connection is at `limit`. */
	acquire(id: string, limit: number): Promise<void> {
		const cur = this.inFlight.get(id) ?? 0;
		if (cur < Math.max(1, limit)) {
			this.inFlight.set(id, cur + 1);
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const q = this.waiters.get(id) ?? [];
			q.push(resolve);
			this.waiters.set(id, q);
		});
	}

	/** Release a slot: hand it to the next waiter if any (count unchanged), else drop the count. */
	release(id: string): void {
		const q = this.waiters.get(id);
		if (q && q.length > 0) {
			const next = q.shift();
			if (q.length === 0) {
				this.waiters.delete(id);
			}
			next?.(); // slot handed off, so the in-flight count stays the same
			return;
		}
		const cur = this.inFlight.get(id) ?? 0;
		if (cur <= 1) {
			this.inFlight.delete(id);
		} else {
			this.inFlight.set(id, cur - 1);
		}
	}

	/** Current in-flight background count for a connection (0 when idle). For tests/diagnostics. */
	inFlightCount(id: string): number {
		return this.inFlight.get(id) ?? 0;
	}

	/** Number of background queries parked waiting for a slot on a connection. For tests/diagnostics. */
	waitingCount(id: string): number {
		return this.waiters.get(id)?.length ?? 0;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalizeQuery, classifyError, type FailureRecord, type FailureSink, type Verdict } from '../shared/engine';

/**
 * Failure memory (Loop 1), the write path. Every record is triggered by a deterministic execution
 * verdict, never by a model's judgement of salience. v1 writes on FAILURE only: the failure signal
 * is clean (the executor or compiler said no), whereas a query can succeed and still be semantically
 * wrong.
 *
 * This is the single sink every executor funnels its verdict through — the whole choke point. It
 * derives the four deterministic match fields (`query_shape`, `error_class`, `schema_fingerprint`,
 * `target_backend`) and appends the record through a {@link FailureSink}.
 *
 * Build order:
 *   - step 2: the sink + routing.
 *   - step 3: error_class — a deterministic classifier (shared/engine/memory/errorClass).
 *   - step 4: query_shape — a canonical, literal-free form (shared/engine/parse/queryShape).
 *   - step 5 (here): durable storage — records go through a FailureSink (SQLite in the app; a fake
 *     in tests). Retrieval still doesn't read them back — no retrieval yet, by design.
 */
export class FailureMemory {
	// In-flight captures, so tests and graceful shutdown can await the fire-and-forget writes.
	private readonly inFlight = new Set<Promise<void>>();

	/**
	 * @param store The persistence seam records are appended to.
	 * @param digestFor Resolves a connection's structural schema fingerprint. Cheap and non-blocking
	 * (served from the server's in-memory cache), resolved off the query's critical path since the
	 * sink never awaits the capture.
	 * @param onRecord Optional observer fired after each captured failure. Kept out of this module (no
	 * console/electron coupling here, so tests stay pure); main wires a dev-only log through it so a
	 * captured failure is visible in the terminal for manual verification.
	 */
	constructor(
		private readonly store: FailureSink,
		private readonly digestFor: (connectionId: string) => Promise<string>,
		private readonly onRecord?: (record: FailureRecord) => void,
	) {}

	/**
	 * Record one execution verdict. Fire-and-forget by contract: it never throws and never blocks the
	 * query flow — a capture failure degrades silently to no-memory. Successes are ignored in v1 (they
	 * only ever backfill a resolution, a later step; they never author a memory).
	 */
	record(verdict: Verdict): void {
		if (verdict.ok) {
			return;
		}
		const capture = this.capture(verdict)
			.catch(() => undefined)
			.finally(() => this.inFlight.delete(capture));
		this.inFlight.add(capture);
	}

	private async capture(verdict: Verdict): Promise<void> {
		const schemaFingerprint = await this.digestFor(verdict.connectionId).catch(() => '');
		const error = verdict.error ?? '';
		const record: FailureRecord = {
			connectionId: verdict.connectionId,
			query: verdict.query,
			queryShape: canonicalizeQuery(verdict.query),
			backend: verdict.backend,
			origin: verdict.origin,
			error,
			errorClass: classifyError(error, verdict.origin),
			schemaFingerprint,
			at: Date.now(),
		};
		this.store.insert(record);
		this.onRecord?.(record);
	}

	/** Await all in-flight captures. Used by tests (the writes are fire-and-forget) and available for
	 *  a graceful shutdown flush. */
	async settled(): Promise<void> {
		await Promise.all(this.inFlight);
	}
}

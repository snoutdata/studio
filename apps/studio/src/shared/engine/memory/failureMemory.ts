/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { BackendKind } from '../compile/native';
import type { ErrorClass, FailureOrigin } from './errorClass';

// Shared data types for the failure memory. Kept in shared/ so the sink (main), the persistence
// store (main), and the replay benchmark can all speak the same record shape without a circular
// import.

/** The deterministic outcome of one execution attempt, handed to the sink by an executor. */
export interface Verdict {
	connectionId: string;
	/** The authored query text (SQL) or a native-query rendering — the source `query_shape` is
	 *  derived from. */
	query: string;
	backend: BackendKind;
	ok: boolean;
	/** The driver or compiler message. Present on failure; used for display and to derive
	 *  `error_class`. Matching never happens on this raw string. */
	error?: string;
	/** Where the failure surfaced: a driver execution error, or the deterministic compiler refusing
	 *  to translate the query to the backend's native form. */
	origin: FailureOrigin;
}

/** One persisted failure. All four match fields (`queryShape`, `schemaFingerprint`, `backend`,
 *  `errorClass`) are deterministically derived; `query`/`error` are raw, for display only. */
export interface FailureRecord {
	connectionId: string;
	query: string;
	/** The canonical, literal-free shape of `query` — the structural key retrieval matches on. */
	queryShape: string;
	backend: BackendKind;
	origin: FailureOrigin;
	error: string;
	/** The deterministic class this failure was mapped to. Matching happens on this, not `error`. */
	errorClass: ErrorClass;
	/** The connection's structural schema fingerprint at failure time ('' if unavailable). */
	schemaFingerprint: string;
	at: number;
}

/**
 * The persistence seam the sink writes through. Kept minimal (append-only for now) so the sink can
 * be unit-tested against a fake and the real SQLite store stays swappable. Fire-and-forget: `insert`
 * runs inside the sink's swallowed capture, so an implementation must not throw into the query flow.
 */
export interface FailureSink {
	insert(record: FailureRecord): void;
}

/**
 * The read seam retrieval queries through. Separate from {@link FailureSink} so the write path and
 * the read path stay independent. `match` is the exact gate — same `schema_fingerprint` AND same
 * `backend` — ranking by `query_shape` happens above it (shared/failureRetrieval).
 */
export interface FailureQuery {
	match(schemaFingerprint: string, backend: BackendKind, limit?: number): FailureRecord[];
}

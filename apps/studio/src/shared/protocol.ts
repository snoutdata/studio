/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Custom LSP messages between the extension host and the SQL language server.
// Standard editor features (completion, hover, diagnostics) use the normal LSP
// methods; these custom ones drive connection lifecycle, schema refresh and query
// execution.

import type { CloudAccount } from './cloud';
import type { ConnectionConfig } from './connection';
import type { DatabaseSchema } from './schema';
import type { QueryResult } from './query';
import type { NativeQuery } from './engine/compile/native';
import type { BulkExportRequest, BulkExportResult, BulkLoadRequest, BulkLoadResult } from './engine/dialect/bulkLoad';

export const SnoutProtocol = {
	/** client -> server: connect via the driver and introspect into the cache. */
	Connect: 'snout/connect',
	/** client -> server: disconnect and drop the cached schema. */
	Disconnect: 'snout/disconnect',
	/** client -> server: re-introspect an existing connection. */
	RefreshSchema: 'snout/refreshSchema',
	/** client -> server: fetch the cached schema for a connection (tree explorer). */
	GetSchema: 'snout/getSchema',
	/**
	 * client -> server: fetch the last-polled structural digest for a connection (a cheap,
	 * order-independent fingerprint of tables/columns/types/positions). Returns the in-memory
	 * cached value the live schema index already maintains, so it never hits the database — a
	 * fire-and-forget caller (the failure-memory write path) can read it without blocking.
	 */
	GetSchemaDigest: 'snout/getSchemaDigest',
	/** client -> server: connect+ping+disconnect without caching ("Test Connection"). */
	TestConnection: 'snout/testConnection',
	/** client -> server: do these cloud credentials sign in, for a log service, before any region,
	 *  workspace or project is chosen (Settings → Cloud accounts → Test, when this build has no
	 *  storage or log-source driver to test them with). */
	VerifyCloudAccount: 'snout/verifyCloudAccount',
	/** client -> server: run a SQL statement on a connection and return its rows. */
	ExecuteQuery: 'snout/executeQuery',
	/** client -> server: stream a file into a table as one statement's body (the engine's own bulk
	 *  path in; see `shared/engine/dialect/bulkLoad.ts`). */
	BulkLoad: 'snout/bulkLoad',
	/** client -> server: write a whole result straight to a file, in one of the engine's own
	 *  formats, without the rows passing through the app. */
	BulkExport: 'snout/bulkExport',
	/** client -> server: cancel the query currently running on a connection. */
	CancelQuery: 'snout/cancelQuery',
	/** client -> server: how far the query running on a connection has got, or null when the
	 *  driver cannot say (or nothing is running). Polled while a run is in flight. */
	QueryProgress: 'snout/queryProgress',
	/**
	 * client -> server: cheap liveness probe (driver.ping()). Used by the heartbeat,
	 * power-resume re-check and window-focus re-check to distinguish a still-live
	 * connection from one whose pooled socket died silently between queries.
	 */
	PingConnection: 'snout/pingConnection',
	/** server -> client: notify that a connection's schema cache changed. */
	SchemaUpdated: 'snout/schemaUpdated',
	/** server -> client: an SSH tunnel trusted a host key seen for the first time; main remembers
	 *  it so later connects to that host and port are held to it. */
	SshHostKeyLearned: 'snout/sshHostKeyLearned',
} as const;

export interface SshHostKeyLearnedParams {
	host: string;
	port: number;
	/** `SHA256:<base64>`, as OpenSSH prints it. */
	fingerprint: string;
}

export interface VerifyCloudAccountParams {
	/** The telemetry service to sign in to (`TELEMETRY_SERVICES` key). */
	service: string;
	account: CloudAccount;
	secret?: string;
}

export interface VerifyCloudAccountResult {
	ok: boolean;
	/** On failure, the service's own explanation of what to fix. */
	message?: string;
}

export interface ConnectParams {
	config: ConnectionConfig;
}

export interface ConnectResult {
	connectionId: string;
	tableCount: number;
}

export interface GetSchemaParams {
	connectionId: string;
}

export interface TestConnectionParams {
	config: ConnectionConfig;
}

export interface TestConnectionResult {
	ok: boolean;
	/** Present when ok is false; a human-readable failure reason. */
	error?: string;
}

export interface SchemaUpdatedParams {
	connectionId: string;
	tableCount: number;
}

/** GetSchema returns the cached schema, or null if the connection is not connected. */
export type GetSchemaResult = DatabaseSchema | null;

export interface GetSchemaDigestParams {
	connectionId: string;
}

/**
 * GetSchemaDigest returns the last-polled structural digest ("<count>:<hash>"), or an empty
 * string when the connection is unknown/not connected or its digest hasn't been captured yet.
 * The empty string means "no fingerprint available", never a valid schema.
 */
export type GetSchemaDigestResult = string;

export interface ExecuteQueryParams {
	connectionId: string;
	/** The resolved native query to run. Transcription from a non-native surface (SQL on a
	 *  document/vector backend, NL) happens in main before the request reaches the server. */
	query: NativeQuery;
}

/**
 * Renderer -> main IPC shape for `sql:execute`. Two surfaces:
 * - `{ connectionId, sql }` — authored SQL. Main wraps it into a `NativeQuery`
 *   ({@link ExecuteQueryParams}) and, for document/vector backends, transcribes it first.
 * - `{ connectionId, native }` — an already-built `NativeQuery` (the native pipeline JSON surface). Main dispatches it as-is after the destructive/read-only guard.
 */
export type RunQueryParams =
	| {
			connectionId: string;
			sql: string;
			allowAiTranscribe?: boolean;
			/**
			 * The time range to run a TELEMETRY statement over, when the SQL names none (the results
			 * footer's range control). Ignored by every other backend, whose queries are not bounded
			 * by time. Absent means the compiler's own default, which is the last hour.
			 */
			window?: { start: number; end: number };
	  }
	| {
			connectionId: string;
			native: NativeQuery;
			/** False for a read the app makes on the user's behalf rather than one they ran (the log
			 *  reader's surrounding events), which does not belong in their query history. */
			recordHistory?: boolean;
	  };

/**
 * BulkLoad: one file, one table, one statement. The PATH crosses the wire, not the bytes — the
 * server child runs on this machine and streams the file itself, which is the only way a load of
 * a file bigger than memory can work.
 */
export interface BulkLoadParams {
	connectionId: string;
	request: BulkLoadRequest;
}

/** Same envelope reasoning as {@link ExecuteQueryResult}: a refused load (a wrong format, a
 *  column that is not there) is an outcome the screen shows, not a transport fault. */
export type BulkLoadOutcome =
	| { ok: true; result: BulkLoadResult }
	| { ok: false; error: string; cancelled?: boolean };

export interface BulkExportParams {
	connectionId: string;
	request: BulkExportRequest;
}

export type BulkExportOutcome =
	| { ok: true; result: BulkExportResult }
	| { ok: false; error: string; cancelled?: boolean };

/** Liveness probe result: `ok:true` if the driver's ping succeeded, else the failure reason. */
export type PingConnectionResult =
	| { ok: true }
	| { ok: false; error: string };

/**
 * ExecuteQuery returns an envelope rather than throwing: a SQL error (bad syntax,
 * missing table) is an expected outcome the results grid renders in place, not an
 * exceptional one. A transport/driver fault still rejects the request. `cancelled`
 * marks the case where the user aborted the run (via CancelQuery) — the client shows
 * it as cancelled, not as an error.
 */
export type ExecuteQueryResult =
	| { ok: true; result: QueryResult; aiTranslated?: boolean }
	| { ok: false; error: string; cancelled?: boolean; needsAiTranscribe?: boolean };

/**
 * Result of translating a SQL string to a backend's native query form WITHOUT running it (the
 * "Get pipeline translation" editor action). Deterministic-first; an unsupported query that the AI
 * could recover reports `needsAiTranscribe` so the caller can ask before spending budget.
 */
export type TranscribeResult =
	| { ok: true; native: NativeQuery }
	| { ok: false; error: string; needsAiTranscribe?: boolean };

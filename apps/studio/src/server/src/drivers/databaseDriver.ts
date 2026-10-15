/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../../shared/connection';
import type { DatabaseSchema } from '../../../shared/schema';
import type { DialectCatalog } from '../../../shared/catalog';
import type { QueryProgress, QueryResult } from '../../../shared/query';
import { type BackendKind, type BulkExportRequest, type BulkExportResult, type BulkLoadRequest, type BulkLoadResult, type NativeQuery } from '../../../shared/engine';

// QueryField/QueryResult are the wire contract for query execution and live in
// shared/ so the client and the LSP protocol use the same shapes. They are
// re-exported here so the drivers that produce them keep importing from this module.
export type { QueryField, QueryResult } from '../../../shared/query';

export interface IntrospectOptions {
	/** Restrict to specific schemas/databases. */
	schemas?: string[];
	includeViews?: boolean;
}

/**
 * The pluggable contract every database backend implements. MySQL/Aurora is the
 * only shipped driver today; Postgres and others register against this same
 * interface (see driverRegistry), so feature code never special-cases a vendor.
 */
export interface DatabaseDriver {
	readonly id: string;
	readonly displayName: string;
	/** The execution-model family this driver belongs to. Relational drivers receive only
	 *  `{ lang: 'sql' }` queries; document/vector drivers receive their own NativeQuery variant. */
	readonly kind: BackendKind;

	connect(config: ConnectionConfig): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	ping(): Promise<void>;

	/** Introspection feeding the completion engine + schema explorer. */
	introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema>;

	/**
	 * A cheap fingerprint of the structural schema (tables/columns/types/positions),
	 * scoped exactly like introspectSchema. Polled by the server's live schema index
	 * to detect DDL changes without a full re-introspection each tick.
	 */
	structuralDigest(): Promise<string>;

	/**
	 * Query execution (results grid — ROADMAP phase b). Receives a {@link NativeQuery} in this
	 * driver's `kind`; relational drivers narrow on `q.lang === 'sql'` and reject other variants.
	 */
	execute(query: NativeQuery): Promise<QueryResult>;

	/**
	 * Cancel the query currently running via {@link execute} (no-op if none). Issued
	 * on a side connection (pg `pg_cancel_backend`, MySQL `KILL QUERY`) so the
	 * in-flight `execute` rejects with {@link QueryCancelledError}.
	 */
	cancel(): Promise<void>;

	/**
	 * How far the query in flight has got, read from the server's own view of it, or null when
	 * nothing is running. Optional: only engines that expose a running query's progress to another
	 * request (ClickHouse `system.processes`) implement it.
	 */
	progress?(): Promise<QueryProgress | null>;

	/**
	 * What this engine KNOWS: its functions, combinators, table functions, engines, types, formats
	 * and settings, read from its own catalog. Completion and hover use it, so they describe the
	 * server's actual version rather than a list baked into the app. Optional — a driver without
	 * one leaves completion exactly as it was, and a failed read is the same as not having it.
	 * Called once per connection, off the connect path.
	 */
	introspectCatalog?(): Promise<DialectCatalog>;

	/**
	 * Load a FILE into a table, as the statement's own body, which is the engine's fast path in
	 * (`shared/engine/dialect/bulkLoad.ts`). Optional: a driver that has no such path leaves the
	 * app's Load button hidden, and rows keep going in as `INSERT ... VALUES`.
	 *
	 * The file is STREAMED. Nothing here may read it into memory, because the files this exists
	 * for are the ones too big to sit in a statement.
	 */
	bulkLoad?(request: BulkLoadRequest): Promise<BulkLoadResult>;

	/**
	 * The same seam the other way: a whole result written STRAIGHT to a file by the server, with
	 * the rows never passing through this process. Optional, and offered by the same engines.
	 */
	bulkExport?(request: BulkExportRequest): Promise<BulkExportResult>;
}

/**
 * Narrow a {@link NativeQuery} to its SQL form for a relational driver, throwing if the driver
 * was handed a non-SQL variant (a transcription bug — relational backends only ever get SQL).
 */
export function expectSql(query: NativeQuery): { sql: string; params?: readonly unknown[]; readOnly: boolean } {
	if (query.lang !== 'sql') {
		throw new Error(`Relational driver cannot execute a '${query.lang}' query.`);
	}
	return { sql: query.sql, params: query.params, readOnly: query.readOnly === true };
}

/** Thrown by a driver's {@link DatabaseDriver.execute} when the query was cancelled. */
export class QueryCancelledError extends Error {
	constructor() {
		super('Query cancelled.');
		this.name = 'QueryCancelledError';
	}
}

export type DriverFactory = () => DatabaseDriver;

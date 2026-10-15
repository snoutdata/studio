/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../../../shared/connection';
import type { NativeRuntime } from '../../../../shared/components';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { readOnlyEnforcementFor, type NativeQuery } from '../../../../shared/engine';
import { withReadOnlySession } from '../readOnlySession';
import { introspectDuckDb, duckdbStructuralDigest, type DuckDbRowRunner } from './introspection';

// The slice of `@duckdb/node-api` we use, typed structurally so the client stays a runtime
// require (it is external + on-demand, never bundled — see loadApi). `getRowsJson()` /
// `getRowObjectsJson()` return values already coerced to JSON-safe forms (BigInt → string,
// timestamps/decimals/LISTs → readable strings/arrays), so no per-cell coercion is needed here.
interface DuckDbReader {
	readonly returnType: number;
	readonly rowsChanged: number;
	columnNames(): string[];
	getRowsJson(): unknown[][];
	getRowObjectsJson(): Record<string, unknown>[];
}

interface DuckDbPrepared {
	bind(values: readonly unknown[]): void;
	runAndReadAll(): Promise<DuckDbReader>;
}

interface DuckDbConnection {
	runAndReadAll(sql: string): Promise<DuckDbReader>;
	prepare(sql: string): Promise<DuckDbPrepared>;
	interrupt(): void;
	disconnectSync(): void;
}

interface DuckDbInstance {
	connect(): Promise<DuckDbConnection>;
	closeSync(): void;
}

interface DuckDbApi {
	DuckDBInstance: { create(path: string, options?: Record<string, string>): Promise<DuckDbInstance> };
	ResultReturnType: { QUERY_RESULT: number };
}

let cachedApi: DuckDbApi | undefined;

/**
 * How a handle that serves a read-only run is opened. DuckDB runs in this process, so
 * a plain "read" could otherwise read any file or URL the app can: `read_text('~/.ssh/id_rsa')`,
 * `read_blob`, `glob`, `read_csv('https://...')`, a replacement scan of `'x.csv'`, ATTACH, INSTALL
 * and LOAD. READ_ONLY refuses writes to the file; `enable_external_access = false` refuses every
 * other file, URL and extension; `lock_configuration` refuses any SET on the handle (DuckDB already
 * refuses to switch external access back on while it runs). The database enforces all three.
 */
export const CONFINED: Readonly<Record<string, string>> = { access_mode: 'READ_ONLY', enable_external_access: 'false', lock_configuration: 'true' };

/**
 * Load `@duckdb/node-api` lazily. It is NOT bundled (esbuild external) nor shipped in the base
 * installer (its per-platform native binary is ~110 MB), so the users who never touch DuckDB don't
 * carry it. In a packaged build it lives in the on-demand component dir whose absolute path arrives
 * on the connect config (`nativeRuntime.modulePath`); in dev it resolves from node_modules (a
 * devDependency). It uses N-API, so unlike Db2's ibm_db it loads in-process here — no stock-Node
 * sidecar, matching the Snowflake pattern.
 */
function loadApi(runtime: NativeRuntime | undefined): DuckDbApi {
	if (cachedApi) {
		return cachedApi;
	}
	const id = runtime?.modulePath ?? '@duckdb/node-api';
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	cachedApi = require(id) as DuckDbApi;
	return cachedApi;
}

/**
 * DuckDB driver. An embedded, file-based analytical (OLAP) engine — like SQLite there is no
 * host/port/credentials and no SSH tunnel; the connection's `database` field carries the path to
 * the `.duckdb` file. A single instance + connection per driver (DuckDB serialises writes to the
 * file itself). Introspection reads the Postgres-shaped information_schema + `duckdb_*` catalog
 * functions. The native client is loaded in-process (N-API) via the on-demand component.
 */
class DuckDbDriver implements DatabaseDriver {
	readonly id = 'duckdb';
	readonly displayName = 'DuckDB';
	readonly kind = 'relational' as const;

	private api?: DuckDbApi;
	private instance?: DuckDbInstance;
	private connection?: DuckDbConnection;
	private filePath?: string;
	/** The connection's own handle is confined (a connection flagged read-only). */
	private confinedConnection = false;
	/** The connection a run is executing on, so cancel() interrupts a read on its own handle too. */
	private running?: DuckDbConnection;
	// DuckDB runs a statement on a worker thread, so a concurrent cancel() can interrupt it. There
	// is no per-statement handle (interrupt is connection-wide); `cancelled` lets execute() report
	// an interrupted statement as a cancellation rather than a raw error.
	private cancelled = false;

	async connect(config: ConnectionConfig): Promise<void> {
		// The file path rides in `database` (the form's file picker writes it there); fall back to
		// `host` defensively in case an imported/hand-edited connection put it there.
		const file = config.database || config.host;
		if (!file) {
			throw new Error('duckdb: no database file path (set the database file on the connection).');
		}
		this.filePath = file;
		this.api = loadApi(config.nativeRuntime);
		// A connection flagged read-only runs every statement as a read-only run, so its one handle
		// is the confined one (see CONFINED): no writes to the file, and no other file, URL or
		// extension. It also avoids creating an empty file on a typo'd path.
		this.confinedConnection = config.readOnly === true;
		const options = this.confinedConnection ? CONFINED : undefined;
		this.instance = await this.api.DuckDBInstance.create(file, options);
		this.connection = await this.instance.connect();
		await this.ping();
	}

	async disconnect(): Promise<void> {
		this.connection?.disconnectSync();
		this.instance?.closeSync();
		this.connection = undefined;
		this.instance = undefined;
	}

	isConnected(): boolean {
		return this.connection !== undefined;
	}

	async ping(): Promise<void> {
		if (!this.connection) {
			throw new Error('duckdb: not connected');
		}
		await this.connection.runAndReadAll('SELECT 1');
	}

	/** Introspection runner: named-column rows with DuckDB's rich types already JSON-coerced. */
	private runner: DuckDbRowRunner = async (sql) => {
		if (!this.connection) {
			throw new Error('duckdb: not connected');
		}
		const reader = await this.connection.runAndReadAll(sql);
		return reader.getRowObjectsJson();
	};

	introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		return introspectDuckDb(this.runner, this.filePath, options?.includeViews ?? true);
	}

	structuralDigest(): Promise<string> {
		return duckdbStructuralDigest(this.runner);
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		const connection = this.connection;
		if (!connection || !this.api) {
			throw new Error('duckdb: not connected');
		}
		if (!readOnly) {
			return this.executeOn(connection, sql, params);
		}
		if (this.confinedConnection) {
			// A READ ONLY transaction on the connection's own (confined) handle. A transaction the user
			// already opened makes BEGIN fail, so the read is refused rather than rolling their work back.
			return this.readOnlyOn(connection, sql, params);
		}
		// A writable connection's handle can read any file and URL, which a read-only grant must
		// not: the run gets a confined handle of its own on the same file, opened for it and closed
		// after it. Opened per run, it reads what is committed now (DuckDB replays the WAL on open).
		const file = this.filePath;
		if (!file || /^:memory:/i.test(file)) {
			throw new Error('duckdb: an in-memory database has no file a read-only handle can open, so a read-only run is refused.');
		}
		const confined = await this.api.DuckDBInstance.create(file, CONFINED);
		try {
			const confinedConnection = await confined.connect();
			try {
				return await this.readOnlyOn(confinedConnection, sql, params);
			} finally {
				confinedConnection.disconnectSync();
			}
		} finally {
			confined.closeSync();
		}
	}

	private readOnlyOn(connection: DuckDbConnection, sql: string, params: readonly unknown[] | undefined): Promise<QueryResult> {
		return withReadOnlySession(readOnlyEnforcementFor('duckdb'), { run: (statement) => connection.runAndReadAll(statement), discard: () => undefined }, () => this.executeOn(connection, sql, params));
	}

	private async executeOn(connection: DuckDbConnection, sql: string, params: readonly unknown[] | undefined): Promise<QueryResult> {
		if (!this.api) {
			throw new Error('duckdb: not connected');
		}
		this.cancelled = false;
		this.running = connection;
		const start = Date.now();
		let reader: DuckDbReader;
		try {
			if (params && params.length > 0) {
				const prepared = await connection.prepare(sql);
				prepared.bind(params);
				reader = await prepared.runAndReadAll();
			} else {
				reader = await connection.runAndReadAll(sql);
			}
		} catch (err) {
			if (this.cancelled) {
				this.cancelled = false;
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			this.running = undefined;
		}
		// A QUERY_RESULT carries real output columns (SELECT, PRAGMA, … RETURNING). CHANGED_ROWS /
		// NOTHING (INSERT/UPDATE/DELETE/DDL) return a synthetic "Count" column, so classify on the
		// result type rather than column presence; their affected-row count is `rowsChanged`.
		if (reader.returnType === this.api.ResultReturnType.QUERY_RESULT) {
			const names = reader.columnNames();
			const rows = reader.getRowsJson();
			return {
				fields: names.map((name) => ({ name })),
				rows,
				rowCount: rows.length,
				durationMs: Date.now() - start,
			};
		}
		return {
			fields: [],
			rows: [],
			rowCount: Number(reader.rowsChanged),
			durationMs: Date.now() - start,
		};
	}

	async cancel(): Promise<void> {
		const connection = this.running ?? this.connection;
		if (connection) {
			this.cancelled = true;
			connection.interrupt();
		}
	}
}

export function createDuckDbDriver(): DatabaseDriver {
	return new DuckDbDriver();
}

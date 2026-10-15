/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../../../shared/connection';
import { clampPoolMax } from '../../../../shared/connection';
import type { NativeRuntime } from '../../../../shared/components';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { assertHanaFields } from '../connectStrings';
import { type NativeQuery } from '../../../../shared/engine';
import { isPreflightDeadConnectionError } from '../deadConnection';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { introspectHana, hanaStructuralDigest } from './introspection';

// The slice of `@sap/hana-client` we use, typed structurally so the client stays a runtime require
// (it is external + on-demand, never bundled — see loadClient) and the tree typechecks with or
// without the package present. `exec` yields positional rows when `rowsAsArray` is set, named-column
// row objects otherwise, and the affected-row count for a non-query.
type HanaCallback<T> = (err: Error | null, result?: T) => void;

interface ExecOptions {
	rowsAsArray?: boolean;
}

interface HanaColumnInfo {
	columnName: string;
}

interface HanaStatement {
	exec(params: unknown[], options: ExecOptions, fn: HanaCallback<unknown>): void;
	getColumnInfo(): HanaColumnInfo[];
	drop(): void;
}

interface HanaConnection {
	exec(sql: string, params: unknown[], options: ExecOptions, fn: HanaCallback<unknown>): void;
	prepare(sql: string, fn: HanaCallback<HanaStatement>): void;
	/** On a POOLED connection this returns it to the pool rather than disconnecting. */
	close(): void;
}

interface HanaPool {
	getConnection(fn: HanaCallback<HanaConnection>): void;
	clear(fn?: (err?: Error) => void): void;
}

/** hana-client connection properties (serverNode/uid/pwd/…) — a free-form string map. */
type HanaConnectionOptions = Record<string, string | number>;

interface HanaClient {
	createPool(options: HanaConnectionOptions, poolParameters: Record<string, string | number | boolean>): HanaPool;
}

let cachedClient: HanaClient | undefined;

/**
 * Load `@sap/hana-client` lazily. It is NOT bundled (esbuild external) nor shipped in the installer
 * (the npm package carries every platform's prebuilt driver — ~92 MB), so the users who never touch
 * HANA don't carry it. In a packaged build it lives in the on-demand component dir whose absolute
 * path arrives on the connect config (`nativeRuntime.modulePath`); in dev it resolves from
 * node_modules (a devDependency). Its native binary is N-API, so — like DuckDB and unlike Db2's
 * ibm_db — it loads IN-PROCESS in the Electron server child, with no stock-Node sidecar.
 */
function loadClient(runtime: NativeRuntime | undefined): HanaClient {
	if (cachedClient) {
		return cachedClient;
	}
	const id = runtime?.modulePath ?? '@sap/hana-client';
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	cachedClient = require(id) as HanaClient;
	return cachedClient;
}

/**
 * Build the HANA connection options. `serverNode` is the host:port pair (post-tunnel), the
 * connection's `database` field carries the TENANT DATABASE name (HANA's true analogue of a
 * database; schemas live inside it) and is only sent when set, so connecting straight to a
 * tenant's own SQL port still works. TLS: `encrypt` turns it on, `sslValidateCertificate` is the
 * verify switch, and a custom CA PEM is passed inline via `sslTrustStore`.
 */
function connectionOptions(config: ConnectionConfig, host: string, port: number): HanaConnectionOptions {
	assertHanaFields(config, host);
	const options: HanaConnectionOptions = {
		serverNode: `${host}:${port}`,
		uid: config.username ?? '',
		pwd: config.password ?? '',
		// Without this the client waits a long time on an unreachable host, hanging the connect UI.
		connectTimeout: 15_000,
	};
	if (config.database) {
		options.databaseName = config.database;
	}
	const ssl = config.ssl;
	if (ssl) {
		options.encrypt = 'true';
		const verify = ssl === true || ssl.rejectUnauthorized !== false;
		options.sslValidateCertificate = verify ? 'true' : 'false';
		if (ssl !== true && ssl.ca) {
			options.sslTrustStore = ssl.ca;
		}
		// Through an SSH tunnel the client connects to localhost, so its hostname check would test
		// "localhost" against a certificate carrying the real DB host — validate against that host.
		if (verify && config.sshTunnel) {
			options.sslHostNameInCertificate = config.host;
		}
	}
	return options;
}

/**
 * SAP HANA driver. Column-store, in-memory OLTP+OLAP reached over the same host/port (+ optional
 * SSH tunnel) as the other network databases, through `@sap/hana-client`'s own connection pool.
 * Introspection reads the SYS.* system views.
 *
 * `cancel()` mirrors the Postgres approach: the connection id of the running statement is captured
 * once per pooled connection (`SELECT CURRENT_CONNECTION FROM DUMMY`), and a cancel issues
 * `ALTER SYSTEM CANCEL WORK IN SESSION` from a side connection. That needs SESSION ADMIN, so it is
 * best-effort — if the privilege is missing the statement runs on and only its result is discarded.
 */
class HanaDriver implements DatabaseDriver {
	readonly id = 'hana';
	readonly displayName = 'SAP HANA';
	readonly kind = 'relational' as const;

	private client?: HanaClient;
	private pool?: HanaPool;
	private tunnel?: SshTunnel;
	private config?: ConnectionConfig;
	// The connection id of each pooled connection, resolved once on first use so a per-query round
	// trip isn't needed just to be able to cancel.
	private connectionIds = new WeakMap<HanaConnection, number>();
	// The user query currently running (one at a time per connection). `cancelled` lets execute()
	// report the abort as a cancellation rather than a generic error.
	private activeQuery?: { connectionId: number; cancelled: boolean };

	async connect(config: ConnectionConfig): Promise<void> {
		this.config = config;
		this.client = loadClient(config.nativeRuntime);

		// Route through the bastion if a tunnel is configured; otherwise connect direct.
		let host = config.host;
		let port = config.port;
		if (config.sshTunnel) {
			this.tunnel = await openSshTunnel(config.sshTunnel, config.host, config.port);
			host = this.tunnel.host;
			port = this.tunnel.port;
		}

		this.pool = this.makePool(host, port);

		// Fail fast on bad credentials/host rather than at first query.
		await this.ping();
	}

	/** Build the hana-client pool. Extracted so a dead-pool retry can swap in a fresh one. */
	private makePool(host: string, port: number): HanaPool {
		if (!this.client || !this.config) {
			throw new Error('hana: no config to build pool');
		}
		const max = clampPoolMax(this.config.poolMax);
		return this.client.createPool(connectionOptions(this.config, host, port), {
			maxPoolSize: max,
			maxConnectedOrPooledConnections: max,
			// Validate a pooled connection before handing it out, so a socket the server culled
			// while idle is replaced rather than returned half-dead.
			pingCheck: true,
		});
	}

	/**
	 * Throw the current pool away and stand a new one up. When the connection is tunnelled the SSH
	 * session is the layer that actually dies on bastion/NLB idle, so we rebuild the tunnel too — a
	 * fresh pool pointed at a dead tunnel could never recover.
	 */
	private async resetPool(): Promise<void> {
		const oldPool = this.pool;
		const oldTunnel = this.tunnel;
		let host = this.config?.host;
		let port = this.config?.port;
		if (this.config?.sshTunnel) {
			this.tunnel = await openSshTunnel(this.config.sshTunnel, this.config.host, this.config.port);
			host = this.tunnel.host;
			port = this.tunnel.port;
		}
		if (host === undefined || port === undefined) {
			return;
		}
		this.pool = this.makePool(host, port);
		this.connectionIds = new WeakMap<HanaConnection, number>();
		try {
			oldPool?.clear();
		} catch {
			// already torn down
		}
		if (oldTunnel && oldTunnel !== this.tunnel) {
			await oldTunnel.close().catch(() => undefined);
		}
	}

	async disconnect(): Promise<void> {
		const pool = this.pool;
		this.pool = undefined;
		if (pool) {
			await new Promise<void>((resolve) => pool.clear(() => resolve()));
		}
		await this.tunnel?.close();
		this.tunnel = undefined;
	}

	isConnected(): boolean {
		return this.pool !== undefined;
	}

	/** Take a connection from the pool. `close()` returns it there (it does not disconnect). */
	private acquire(): Promise<HanaConnection> {
		const pool = this.pool;
		if (!pool) {
			return Promise.reject(new Error('hana: not connected'));
		}
		return new Promise<HanaConnection>((resolve, reject) => {
			pool.getConnection((err, conn) => (err || !conn ? reject(err ?? new Error('hana: no connection')) : resolve(conn)));
		});
	}

	/** Release a pooled connection, swallowing a close error (the pool discards a broken one). */
	private release(conn: HanaConnection): void {
		try {
			conn.close();
		} catch {
			// already destroyed
		}
	}

	/** Run a statement on a given connection, resolving to named-column rows (introspection) or the
	 *  affected-row count (DML/DDL). `rowsAsArray` is set by the caller that wants the wire shape. */
	private exec(conn: HanaConnection, sql: string, params: readonly unknown[] | undefined, options: ExecOptions): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			conn.exec(sql, params ? [...params] : [], options, (err, result) => (err ? reject(err) : resolve(result)));
		});
	}

	/** The HANA connection id of a pooled connection, resolved once and remembered. Used only to
	 *  cancel; a failure here is non-fatal (cancel simply becomes a no-op for that connection). */
	private async connectionIdOf(conn: HanaConnection): Promise<number> {
		const known = this.connectionIds.get(conn);
		if (known !== undefined) {
			return known;
		}
		try {
			const rows = (await this.exec(conn, 'SELECT CURRENT_CONNECTION AS "id" FROM DUMMY', undefined, {})) as { id: number | string }[];
			const id = Number(rows?.[0]?.id ?? -1);
			this.connectionIds.set(conn, id);
			return id;
		} catch {
			this.connectionIds.set(conn, -1);
			return -1;
		}
	}

	/** Run a query on a pooled connection and resolve to named-column rows (introspection). */
	private async runRows(sql: string): Promise<Record<string, unknown>[]> {
		const conn = await this.acquire();
		try {
			const result = await this.exec(conn, sql, undefined, {});
			return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
		} finally {
			this.release(conn);
		}
	}

	async ping(): Promise<void> {
		await this.runRows('SELECT 1 FROM DUMMY');
	}

	introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		return introspectHana((sql) => this.runRows(sql), this.config?.database, options?.includeViews ?? true);
	}

	structuralDigest(): Promise<string> {
		return hanaStructuralDigest((sql) => this.runRows(sql));
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params } = expectSql(query);
		try {
			return await this.executeOnce(sql, params);
		} catch (err) {
			// Only a clearly-preflight dead connection (the statement never reached the server) is
			// safe to recreate the pool and retry. Any other failure (real SQL errors, mid-query
			// disconnects) bubbles up: we don't replay a write/DDL that may have already committed.
			if (!isPreflightDeadConnectionError(err, 'hana')) {
				throw err;
			}
			await this.resetPool();
			return this.executeOnce(sql, params);
		}
	}

	private async executeOnce(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
		const start = Date.now();
		const conn = await this.acquire();
		const entry = { connectionId: await this.connectionIdOf(conn), cancelled: false };
		this.activeQuery = entry;
		// A trailing semicolon is not part of a single HANA statement.
		const statement = sql.replace(/;\s*$/, '');
		let prepared: HanaStatement | undefined;
		try {
			prepared = await new Promise<HanaStatement>((resolve, reject) => {
				conn.prepare(statement, (err, stmt) => (err || !stmt ? reject(err ?? new Error('hana: prepare failed')) : resolve(stmt)));
			});
			// rowsAsArray yields positional rows — the wire shape — while getColumnInfo() supplies the
			// column names, so a zero-row SELECT still reports its columns (unlike deriving them from
			// the first row). A non-query returns the affected-row count instead of an array.
			const result = await new Promise<unknown>((resolve, reject) => {
				prepared!.exec(params ? [...params] : [], { rowsAsArray: true }, (err, rows) => (err ? reject(err) : resolve(rows)));
			});
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			if (Array.isArray(result)) {
				const fields = columnNames(prepared).map((name) => ({ name }));
				const rows = result as unknown[][];
				return { fields, rows, rowCount: rows.length, durationMs: Date.now() - start };
			}
			return { fields: [], rows: [], rowCount: Number(result ?? 0), durationMs: Date.now() - start };
		} catch (err) {
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.activeQuery === entry) {
				this.activeQuery = undefined;
			}
			try {
				prepared?.drop();
			} catch {
				// statement already gone
			}
			this.release(conn);
		}
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry || !this.pool || entry.connectionId < 0) {
			return;
		}
		entry.cancelled = true;
		// ALTER SYSTEM CANCEL WORK IN SESSION aborts the statement running on that session but leaves
		// the session up (HANA's pg_cancel_backend). It needs SESSION ADMIN; without it the statement
		// runs to completion server-side and only its result is discarded.
		const conn = await this.acquire().catch(() => undefined);
		if (!conn) {
			return;
		}
		try {
			await this.exec(conn, `ALTER SYSTEM CANCEL WORK IN SESSION '${entry.connectionId}'`, undefined, {}).catch(() => undefined);
		} finally {
			this.release(conn);
		}
	}
}

/** Result-set column names of a prepared statement, or [] when the client reports none. */
function columnNames(stmt: HanaStatement): string[] {
	try {
		return (stmt.getColumnInfo() ?? []).map((info) => info.columnName);
	} catch {
		return [];
	}
}

export function createHanaDriver(): DatabaseDriver {
	return new HanaDriver();
}

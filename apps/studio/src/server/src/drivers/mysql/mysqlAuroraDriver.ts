/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';

import type { ConnectionConfig } from '../../../../shared/connection';
import { clampPoolMax } from '../../../../shared/connection';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { readOnlyEnforcementFor, type NativeQuery } from '../../../../shared/engine';
import { isPreflightDeadConnectionError } from '../deadConnection';
import { introspectMySql, mysqlStructuralDigest } from './introspection';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { withReadOnlySession } from '../readOnlySession';

/** The server-status bit an OK packet sets while a transaction is open (MySQL protocol). */
const SERVER_STATUS_IN_TRANS = 0x0001;

/** Translate the connection's `ssl` setting into a mysql2 ssl option. */
function toSslOption(ssl: ConnectionConfig['ssl']): mysql.PoolOptions['ssl'] {
	if (!ssl) {
		return undefined;
	}
	if (ssl === true) {
		return { rejectUnauthorized: true };
	}
	return ssl;
}

/**
 * MySQL-family driver (MySQL / Aurora MySQL and MariaDB).
 *
 * MariaDB is a MySQL fork that the same `mysql2` client and INFORMATION_SCHEMA
 * introspection drive unchanged, so both vendors share this one implementation —
 * only the driver id + display name differ (passed in by the factory).
 *
 * Connects through an optional `ssh2` tunnel (bastion → cluster) and runs a
 * `mysql2` connection pool. Schema introspection reads INFORMATION_SCHEMA so the
 * cache carries columns, primary keys and foreign keys (the latter feeding the
 * FK-derived JOIN suggestions planned for ROADMAP phase d).
 */
class MySqlFamilyDriver implements DatabaseDriver {
	readonly id: string;
	readonly displayName: string;
	readonly kind = 'relational' as const;

	constructor(id: string, displayName: string) {
		this.id = id;
		this.displayName = displayName;
	}

	private pool?: Pool;
	private tunnel?: SshTunnel;
	private config?: ConnectionConfig;
	// The user query currently running (one at a time per connection), so cancel() can
	// KILL QUERY its server thread from a side connection. `cancelled` lets execute()
	// report the abort as a cancellation rather than a generic error.
	private activeQuery?: { threadId: number; cancelled: boolean };

	async connect(config: ConnectionConfig): Promise<void> {
		this.config = config;

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

	/**
	 * Build the mysql2 pool. Extracted so a dead-pool retry can swap in a fresh one
	 * after an idle-timeout / wait_timeout teardown (see {@link executeOnce}).
	 *
	 * The idle settings matter: MySQL's `wait_timeout` (typ. 28 800s) and AWS NLB
	 * idle (350s) both close sockets the pool was still holding, and mysql2 doesn't
	 * validate on acquire. `maxIdle: 0` evicts idle connections immediately so the
	 * pool can't hand back a half-dead socket; `idleTimeout` is kept just as a belt
	 * for any version that ignores `maxIdle`. Keepalive piggy-backs on the TCP layer.
	 */
	private makePool(host: string, port: number): Pool {
		if (!this.config) {
			throw new Error(`${this.id}: no config to build pool`);
		}
		// No pool-level 'error' listener here, unlike postgres/sqlserver: mysql2 gives every
		// PoolConnection its own `once('error')` that evicts it from the pool (pool_connection.js),
		// and the promise wrapper doesn't forward 'error' at all — so there's no unhandled event
		// to guard against, and adding a listener would just be dead code.
		return mysql.createPool({
			host,
			port,
			user: this.config.username,
			password: this.config.password,
			database: this.config.database,
			ssl: toSslOption(this.config.ssl),
			waitForConnections: true,
			connectionLimit: clampPoolMax(this.config.poolMax),
			maxIdle: 0,
			idleTimeout: 30_000,
			enableKeepAlive: true,
		});
	}

	/**
	 * Throw the current pool away and stand a new one up. Used after a preflight-dead
	 * error so the next execute() starts from a clean slate (mysql2 sometimes wedges the
	 * whole pool after a wait_timeout, not just the one idle socket — recreating is the
	 * only reliable recovery). When the connection is tunnelled the SSH session is the
	 * layer that actually dies on bastion/NLB idle, so we rebuild the tunnel too — a fresh
	 * pool pointed at a dead tunnel could never recover.
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
		await oldPool?.end().catch(() => undefined);
		if (oldTunnel && oldTunnel !== this.tunnel) {
			await oldTunnel.close().catch(() => undefined);
		}
	}

	async disconnect(): Promise<void> {
		await this.pool?.end();
		this.pool = undefined;
		await this.tunnel?.close();
		this.tunnel = undefined;
	}

	isConnected(): boolean {
		return this.pool !== undefined;
	}

	async ping(): Promise<void> {
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		const connection = await this.pool.getConnection();
		try {
			await connection.ping();
		} finally {
			connection.release();
		}
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		const database = options?.schemas?.[0] ?? this.config?.database;
		return introspectMySql(this.pool, database, options?.includeViews ?? true);
	}

	async structuralDigest(): Promise<string> {
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		return mysqlStructuralDigest(this.pool, this.config?.database);
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		try {
			return await this.executeOnce(sql, params, readOnly);
		} catch (err) {
			// "Connection is closed" / PROTOCOL_CONNECTION_LOST mean the pooled socket
			// died before the statement was sent — safe to recreate the pool and retry
			// once. Any other failure (real SQL errors, mid-query disconnects) bubbles up
			// as-is: we don't replay a write/DDL that may have already committed.
			if (!isPreflightDeadConnectionError(err, 'mysql')) {
				throw err;
			}
			await this.resetPool();
			return this.executeOnce(sql, params, readOnly);
		}
	}

	private async executeOnce(sql: string, params: readonly unknown[] | undefined, readOnly: boolean): Promise<QueryResult> {
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		const start = Date.now();
		// Run on a dedicated pooled connection so we know its thread id; cancel() KILLs
		// that thread from a separate connection.
		const connection = await this.pool.getConnection();
		const entry = { threadId: connection.threadId, cancelled: false };
		this.activeQuery = entry;
		// A read-only run that could not put the session back destroys the connection instead of
		// releasing it, so no later interactive write lands on a read-only session.
		let discard = false;
		try {
			const run = () => connection.query<RowDataPacket[] | ResultSetHeader>(
				{ sql, rowsAsArray: true },
				params as unknown[] | undefined,
			);
			const enforcement = readOnlyEnforcementFor(this.id, this.config?.flavor);
			const [result, fields] = readOnly
				? await withReadOnlySession(enforcement, {
					run: async (statement) => {
						const [header] = await connection.query<ResultSetHeader>(statement);
						// START TRANSACTION commits a transaction already open on this connection, so the
						// first statement checks for one and refuses. The connection is then destroyed,
						// which rolls that transaction back rather than committing half of it.
						if (statement === enforcement.begin[0] && (header.serverStatus & SERVER_STATUS_IN_TRANS) !== 0) {
							throw new Error('a transaction is open on this connection. Commit or roll it back first.');
						}
					},
					discard: () => { discard = true; },
				}, run)
				: await run();
			// A SELECT yields row arrays; a write yields a ResultSetHeader with affectedRows.
			const rows = Array.isArray(result) ? (result as unknown[][]) : [];
			return {
				fields: (fields ?? []).map((field) => ({ name: field.name })),
				rows,
				rowCount: Array.isArray(result) ? rows.length : result.affectedRows,
				durationMs: Date.now() - start,
			};
		} catch (err) {
			// If we asked to cancel this query, surface it as a cancellation, not an error.
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.activeQuery === entry) {
				this.activeQuery = undefined;
			}
			// Don't return a dead socket to the pool — destroy it so the next acquire
			// gets a fresh one. mysql2 marks ECONNRESET/PROTOCOL connections internally,
			// but a destroy is the deterministic answer.
			try {
				if (discard) {
					connection.destroy();
				} else {
					connection.release();
				}
			} catch {
				// already destroyed
			}
		}
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry || !this.pool) {
			return;
		}
		entry.cancelled = true;
		// KILL QUERY aborts the running statement but keeps the connection alive. The id
		// comes from the driver (a number), so the interpolation is safe.
		await this.pool.query(`KILL QUERY ${entry.threadId}`).catch(() => undefined);
	}
}

export function createMySqlAuroraDriver(): DatabaseDriver {
	return new MySqlFamilyDriver('mysql-aurora', 'MySQL / Aurora MySQL');
}

/** Build a driver of the MySQL family (MySQL/Aurora or MariaDB) with the given id + label. The
 *  MariaDB driver re-uses this so the two vendors share one implementation (see mariadbDriver.ts). */
export function createMySqlFamilyDriver(id: string, displayName: string): DatabaseDriver {
	return new MySqlFamilyDriver(id, displayName);
}

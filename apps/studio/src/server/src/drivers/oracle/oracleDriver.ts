/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import oracledb, { type Connection, type Pool } from 'oracledb';

import type { ConnectionConfig } from '../../../../shared/connection';
import { clampPoolMax } from '../../../../shared/connection';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { oracleConnectString as connectString } from '../connectStrings';
import { readOnlyEnforcementFor, type NativeQuery } from '../../../../shared/engine';
import { isPreflightDeadConnectionError } from '../deadConnection';
import { withReadOnlySession } from '../readOnlySession';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { introspectOracle, oracleStructuralDigest } from './introspection';

// Return CLOB/BLOB column values as JS strings/Buffers instead of Lob stream objects, so the
// results grid shows their content like every other column. Set once at module load (global to
// the oracledb client, which is fine — the whole process talks to Oracle the same way).
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

/**
 * Oracle Database driver. Uses the `oracledb` client in thin mode (pure-JS, no Oracle Instant
 * Client) over the same optional `ssh2` tunnel the other drivers use. Introspection reads the
 * ALL_* data-dictionary views so columns, PKs, FKs, indexes, triggers and routines ride in the
 * schema cache exactly like the other vendors. Each user statement runs with autoCommit on so a
 * write persists without an explicit COMMIT (matching the other drivers' default behaviour).
 */
class OracleDriver implements DatabaseDriver {
	readonly id = 'oracle';
	readonly displayName = 'Oracle Database';
	readonly kind = 'relational' as const;

	private pool?: Pool;
	private tunnel?: SshTunnel;
	private config?: ConnectionConfig;
	// The user query currently running (one at a time per connection). Oracle interrupts an
	// in-flight statement via connection.break() on the same connection (no side connection);
	// `cancelled` lets execute() report the abort as a cancellation rather than a generic error.
	private activeQuery?: { connection: Connection; cancelled: boolean };

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

		this.pool = await this.makePool(host, port);

		// Fail fast on bad credentials/host rather than at first query.
		await this.ping();
	}

	/**
	 * Build the oracledb pool. Extracted so a dead-pool retry can swap in a fresh one after an
	 * idle connection reset (see {@link executeOnce}). `poolTimeout` evicts idle connections well
	 * under typical NLB/load-balancer idle culls so the pool can't hand back a dead connection.
	 */
	private async makePool(host: string, port: number): Promise<Pool> {
		if (!this.config) {
			throw new Error('oracle: no config to build pool');
		}
		return oracledb.createPool({
			user: this.config.username,
			password: this.config.password,
			connectString: connectString(this.config, host, port),
			poolMin: 0,
			poolMax: clampPoolMax(this.config.poolMax),
			poolTimeout: 30,
		});
	}

	/**
	 * Throw the current pool away and stand a new one up. When the connection is tunnelled the SSH
	 * session is the layer that actually dies on bastion/NLB idle, so we rebuild the tunnel too —
	 * a fresh pool pointed at a dead tunnel could never recover.
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
		this.pool = await this.makePool(host, port);
		// drainTime 0 → close immediately even if a connection is checked out.
		await oldPool?.close(0).catch(() => undefined);
		if (oldTunnel && oldTunnel !== this.tunnel) {
			await oldTunnel.close().catch(() => undefined);
		}
	}

	async disconnect(): Promise<void> {
		await this.pool?.close(0);
		this.pool = undefined;
		await this.tunnel?.close();
		this.tunnel = undefined;
	}

	isConnected(): boolean {
		return this.pool !== undefined;
	}

	async ping(): Promise<void> {
		if (!this.pool) {
			throw new Error('oracle: not connected');
		}
		const connection = await this.pool.getConnection();
		try {
			await connection.execute('SELECT 1 FROM DUAL');
		} finally {
			await connection.close().catch(() => undefined);
		}
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		if (!this.pool) {
			throw new Error('oracle: not connected');
		}
		const connection = await this.pool.getConnection();
		try {
			return await introspectOracle((sql) => runRows(connection, sql), this.config?.database, options?.includeViews ?? true);
		} finally {
			await connection.close().catch(() => undefined);
		}
	}

	async structuralDigest(): Promise<string> {
		if (!this.pool) {
			throw new Error('oracle: not connected');
		}
		const connection = await this.pool.getConnection();
		try {
			return await oracleStructuralDigest((sql) => runRows(connection, sql));
		} finally {
			await connection.close().catch(() => undefined);
		}
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		if (!this.pool) {
			throw new Error('oracle: not connected');
		}
		try {
			return await this.executeOnce(sql, params, readOnly);
		} catch (err) {
			// Only a clearly-preflight dead connection (the statement never reached the server) is
			// safe to recreate the pool and retry. Any other failure (real SQL errors, mid-query
			// disconnects) bubbles up: we don't replay a write/DDL that may have already committed.
			if (!isPreflightDeadConnectionError(err, 'oracle')) {
				throw err;
			}
			await this.resetPool();
			return this.executeOnce(sql, params, readOnly);
		}
	}

	private async executeOnce(sql: string, params: readonly unknown[] | undefined, readOnly: boolean): Promise<QueryResult> {
		if (!this.pool) {
			throw new Error('oracle: not connected');
		}
		const start = Date.now();
		const connection = await this.pool.getConnection();
		const entry = { connection, cancelled: false };
		this.activeQuery = entry;
		// A read-only run that could not put the session back drops the connection from the pool.
		let discard = false;
		try {
			// OUT_FORMAT_ARRAY yields positional row arrays (the wire shape); column names ride on
			// metaData. autoCommit:true so a write persists like the other drivers (oracledb defaults
			// autoCommit to false, which would silently roll a write back on connection close). A
			// read-only run turns it off: the statement belongs to the SET TRANSACTION READ ONLY
			// transaction, which is rolled back.
			const run = () => connection.execute(
				// strip a trailing semicolon: Oracle's SQL layer rejects it on a plain statement.
				sql.replace(/;\s*$/, ''),
				(params ?? []) as unknown[],
				{ outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: !readOnly },
			);
			const result = readOnly
				? await withReadOnlySession(readOnlyEnforcementFor('oracle'), { run: (statement) => connection.execute(statement), discard: () => { discard = true; } }, run)
				: await run();
			const rows = (result.rows ?? []) as unknown[][];
			const fields = (result.metaData ?? []).map((m) => ({ name: m.name }));
			return {
				fields,
				rows,
				rowCount: rows.length > 0 ? rows.length : (result.rowsAffected ?? 0),
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
			await (discard ? connection.close({ drop: true }) : connection.close()).catch(() => undefined);
		}
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry) {
			return;
		}
		entry.cancelled = true;
		// break() interrupts the running statement on its own connection (no side connection needed),
		// causing the in-flight execute() to reject; the connection is then closed in its finally.
		try {
			await entry.connection.break();
		} catch {
			// statement already finished
		}
	}
}

/** Run a query in object-row mode (introspection wants named columns; execute() wants arrays). */
async function runRows(connection: Connection, sql: string): Promise<Record<string, unknown>[]> {
	const result = await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
	return (result.rows ?? []) as Record<string, unknown>[];
}

export function createOracleDriver(): DatabaseDriver {
	return new OracleDriver();
}

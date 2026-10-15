/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../../../shared/connection';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { type NativeQuery } from '../../../../shared/engine';
import { isPreflightDeadConnectionError } from '../deadConnection';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { Db2Sidecar } from './db2Sidecar';
import { db2ConnectString as connectString } from '../connectStrings';
import { introspectDb2, db2StructuralDigest } from './introspection';

/**
 * IBM Db2 (LUW) driver. Unlike the other drivers, `ibm_db` cannot run inside the Electron server
 * child (its native binary will not load — nor recompile — against Electron's ABI), so this driver
 * proxies every statement to a **stock-Node sidecar** ({@link Db2Sidecar}) that hosts `ibm_db`. The
 * driver keeps all the vendor-neutral logic here: the optional SSH tunnel, the DSN, introspection
 * over the SYSCAT.* catalog views, the dead-connection retry, and best-effort cancel.
 *
 * ibm_db runs with autocommit on by default, so a write persists without an explicit COMMIT
 * (matching the other drivers). Db2 has no client-side statement cancel through ibm_db, so
 * {@link cancel} is best-effort.
 */
class Db2Driver implements DatabaseDriver {
	readonly id = 'db2';
	readonly displayName = 'IBM Db2';
	readonly kind = 'relational' as const;

	private sidecar?: Db2Sidecar;
	private tunnel?: SshTunnel;
	private config?: ConnectionConfig;
	// The user query currently running (one at a time per connection). Db2 offers no in-flight
	// statement interrupt via ibm_db, so `cancelled` only lets execute() report the abort as a
	// cancellation (the statement still runs to completion server-side).
	private activeQuery?: { cancelled: boolean };

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

		this.sidecar = new Db2Sidecar(config.nativeRuntime);
		await this.sidecar.open(connectString(config, host, port));

		// Fail fast on bad credentials/host rather than at first query.
		await this.ping();
	}

	/**
	 * Tear down the sidecar pool and (when tunnelled) the SSH session, then stand both back up. When
	 * the connection is tunnelled the SSH session is the layer that actually dies on bastion/NLB
	 * idle, so we rebuild the tunnel too — a fresh pool pointed at a dead tunnel could never recover.
	 */
	private async resetPool(): Promise<void> {
		const oldTunnel = this.tunnel;
		let host = this.config?.host;
		let port = this.config?.port;
		if (this.config?.sshTunnel) {
			this.tunnel = await openSshTunnel(this.config.sshTunnel, this.config.host, this.config.port);
			host = this.tunnel.host;
			port = this.tunnel.port;
		}
		if (!this.config || host === undefined || port === undefined || !this.sidecar) {
			return;
		}
		await this.sidecar.open(connectString(this.config, host, port));
		if (oldTunnel && oldTunnel !== this.tunnel) {
			await oldTunnel.close().catch(() => undefined);
		}
	}

	async disconnect(): Promise<void> {
		const sidecar = this.sidecar;
		this.sidecar = undefined;
		if (sidecar) {
			await sidecar.close();
		}
		await this.tunnel?.close();
		this.tunnel = undefined;
	}

	isConnected(): boolean {
		return this.sidecar !== undefined;
	}

	/** Run a query through the sidecar, resolving to named-column rows (introspection wants named
	 *  columns; execute() derives positional rows from these). */
	private runRows(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]> {
		if (!this.sidecar) {
			throw new Error('db2: not connected');
		}
		return this.sidecar.query(sql, params);
	}

	async ping(): Promise<void> {
		await this.runRows('SELECT 1 FROM SYSIBM.SYSDUMMY1');
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		return introspectDb2((sql) => this.runRows(sql), this.config?.database, options?.includeViews ?? true);
	}

	async structuralDigest(): Promise<string> {
		return db2StructuralDigest((sql) => this.runRows(sql));
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params } = expectSql(query);
		try {
			return await this.executeOnce(sql, params);
		} catch (err) {
			// Only a clearly-preflight dead connection (the statement never reached the server) is
			// safe to recreate the pool and retry. Any other failure (real SQL errors, mid-query
			// disconnects) bubbles up: we don't replay a write/DDL that may have already committed.
			if (!isPreflightDeadConnectionError(err, 'db2')) {
				throw err;
			}
			await this.resetPool();
			return this.executeOnce(sql, params);
		}
	}

	private async executeOnce(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
		const start = Date.now();
		const entry = { cancelled: false };
		this.activeQuery = entry;
		try {
			// strip a trailing semicolon: ibm_db rejects it on a plain statement.
			const rows = await this.runRows(sql.replace(/;\s*$/, ''), params);
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			// ibm_db returns row objects keyed by column name in column order; derive the wire
			// shape (positional fields + rows) from the first row's keys. A zero-row result has
			// no column metadata here, so its fields come back empty (best-effort, first cut).
			const fields = rows.length > 0 ? Object.keys(rows[0]).map((name) => ({ name })) : [];
			const positional = rows.map((row) => fields.map((field) => row[field.name]));
			return {
				fields,
				rows: positional,
				rowCount: rows.length,
				durationMs: Date.now() - start,
			};
		} catch (err) {
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.activeQuery === entry) {
				this.activeQuery = undefined;
			}
		}
	}

	async cancel(): Promise<void> {
		// Db2 exposes no per-statement cancel through ibm_db (interrupting a running statement
		// needs an out-of-band FORCE APPLICATION with admin rights). We mark the in-flight query so
		// its result is discarded as a cancellation, but the statement still runs to completion.
		if (this.activeQuery) {
			this.activeQuery.cancelled = true;
		}
	}
}

export function createDb2Driver(): DatabaseDriver {
	return new Db2Driver();
}

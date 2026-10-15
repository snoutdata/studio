/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { checkServerIdentity, type PeerCertificate } from 'node:tls';

import { Pool, type PoolConfig } from 'pg';

import type { ConnectionConfig } from '../../../../shared/connection';
import { clampPoolMax } from '../../../../shared/connection';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { readOnlyEnforcementFor, type NativeQuery } from '../../../../shared/engine';
import { isPreflightDeadConnectionError } from '../deadConnection';
import { withReadOnlySession } from '../readOnlySession';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { introspectPostgres, postgresStructuralDigest } from './introspection';

/** Translate the connection's `ssl` setting into a node-postgres ssl option. */
function toSslOption(ssl: ConnectionConfig['ssl']): PoolConfig['ssl'] {
	if (!ssl) {
		return undefined;
	}
	if (ssl === true) {
		return { rejectUnauthorized: true };
	}
	return ssl;
}

/**
 * The pool's options for one connection. Every credential and the TLS choice are passed explicitly,
 * because node-postgres fills a missing one from the process: an absent password from PGPASSWORD and
 * then from ~/.pgpass (or PGPASSFILE), an absent `ssl` from PGSSLMODE. A saved connection's password
 * is the one in the keychain or none, never one this machine's environment or a pgpass file holds
 * for some other purpose. The password is handed over as a function, which pg takes as the answer
 * (an empty string included) without looking further; a plain empty string would read as "absent".
 */
export function postgresPoolConfig(config: ConnectionConfig, host: string, port: number): PoolConfig {
	const ssl = toSslOption(config.ssl);
	// Through an SSH tunnel pg connects to localhost, so its built-in TLS hostname check
	// would test "localhost" against the cert (which carries the real DB host's SAN) and
	// fail. When we're verifying (ssl object, rejectUnauthorized not false) and tunnelling,
	// validate the certificate against the original DB host instead. (Set here, not in
	// main: a checkServerIdentity function can't cross the main↔server JSON-RPC boundary.)
	if (ssl && typeof ssl === 'object' && ssl.rejectUnauthorized !== false && config.sshTunnel) {
		const realHost = config.host;
		ssl.checkServerIdentity = (_servername: string, cert: PeerCertificate) => checkServerIdentity(realHost, cert);
	}
	const password = config.password ?? '';
	return {
		host,
		port,
		user: config.username,
		password: () => password,
		database: config.database,
		ssl: ssl ?? false,
		max: clampPoolMax(config.poolMax),
		idleTimeoutMillis: 30_000,
		keepAlive: true,
	};
}

/** How a Postgres-family vendor introspects: both take the live pool, so a vendor whose catalog
 *  differs (Redshift) plugs its own pair in without re-implementing connect/execute/cancel. */
export interface PostgresFamilyIntrospection {
	schema(pool: Pool, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema>;
	digest(pool: Pool): Promise<string>;
}

const POSTGRES_INTROSPECTION: PostgresFamilyIntrospection = {
	schema: (pool, database, includeViews) => introspectPostgres(pool, database, includeViews),
	digest: (pool) => postgresStructuralDigest(pool),
};

/**
 * PostgreSQL driver. Connects through the same optional `ssh2` tunnel the MySQL
 * driver uses and runs a node-postgres pool. Introspection reads information_schema
 * so columns, PKs and FKs ride in the schema cache exactly like MySQL — completion,
 * the explorer and FK-join suggestions never special-case the vendor.
 *
 * Amazon Redshift speaks the same wire protocol and reuses this class verbatim (see
 * redshiftDriver.ts); only the id, label and introspection pair differ, since Redshift carries its
 * own SVV_* catalog rather than Postgres's.
 */
class PostgresFamilyDriver implements DatabaseDriver {
	readonly kind = 'relational' as const;

	constructor(
		readonly id: string,
		readonly displayName: string,
		private readonly introspection: PostgresFamilyIntrospection,
	) { }

	private pool?: Pool;
	private tunnel?: SshTunnel;
	private config?: ConnectionConfig;
	// The user query currently running (one at a time per connection), so cancel() can
	// pg_cancel_backend its backend pid from a side connection. `cancelled` lets
	// execute() report the abort as a cancellation rather than a generic error.
	private activeQuery?: { pid: number; cancelled: boolean };

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
		// Swallow client-level error events so an idle backend reset doesn't bubble up
		// as an unhandled `error` and crash the LSP child (node-postgres emits these
		// on a Client when its socket dies; without a listener Node terminates the
		// process). The retry path in execute() handles recovery.
		this.pool.on('error', () => undefined);

		// Fail fast on bad credentials/host rather than at first query.
		await this.ping();
	}

	/**
	 * Build the pg pool. Extracted so a dead-pool retry can swap in a fresh one after
	 * an idle backend reset (see {@link executeOnce}). `idleTimeoutMillis` evicts idle
	 * clients well under typical NLB/load-balancer idle culls so the pool can't hand
	 * back a half-dead socket.
	 */
	private makePool(host: string, port: number): Pool {
		if (!this.config) {
			throw new Error(`${this.id}: no config to build pool`);
		}
		return new Pool(postgresPoolConfig(this.config, host, port));
	}

	/**
	 * Throw the current pool away and stand a new one up. When the connection is tunnelled
	 * the SSH session is the layer that actually dies on bastion/NLB idle, so we rebuild
	 * the tunnel too — a fresh pool pointed at a dead tunnel could never recover.
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
		this.pool.on('error', () => undefined);
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
		await this.pool.query('SELECT 1');
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		return this.introspection.schema(this.pool, this.config?.database, options?.includeViews ?? true);
	}

	async structuralDigest(): Promise<string> {
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		return this.introspection.digest(this.pool);
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		if (!this.pool) {
			throw new Error(`${this.id}: not connected`);
		}
		try {
			return await this.executeOnce(sql, params, readOnly);
		} catch (err) {
			// Administrator-shutdown SQLSTATEs and "Connection terminated" on acquire
			// mean the backend was gone BEFORE the statement was sent — safe to recreate
			// the pool and retry once. Any other failure (real SQL errors, mid-query
			// disconnects) bubbles up: we don't replay a write/DDL that may have already
			// committed on the other side.
			if (!isPreflightDeadConnectionError(err, 'postgres')) {
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
		// Run on a dedicated pooled client so we know its backend pid; cancel() calls
		// pg_cancel_backend(pid) from a separate connection. `processID` is set by
		// node-postgres at connect time but isn't in @types/pg, hence the cast.
		const client = await this.pool.connect();
		const pid = (client as unknown as { processID?: number }).processID ?? -1;
		const entry = { pid, cancelled: false };
		this.activeQuery = entry;
		// A read-only run that could not put the session back destroys the client instead of
		// returning it, so no later interactive write lands on a read-only session.
		let discard = false;
		try {
			// rowMode 'array' yields positional rows aligned to `fields` — the wire shape.
			const run = () => client.query({ text: sql, rowMode: 'array', values: params as unknown[] | undefined });
			let result: Awaited<ReturnType<typeof run>>;
			if (readOnly) {
				// A client inside a transaction someone else opened would have it rolled back by the
				// read-only run's ROLLBACK (and BEGIN inside it only warns), so refuse rather than guess.
				// `getTransactionStatus` is node-postgres's ReadyForQuery status ('I', 'T', 'E'); not in @types/pg.
				const status = (client as unknown as { getTransactionStatus?(): string | null }).getTransactionStatus?.();
				if (status === 'T' || status === 'E') {
					throw new Error('A transaction is open on this connection, so a read-only query cannot run on it. Commit or roll it back first.');
				}
				result = await withReadOnlySession(readOnlyEnforcementFor(this.id, this.config?.flavor), {
					run: (statement) => client.query(statement),
					discard: () => { discard = true; },
					check: async (statement) => (await client.query({ text: statement, rowMode: 'array' })).rows?.[0]?.[0] === true,
				}, run);
			} else {
				result = await run();
			}
			const rows = Array.isArray(result.rows) ? (result.rows as unknown[][]) : [];
			return {
				fields: (result.fields ?? []).map((field) => ({ name: field.name })),
				rows,
				rowCount: result.rowCount ?? rows.length,
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
			try {
				client.release(discard ? new Error('read-only session not restored') : undefined);
			} catch {
				// already destroyed
			}
		}
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry || !this.pool || entry.pid < 0) {
			return;
		}
		entry.cancelled = true;
		// pg_cancel_backend politely cancels the running statement on that backend.
		await this.pool.query('SELECT pg_cancel_backend($1)', [entry.pid]).catch(() => undefined);
	}
}

export function createPostgresDriver(): DatabaseDriver {
	return new PostgresFamilyDriver('postgres', 'PostgreSQL', POSTGRES_INTROSPECTION);
}

/** Build a driver of the Postgres family (PostgreSQL or Amazon Redshift) with the given id, label
 *  and catalog queries. Redshift re-uses this so the two vendors share one connect/execute/cancel
 *  implementation (see redshiftDriver.ts). */
export function createPostgresFamilyDriver(id: string, displayName: string, introspection: PostgresFamilyIntrospection): DatabaseDriver {
	return new PostgresFamilyDriver(id, displayName, introspection);
}

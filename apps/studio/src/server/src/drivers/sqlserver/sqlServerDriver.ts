/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConnectionPool, Transaction, type IOptions, type Request } from 'mssql';

import type { ConnectionConfig } from '../../../../shared/connection';
import { clampPoolMax } from '../../../../shared/connection';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { readOnlyEnforcementFor, type NativeQuery } from '../../../../shared/engine';
import { isPreflightDeadConnectionError } from '../deadConnection';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { introspectSqlServer, sqlServerStructuralDigest } from './introspection';

/** What a read-only run reports when its batch ended the transaction it runs in (see executeOnce). */
export const READ_ONLY_TRANSACTION_ENDED = 'This query ran a COMMIT or ROLLBACK, which ended the read-only run\'s transaction, so its result is not shown. Run it on a connection that is not read-only, or without the COMMIT or ROLLBACK. A statement it ran after ending both of the run\'s transactions may have been committed.';

/** Translate the connection's `ssl` setting into mssql/tedious encryption options. */
function toSslOption(ssl: ConnectionConfig['ssl']): Pick<IOptions, 'encrypt' | 'trustServerCertificate' | 'cryptoCredentialsDetails'> {
	if (!ssl) {
		// Plain TCP (typical for a local SQL Server or an already-encrypted SSH tunnel).
		return { encrypt: false };
	}
	if (ssl === true) {
		return { encrypt: true, trustServerCertificate: false };
	}
	// An ssl object with rejectUnauthorized:false means "encrypt but accept a self-signed cert".
	// A resolved `ca` (e.g. the Amazon RDS CA for an RDS SQL Server) is handed to tedious'
	// TLS layer so verification checks against it rather than the system store alone.
	const options: Pick<IOptions, 'encrypt' | 'trustServerCertificate' | 'cryptoCredentialsDetails'> = {
		encrypt: true,
		trustServerCertificate: ssl.rejectUnauthorized === false,
	};
	if (ssl.ca) {
		options.cryptoCredentialsDetails = { ca: ssl.ca };
	}
	return options;
}

/**
 * Microsoft SQL Server driver. Connects through the same optional `ssh2` tunnel the
 * MySQL/Postgres drivers use and runs an `mssql` (tedious) connection pool. Introspection
 * reads INFORMATION_SCHEMA + sys.* so columns, PKs, FKs, indexes, triggers and routines
 * ride in the schema cache exactly like the other vendors — completion, the explorer and
 * FK-join suggestions never special-case T-SQL.
 */
class SqlServerDriver implements DatabaseDriver {
	readonly id = 'sqlserver';
	readonly displayName = 'Microsoft SQL Server';
	readonly kind = 'relational' as const;

	private pool?: ConnectionPool;
	private tunnel?: SshTunnel;
	private config?: ConnectionConfig;
	// The user query currently running (one at a time per connection). Unlike pg/mysql there's
	// no side-connection KILL: tedious cancels the in-flight request directly via request.cancel().
	// `cancelled` lets execute() report the abort as a cancellation rather than a generic error.
	private activeQuery?: { request: Request; cancelled: boolean };

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
		// Swallow pool-level error events so a reset backend doesn't bubble up as an
		// unhandled `error` and crash the LSP child; the retry path in execute() recovers.
		this.pool.on('error', () => undefined);
		await this.pool.connect();

		// Fail fast on bad credentials/host rather than at first query.
		await this.ping();
	}

	/**
	 * Build the mssql pool. Extracted so a dead-pool retry can swap in a fresh one after an
	 * idle backend reset (see {@link executeOnce}). `idleTimeoutMillis` evicts idle clients
	 * well under typical NLB/load-balancer idle culls so the pool can't hand back a dead socket.
	 */
	private makePool(host: string, port: number): ConnectionPool {
		if (!this.config) {
			throw new Error('sqlserver: no config to build pool');
		}
		return new ConnectionPool({
			server: host,
			port,
			user: this.config.username,
			password: this.config.password,
			database: this.config.database,
			// arrayRowMode is set per-request (execute → array rows for the grid; introspection
			// → object rows), so it's deliberately left off the pool-wide default.
			pool: { max: clampPoolMax(this.config.poolMax), min: 0, idleTimeoutMillis: 30_000 },
			options: { enableArithAbort: true, ...toSslOption(this.config.ssl) },
		});
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
		await this.pool.connect();
		await oldPool?.close().catch(() => undefined);
		if (oldTunnel && oldTunnel !== this.tunnel) {
			await oldTunnel.close().catch(() => undefined);
		}
	}

	async disconnect(): Promise<void> {
		await this.pool?.close();
		this.pool = undefined;
		await this.tunnel?.close();
		this.tunnel = undefined;
	}

	isConnected(): boolean {
		return this.pool !== undefined;
	}

	async ping(): Promise<void> {
		if (!this.pool) {
			throw new Error('sqlserver: not connected');
		}
		await this.pool.request().query('SELECT 1');
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		if (!this.pool) {
			throw new Error('sqlserver: not connected');
		}
		return introspectSqlServer(this.pool, this.config?.database, options?.includeViews ?? true);
	}

	async structuralDigest(): Promise<string> {
		if (!this.pool) {
			throw new Error('sqlserver: not connected');
		}
		return sqlServerStructuralDigest(this.pool);
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		if (!this.pool) {
			throw new Error('sqlserver: not connected');
		}
		try {
			return await this.executeOnce(sql, params, readOnly);
		} catch (err) {
			// Only a clearly-preflight dead socket (the statement never reached the server)
			// is safe to recreate the pool and retry. Any other failure (real SQL errors,
			// mid-query disconnects) bubbles up: we don't replay a write/DDL that may have
			// already committed on the other side.
			if (!isPreflightDeadConnectionError(err, 'sqlserver')) {
				throw err;
			}
			await this.resetPool();
			return this.executeOnce(sql, params, readOnly);
		}
	}

	private async executeOnce(sql: string, params: readonly unknown[] | undefined, readOnly: boolean): Promise<QueryResult> {
		if (!this.pool) {
			throw new Error('sqlserver: not connected');
		}
		// SQL Server has no read-only transaction (`readOnly.ts`, SQLSERVER_READ_ONLY): a read-only run
		// holds one pooled connection in a transaction and always rolls it back, so a table write the
		// statement makes is undone. mssql's Transaction is that connection: BEGIN TRANSACTION on
		// acquire, and its rollback releases the connection to the pool with no transaction open.
		//
		// The statement check refuses a COMMIT or ROLLBACK anywhere in the batch, since T-SQL needs no
		// `;` and a COMMIT ends this transaction (whatever follows it autocommits). This is the second
		// layer, for one the check missed: the run opens a NESTED transaction too, so one COMMIT only
		// takes @@TRANCOUNT from 2 to 1 and nothing is committed, and a batch that leaves fewer than
		// two open has run a COMMIT or ROLLBACK, so it is reported as a failure rather than a result.
		// It cannot undo what a batch committed by ending both (two COMMITs, or a ROLLBACK) before it
		// wrote; it says so. Nothing here changes the session, so the pooled connection goes back as
		// it came out.
		if (readOnly && readOnlyEnforcementFor('sqlserver').mechanism === 'rollback') {
			const transaction = new Transaction(this.pool);
			try {
				await transaction.begin();
				await transaction.request().query('BEGIN TRANSACTION');
			} catch (err) {
				await transaction.rollback().catch(() => undefined);
				throw new Error(`The database could not start a read-only run, so the query was not sent: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				const result = await this.runRequest(transaction.request(), sql, params);
				const depth = await transaction.request().query('SELECT @@TRANCOUNT AS depth');
				const open = Number((depth.recordset?.[0] as { depth?: number } | undefined)?.depth ?? 0);
				if (open < 2) {
					throw new Error(READ_ONLY_TRANSACTION_ENDED);
				}
				return result;
			} finally {
				// Throws when the server already ended the transaction (an error with XACT_ABORT, or a
				// COMMIT in the batch); the connection has been released either way.
				await transaction.rollback().catch(() => undefined);
			}
		}
		return this.runRequest(this.pool.request(), sql, params);
	}

	private async runRequest(request: Request, sql: string, params: readonly unknown[] | undefined): Promise<QueryResult> {
		const start = Date.now();
		request.arrayRowMode = true;
		// Positional params are bound as @p0, @p1, … so a caller using those placeholders works.
		// In practice the editor and the grid-DML path pass none (DML inlines literals).
		(params ?? []).forEach((value, i) => request.input(`p${i}`, value));
		const entry = { request, cancelled: false };
		this.activeQuery = entry;
		try {
			// arrayRowMode yields positional row arrays; column metadata rides on each recordset.
			const result = await request.query(sql);
			// A multi-statement batch returns several recordsets; surface the last one with
			// rows (mirrors what a SQL console shows), falling back to the primary recordset.
			const recordsets = (result.recordsets ?? []) as unknown as Array<Array<unknown[]> & { columns?: Record<string, { index: number; name: string }> }>;
			const recordset = [...recordsets].reverse().find((r) => Array.isArray(r) && r.length > 0)
				?? (result.recordset as unknown as Array<unknown[]> & { columns?: Record<string, { index: number; name: string }> });
			const rows: unknown[][] = Array.isArray(recordset) ? (recordset as unknown[][]) : [];
			const columns = recordset?.columns ?? {};
			const fields = Object.values(columns)
				.sort((a, b) => a.index - b.index)
				.map((c) => ({ name: c.name }));
			// Writes report affected rows per statement; sum them. A SELECT reports its row count.
			const affected = (result.rowsAffected ?? []).reduce((sum, n) => sum + n, 0);
			return {
				fields,
				rows,
				rowCount: rows.length > 0 ? rows.length : affected,
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
		}
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry) {
			return;
		}
		entry.cancelled = true;
		// tedious cancels the running request on its own connection (no side connection needed).
		try {
			entry.request.cancel();
		} catch {
			// request already finished
		}
	}
}

export function createSqlServerDriver(): DatabaseDriver {
	return new SqlServerDriver();
}

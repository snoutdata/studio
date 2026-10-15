/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Connection, Statement, ConnectionOptions } from 'snowflake-sdk';

import type { ConnectionConfig } from '../../../../shared/connection';
import type { NativeRuntime } from '../../../../shared/components';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { assertSnowflakeAccount } from '../connectStrings';
import { type NativeQuery } from '../../../../shared/engine';
import { introspectSnowflake, snowflakeStructuralDigest } from './introspection';

type SnowflakeSdk = typeof import('snowflake-sdk');

let cachedSdk: SnowflakeSdk | undefined;

/**
 * Load `snowflake-sdk` lazily. It is NOT bundled (esbuild external) nor shipped in the installer
 * (its dependency tree is ~95 MB), so the ~99% who never use Snowflake don't carry it. In a packaged
 * build it lives in the on-demand component dir, whose absolute path arrives on the connect config
 * (`nativeRuntime.modulePath`); in dev it resolves from node_modules (a devDependency). Unlike Db2
 * it is pure JS, so it loads in-process here — no stock-Node sidecar.
 */
function loadSdk(runtime: NativeRuntime | undefined): SnowflakeSdk {
	if (cachedSdk) {
		return cachedSdk;
	}
	const id = runtime?.modulePath ?? 'snowflake-sdk';
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const sdk = require(id) as SnowflakeSdk;
	// Snowflake's client writes a rotating log file and chatters to the console by default; silence it.
	try {
		sdk.configure({ logLevel: 'OFF', additionalLogToConsole: false });
	} catch {
		// older/newer SDKs may not accept these keys — non-fatal.
	}
	cachedSdk = sdk;
	return sdk;
}

/** Build the Snowflake connection options from the connection config. The `host` field carries the
 *  account identifier (the form labels it "Account"); warehouse/role ride on dedicated fields. */
function connectionOptions(config: ConnectionConfig, sdk: SnowflakeSdk): Connection {
	assertSnowflakeAccount(config.host);
	const options: ConnectionOptions = {
		account: config.host,
		username: config.username,
		password: config.password,
		database: config.database,
		warehouse: config.warehouse,
		role: config.role,
		application: 'SnoutData',
		clientSessionKeepAlive: true,
	};
	return sdk.createConnection(options);
}

/**
 * Snowflake driver. Cloud OLAP warehouse reached over HTTPS by account identifier (no host/port,
 * no SSH tunnel). Uses the pure-JS `snowflake-sdk` over a single session connection (the warehouse
 * handles concurrency server-side, so no client pool). Introspection reads a database's
 * INFORMATION_SCHEMA. Read-leaning by nature: pair with the connection's `readOnly` flag.
 */
class SnowflakeDriver implements DatabaseDriver {
	readonly id = 'snowflake';
	readonly displayName = 'Snowflake';
	readonly kind = 'relational' as const;

	private connection?: Connection;
	private config?: ConnectionConfig;
	// The statement currently running (one at a time per connection). Snowflake aborts an in-flight
	// statement via Statement.cancel(); `cancelled` lets execute() report the abort as a cancellation.
	private activeQuery?: { statement: Statement; cancelled: boolean };

	async connect(config: ConnectionConfig): Promise<void> {
		this.config = config;
		const sdk = loadSdk(config.nativeRuntime);
		const connection = connectionOptions(config, sdk);
		await new Promise<void>((resolve, reject) => {
			connection.connect((err) => (err ? reject(err) : resolve()));
		});
		this.connection = connection;
	}

	async disconnect(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection) {
			await new Promise<void>((resolve) => {
				connection.destroy(() => resolve());
			});
		}
	}

	isConnected(): boolean {
		return this.connection !== undefined;
	}

	/** Run a statement, resolving to named-column rows + the statement's column metadata. */
	private runStatement(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
		const connection = this.connection;
		if (!connection) {
			return Promise.reject(new Error('snowflake: not connected'));
		}
		return new Promise((resolve, reject) => {
			connection.execute({
				sqlText: sql,
				binds: params ? [...params] : undefined,
				complete: (err, stmt, rows) => {
					if (err) {
						reject(err);
						return;
					}
					resolve({ rows: rows ?? [], columns: stmt.getColumns().map((c) => c.getName()) });
				},
			});
		});
	}

	/** A runner that yields named-column rows (introspection wants named columns). */
	private runRows(sql: string): Promise<Record<string, unknown>[]> {
		return this.runStatement(sql).then((result) => result.rows);
	}

	async ping(): Promise<void> {
		await this.runRows('SELECT 1');
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		return introspectSnowflake((sql) => this.runRows(sql), this.config?.database, options?.includeViews ?? true);
	}

	async structuralDigest(): Promise<string> {
		if (!this.config?.database) {
			return '0:0';
		}
		return snowflakeStructuralDigest((sql) => this.runRows(sql), this.config.database);
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params } = expectSql(query);
		const connection = this.connection;
		if (!connection) {
			throw new Error('snowflake: not connected');
		}
		const start = Date.now();
		// strip a trailing semicolon: a single statement runs cleaner without it.
		const text = sql.replace(/;\s*$/, '');
		return new Promise<QueryResult>((resolve, reject) => {
			const statement = connection.execute({
				sqlText: text,
				binds: params ? [...params] : undefined,
				complete: (err, stmt, rows) => {
					const entry = this.activeQuery;
					if (this.activeQuery?.statement === statement) {
						this.activeQuery = undefined;
					}
					if (err) {
						reject(entry?.cancelled ? new QueryCancelledError() : err);
						return;
					}
					const data = rows ?? [];
					const fields = stmt.getColumns().map((c) => ({ name: c.getName() }));
					const positional = data.map((row) => fields.map((field) => row[field.name]));
					resolve({
						fields,
						rows: positional,
						rowCount: data.length,
						durationMs: Date.now() - start,
					});
				},
			});
			this.activeQuery = { statement, cancelled: false };
		});
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry) {
			return;
		}
		entry.cancelled = true;
		await new Promise<void>((resolve) => {
			entry.statement.cancel(() => resolve());
		});
	}
}

export function createSnowflakeDriver(): DatabaseDriver {
	return new SnowflakeDriver();
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';

import type { ConnectionConfig } from '../../../../shared/connection';
import type { DatabaseSchema } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql } from '../databaseDriver';
import { readOnlyEnforcementFor, type NativeQuery } from '../../../../shared/engine';
import { withReadOnlySession } from '../readOnlySession';
import { introspectSqlite, sqliteStructuralDigest, type SqliteRowRunner } from './introspection';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Coerce one node:sqlite cell value into something the JSON-RPC wire can carry. Integers are read
 * as BigInt (so a value past 2^53 doesn't throw on read); fold them back to a number when safe and
 * to a string otherwise, mirroring how mysql2 surfaces big integers. BLOBs arrive as Uint8Array;
 * wrap them in a Buffer so they serialise like the other drivers' binary columns.
 */
function jsonSafe(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
	}
	if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
		return Buffer.from(value);
	}
	return value;
}

/**
 * SQLite driver, backed by Node's built-in `node:sqlite` (no native dependency to package). SQLite
 * is an embedded, file-based engine: there is no host/port/credentials and no SSH tunnel — the
 * connection's `database` field carries the path to the `.db` file. The handle is synchronous and
 * single-connection (SQLite serialises access to the file itself), so there is no pool and no
 * preflight-dead retry; a transaction opened via BEGIN spans subsequent execute() calls.
 */
class SqliteDriver implements DatabaseDriver {
	readonly id = 'sqlite';
	readonly displayName = 'SQLite';
	readonly kind = 'relational' as const;

	private db?: DatabaseSync;
	private filePath?: string;

	async connect(config: ConnectionConfig): Promise<void> {
		// The file path rides in `database` (the form's file picker writes it there); fall back to
		// `host` defensively in case an imported/hand-edited connection put it there.
		const file = config.database || config.host;
		if (!file) {
			throw new Error('sqlite: no database file path (set the database file on the connection).');
		}
		this.filePath = file;
		// Open read-only when the connection is flagged read-only — a belt-and-suspenders match for
		// the main-process write guard, and it keeps us from creating an empty file on a typo'd path.
		this.db = new DatabaseSync(file, { readOnly: config.readOnly === true });
		await this.ping();
	}

	async disconnect(): Promise<void> {
		this.db?.close();
		this.db = undefined;
	}

	isConnected(): boolean {
		return this.db !== undefined;
	}

	async ping(): Promise<void> {
		if (!this.db) {
			throw new Error('sqlite: not connected');
		}
		this.db.exec('SELECT 1');
	}

	/** Introspection runner: node:sqlite is synchronous, so each query resolves immediately. Reads
	 *  integers as plain numbers (catalog/PRAGMA values are small) — only execute() needs BigInts. */
	private runner: SqliteRowRunner = (sql) => {
		if (!this.db) {
			return Promise.reject(new Error('sqlite: not connected'));
		}
		return Promise.resolve(this.db.prepare(sql).all() as Record<string, unknown>[]);
	};

	introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		return introspectSqlite(this.runner, this.filePath, options?.includeViews ?? true);
	}

	structuralDigest(): Promise<string> {
		return sqliteStructuralDigest(this.runner);
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		const db = this.db;
		if (!db) {
			throw new Error('sqlite: not connected');
		}
		if (!readOnly) {
			return this.executeOn(db, sql, params);
		}
		// PRAGMA query_only for this one call. The handle is the driver's only connection and cannot
		// be swapped, so there is nothing to discard: the pragma is put back by `end`.
		return withReadOnlySession(readOnlyEnforcementFor('sqlite'), { run: async (statement) => db.exec(statement), discard: () => undefined }, () => this.executeOn(db, sql, params));
	}

	private async executeOn(db: DatabaseSync, sql: string, params: readonly unknown[] | undefined): Promise<QueryResult> {
		const start = Date.now();
		const stmt = db.prepare(sql);
		// Read integers as BigInt so a column past 2^53 returns instead of throwing; jsonSafe folds
		// them back to a wire-safe number/string.
		stmt.setReadBigInts(true);
		const args = (params ?? []) as never[];
		// A statement with output columns is a query (SELECT, PRAGMA, or INSERT/UPDATE/DELETE
		// … RETURNING); anything else is a write whose affected-row count comes from run().
		const columns = stmt.columns();
		if (columns.length > 0) {
			const names = columns.map((c) => c.name);
			const objects = stmt.all(...args) as Record<string, unknown>[];
			const rows = objects.map((row) => names.map((name) => jsonSafe(row[name])));
			return {
				fields: names.map((name) => ({ name })),
				rows,
				rowCount: rows.length,
				durationMs: Date.now() - start,
			};
		}
		const info = stmt.run(...args);
		return {
			fields: [],
			rows: [],
			rowCount: Number(info.changes),
			durationMs: Date.now() - start,
		};
	}

	async cancel(): Promise<void> {
		// node:sqlite is synchronous and single-threaded: a running statement blocks the event loop,
		// so there is never an in-flight statement to interrupt from here. A no-op (queries against a
		// local file return quickly). Matches Db2's cancel limitation.
	}
}

export function createSqliteDriver(): DatabaseDriver {
	return new SqliteDriver();
}

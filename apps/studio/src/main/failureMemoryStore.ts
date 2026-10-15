/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Database from 'better-sqlite3';
import { openDatabase } from './sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { type BackendKind, type ErrorClass, type FailureOrigin, type FailureQuery, type FailureRecord, type FailureSink } from '../shared/engine';

// Durable failure-memory storage. SQLite via better-sqlite3 — the same proven native module the
// dashboards sample store uses (packaging handled by the shared beforeBuild hook). Chosen over
// JSONL because the match query retrieval will run — exact `schema_fingerprint` + `backend`, ranked
// by `query_shape` — is a query, and the product already speaks databases.
//
// Opened LAZILY on first write, so nothing touches the DB on boot — startup is sacred. Append-only
// for v1; pruning is deferred (open question #3) until stores exceed a few thousand records.

/** SQLite row shape (snake_case columns) before mapping back to a {@link FailureRecord}. */
interface FailureRow {
	connection_id: string;
	query: string;
	query_shape: string;
	backend: string;
	origin: string;
	error: string;
	error_class: string;
	schema_fingerprint: string;
	at: number;
}

export class FailureMemoryStore implements FailureSink, FailureQuery {
	private db: Database.Database | undefined;

	/** @param dbPath Full path to the SQLite file, or ':memory:' for tests. */
	constructor(private readonly dbPath: string) {}

	private getDb(): Database.Database {
		if (!this.db) {
			if (this.dbPath !== ':memory:') {
				mkdirSync(dirname(this.dbPath), { recursive: true });
			}
			const db = openDatabase(this.dbPath, "The assistant's failure memory");
			db.pragma('journal_mode = WAL');
			db.pragma('busy_timeout = 5000');
			db.exec(
				`CREATE TABLE IF NOT EXISTS failures (
					id                 INTEGER PRIMARY KEY AUTOINCREMENT,
					connection_id      TEXT NOT NULL,
					query              TEXT NOT NULL,
					query_shape        TEXT NOT NULL,
					backend            TEXT NOT NULL,
					origin             TEXT NOT NULL,
					error              TEXT NOT NULL,
					error_class        TEXT NOT NULL,
					schema_fingerprint TEXT NOT NULL,
					at                 INTEGER NOT NULL
				);
				-- The retrieval gate: exact schema_fingerprint + backend, then rank by query_shape.
				CREATE INDEX IF NOT EXISTS idx_failures_match ON failures(schema_fingerprint, backend);
				CREATE INDEX IF NOT EXISTS idx_failures_at ON failures(at);`,
			);
			this.db = db;
		}
		return this.db;
	}

	/** Append one failure. Synchronous (better-sqlite3), called inside the sink's swallowed capture. */
	insert(record: FailureRecord): void {
		this.getDb()
			.prepare(
				`INSERT INTO failures
					(connection_id, query, query_shape, backend, origin, error, error_class, schema_fingerprint, at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.connectionId,
				record.query,
				record.queryShape,
				record.backend,
				record.origin,
				record.error,
				record.errorClass,
				record.schemaFingerprint,
				record.at,
			);
	}

	/**
	 * The retrieval gate: prior failures on the SAME schema (`schemaFingerprint`) AND `backend`,
	 * newest first. Ranking by `query_shape` happens above this (shared/engine/memory/failureRetrieval). An empty
	 * fingerprint returns nothing — an unknown schema must not collide with every other unknown.
	 */
	match(schemaFingerprint: string, backend: BackendKind, limit = 25): FailureRecord[] {
		if (!schemaFingerprint) {
			return [];
		}
		const rows = this.getDb()
			.prepare('SELECT * FROM failures WHERE schema_fingerprint = ? AND backend = ? ORDER BY at DESC, id DESC LIMIT ?')
			.all(schemaFingerprint, backend, limit) as FailureRow[];
		return rows.map(rowToRecord);
	}

	/** The most recent failures, newest first. For the eventual view UI and manual inspection. */
	recent(limit = 100): FailureRecord[] {
		const rows = this.getDb()
			.prepare('SELECT * FROM failures ORDER BY at DESC, id DESC LIMIT ?')
			.all(limit) as FailureRow[];
		return rows.map(rowToRecord);
	}

	/** Total stored failures. Cheap; used by the view UI and to watch the store's growth. */
	count(): number {
		return (this.getDb().prepare('SELECT COUNT(*) AS n FROM failures').get() as { n: number }).n;
	}

	/** Clear the whole store (the v1 "delete all" affordance; full curation is post-v1). */
	deleteAll(): void {
		this.getDb().exec('DELETE FROM failures');
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}
}

function rowToRecord(row: FailureRow): FailureRecord {
	return {
		connectionId: row.connection_id,
		query: row.query,
		queryShape: row.query_shape,
		backend: row.backend as BackendKind,
		origin: row.origin as FailureOrigin,
		error: row.error,
		errorClass: row.error_class as ErrorClass,
		schemaFingerprint: row.schema_fingerprint,
		at: row.at,
	};
}

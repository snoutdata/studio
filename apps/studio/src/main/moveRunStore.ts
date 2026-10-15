/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase } from './sqlite';
import type { MoveRunRecord } from '../shared/move';

/*---------------------------------------------------------------------------------------------
 *  The runs of a database move: written when one starts and again when it ends, read back as a
 *  move's history.
 *
 *  In `flows.db`, beside the Data Flows run ledger, because that is where they have been written
 *  since Move shipped (1.0.33): a new file would leave every existing move's history behind. Its own
 *  store, and its own handle on that file, because Move is in every build and Data Flows is not.
 *  It owns `move_runs` and nothing else; the flow ledger owns the rest of the
 *  file. Two handles on one WAL database in one process is ordinary SQLite.
 *--------------------------------------------------------------------------------------------*/

interface MoveRunRow {
	id: string;
	move_id: string;
	started_at: string;
	finished_at: string | null;
	status: string;
	spec: string;
	findings: string;
	result: string | null;
}

export class MoveRunStore {
	private db: Database.Database | undefined;

	constructor(private readonly userDataDir: string) {}

	private getDb(): Database.Database {
		if (!this.db) {
			const path = join(this.userDataDir, 'flows.db');
			mkdirSync(dirname(path), { recursive: true });
			const db = openDatabase(path, 'Move');
			db.pragma('journal_mode = WAL');
			db.pragma('busy_timeout = 5000');
			// The spec snapshot never holds a credential; the result is the verification report.
			db.exec(
				`CREATE TABLE IF NOT EXISTS move_runs (
					id          TEXT PRIMARY KEY,
					move_id     TEXT NOT NULL,
					started_at  TEXT NOT NULL,
					finished_at TEXT,
					status      TEXT NOT NULL,
					spec        TEXT NOT NULL,
					findings    TEXT NOT NULL,
					result      TEXT
				);
				CREATE INDEX IF NOT EXISTS idx_move_runs_move ON move_runs(move_id, started_at DESC);`,
			);
			this.db = db;
		}
		return this.db;
	}

	/** Insert or update one move run: written when it starts and again when it ends. */
	record(run: MoveRunRecord): void {
		this.getDb().prepare(
			`INSERT INTO move_runs (id, move_id, started_at, finished_at, status, spec, findings, result)
			 VALUES (@id, @move_id, @started_at, @finished_at, @status, @spec, @findings, @result)
			 ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, status = excluded.status, result = excluded.result`,
		).run({
			id: run.id,
			move_id: run.moveId,
			started_at: run.startedAt,
			finished_at: run.finishedAt,
			status: run.status,
			spec: JSON.stringify(run.spec),
			findings: JSON.stringify(run.findings),
			result: run.result ? JSON.stringify(run.result) : null,
		});
	}

	/** A move's runs, newest first. */
	list(moveId: string, limit = 20): MoveRunRecord[] {
		const rows = this.getDb()
			.prepare('SELECT * FROM move_runs WHERE move_id = ? ORDER BY started_at DESC LIMIT ?')
			.all(moveId, limit) as MoveRunRow[];
		return rows.map((row) => ({
			id: row.id,
			moveId: row.move_id,
			startedAt: row.started_at,
			finishedAt: row.finished_at,
			status: row.status as MoveRunRecord['status'],
			spec: JSON.parse(row.spec) as MoveRunRecord['spec'],
			findings: JSON.parse(row.findings) as MoveRunRecord['findings'],
			result: row.result ? (JSON.parse(row.result) as MoveRunRecord['result']) : null,
		}));
	}

	/** Close the move runs the app was killed in the middle of. Their tools died with it. */
	recoverInterrupted(finishedAt: string): number {
		return this.getDb().prepare(`UPDATE move_runs SET status = 'failed', finished_at = ? WHERE status = 'running'`).run(finishedAt).changes;
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}
}

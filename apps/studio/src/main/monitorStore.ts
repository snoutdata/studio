/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Database from 'better-sqlite3';
import { openDatabase } from './sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Monitor, TrendSample } from '../shared/monitor';

// Monitor persistence, split two ways:
//   - definitions  → userData/monitors.json  (low-volume, human-readable; same JSON pattern
//                    as the other *Store files)
//   - trend samples → userData/monitors.db   (high-volume, append-heavy, range-queried; SQLite
//                    via better-sqlite3). Opened lazily on first sample op so nothing touches the
//                    DB on boot — startup is sacred.
//
// Monitors were called dashboards until 2026-10-01, and so were these two files and the JSON key;
// `adoptLegacyFiles` moves the old files over once, and `read` still accepts the old key, so a
// user's monitors and their history come through the rename untouched.

interface MonitorState {
	monitors: Monitor[];
}

export class MonitorStore {
	private db: Database.Database | undefined;

	constructor(private readonly userDataDir: string) {
		this.adoptLegacyFiles();
	}

	/** dashboards.json / dashboards.db (with SQLite's -wal and -shm) become monitors.*, once. */
	private adoptLegacyFiles(): void {
		const moves: Array<[string, string]> = [
			['dashboards.json', 'monitors.json'],
			['dashboards.db', 'monitors.db'],
			['dashboards.db-wal', 'monitors.db-wal'],
			['dashboards.db-shm', 'monitors.db-shm'],
		];
		// The database moves with its journal or not at all: a db without its -wal loses writes.
		if (existsSync(join(this.userDataDir, 'monitors.db'))) {
			moves.splice(1);
		}
		for (const [from, to] of moves) {
			const source = join(this.userDataDir, from);
			const target = join(this.userDataDir, to);
			try {
				if (existsSync(source) && !existsSync(target)) {
					renameSync(source, target);
				}
			} catch {
				// Left where it is: the old file stays readable by an older build, and nothing is lost.
			}
		}
	}

	// --- Definitions (JSON) ---------------------------------------------------------------

	private jsonPath(): string {
		return join(this.userDataDir, 'monitors.json');
	}

	private read(): MonitorState {
		const path = this.jsonPath();
		if (!existsSync(path)) {
			return { monitors: [] };
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MonitorState> & { dashboards?: Monitor[] };
			return { monitors: raw.monitors ?? raw.dashboards ?? [] };
		} catch {
			return { monitors: [] };
		}
	}

	private write(state: MonitorState): void {
		const path = this.jsonPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
	}

	/** All monitors, ordered by name (case-insensitive). */
	list(): Monitor[] {
		return [...this.read().monitors].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	}

	get(id: string): Monitor | undefined {
		return this.read().monitors.find((d) => d.id === id);
	}

	/** Every trend widget across all monitors — what the poller schedules. */
	trendWidgets(): Monitor['widgets'] {
		return this.read().monitors.flatMap((d) => d.widgets).filter((w) => w.kind === 'trend');
	}

	/** Upsert a monitor (matched by id). Prunes samples for any widget that was removed. */
	upsert(monitor: Monitor): void {
		const state = this.read();
		const prior = state.monitors.find((d) => d.id === monitor.id);
		state.monitors = [...state.monitors.filter((d) => d.id !== monitor.id), monitor];
		this.write(state);
		if (prior) {
			const stillThere = new Set(monitor.widgets.map((w) => w.id));
			for (const w of prior.widgets) {
				if (!stillThere.has(w.id)) {
					this.deleteWidgetSamples(w.id);
				}
			}
		}
	}

	/**
	 * Set (or, with undefined, clear) why one widget is not run, leaving everything else about it as
	 * it was. True when the stored definition changed.
	 */
	setWidgetPaused(widgetId: string, reason: string | undefined): boolean {
		const state = this.read();
		let changed = false;
		state.monitors = state.monitors.map((monitor) => {
			if (!monitor.widgets.some((w) => w.id === widgetId && w.paused !== reason)) {
				return monitor;
			}
			changed = true;
			return {
				...monitor,
				widgets: monitor.widgets.map((w) => {
					if (w.id !== widgetId) {
						return w;
					}
					const { paused: _old, ...rest } = w;
					return reason ? { ...rest, paused: reason } : rest;
				}),
			};
		});
		if (changed) {
			this.write(state);
		}
		return changed;
	}

	/** Remove a monitor and all of its widgets' samples. */
	remove(id: string): void {
		const state = this.read();
		const removed = state.monitors.find((d) => d.id === id);
		state.monitors = state.monitors.filter((d) => d.id !== id);
		this.write(state);
		for (const w of removed?.widgets ?? []) {
			this.deleteWidgetSamples(w.id);
		}
	}

	// --- Samples (SQLite) -----------------------------------------------------------------

	private getDb(): Database.Database {
		if (!this.db) {
			const path = join(this.userDataDir, 'monitors.db');
			mkdirSync(dirname(path), { recursive: true });
			const db = openDatabase(path, 'Monitors');
			db.pragma('journal_mode = WAL');
			db.pragma('busy_timeout = 5000');
			db.exec(
				`CREATE TABLE IF NOT EXISTS samples (
					widget_id TEXT NOT NULL,
					t         INTEGER NOT NULL,
					series    TEXT NOT NULL DEFAULT '',
					value     REAL,
					PRIMARY KEY (widget_id, series, t)
				) WITHOUT ROWID;
				CREATE INDEX IF NOT EXISTS idx_samples_widget_t ON samples(widget_id, t);`,
			);
			this.db = db;
		}
		return this.db;
	}

	/** Append a tick's worth of samples for one widget (one transaction). */
	insertSamples(widgetId: string, samples: TrendSample[]): void {
		if (samples.length === 0) {
			return;
		}
		const db = this.getDb();
		const stmt = db.prepare('INSERT OR REPLACE INTO samples (widget_id, t, series, value) VALUES (?, ?, ?, ?)');
		const insertAll = db.transaction((rows: TrendSample[]) => {
			for (const s of rows) {
				stmt.run(widgetId, s.t, s.series, s.value);
			}
		});
		insertAll(samples);
	}

	/** A widget's samples at or after `sinceMs` (default: all), oldest-first. */
	samples(widgetId: string, sinceMs = 0): TrendSample[] {
		const rows = this.getDb()
			.prepare('SELECT t, series, value FROM samples WHERE widget_id = ? AND t >= ? ORDER BY t ASC')
			.all(widgetId, sinceMs) as { t: number; series: string; value: number | null }[];
		return rows.map((r) => ({ t: r.t, series: r.series, value: r.value }));
	}

	/** Drop samples older than `beforeMs` for one widget (retention prune). */
	pruneOlderThan(widgetId: string, beforeMs: number): void {
		this.getDb().prepare('DELETE FROM samples WHERE widget_id = ? AND t < ?').run(widgetId, beforeMs);
	}

	/** Drop all samples for a widget (on widget/monitor delete). */
	deleteWidgetSamples(widgetId: string): void {
		this.getDb().prepare('DELETE FROM samples WHERE widget_id = ?').run(widgetId);
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}
}

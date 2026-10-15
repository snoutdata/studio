/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExecuteQueryResult } from '../shared/protocol';
import { DEFAULT_RETENTION_MIN, effectiveIntervalSec, extractTrendSamples, monitorQueryRefusal, type MonitorWidget, type TrendSample } from '../shared/monitor';
import type { MonitorStore } from './monitorStore';

// The main-process poller for `trend` widgets. It runs each enabled trend widget's SQL on its own
// interval, extracts the sample(s), persists them to the SQLite samples store, prunes to the
// widget's retention window, and broadcasts a tick so an open monitor updates live. It lives in
// main (not the renderer) so trend history accumulates in the BACKGROUND — even when the monitor
// tab is closed — and survives app restart.
//
// Snapshot widgets are NOT polled here: they keep no history and are refreshed renderer-side.
//
// Startup is sacred: the caller starts this DEFERRED off the boot path; nothing here runs on
// first paint.
//
// A widget's query only ever READS. It runs with nobody looking, every interval, across restarts,
// and never past the production confirmation, and a model can write one (create_monitor). So every
// widget passes the lexical read-only check (`monitorQueryRefusal`) and then runs through the
// database's read-only path (`executeRead`), which refuses a write the text hides, such as a SELECT
// of a function that writes. A widget that is not a read is PAUSED with the reason, on its first
// look here (a monitor saved before this rule existed) as on every save, and is never deleted.

/** The slice of the connection manager the poller needs (kept minimal for decoupling/testing).
 *  `priority` lets the poller run at background priority so its queries can't starve interactive
 *  ones of pool connections. */
export interface MonitorQueryRunner {
	/** Run a statement the app has promised is a read, so the database refuses a write too. */
	executeRead(id: string, sql: string, recordHistory?: boolean, priority?: 'interactive' | 'background'): Promise<ExecuteQueryResult>;
	/** The driver of a saved connection, for the dialect the read-only check splits statements by. */
	driverFor(id: string): string | undefined;
	/** The flavor of a saved connection (TiDB on `mysql-aurora`), for the same check. */
	flavorFor?(id: string): string | undefined;
}

/** The slice of the store the poller reads and writes. */
type PollerStore = Pick<MonitorStore, 'list' | 'setWidgetPaused' | 'insertSamples' | 'pruneOlderThan'>;

export class MonitorPoller {
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly inFlight = new Set<string>();
	// Last poll status per trend widget: an error string, or null once a poll succeeds. Lets a tile
	// that mounts mid-stream show why it has no data (a failing query) instead of hanging on "waiting".
	private readonly lastStatus = new Map<string, string | null>();
	private running = false;

	constructor(
		private readonly store: PollerStore,
		private readonly runner: MonitorQueryRunner,
		private readonly broadcastSample: (widgetId: string, samples: TrendSample[]) => void,
		private readonly broadcastStatus: (widgetId: string, error: string | null) => void,
		/** A widget was paused (or resumed) in the stored definitions, so an open view re-reads them. */
		private readonly definitionsChanged: () => void = () => undefined,
	) {}

	/** Why this widget is not run, or undefined when its query is a read. */
	private refusal(widget: MonitorWidget): string | undefined {
		return monitorQueryRefusal(widget.sql, this.runner.driverFor(widget.connectionId), this.runner.flavorFor?.(widget.connectionId));
	}

	/** The last known poll status for a widget (error string, or null when its last poll was ok). */
	status(widgetId: string): string | null {
		return this.lastStatus.get(widgetId) ?? null;
	}

	private setStatus(widgetId: string, error: string | null): void {
		this.lastStatus.set(widgetId, error);
		this.broadcastStatus(widgetId, error);
	}

	/** Begin polling. Safe to call once; use refresh() to pick up definition changes afterwards. */
	start(): void {
		this.running = true;
		this.refresh();
	}

	/** Reconcile timers with the current set of enabled trend widgets. Call after any save/delete. */
	refresh(): void {
		if (!this.running) {
			return;
		}
		// Simplest correct reconciliation: tear down every timer and rebuild from the store, so an
		// edited interval/SQL/enabled-flag always takes effect. Timer churn is trivial at this scale.
		for (const timer of this.timers.values()) {
			clearInterval(timer);
		}
		this.timers.clear();

		let pausedChanged = false;
		for (const widget of this.store.list().flatMap((monitor) => monitor.widgets)) {
			// Every widget, snapshots too: a snapshot is run by the open view, through `runWidget`,
			// which refuses the same way, and the pause is what the view shows instead of a chart.
			const refusal = this.refusal(widget);
			if (refusal !== widget.paused && this.store.setWidgetPaused(widget.id, refusal)) {
				pausedChanged = true;
			}
			if (refusal) {
				this.setStatus(widget.id, refusal);
				continue;
			}
			if (widget.kind !== 'trend' || widget.enabled === false) {
				continue;
			}
			const intervalMs = effectiveIntervalSec(widget) * 1000;
			// Fire one tick immediately so a freshly-added widget's chart isn't empty for `interval`s,
			// then on the interval.
			void this.tick(widget);
			const timer = setInterval(() => void this.tick(widget), intervalMs);
			timer.unref();
			this.timers.set(widget.id, timer);
		}
		if (pausedChanged) {
			this.definitionsChanged();
		}
	}

	/** Stop all polling. */
	stop(): void {
		this.running = false;
		for (const timer of this.timers.values()) {
			clearInterval(timer);
		}
		this.timers.clear();
	}

	private async tick(widget: MonitorWidget): Promise<void> {
		// Skip if the previous tick for this widget is still running (slow query > interval).
		if (this.inFlight.has(widget.id)) {
			return;
		}
		// Checked again at the moment of running, not only when scheduled: this is the enforcing side.
		const refusal = this.refusal(widget);
		if (refusal) {
			this.setStatus(widget.id, refusal);
			return;
		}
		this.inFlight.add(widget.id);
		try {
			// recordHistory=false: automated polls must never pollute the user's query history.
			// background priority: a busy monitor can't consume every pool connection and stall an
			// interactive query. executeRead: the database refuses a write as well.
			const res = await this.runner.executeRead(widget.connectionId, widget.sql, false, 'background');
			if (!res.ok) {
				this.setStatus(widget.id, res.error);
				return;
			}
			const t = Date.now();
			const samples = extractTrendSamples(res.result, t);
			// A successful poll clears any prior error even if it produced nothing to plot.
			this.setStatus(widget.id, null);
			if (samples.length === 0) {
				return;
			}
			this.store.insertSamples(widget.id, samples);
			const retentionMin = widget.retentionMin ?? DEFAULT_RETENTION_MIN;
			this.store.pruneOlderThan(widget.id, t - retentionMin * 60_000);
			this.broadcastSample(widget.id, samples);
		} catch (err) {
			// A poll failure (disconnected, transient error) skips this sample; surface it so the tile
			// isn't stuck on "waiting", and the next tick retries.
			this.setStatus(widget.id, err instanceof Error ? err.message : String(err));
		} finally {
			this.inFlight.delete(widget.id);
		}
	}
}

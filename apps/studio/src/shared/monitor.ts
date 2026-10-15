/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Monitor contracts — live DB monitors. A monitor is a named set of widgets; each widget
 * is a SQL query polled on an interval and plotted. Two widget kinds:
 *
 *   - `snapshot` — the SQL returns a result set, re-run each interval and replacing the chart.
 *                  No history kept (refreshed renderer-side).
 *   - `trend`    — the SQL returns a scalar (or a small grouped row set), sampled over wall-clock
 *                  time and accumulated into the SQLite samples store, then plotted as a series.
 *
 * Pure types + helpers only (no Electron/DOM), so this is shared by main and renderer and the
 * extraction helper stays node-testable.
 */

import { readOnlyError } from './engine';
import type { QueryResult } from './query';

export type WidgetKind = 'trend' | 'snapshot';

export type WidgetViz = 'line' | 'area' | 'bar' | 'number' | 'table';

/** One monitored query inside a monitor. */
export interface MonitorWidget {
	id: string;
	title: string;
	connectionId: string;
	sql: string;
	kind: WidgetKind;
	viz: WidgetViz;
	/** Poll cadence in seconds; floored at {@link MIN_INTERVAL_SEC}. */
	intervalSec: number;
	/** Trend only: keep this many minutes of samples (defaults to {@link DEFAULT_RETENTION_MIN}). */
	retentionMin?: number;
	/** A disabled widget is not polled. Defaults to true (enabled). */
	enabled?: boolean;
	/**
	 * Why this widget is not run: its query is not a read ({@link monitorQueryRefusal}). Written by
	 * main, on every save and on the poller's first look at a saved monitor, and cleared the same way
	 * once the query reads; the view shows it in place of the chart. A paused widget is kept, never
	 * deleted, so the person can see what it was and edit it.
	 */
	paused?: string;
}

/** A named set of widgets. Persisted (definitions only) as JSON; samples live in SQLite. */
export interface Monitor {
	id: string;
	name: string;
	widgets: MonitorWidget[];
	createdAt: number;
	updatedAt: number;
}

/** One accumulated trend point: a wall-clock time, a series label (`''` for a scalar), a value. */
export interface TrendSample {
	/** Epoch milliseconds. */
	t: number;
	/** `''` for a scalar metric; the group label for a grouped/multi-series metric. */
	series: string;
	value: number | null;
}

/** Don't poll faster than this — keeps a prod box from being hammered. Clamped at read time, so
 *  raising it also throttles any widget already saved with a smaller interval. */
export const MIN_INTERVAL_SEC = 60;

/** Default trend retention window (24h). Older samples are pruned each tick. */
export const DEFAULT_RETENTION_MIN = 24 * 60;

/** Coerce a query cell to a finite number, or null if it isn't one. */
function toNumber(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * Turn one trend query's result into the samples to store at time `t`. The shape of the result tells
 * us how to read it:
 *   - 1 column                       → one scalar sample (`series: ''`), value = the first cell.
 *   - 1 row, multiple columns        → one series PER numeric column, named by the column (e.g.
 *                                       `SELECT COUNT(*) AS payments, SUM(amount) AS total`). A
 *                                       non-numeric column in that row (a text label) is skipped.
 *   - multiple rows, ≥2 columns      → a grouped metric: one sample per row, first column the series
 *                                       label, last column the value (e.g. `SELECT status, COUNT(*)
 *                                       … GROUP BY status`).
 * Rows are positional value arrays (the engine runs `rowsAsArray`), aligned to `fields` by index.
 */
export function extractTrendSamples(result: QueryResult, t: number): TrendSample[] {
	const cols = result.fields.length;
	if (cols === 0 || result.rows.length === 0) {
		return [];
	}
	if (cols === 1) {
		return [{ t, series: '', value: toNumber(result.rows[0][0]) }];
	}
	// A single row of several columns is N separate metrics, one series each (keyed by column name).
	if (result.rows.length === 1) {
		const row = result.rows[0];
		const metrics: TrendSample[] = [];
		result.fields.forEach((field, i) => {
			const value = toNumber(row[i]);
			if (value !== null) {
				metrics.push({ t, series: field.name, value });
			}
		});
		if (metrics.length > 0) {
			return metrics;
		}
	}
	// Multiple rows: a grouped metric — first column labels the series, last column is the value.
	const out: TrendSample[] = [];
	for (const row of result.rows) {
		const series = row[0] === null || row[0] === undefined ? '' : String(row[0]);
		out.push({ t, series, value: toNumber(row[row.length - 1]) });
	}
	return out;
}

/** Clamp a widget's interval to the floor. */
export function effectiveIntervalSec(widget: MonitorWidget): number {
	return Math.max(MIN_INTERVAL_SEC, Math.floor(widget.intervalSec) || MIN_INTERVAL_SEC);
}

/**
 * Why a monitor will not run this query, or undefined when it may.
 *
 * A widget's query is run by the app on its own: every interval, in the background, after a
 * restart, with nobody looking, and never past the production confirmation. So it may only READ,
 * whoever wrote it. This is the lexical half (the same check the agent's run_query gets); main also
 * runs every widget through the database's read-only path, which catches a write the text hides.
 */
export function monitorQueryRefusal(sql: string, driver?: string, flavor?: string): string | undefined {
	const refusal = readOnlyError(sql, driver, flavor);
	if (!refusal) {
		return undefined;
	}
	const detail = refusal
		.replace(/^Refused:\s*/, '')
		.replace(/\s*The agent may only run [^.]*\.$/, '');
	const why = /^only read-only queries/.test(detail) ? '' : ` ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
	return `Paused: a monitor only runs read-only queries (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN), and this one is not.${why} Edit the query to resume it.`;
}

/** The monitor with each widget's {@link MonitorWidget.paused} set or cleared from its query. */
export function guardMonitor(
	monitor: Monitor,
	driverFor: (connectionId: string) => string | undefined,
	flavorFor: (connectionId: string) => string | undefined = () => undefined,
): Monitor {
	return {
		...monitor,
		widgets: monitor.widgets.map((widget) => {
			const paused = monitorQueryRefusal(widget.sql, driverFor(widget.connectionId), flavorFor(widget.connectionId));
			const { paused: _old, ...rest } = widget;
			return paused ? { ...rest, paused } : rest;
		}),
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A monitor over a SnoutTime series' rollups.
//
// A trend widget exists because the database keeps no history of a metric, so the app samples
// the metric on a clock and keeps the samples itself. A rollup turns that around: the history IS
// in the database, already aggregated per bucket and current to the latest row. So a widget over
// a rollup is a SNAPSHOT of its recent buckets, redrawn each poll, instead of a trend that
// re-aggregates raw rows every minute and remembers the answers. It reads a few dozen
// materialized rows where the trend would have scanned the raw table, and the chart has its
// whole history the first time it is opened rather than filling in over a day.
//
// Pure, like `clickhouseMonitor.ts`: the widgets are decided here and tested; the app saves them.

import type { Monitor } from './monitor';
import type { TableInfo } from './schema';
import { dialectFor } from './engine';

/** A widget before it has an id and a connection. */
export interface SeriesWidget {
	title: string;
	sql: string;
	viz: 'line' | 'bar';
}

/** How many buckets back a chart reaches: two days of hours, seven weeks of days. */
const BUCKETS_SHOWN = 48;

const NUMERIC = /^(smallint|integer|bigint|int2|int4|int8|real|double precision|float4|float8|numeric|decimal)/i;

function quote(name: string): string {
	return dialectFor('postgres').quoteIdent(name);
}

/**
 * The widgets for one rollup view. A rollup's columns are `bucket`, its aggregates, and any
 * group-by columns; an ungrouped rollup charts its aggregates over the recent buckets, and a
 * grouped one would stack one line per group per aggregate, so it shows the latest bucket's top
 * groups instead. Empty when the view's columns are unknown (views were not introspected).
 */
export function rollupWidgets(view: TableInfo, integerTime: boolean): SeriesWidget[] {
	if (!view.rollup || view.columns.length === 0) {
		return [];
	}
	const rel = `${view.schema ? `${quote(view.schema)}.` : ''}${quote(view.name)}`;
	const bucket = view.rollup.bucket;
	const measures = view.columns.filter((c) => c.name !== 'bucket' && NUMERIC.test(c.dataType));
	const groups = view.columns.filter((c) => c.name !== 'bucket' && !NUMERIC.test(c.dataType));
	if (measures.length === 0) {
		return [];
	}
	// Back from the newest bucket, not from now(): a series that stopped taking writes, or one
	// loaded with history, would otherwise chart nothing (the first live run of this did). The
	// newest bucket is cheap: the materialized part is one row per bucket, indexed on it.
	const width = integerTime ? bucket.trim() : `interval '${bucket.replace(/'/g, "''")}'`;
	const since = `(SELECT max(bucket) FROM ${rel}) - ${BUCKETS_SHOWN} * ${width}`;
	if (groups.length === 0) {
		return [{
			title: `${view.name}: ${measures.map((m) => m.name).join(', ')}`,
			viz: 'line',
			sql: `SELECT bucket, ${measures.map((m) => quote(m.name)).join(', ')}\nFROM ${rel}\nWHERE bucket >= ${since}\nORDER BY bucket`,
		}];
	}
	const label = groups.map((g) => quote(g.name)).join(` || ' · ' || `);
	return measures.map((m) => ({
		title: `${view.name}: ${m.name} by ${groups.map((g) => g.name).join(', ')}, latest bucket`,
		viz: 'bar' as const,
		sql: `SELECT ${groups.length === 1 ? label : `${label} AS "group"`}, ${quote(m.name)}\nFROM ${rel}\nWHERE bucket = (SELECT max(bucket) FROM ${rel})\nORDER BY ${quote(m.name)} DESC NULLS LAST\nLIMIT 10`,
	}));
}

/** The poll: once a minute, the floor, since a rollup's newest bucket moves with every write. */
const INTERVAL_SEC = 60;

/**
 * The monitor for a series table: every rollup it has, as snapshots. Undefined when none of
 * its rollups has anything to chart. `tables` is the schema's table list, where the rollup views
 * and their columns are.
 */
export function seriesMonitor(series: TableInfo, tables: TableInfo[], connectionId: string, label: string, newId: () => string, now = Date.now()): Monitor | undefined {
	if (!series.series) {
		return undefined;
	}
	const integerTime = /int/i.test(series.series.timeType);
	const widgets = series.series.rollups.flatMap((r) => {
		const view = tables.find((t) => t.name === r.name && (t.schema ?? '') === (r.schema ?? ''));
		return view ? rollupWidgets(view, integerTime) : [];
	});
	if (widgets.length === 0) {
		return undefined;
	}
	return {
		id: newId(),
		name: `${series.name} rollups · ${label}`,
		createdAt: now,
		updatedAt: now,
		widgets: widgets.map((w) => ({
			id: newId(),
			title: w.title,
			connectionId,
			sql: w.sql,
			kind: 'snapshot',
			viz: w.viz,
			intervalSec: INTERVAL_SEC,
		})),
	};
}

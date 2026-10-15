/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChartSpec, ChartType } from '../../shared/chart';
import type { TrendSample, WidgetViz } from '../../shared/monitor';
import type { QueryResult } from '../../shared/query';

// Turn monitor widget data into a Recharts {@link ChartSpec} (rendered by ChartCanvas).
// Two sources: accumulated trend samples (time on the x axis) and one-shot snapshot result sets
// (the first column on the x axis). Pure + DOM-free.

/** The single series key used for a scalar (ungrouped) trend metric. */
const SCALAR_KEY = 'value';

/** Map a widget's viz choice to a Recharts chart type (only the chartable vizzes). */
export function vizToChartType(viz: WidgetViz): ChartType {
	switch (viz) {
		case 'area':
			return 'area';
		case 'bar':
			return 'bar';
		default:
			return 'line';
	}
}

/** Format an epoch-ms instant as HH:MM:SS for a time axis tick. */
function clockLabel(t: number): string {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Build a time-series chart from accumulated trend samples. Distinct `series` labels become the
 * plotted series (a scalar metric — all `series === ''` — collapses to one series named after the
 * widget). Rows are grouped by timestamp so multiple series align on the x axis.
 */
export function trendToChartSpec(title: string, viz: WidgetViz, samples: TrendSample[]): ChartSpec {
	const labels: string[] = [];
	for (const s of samples) {
		if (!labels.includes(s.series)) {
			labels.push(s.series);
		}
	}
	const scalar = labels.length <= 1 && (labels[0] ?? '') === '';
	const keyFor = (label: string): string => (scalar ? SCALAR_KEY : label);

	const byTime = new Map<number, Record<string, string | number | null>>();
	const order: number[] = [];
	for (const s of samples) {
		let row = byTime.get(s.t);
		if (!row) {
			row = { time: clockLabel(s.t) };
			byTime.set(s.t, row);
			order.push(s.t);
		}
		row[keyFor(s.series)] = s.value;
	}

	const series = scalar
		? [{ key: SCALAR_KEY, name: title }]
		: labels.map((label) => ({ key: label, name: label }));
	return { type: vizToChartType(viz), title, x: 'time', series, data: order.map((t) => byTime.get(t)!) };
}

/** Coerce a query cell to a chart-friendly value. */
function cell(value: unknown): string | number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'number' || typeof value === 'string') {
		return value;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	return String(value);
}

/**
 * Build a chart from a one-shot snapshot result set: the first column is the category axis, every
 * remaining column is a plotted series. A single-column result is plotted by row index.
 */
export function resultToChartSpec(title: string, viz: WidgetViz, result: QueryResult): ChartSpec {
	const names = result.fields.map((f) => f.name);
	const type = vizToChartType(viz);
	if (names.length <= 1) {
		const key = names[0] ?? SCALAR_KEY;
		const data = result.rows.map((row, i) => ({ '#': String(i + 1), [key]: cell(row[0]) }));
		return { type, title, x: '#', series: [{ key }], data };
	}
	const x = names[0];
	const series = names.slice(1).map((name) => ({ key: name }));
	const data = result.rows.map((row) => {
		const out: Record<string, string | number | null> = {};
		names.forEach((name, i) => {
			out[name] = cell(row[i]);
		});
		return out;
	});
	return { type, title, x, series, data };
}

/** The most recent value of a (scalar) trend metric, for the "number" viz. Null if no samples. */
export function latestTrendValue(samples: TrendSample[]): number | null {
	for (let i = samples.length - 1; i >= 0; i--) {
		if (samples[i].value !== null) {
			return samples[i].value;
		}
	}
	return null;
}

/** The scalar value of a one-shot result (first row, first column) for the snapshot "number" viz. */
export function resultScalar(result: QueryResult): string | number | null {
	if (result.rows.length === 0 || result.fields.length === 0) {
		return null;
	}
	return cell(result.rows[0][0]);
}

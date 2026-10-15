/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chart specs the AI assistant emits inside a ```chart fenced block in its reply. ChatPanel
 * parses each block with {@link parseChartSpec} and renders it inline with `ChartView` (Recharts).
 * The shape is deliberately small and Recharts-friendly: a category key (`x`), one or more value
 * series, and the data rows inline. Pure/DOM-free so it stays node-testable.
 */

import { csvField } from './export';

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter';

/** One plotted series: the data-row key holding its value, plus an optional display name. */
export interface ChartSeries {
	/** The key in each {@link ChartSpec.data} row holding this series' numeric value. */
	key: string;
	/** Display name in the legend/tooltip. Defaults to {@link key}. */
	name?: string;
}

/** A renderable chart: type, the category axis key, the value series, and the data rows. */
export interface ChartSpec {
	type: ChartType;
	title?: string;
	/** The key in each data row used for the category axis (or the slice label for `pie`). */
	x: string;
	series: ChartSeries[];
	/** The rows to plot. Each is a flat object keyed by `x` and every series `key`. */
	data: Record<string, string | number | null>[];
}

const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'area', 'pie', 'scatter'];

/** The result of {@link parseChartSpec}: a valid spec, or a human-readable error to show inline. */
export type ParsedChart = { spec: ChartSpec } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate the JSON inside a ```chart block. Tolerant: any malformed/incomplete spec
 * yields an `{ error }` the caller renders as an inline chip rather than throwing. A valid spec
 * always comes back with a non-empty `series` and `data`.
 */
export function parseChartSpec(text: string): ParsedChart {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: "Chart spec is not valid JSON." };
	}
	if (!isRecord(raw)) {
		return { error: "Chart spec must be a JSON object." };
	}
	const type = raw.type;
	if (typeof type !== 'string' || !CHART_TYPES.includes(type as ChartType)) {
		return { error: `Chart "type" must be one of: ${CHART_TYPES.join(', ')}.` };
	}
	const x = raw.x;
	if (typeof x !== 'string' || x.length === 0) {
		return { error: 'Chart "x" (the category key) is required.' };
	}
	if (!Array.isArray(raw.series) || raw.series.length === 0) {
		return { error: 'Chart "series" must be a non-empty array.' };
	}
	const series: ChartSeries[] = [];
	for (const s of raw.series) {
		if (!isRecord(s) || typeof s.key !== 'string' || s.key.length === 0) {
			return { error: 'Each chart series needs a non-empty "key".' };
		}
		series.push({ key: s.key, name: typeof s.name === 'string' ? s.name : undefined });
	}
	if (!Array.isArray(raw.data) || raw.data.length === 0) {
		return { error: 'Chart "data" must be a non-empty array of rows.' };
	}
	const data: Record<string, string | number | null>[] = [];
	for (const row of raw.data) {
		if (!isRecord(row)) {
			return { error: 'Each chart data row must be an object.' };
		}
		const clean: Record<string, string | number | null> = {};
		for (const [k, v] of Object.entries(row)) {
			clean[k] = v === null || typeof v === 'string' || typeof v === 'number' ? v : String(v);
		}
		data.push(clean);
	}
	const title = typeof raw.title === 'string' ? raw.title : undefined;
	return { spec: { type: type as ChartType, title, x, series, data } };
}

/** Serialize a chart's data rows to RFC 4180 CSV (header = the x key + each series key), with a
 *  cell a spreadsheet would read as a formula neutralised, as the grid's CSV export does. */
export function chartDataToCsv(spec: ChartSpec): string {
	const keys = [spec.x, ...spec.series.map((s) => s.key)];
	const field = (value: string | number | null | undefined): string => csvField(value, true);
	const header = keys.map(field).join(',');
	const lines = spec.data.map((row) => keys.map((k) => field(row[k])).join(','));
	return [header, ...lines].join('\r\n');
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ResponsiveContainer,
	BarChart, Bar,
	LineChart, Line,
	AreaChart, Area,
	PieChart, Pie, Cell,
	ScatterChart, Scatter,
	XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import type { ChartSpec } from '../../../shared/chart';

/**
 * The Recharts renderer for a {@link ChartSpec}. Split out from `ChartView` so it (and the whole
 * recharts/d3 dependency) is lazy-loaded only when a chart actually appears — keeping it off the
 * boot/first-paint path. Default export so it can be `React.lazy`-imported.
 */

// Two categorical palettes: brighter on a dark background (mid-tones vanish on dark), deeper on a
// light one (bright colors wash out on white). Picked per-render from the resolved --bg luminance.
const PALETTE_DARK = ['#5cb3ff', '#ffa64d', '#4ad991', '#ff7a99', '#bd9bff', '#ffd24a', '#4fd4e0', '#ff95dd'];
const PALETTE_LIGHT = ['#2f7fbf', '#cf6f2a', '#3a9e6f', '#c43d5a', '#7c5fd0', '#bf9420', '#2f9aa3', '#b85fa0'];

/** True when the app background is dark (so we pick the brighter palette). */
function isDarkBackground(): boolean {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(cssVar('--bg', '#1f1f1f'));
	if (!m) {
		return true;
	}
	const n = parseInt(m[1], 16);
	const luminance = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
	return luminance < 128;
}

/** Read a theme CSS variable for axis/grid colors so the chart tracks light/dark. */
function cssVar(name: string, fallback: string): string {
	if (typeof window === 'undefined') {
		return fallback;
	}
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v || fallback;
}

export default function ChartCanvas({ spec }: { spec: ChartSpec }): JSX.Element {
	const axis = cssVar('--fg-dim', '#888');
	const grid = cssVar('--border', '#444');
	const palette = isDarkBackground() ? PALETTE_DARK : PALETTE_LIGHT;
	const color = (i: number): string => palette[i % palette.length];
	const common = (
		<>
			<CartesianGrid stroke={grid} strokeDasharray="3 3" />
			<XAxis dataKey={spec.x} stroke={axis} tick={{ fontSize: 11 }} />
			<YAxis stroke={axis} tick={{ fontSize: 11 }} />
			<Tooltip contentStyle={{ background: cssVar('--bg-widget', '#222'), border: `1px solid ${grid}`, color: cssVar('--fg', '#eee'), fontSize: 12 }} />
			<Legend wrapperStyle={{ fontSize: 12 }} />
		</>
	);

	let chart: JSX.Element;
	switch (spec.type) {
		case 'line':
			chart = (
				<LineChart data={spec.data}>
					{common}
					{spec.series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name ?? s.key} stroke={color(i)} strokeWidth={2} dot={false} />)}
				</LineChart>
			);
			break;
		case 'area':
			chart = (
				<AreaChart data={spec.data}>
					{common}
					{spec.series.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name ?? s.key} stroke={color(i)} fill={color(i)} fillOpacity={0.3} />)}
				</AreaChart>
			);
			break;
		case 'pie':
			chart = (
				<PieChart>
					<Tooltip contentStyle={{ background: cssVar('--bg-widget', '#222'), border: `1px solid ${grid}`, color: cssVar('--fg', '#eee'), fontSize: 12 }} />
					<Legend wrapperStyle={{ fontSize: 12 }} />
					<Pie data={spec.data} dataKey={spec.series[0].key} nameKey={spec.x} outerRadius="80%" label={{ fontSize: 11 }}>
						{spec.data.map((_row, i) => <Cell key={i} fill={color(i)} />)}
					</Pie>
				</PieChart>
			);
			break;
		case 'scatter':
			chart = (
				<ScatterChart>
					<CartesianGrid stroke={grid} strokeDasharray="3 3" />
					<XAxis dataKey={spec.x} stroke={axis} tick={{ fontSize: 11 }} name={spec.x} />
					<YAxis stroke={axis} tick={{ fontSize: 11 }} />
					<Tooltip contentStyle={{ background: cssVar('--bg-widget', '#222'), border: `1px solid ${grid}`, color: cssVar('--fg', '#eee'), fontSize: 12 }} />
					<Legend wrapperStyle={{ fontSize: 12 }} />
					{spec.series.map((s, i) => (
						<Scatter key={s.key} name={s.name ?? s.key} data={spec.data.map((row) => ({ [spec.x]: row[spec.x], [s.key]: row[s.key] }))} dataKey={s.key} fill={color(i)} />
					))}
				</ScatterChart>
			);
			break;
		default:
			chart = (
				<BarChart data={spec.data}>
					{common}
					{spec.series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.name ?? s.key} fill={color(i)} />)}
				</BarChart>
			);
	}
	return (
		<ResponsiveContainer width="100%" height={260}>
			{chart}
		</ResponsiveContainer>
	);
}

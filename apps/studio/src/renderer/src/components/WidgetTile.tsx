/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { effectiveIntervalSec, type MonitorWidget, type TrendSample } from '../../../shared/monitor';
import type { QueryResult } from '../../../shared/query';
import { latestTrendValue, resultScalar, resultToChartSpec, trendToChartSpec } from '../monitorChart';

// One monitor widget. A `trend` widget reads its accumulated samples from the SQLite store and
// appends live ticks pushed by the main poller. A `snapshot` widget re-runs its SQL on an interval
// (renderer-driven) and replaces its view; it keeps no history, so it only polls while the monitor
// is visible (`active`).

// Lazy so recharts/d3 stays off the boot path until a chart tile actually mounts.
const ChartCanvas = lazy(() => import('./ChartCanvas'));

/** Cap the in-memory trend buffer so a long-lived dense metric doesn't grow without bound. */
const MAX_POINTS = 1000;

interface WidgetTileProps {
	widget: MonitorWidget;
	connectionLabel: string | undefined;
	/** The monitor tab is currently visible (snapshot polling pauses when false). */
	active: boolean;
	onEdit(): void;
	onDelete(): void;
}

function formatNumber(value: number | string | null): string {
	if (value === null) {
		return "—";
	}
	if (typeof value === 'number') {
		return value.toLocaleString();
	}
	return value;
}

export function WidgetTile(props: WidgetTileProps): JSX.Element {
	const { widget } = props;
	const [samples, setSamples] = useState<TrendSample[]>([]);
	const [result, setResult] = useState<QueryResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const interval = effectiveIntervalSec(widget);
	// Wall-clock instant of the last actual poll; the countdown (a separate component) restarts off
	// this. Kept OUT of any per-second state so the heavy chart only re-renders when data arrives,
	// not once a second (a trend's polls happen in main, so we stamp this off its sample/status events).
	const [lastPollAt, setLastPollAt] = useState(0);
	// Latest props for the snapshot interval closure (so it sees the current `active` without resubscribing).
	const activeRef = useRef(props.active);
	activeRef.current = props.active;

	// Trend: load history + last poll status once, then append live ticks (and track poll errors) from
	// the poller. The status is what keeps a failing query from sitting on "waiting" with no feedback.
	useEffect(() => {
		if (widget.kind !== 'trend') {
			return;
		}
		let cancelled = false;
		setLoading(true);
		void Promise.all([
			window.sqlApi.monitors.samples(widget.id),
			window.sqlApi.monitors.status(widget.id),
		]).then(([rows, status]) => {
			if (!cancelled) {
				// Cap the initial load too (not just live appends) so reopening a long-lived monitor
				// never hands the chart an unbounded array to process.
				setSamples(rows.slice(-MAX_POINTS));
				setError(status);
				setLoading(false);
			}
		});
		const offSample = window.sqlApi.monitors.onSample((id, incoming) => {
			if (id !== widget.id) {
				return;
			}
			setError(null);
			setLastPollAt(Date.now());
			setSamples((prev) => [...prev, ...incoming].slice(-MAX_POINTS));
		});
		const offStatus = window.sqlApi.monitors.onStatus((id, message) => {
			if (id === widget.id) {
				setError(message);
				setLastPollAt(Date.now());
			}
		});
		return () => {
			cancelled = true;
			offSample();
			offStatus();
		};
	}, [widget.id, widget.kind]);

	// Snapshot: poll the SQL on the widget's interval while the monitor is visible. Not when it is
	// paused: main would refuse it anyway, and the tile says why instead.
	useEffect(() => {
		if (widget.kind !== 'snapshot' || widget.paused) {
			return;
		}
		let cancelled = false;
		async function tick(): Promise<void> {
			if (!activeRef.current) {
				return;
			}
			const res = await window.sqlApi.monitors.runWidget(widget.connectionId, widget.sql);
			if (cancelled) {
				return;
			}
			setLastPollAt(Date.now());
			if (res.ok) {
				setResult(res.result);
				setError(null);
			} else {
				setError(res.error);
			}
			setLoading(false);
		}
		void tick();
		const timer = window.setInterval(() => void tick(), effectiveIntervalSec(widget) * 1000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [widget.id, widget.kind, widget.connectionId, widget.sql, widget.intervalSec, widget.paused]);

	// Memoize the lazy, heavy chart element so it's rebuilt ONLY when its data changes — never on an
	// unrelated re-render. Returning a stable element reference makes React skip re-rendering Recharts.
	// This is the core of keeping a many-series chart from dragging the app down over time.
	const trendChart = useMemo(
		() => (
			<Suspense fallback={<div className="widget-tile-empty">Loading chart…</div>}>
				<ChartCanvas spec={trendToChartSpec(widget.title, widget.viz, samples)} />
			</Suspense>
		),
		[widget.title, widget.viz, samples],
	);
	const snapshotChart = useMemo(
		() => (result ? (
			<Suspense fallback={<div className="widget-tile-empty">Loading chart…</div>}>
				<ChartCanvas spec={resultToChartSpec(widget.title, widget.viz, result)} />
			</Suspense>
		) : null),
		[widget.title, widget.viz, result],
	);

	function errorBox(): JSX.Element {
		return <div className="widget-tile-error" title={error ?? undefined}><Icon name="warning" /> {error}</div>;
	}

	function body(): JSX.Element {
		// A query that is not a read is not run at all (main decides, monitorQueryRefusal), and the
		// widget stays, saying so, until it is edited.
		if (widget.paused) {
			return <div className="widget-tile-error widget-tile-paused" title={widget.paused}><Icon name="debug-pause" /> {widget.paused}</div>;
		}
		if (loading) {
			return <div className="widget-tile-empty">Loading…</div>;
		}
		if (widget.kind === 'trend') {
			// A poll error only takes over the tile when there's nothing accumulated to show; once
			// samples exist, keep plotting them (a transient error doesn't blank the chart).
			if (samples.length === 0) {
				return error ? errorBox() : <div className="widget-tile-empty">Waiting for the first sample…</div>;
			}
			if (widget.viz === 'number') {
				return <div className="widget-tile-number">{formatNumber(latestTrendValue(samples))}</div>;
			}
			if (widget.viz === 'table') {
				return <TrendTable samples={samples} />;
			}
			return trendChart;
		}
		// snapshot
		if (!result) {
			return error ? errorBox() : <div className="widget-tile-empty">No data.</div>;
		}
		if (widget.viz === 'number') {
			return <div className="widget-tile-number">{formatNumber(resultScalar(result))}</div>;
		}
		if (widget.viz === 'table') {
			return <ResultTable result={result} />;
		}
		return snapshotChart ?? <div className="widget-tile-empty">No data.</div>;
	}

	return (
		<div className="widget-tile">
			<div className="widget-tile-head">
				<span className="widget-tile-title" title={widget.title}>{widget.title}</span>
				<span className="widget-tile-meta">
					{props.connectionLabel ?? "No connection"} · every {interval}s
					<Countdown intervalSec={interval} pollAt={lastPollAt} active={props.active} />
				</span>
				<span className="spacer" />
				<button className="icon-button" title="Edit widget" onClick={props.onEdit}><Icon name="edit" /></button>
				<button className="icon-button" title="Delete widget" onClick={props.onDelete}><Icon name="trash" /></button>
			</div>
			<div className="widget-tile-body">{body()}</div>
		</div>
	);
}

/**
 * Standalone per-second countdown to the next refresh. Isolated in its own component on purpose: its
 * 1s state updates re-render only this little number, never the tile's (heavy, many-series) chart.
 * Restarts at each actual poll (`pollAt` changes); floors at 0 if a poll runs late.
 */
function Countdown({ intervalSec, pollAt, active }: { intervalSec: number; pollAt: number; active: boolean }): JSX.Element {
	const [left, setLeft] = useState(intervalSec);
	useEffect(() => { setLeft(intervalSec); }, [pollAt, intervalSec]);
	useEffect(() => {
		// No reason to tick while the monitor tab is hidden — pause to keep idle work at zero.
		if (!active) {
			return;
		}
		const id = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
		return () => window.clearInterval(id);
	}, [active]);
	return <span className="widget-tile-countdown" title="Seconds until the next refresh"> · {left}s</span>;
}

/** Recent trend samples as a small table (newest first). */
function TrendTable({ samples }: { samples: TrendSample[] }): JSX.Element {
	const recent = [...samples].slice(-20).reverse();
	const grouped = recent.some((s) => s.series !== '');
	return (
		<table className="widget-tile-table">
			<thead>
				<tr><th>time</th>{grouped && <th>series</th>}<th>value</th></tr>
			</thead>
			<tbody>
				{recent.map((s, i) => (
					<tr key={i}>
						<td>{new Date(s.t).toLocaleTimeString()}</td>
						{grouped && <td>{s.series}</td>}
						<td>{s.value === null ? "—" : s.value.toLocaleString()}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** A snapshot result set as a capped table. */
function ResultTable({ result }: { result: QueryResult }): JSX.Element {
	const rows = result.rows.slice(0, 50);
	return (
		<table className="widget-tile-table">
			<thead>
				<tr>{result.fields.map((f, i) => <th key={i}>{f.name}</th>)}</tr>
			</thead>
			<tbody>
				{rows.map((row, ri) => (
					<tr key={ri}>{row.map((v, ci) => <td key={ci}>{v === null || v === undefined ? "—" : String(v)}</td>)}</tr>
				))}
			</tbody>
		</table>
	);
}

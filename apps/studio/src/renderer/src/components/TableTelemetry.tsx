/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../formatBytes';
import { Icon } from './Icon';
import { Metric } from './Metric';
import type { TableInfo } from '../../../shared/schema';
import type { QueryHistoryEntry } from '../../../shared/queries';

// A dashboard for one table: catalog stats as metric cards, a data-vs-index size bar,
// and "recent queries" pulled from query history filtered by the table's name appearing
// in the SQL (cheap word-boundary match — covers FROM/JOIN/INSERT/UPDATE/DELETE references
// without parsing SQL). All inputs are catalog-only (no extra round trip when this tab
// opens) except the recent-queries fetch.
interface TableTelemetryProps {
	connectionId: string;
	table: TableInfo;
}


function formatCount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) {
		return '—';
	}
	return n.toLocaleString();
}

function formatDate(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
		return '—';
	}
	return new Date(ms).toLocaleString();
}

function formatRelative(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
		return '—';
	}
	const diff = Date.now() - ms;
	if (diff < 60_000) {
		return 'just now';
	}
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) {
		return `${mins}m ago`;
	}
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	if (days < 60) {
		return `${days}d ago`;
	}
	return new Date(ms).toLocaleDateString();
}

/** Render the data/index/total size as a stacked horizontal bar — small inline SVG keeps
 *  the renderer bundle the way the project wants it (no chart library). */
function SizeBar({ dataBytes, indexBytes, totalBytes }: { dataBytes?: number; indexBytes?: number; totalBytes?: number }): JSX.Element | null {
	const data = dataBytes ?? 0;
	const index = indexBytes ?? 0;
	// Postgres `total_bytes` includes TOAST + visibility map; the "other" slice is what
	// can't be attributed to data or index pages and only appears when total > data+index.
	const total = totalBytes ?? data + index;
	const other = Math.max(0, total - data - index);
	const sum = data + index + other;
	if (sum <= 0) {
		return null;
	}
	const dPct = (data / sum) * 100;
	const iPct = (index / sum) * 100;
	const oPct = (other / sum) * 100;
	return (
		<div className="size-bar-wrap">
			<div className="size-bar" role="img" aria-label="Storage breakdown">
				<div className="size-bar-seg data" style={{ width: `${dPct}%` }} title={`Data ${formatBytesOr(data)} (${dPct.toFixed(1)}%)`} />
				<div className="size-bar-seg index" style={{ width: `${iPct}%` }} title={`Indexes ${formatBytesOr(index)} (${iPct.toFixed(1)}%)`} />
				{other > 0 && <div className="size-bar-seg other" style={{ width: `${oPct}%` }} title={`Other ${formatBytesOr(other)} (${oPct.toFixed(1)}%)`} />}
			</div>
			<div className="size-bar-legend">
				<span><span className="swatch data" /> Data {formatBytesOr(data)}</span>
				<span><span className="swatch index" /> Indexes {formatBytesOr(index)}</span>
				{other > 0 && <span><span className="swatch other" /> Other {formatBytesOr(other)}</span>}
				<span className="muted">Total {formatBytesOr(sum)}</span>
			</div>
		</div>
	);
}

/** Build a case-insensitive word-boundary regex matching either bare `tableName` or
 *  qualified `schema.tableName`. Quoted variants (`` `t` ``, `"t"`) are caught because the
 *  word boundary fires either side of the quote. */
function matcherFor(table: TableInfo): RegExp {
	const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const name = escape(table.name);
	const qualified = table.schema ? `${escape(table.schema)}\\.${name}` : null;
	const pattern = qualified ? `(?:\\b${qualified}\\b|\\b${name}\\b)` : `\\b${name}\\b`;
	return new RegExp(pattern, 'i');
}

export function TableTelemetry({ connectionId, table }: TableTelemetryProps): JSX.Element {
	const [history, setHistory] = useState<QueryHistoryEntry[] | null>(null);
	const [showAllConns, setShowAllConns] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void window.sqlApi.history().then((h) => { if (!cancelled) { setHistory(h); } });
		return () => { cancelled = true; };
	}, []);

	const recent = useMemo(() => {
		if (!history) {
			return [];
		}
		const re = matcherFor(table);
		return history.filter((e) => (showAllConns || e.connectionId === connectionId) && re.test(e.sql)).slice(0, 25);
	}, [history, table, connectionId, showAllConns]);

	const stats = table.stats ?? {};
	const total = stats.totalBytes ?? ((stats.dataBytes ?? 0) + (stats.indexBytes ?? 0));
	// "Bloat" is the dead/live ratio — Postgres-only and approximate.
	const bloatPct = stats.liveTuples && stats.deadTuples
		? (stats.deadTuples / (stats.liveTuples + stats.deadTuples)) * 100
		: undefined;

	return (
		<div className="telemetry">
			<div className="telemetry-section">
				<div className="telemetry-heading">Storage</div>
				<div className="metric-cards">
					<Metric icon="symbol-numeric" label="Rows" value={formatCount(stats.rowCount ?? stats.liveTuples)} hint="Approximate row count from the catalog (not an exact COUNT)." />
					<Metric icon="database" label="Total size" value={formatBytesOr(total)} hint="Data + indexes (+ TOAST on Postgres)." />
					<Metric icon="file-binary" label="Data size" value={formatBytesOr(stats.dataBytes)} />
					<Metric icon="list-tree" label="Index size" value={formatBytesOr(stats.indexBytes)} />
					{stats.avgRowBytes !== undefined && <Metric icon="symbol-ruler" label="Avg row" value={formatBytesOr(stats.avgRowBytes)} hint="AVG_ROW_LENGTH from INFORMATION_SCHEMA.TABLES." />}
					{stats.dataFreeBytes !== undefined && stats.dataFreeBytes > 0 && <Metric icon="trash" label="Data free" value={formatBytesOr(stats.dataFreeBytes)} hint="Free space inside the data file (reusable, not returned to the OS)." />}
				</div>
				<SizeBar dataBytes={stats.dataBytes} indexBytes={stats.indexBytes} totalBytes={stats.totalBytes} />
			</div>

			<div className="telemetry-section">
				<div className="telemetry-heading">Schema</div>
				<div className="metric-cards">
					<Metric icon={table.kind === 'view' ? 'eye' : 'table'} label="Kind" value={table.kind} />
					<Metric icon="symbol-field" label="Columns" value={String(table.columns.length)} />
					<Metric icon="key" label="Primary key" value={table.primaryKey.length > 0 ? table.primaryKey.join(', ') : '—'} />
					<Metric icon="references" label="Foreign keys" value={String(table.foreignKeys.length)} />
					<Metric icon="list-ordered" label="Indexes" value={String(table.indexes?.length ?? 0)} />
					<Metric icon="symbol-event" label="Triggers" value={String(table.triggers?.length ?? 0)} />
					{stats.engine && <Metric icon="server-environment" label="Engine" value={stats.engine} />}
					{stats.collation && <Metric icon="symbol-string" label="Collation" value={stats.collation} />}
					{stats.autoIncrement !== undefined && <Metric icon="arrow-up" label="Auto increment" value={formatCount(stats.autoIncrement)} hint="Next AUTO_INCREMENT value." />}
				</div>
				{table.comment && <div className="telemetry-comment"><Icon name="comment" /> {table.comment}</div>}
			</div>

			{(stats.createdAt || stats.updatedAt || stats.lastVacuum || stats.lastAutovacuum || stats.lastAnalyze || stats.lastAutoanalyze) && (
				<div className="telemetry-section">
					<div className="telemetry-heading">Activity</div>
					<div className="metric-cards">
						{stats.createdAt !== undefined && <Metric icon="calendar" label="Created" value={formatDate(stats.createdAt)} />}
						{stats.updatedAt !== undefined && <Metric icon="history" label="Last modified" value={formatRelative(stats.updatedAt)} hint={formatDate(stats.updatedAt)} />}
						{stats.seqScan !== undefined && <Metric icon="search" label="Sequential scans" value={formatCount(stats.seqScan)} hint="Since the last pg_stat reset." />}
						{stats.idxScan !== undefined && <Metric icon="list-tree" label="Index scans" value={formatCount(stats.idxScan)} hint="Since the last pg_stat reset." />}
						{stats.deadTuples !== undefined && <Metric icon="trash" label="Dead tuples" value={formatCount(stats.deadTuples)} hint="Rows awaiting vacuum." />}
						{bloatPct !== undefined && <Metric icon="symbol-ruler" label="Bloat" value={`${bloatPct.toFixed(1)}%`} hint="dead / (live + dead); vacuum if it climbs." />}
						{stats.lastVacuum !== undefined && <Metric icon="clear-all" label="Last VACUUM" value={formatRelative(stats.lastVacuum)} hint={formatDate(stats.lastVacuum)} />}
						{stats.lastAutovacuum !== undefined && <Metric icon="sync" label="Last autovacuum" value={formatRelative(stats.lastAutovacuum)} hint={formatDate(stats.lastAutovacuum)} />}
						{stats.lastAnalyze !== undefined && <Metric icon="graph" label="Last ANALYZE" value={formatRelative(stats.lastAnalyze)} hint={formatDate(stats.lastAnalyze)} />}
						{stats.lastAutoanalyze !== undefined && <Metric icon="sync" label="Last autoanalyze" value={formatRelative(stats.lastAutoanalyze)} hint={formatDate(stats.lastAutoanalyze)} />}
					</div>
				</div>
			)}

			<div className="telemetry-section">
				<div className="telemetry-heading">
					Recent queries
					<span className="spacer" />
					<label className="muted check">
						<input type="checkbox" checked={showAllConns} onChange={(e) => setShowAllConns(e.target.checked)} />
						all connections
					</label>
				</div>
				{history === null && <div className="prop-empty">Loading…</div>}
				{history !== null && recent.length === 0 && (
					<div className="prop-empty">No history matches <code>{table.name}</code>. Run a query against it to populate this list.</div>
				)}
				{recent.length > 0 && (
					<div className="recent-queries">
						{recent.map((e, i) => {
							const ok = e.outcome.ok;
							const meta = ok
								? `${e.outcome.rowCount.toLocaleString()} rows · ${e.outcome.durationMs} ms`
								: `failed: ${e.outcome.error}`;
							return (
								<div className={`recent-query${ok ? '' : ' failed'}`} key={i}>
									<div className="recent-query-head">
										<Icon name={ok ? 'check' : 'error'} />
										<span className="muted">{formatRelative(e.timestamp)}</span>
										<span className="muted">·</span>
										<span className="muted">{e.connectionLabel}</span>
										{e.environment && <span className={`env${e.environment === 'prod' ? ' prod' : ''}`}>{e.environment}</span>}
										<span className="spacer" />
										<span className="muted">{meta}</span>
									</div>
									<pre className="recent-query-sql">{e.sql}</pre>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

/** An unknown size shows as a dash in this panel. */
function formatBytesOr(n: number | undefined): string {
	return formatBytes(n, '—');
}

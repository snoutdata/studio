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
import { formatLocale, rich, useT, type Translate } from '../i18n';

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
	return n.toLocaleString(formatLocale());
}

function formatDate(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
		return '—';
	}
	return new Date(ms).toLocaleString(formatLocale());
}

function formatRelative(t: Translate, ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
		return '—';
	}
	const diff = Date.now() - ms;
	if (diff < 60_000) {
		return t('tables.tele.justNow');
	}
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) {
		return t('editor.history.minutesAgo', { n: String(mins) });
	}
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		return t('editor.history.hoursAgo', { n: String(hours) });
	}
	const days = Math.floor(hours / 24);
	if (days < 60) {
		return t('editor.history.daysAgo', { n: String(days) });
	}
	return new Date(ms).toLocaleDateString(formatLocale());
}

/** Render the data/index/total size as a stacked horizontal bar — small inline SVG keeps
 *  the renderer bundle the way the project wants it (no chart library). */
function SizeBar({ dataBytes, indexBytes, totalBytes }: { dataBytes?: number; indexBytes?: number; totalBytes?: number }): JSX.Element | null {
	const t = useT();
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
			<div className="size-bar" role="img" aria-label={t('tables.tele.storageBreakdown')}>
				<div className="size-bar-seg data" style={{ width: `${dPct}%` }} title={t('tables.tele.dataTip', { size: formatBytesOr(data), pct: dPct.toFixed(1) })} />
				<div className="size-bar-seg index" style={{ width: `${iPct}%` }} title={t('tables.tele.indexesTip', { size: formatBytesOr(index), pct: iPct.toFixed(1) })} />
				{other > 0 && <div className="size-bar-seg other" style={{ width: `${oPct}%` }} title={t('tables.tele.otherTip', { size: formatBytesOr(other), pct: oPct.toFixed(1) })} />}
			</div>
			<div className="size-bar-legend">
				<span><span className="swatch data" /> {t('tables.tele.legendData', { size: formatBytesOr(data) })}</span>
				<span><span className="swatch index" /> {t('tables.tele.legendIndexes', { size: formatBytesOr(index) })}</span>
				{other > 0 && <span><span className="swatch other" /> {t('tables.tele.legendOther', { size: formatBytesOr(other) })}</span>}
				<span className="muted">{t('tables.tele.legendTotal', { size: formatBytesOr(sum) })}</span>
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
	const t = useT();
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
				<div className="telemetry-heading">{t('tables.tele.storage')}</div>
				<div className="metric-cards">
					<Metric icon="symbol-numeric" label={t('tables.tele.rows')} value={formatCount(stats.rowCount ?? stats.liveTuples)} hint={t('tables.tele.rowsHint')} />
					<Metric icon="database" label={t('tables.tele.totalSize')} value={formatBytesOr(total)} hint={t('tables.tele.totalSizeHint')} />
					<Metric icon="file-binary" label={t('tables.tele.dataSize')} value={formatBytesOr(stats.dataBytes)} />
					<Metric icon="list-tree" label={t('tables.tele.indexSize')} value={formatBytesOr(stats.indexBytes)} />
					{stats.avgRowBytes !== undefined && <Metric icon="symbol-ruler" label={t('tables.tele.avgRow')} value={formatBytesOr(stats.avgRowBytes)} hint={t('tables.tele.avgRowHint')} />}
					{stats.dataFreeBytes !== undefined && stats.dataFreeBytes > 0 && <Metric icon="trash" label={t('tables.tele.dataFree')} value={formatBytesOr(stats.dataFreeBytes)} hint={t('tables.tele.dataFreeHint')} />}
				</div>
				<SizeBar dataBytes={stats.dataBytes} indexBytes={stats.indexBytes} totalBytes={stats.totalBytes} />
			</div>

			<div className="telemetry-section">
				<div className="telemetry-heading">{t('tables.tele.schema')}</div>
				<div className="metric-cards">
					<Metric icon={table.kind === 'view' ? 'eye' : 'table'} label={t('tables.tele.kind')} value={kindText(t, table.kind)} />
					<Metric icon="symbol-field" label={t('tables.tele.columns')} value={String(table.columns.length)} />
					<Metric icon="key" label={t('tables.tele.primaryKey')} value={table.primaryKey.length > 0 ? table.primaryKey.join(', ') : '—'} />
					<Metric icon="references" label={t('tables.tele.foreignKeys')} value={String(table.foreignKeys.length)} />
					<Metric icon="list-ordered" label={t('tables.tele.indexes')} value={String(table.indexes?.length ?? 0)} />
					<Metric icon="symbol-event" label={t('tables.tele.triggers')} value={String(table.triggers?.length ?? 0)} />
					{stats.engine && <Metric icon="server-environment" label={t('tables.tele.engine')} value={stats.engine} />}
					{stats.collation && <Metric icon="symbol-string" label={t('tables.tele.collation')} value={stats.collation} />}
					{stats.autoIncrement !== undefined && <Metric icon="arrow-up" label={t('tables.tele.autoIncrement')} value={formatCount(stats.autoIncrement)} hint={t('tables.tele.autoIncrementHint')} />}
				</div>
				{table.comment && <div className="telemetry-comment"><Icon name="comment" /> {table.comment}</div>}
			</div>

			{(stats.createdAt || stats.updatedAt || stats.lastVacuum || stats.lastAutovacuum || stats.lastAnalyze || stats.lastAutoanalyze) && (
				<div className="telemetry-section">
					<div className="telemetry-heading">{t('tables.tele.activity')}</div>
					<div className="metric-cards">
						{stats.createdAt !== undefined && <Metric icon="calendar" label={t('tables.tele.created')} value={formatDate(stats.createdAt)} />}
						{stats.updatedAt !== undefined && <Metric icon="history" label={t('tables.tele.lastModified')} value={formatRelative(t, stats.updatedAt)} hint={formatDate(stats.updatedAt)} />}
						{stats.seqScan !== undefined && <Metric icon="search" label={t('tables.tele.seqScans')} value={formatCount(stats.seqScan)} hint={t('tables.tele.statHint')} />}
						{stats.idxScan !== undefined && <Metric icon="list-tree" label={t('tables.tele.indexScans')} value={formatCount(stats.idxScan)} hint={t('tables.tele.statHint')} />}
						{stats.deadTuples !== undefined && <Metric icon="trash" label={t('tables.tele.deadTuples')} value={formatCount(stats.deadTuples)} hint={t('tables.tele.deadHint')} />}
						{bloatPct !== undefined && <Metric icon="symbol-ruler" label={t('tables.tele.bloat')} value={`${bloatPct.toFixed(1)}%`} hint={t('tables.tele.bloatHint')} />}
						{stats.lastVacuum !== undefined && <Metric icon="clear-all" label={t('tables.tele.lastVacuum')} value={formatRelative(t, stats.lastVacuum)} hint={formatDate(stats.lastVacuum)} />}
						{stats.lastAutovacuum !== undefined && <Metric icon="sync" label={t('tables.tele.lastAutovacuum')} value={formatRelative(t, stats.lastAutovacuum)} hint={formatDate(stats.lastAutovacuum)} />}
						{stats.lastAnalyze !== undefined && <Metric icon="graph" label={t('tables.tele.lastAnalyze')} value={formatRelative(t, stats.lastAnalyze)} hint={formatDate(stats.lastAnalyze)} />}
						{stats.lastAutoanalyze !== undefined && <Metric icon="sync" label={t('tables.tele.lastAutoanalyze')} value={formatRelative(t, stats.lastAutoanalyze)} hint={formatDate(stats.lastAutoanalyze)} />}
					</div>
				</div>
			)}

			<div className="telemetry-section">
				<div className="telemetry-heading">
					{t('tables.tele.recentQueries')}
					<span className="spacer" />
					<label className="muted check">
						<input type="checkbox" checked={showAllConns} onChange={(e) => setShowAllConns(e.target.checked)} />
						{t('tables.tele.allConnections')}
					</label>
				</div>
				{history === null && <div className="prop-empty">{t('editor.common.loading')}</div>}
				{history !== null && recent.length === 0 && (
					<div className="prop-empty">{rich(t('tables.tele.noHistory', { table: table.name }))}</div>
				)}
				{recent.length > 0 && (
					<div className="recent-queries">
						{recent.map((e, i) => {
							const ok = e.outcome.ok;
							const meta = ok
								? t('editor.history.rowsMs', { count: e.outcome.rowCount, ms: String(e.outcome.durationMs) })
								: t('tables.tele.failed', { error: e.outcome.error });
							return (
								<div className={`recent-query${ok ? '' : ' failed'}`} key={i}>
									<div className="recent-query-head">
										<Icon name={ok ? 'check' : 'error'} />
										<span className="muted">{formatRelative(t, e.timestamp)}</span>
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

/** A table's kind as the reader's language says it; a kind with no words of its own shows as it is. */
function kindText(t: Translate, kind: string): string {
	switch (kind) {
		case 'table':
			return t('tables.common.kindTable');
		case 'view':
			return t('tables.common.kindView');
		case 'collection':
			return t('tables.common.kindCollection');
		case 'dictionary':
			return t('tables.common.kindDictionary');
		default:
			return kind;
	}
}

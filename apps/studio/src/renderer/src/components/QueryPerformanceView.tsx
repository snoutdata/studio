/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_NAME } from '../../../shared/assistant';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { CellValueEditor } from './CellValueEditor';
import { DataGrid, cellText, computeColumnWidths, type SortState } from './DataGrid';
import { errorMessage } from '../errors';
import { formatSql } from '../sqlFormat';
import type { KeywordCase } from '../appSettings';
import { dialectFor, type ReplicaScope, type WorkloadRank } from '../../../shared/engine';
import type { ConnectionConfig } from '../../../shared/connection';
import type { QueryResult } from '../../../shared/query';

// The "Query Performance" tool: a point-in-time read of a database's OWN
// runtime-statistics view (pg_stat_statements, performance_schema, v$sqlarea, …), ranking the
// heaviest statements by total execution time. NOT continuous monitoring; the DB accumulates the
// stats itself and we surface them on demand. Nothing runs automatically: the tool analyzes the
// connection that's active in the connections sidebar (no separate picker here), and "Collect data"
// is enabled only once that connection is live. The user clicks it, browses/sorts the heaviest
// statements, then hands one to the chat assistant. The explain/optimize work happens in the chat
// panel (agentic, schema-grounded, approval-gated DDL) rather than a second mini-panel here.

const TOP_OPTIONS = [15, 25, 50, 100];

const RANK_LABELS: Record<WorkloadRank, string> = { time: 'Total time', read: 'Data read', memory: 'Peak memory' };
const DEFAULT_TOP = 25;

interface QueryPerformanceViewProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	/** The connection to analyze: the one bound to this tab, driven by the connections sidebar (there
	 *  is no in-panel picker). Switch it by selecting a connection in the sidebar while this tab is focused. */
	connectionId?: string;
	/** Keyword case for the "Format query" action in the value viewer (matches the editor's Ctrl+Shift+F). */
	keywordCase: KeywordCase;
	/** Hand a statement to the chat assistant's "Analyze" action (explain what it does + why it's
	 *  heavy). Triggered by the per-row Analyze button in the grid. */
	onAnalyze(connectionId: string, sql: string): void;
	/** Hand a statement to the chat assistant's "Suggest optimization" action. Triggered by the
	 *  per-row optimize button in the grid. */
	onSuggest(connectionId: string, sql: string): void;
}

/** Map result field name (lowercased) → column index, for reading named cells off a row. */
function columnIndex(fields: QueryResult['fields']): Map<string, number> {
	return new Map(fields.map((f, i) => [f.name.toLowerCase(), i]));
}

function isEmpty(value: unknown): boolean {
	return value === null || value === undefined || value === '';
}

/** Compare two non-empty cell values: numerically when both look numeric, else by text. */
function compareNonEmpty(a: unknown, b: unknown): number {
	const na = typeof a === 'number' ? a : Number(a);
	const nb = typeof b === 'number' ? b : Number(b);
	if (Number.isFinite(na) && Number.isFinite(nb)) {
		return na - nb;
	}
	return String(a).localeCompare(String(b));
}

export function QueryPerformanceView({ connections, connectedIds, connectionId: connId, keywordCase, onAnalyze, onSuggest }: QueryPerformanceViewProps): JSX.Element {
	const [top, setTop] = useState(DEFAULT_TOP);
	const [rank, setRank] = useState<WorkloadRank>('time');
	const [data, setData] = useState<QueryResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reloadSeq, setReloadSeq] = useState(0);
	// Which replicas the last collect read, on an engine served by several (ClickHouse Cloud).
	const [scope, setScope] = useState<ReplicaScope | null>(null);
	const [sort, setSort] = useState<SortState | null>(null);
	// The cell shown in the read-only value viewer (right-click "View value…"), or null when closed.
	// Heaviest-statement SQL is long, so the cramped grid cell gets a full-size modal on demand.
	const [viewCell, setViewCell] = useState<{ value: string | null; columnName: string } | null>(null);
	// The in-flight request token: bumping it (a new collect, or a connection change) abandons any
	// reply still streaming back for a prior request so it can't overwrite the current grid.
	const reqRef = useRef(0);

	const conn = connId ? connections.find((c) => c.id === connId) : undefined;
	const driver = conn?.driver ?? '';
	const connected = connId !== undefined && connectedIds.includes(connId);
	// The vendor stats SQL, or null when this engine exposes no runtime workload view (SQLite,
	// generic) or is a non-SQL backend (Mongo/Pinecone — the optional method is absent).
	const digestSql = useMemo(() => (driver ? dialectFor(driver).workloadDigest?.(top, undefined, rank) ?? null : null), [driver, top, rank]);
	// Ranked by more than time only where the engine records what each statement read and held.
	const rankings = driver ? dialectFor(driver).workloadRankings ?? [] : [];

	const fields = data?.fields ?? [];
	const rows = data?.rows ?? [];
	const widths = useMemo(() => computeColumnWidths(fields, rows.length, (i) => rows[i]), [data]);
	const colIndex = useMemo(() => columnIndex(fields), [fields]);
	const qtCol = colIndex.get('query_text') ?? 0;

	// Display order: a permutation of original row indices by the active sort (empties sink). The grid
	// reads rows through this, so sorting is a pure client-side view over the already-collected digest.
	const order = useMemo(() => {
		const idx = rows.map((_, i) => i);
		if (!sort || sort.col >= fields.length) {
			return idx;
		}
		const { col, dir } = sort;
		const sign = dir === 'asc' ? 1 : -1;
		idx.sort((a, b) => {
			const va = rows[a][col];
			const vb = rows[b][col];
			const ea = isEmpty(va);
			const eb = isEmpty(vb);
			if (ea || eb) {
				return ea === eb ? 0 : ea ? 1 : -1;
			}
			return sign * compareNonEmpty(va, vb);
		});
		return idx;
	}, [data, sort, fields.length]);

	// Run the digest for the current connection. Only ever fires from an explicit Collect (reloadSeq
	// bump) — never on connection select — so opening or switching a connection shows an empty grid
	// until the user asks for the data.
	useEffect(() => {
		if (reloadSeq === 0 || !connId || !digestSql) {
			return;
		}
		const seq = ++reqRef.current;
		const cid = connId;
		setLoading(true);
		setError(null);
		void collectSql(cid).then((sql) => window.sqlApi.execute({ connectionId: cid, sql })).then((res) => {
			if (reqRef.current !== seq) {
				return;
			}
			if (!res.ok) {
				// A missing extension / denied permission lands here (e.g. "SELECT command denied …
				// events_statements_summary_by_digest"); kept so degradeHint() can guide the user.
				setError(res.error);
				setData(null);
			} else {
				setData(res.result);
			}
			setLoading(false);
		}).catch((err: unknown) => {
			if (reqRef.current !== seq) {
				return;
			}
			setError(errorMessage(err));
			setData(null);
			setLoading(false);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [reloadSeq]);

	// The digest for this collect: across every replica where the engine is served by several and
	// each keeps its own statistics (ClickHouse Cloud), otherwise the plain one.
	async function collectSql(cid: string): Promise<string> {
		const dialect = dialectFor(driver);
		if (!dialect.replicaScope) {
			return digestSql ?? '';
		}
		const found = await dialect.replicaScope(async (sql) => {
			const res = await window.sqlApi.explain({ connectionId: cid, sql });
			if (!res.ok) {
				throw new Error(res.error);
			}
			return res.result.rows.map((row) => Object.fromEntries(res.result.fields.map((f, i) => [f.name, row[i]])));
		});
		setScope(found);
		return dialect.workloadDigest?.(top, found, rank) ?? digestSql ?? '';
	}

	// Collect (or recollect) the heaviest statements for the active database. The Collect button is
	// only enabled once that connection is live, so there's no connect-on-collect step here.
	function collect(): void {
		if (!connId || !digestSql || !connected) {
			return;
		}
		setReloadSeq((s) => s + 1);
	}

	// Switching the active connection (via the sidebar) drops the previous one's grid and any in-flight
	// collect, but does NOT auto-collect: the user clicks Collect when ready. Keyed on the connection
	// prop so a sidebar rebind resets this surface cleanly.
	useEffect(() => {
		reqRef.current++;
		setData(null);
		setError(null);
		setSort(null);
		setLoading(false);
		setScope(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [connId]);

	function changeRank(next: WorkloadRank): void {
		setRank(next);
		setSort(null);
		// Like Top-N, the ranking is a parameter of the collection: recollect only if we have data.
		if (data || error) {
			setReloadSeq((s) => s + 1);
		}
	}

	function changeTop(n: number): void {
		setTop(n);
		// Top-N is a parameter of the collection, so recollect with it only if we already have data
		// (otherwise just remember the choice for the first Collect).
		if (data || error) {
			setReloadSeq((s) => s + 1);
		}
	}

	function clickHeader(col: number): void {
		setSort((prev) => {
			if (!prev || prev.col !== col) {
				return { col, dir: 'asc' };
			}
			return prev.dir === 'asc' ? { col, dir: 'desc' } : null;
		});
	}

	// A friendlier nudge for the common "stats view exists but I can't read it" failures, layered on
	// top of the raw DB error (which we still show verbatim below it).
	const flavour = dialectFor(driver).aiDisplayName;
	const hint = error ? degradeHint(error, flavour) : null;
	// Collect is enabled only when the active connection is live AND its engine exposes a workload view.
	const canCollect = Boolean(connId && digestSql && connected);
	const collectTitle = !connId
		? "Select a connection in the sidebar to analyze"
		: !connected
			? `Connect "${conn?.label ?? 'the database'}" to collect its workload`
			: !digestSql
				? `${conn?.label ?? 'This database'} exposes no runtime query statistics`
				: "Collect the heaviest statements";

	return (
		<>
		<div className="table-view">
			<div className="tv-head">
				<Icon name="dashboard" className="tv-head-icon" />
				<span className="tv-title">Query Performance</span>
				<span className="muted">heaviest statements by {RANK_LABELS[rank].toLowerCase()}, point-in-time</span>
				<button type="button" className="tv-collect" disabled={loading || !canCollect} title={collectTitle} onClick={() => collect()}>
					<Icon name="play" /> {loading ? 'Collecting…' : 'Collect data'}
				</button>
				<span className="spacer" />
			</div>

			{!connId
				? <div className="results-message">Select a database in the connections sidebar, connect it, then click "Collect data" to see its heaviest queries.</div>
				: !digestSql
					? <div className="results-message">{conn?.label ?? 'This database'} exposes no runtime query statistics, so there is no workload to analyze.</div>
					: (
						<div className="qp-grid">
							{error
								? <div className="qp-error">
									{hint && <div className="results-message">{hint}</div>}
									<div className="results-error">{error}</div>
								</div>
								: loading
									? <div className="results-message">Collecting the heaviest statements…</div>
									: !data
										? !connected
											? <div className="results-message">Connect "{conn?.label ?? 'this database'}" in the sidebar to collect its heaviest queries.</div>
											: <div className="results-message">Click "Collect data" above to load {conn?.label ?? 'this database'}'s heaviest queries.</div>
										: rows.length === 0
											? <div className="results-message">No statements recorded yet. Run some queries against this database, then collect again.</div>
											: (
												<DataGrid
													fields={fields}
													rowCount={order.length}
													getRow={(i) => rows[order[i]]}
													widths={widths}
													sort={sort}
													onSortColumn={clickHeader}
													resetKey={`${connId}:${top}:${reloadSeq}`}
													onCopyCell={(i, col) => void navigator.clipboard.writeText(cellText(rows[order[i]][col]) ?? '')}
													onCopyRow={(i) => void navigator.clipboard.writeText(fields.map((_f, col) => cellText(rows[order[i]][col]) ?? '').join('\t'))}
													onViewCell={(i, col) => setViewCell({ value: cellText(rows[order[i]][col]), columnName: fields[col]?.name ?? '' })}
													rowActions={connId ? [
														{ icon: 'sparkle', title: `Analyze this statement with ${ASSISTANT_NAME}`, onClick: (i) => { const sql = cellText(rows[order[i]][qtCol]); if (sql) { onAnalyze(connId, sql); } } },
														{ icon: 'lightbulb', title: `Suggest an optimization with ${ASSISTANT_NAME}`, onClick: (i) => { const sql = cellText(rows[order[i]][qtCol]); if (sql) { onSuggest(connId, sql); } } },
													] : undefined}
												/>
											)}

							<div className="results-footer">
								<span>{data && rows.length > 0 ? `${rows.length.toLocaleString()} statement${rows.length === 1 ? '' : 's'}` : ''}</span>
								{scope && scope.replicas > 1 && (
									<span className={`qp-scope${scope.cluster ? '' : ' ch-ops-scope-warn'}`} title={scope.limitation}>
										{scope.cluster ? `across all ${scope.replicas} replicas` : `1 of ${scope.replicas} replicas only`}
									</span>
								)}
								<span className="spacer" />
								{rankings.length > 1 && (
									<label className="page-size">Rank by
										<select value={rank} onChange={(e) => changeRank(e.target.value as WorkloadRank)}>
											{rankings.map((r) => <option key={r} value={r}>{RANK_LABELS[r]}</option>)}
										</select>
									</label>
								)}
								<label className="page-size">Top
									<select value={top} onChange={(e) => changeTop(Number(e.target.value))}>
										{TOP_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
									</select>
								</label>
							</div>
						</div>
					)}
		</div>
		{viewCell && (
			<CellValueEditor
				columnName={viewCell.columnName}
				value={viewCell.value}
				readOnly
				formatLabel="Format query"
				onFormat={(t) => formatSql(t, driver, keywordCase)}
				onCommit={() => {}}
				onClose={() => setViewCell(null)}
			/>
		)}
		</>
	);
}

/** A plain-language nudge for the common, recoverable workload-stats failures (permission denied or
 *  the stats source not enabled), shown above the raw DB error. Returns null for anything else so we
 *  never bury an unexpected error under a wrong guess. */
function degradeHint(error: string, flavour: string): string | null {
	const e = error.toLowerCase();
	const denied = e.includes('denied') || e.includes('permission') || e.includes('privilege') || e.includes('access');
	const missing = e.includes("doesn't exist") || e.includes('does not exist') || e.includes('not found') || e.includes('unknown table');
	if (flavour === 'MySQL' || flavour === 'MariaDB') {
		if (denied) {
			return "This needs SELECT on performance_schema. Ask a DBA to grant it (e.g. GRANT SELECT ON performance_schema.* TO your_user), then collect again.";
		}
		if (missing) {
			return "performance_schema appears to be disabled on this server. Enable it (performance_schema=ON) to see the workload.";
		}
	}
	if (flavour === 'PostgreSQL' && (missing || e.includes('pg_stat_statements'))) {
		return "This needs the pg_stat_statements extension. Run CREATE EXTENSION pg_stat_statements (and add it to shared_preload_libraries + restart), then collect again.";
	}
	if (denied) {
		return "Reading this database's query statistics needs extra privileges (e.g. VIEW SERVER STATE on SQL Server, SELECT ANY DICTIONARY on Oracle, or MONITOR on Snowflake). Grant access, then collect again.";
	}
	return null;
}

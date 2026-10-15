/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { DataGrid, cellText, computeColumnWidths, type SortState } from './DataGrid';
import { useConfirm } from './ConfirmDialog';
import { CellValueEditor } from './CellValueEditor';
import { errorMessage } from '../errors';
import type { ConnectionConfig } from '../../../shared/connection';
import type { QueryResult } from '../../../shared/query';
import { dialectFor, type ReplicaScope } from '../../../shared/engine';
import { assessHealth, healthSql, keeperChild, keeperTrail, namedRows, num, OPS_GROUPS, opsSql, opsView, unavailableMessage, viewsIn, type HealthInput, type HealthItem, type OpsViewId } from '../../../shared/clickhouseOps';
import { clickhouseStarterMonitor } from '../../../shared/clickhouseMonitor';

// ClickHouse Operations: the server's own system tables, read the way someone running ClickHouse
// reads them when a thing is slow or stuck. The health cards say what needs attention and open the
// view with the rows behind it.
//
// Reads go through `sqlApi.explain`, the path that runs a statement WITHOUT putting it in query
// history: a panel that refreshes every few seconds would otherwise bury the user's own queries.
// The two writes (stop a query, cancel a mutation) are confirmed first and DO go through the normal
// path, so they are in history and behind the read-only-connection guard like any other statement.

const REFRESH_MS = 5000;

interface ClickHouseOpsViewProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	connectionId?: string;
	/** Open the monitors view on this monitor, once it has been saved. This panel is the NOW
	 *  view; a monitor is the same system tables kept over wall-clock time, which is the only way
	 *  to answer "when did this start". */
	onOpenMonitor?(monitorId: string): void;
}

async function read(connectionId: string, sql: string): Promise<QueryResult> {
	const res = await window.sqlApi.explain({ connectionId, sql: opsSql(sql) });
	if (!res.ok) {
		throw new Error(res.error);
	}
	return res.result;
}

/** Which replicas the panel reads: all of them on ClickHouse Cloud or a replicated cluster, where
 *  each request lands on any one and system tables are per node. */
function readScope(connectionId: string): Promise<ReplicaScope> {
	const probe = dialectFor('clickhouse').replicaScope;
	return probe
		? probe(async (sql) => {
			const result = await read(connectionId, sql);
			return namedRows(result.fields, result.rows);
		})
		: Promise.resolve({ replicas: 1, settings: '' });
}

/** Run the health queries side by side; one this user may not read leaves its check unknown. */
async function readHealth(connectionId: string, scope: ReplicaScope | undefined): Promise<HealthItem[]> {
	const HEALTH_SQL = healthSql(scope);
	const [running, parts, limits, mutations, replication, failed, disk, detached, dictionaries, refreshes] = await Promise.allSettled([
		read(connectionId, HEALTH_SQL.running),
		read(connectionId, HEALTH_SQL.parts),
		read(connectionId, HEALTH_SQL.limits),
		read(connectionId, HEALTH_SQL.mutations),
		read(connectionId, HEALTH_SQL.replication),
		read(connectionId, HEALTH_SQL.failed),
		read(connectionId, HEALTH_SQL.disk),
		read(connectionId, HEALTH_SQL.detached),
		read(connectionId, HEALTH_SQL.dictionaries),
		read(connectionId, HEALTH_SQL.refreshes),
	]);
	const first = (r: PromiseSettledResult<QueryResult>): Record<string, unknown> | undefined =>
		r.status === 'fulfilled' ? namedRows(r.value.fields, r.value.rows)[0] : undefined;
	const input: HealthInput = {};
	const run = first(running);
	if (run) {
		input.running = { n: num(run.n), longest: num(run.longest) };
	}
	if (parts.status === 'fulfilled') {
		const worst = first(parts);
		input.worstPartition = worst ? { database: String(worst.database), table: String(worst.table), parts: num(worst.parts) } : null;
	}
	if (limits.status === 'fulfilled') {
		for (const row of namedRows(limits.value.fields, limits.value.rows)) {
			if (row.name === 'parts_to_delay_insert') {
				input.delayAt = num(row.value);
			} else if (row.name === 'parts_to_throw_insert') {
				input.throwAt = num(row.value);
			}
		}
	}
	const mut = first(mutations);
	if (mut) {
		input.mutations = { pending: num(mut.pending), failing: num(mut.failing) };
	}
	const rep = first(replication);
	if (rep) {
		input.replication = { tables: num(rep.tables), readonly: num(rep.readonly), delay: num(rep.delay) };
	}
	const fail = first(failed);
	if (fail) {
		input.failed = { n: num(fail.n), kinds: num(fail.kinds) };
	}
	if (disk.status === 'fulfilled') {
		const worst = first(disk);
		input.disk = worst ? { name: String(worst.name), usedPercent: num(worst.used_percent), free: num(worst.free_space) } : null;
	}
	const det = first(detached);
	if (det) {
		input.detached = num(det.n);
	}
	const dict = first(dictionaries);
	if (dict) {
		input.dictionaries = { total: num(dict.total), failing: num(dict.failing) };
	}
	const refresh = first(refreshes);
	if (refresh) {
		input.refreshes = { total: num(refresh.total), failing: num(refresh.failing) };
	}
	return assessHealth(input);
}

function compareCells(a: unknown, b: unknown): number {
	const na = typeof a === 'number' ? a : Number(a);
	const nb = typeof b === 'number' ? b : Number(b);
	if (a !== '' && b !== '' && a !== null && b !== null && Number.isFinite(na) && Number.isFinite(nb)) {
		return na - nb;
	}
	return String(a ?? '').localeCompare(String(b ?? ''));
}

export function ClickHouseOpsView({ connections, connectedIds, connectionId, onOpenMonitor }: ClickHouseOpsViewProps): JSX.Element {
	const [viewId, setViewId] = useState<OpsViewId>('running');
	const [data, setData] = useState<QueryResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [health, setHealth] = useState<HealthItem[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [auto, setAuto] = useState(true);
	const [sort, setSort] = useState<SortState | null>(null);
	const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
	const [seq, setSeq] = useState(0);
	const [confirm, confirmDialog] = useConfirm();
	// A long cell (an exception, a query, a view's SELECT) read in full, from the grid's "View value".
	const [viewCell, setViewCell] = useState<{ value: string | null; columnName: string } | null>(null);
	// True while a refresh is out. The timer skips a tick rather than abandon a slow refresh, or a
	// server that takes longer than the interval to answer would never be shown at all.
	const loadingRef = useRef(false);
	// What a FILTERABLE view is narrowed to (the server log), or ''.
	const [filter, setFilter] = useState('');
	// Where a BROWSING view is (Keeper). Kept here rather than in the view because it is a place in
	// the tree the person walked to, not a property of the view.
	const [path, setPath] = useState('/');
	// Read once per connection, before anything else: every read after it depends on it.
	const [scope, setScope] = useState<{ connectionId: string; scope: ReplicaScope } | null>(null);

	const conn = connectionId ? connections.find((c) => c.id === connectionId) : undefined;
	const isClickHouse = conn?.driver === 'clickhouse';
	const connected = Boolean(connectionId && connectedIds.includes(connectionId));
	const view = opsView(viewId);
	const currentScope = scope && scope.connectionId === connectionId ? scope.scope : undefined;

	useEffect(() => {
		if (!connectionId || !isClickHouse || !connected || scope?.connectionId === connectionId) {
			return;
		}
		let alive = true;
		const cid = connectionId;
		void readScope(cid).then((found) => {
			if (alive) {
				setScope({ connectionId: cid, scope: found });
			}
		});
		return () => {
			alive = false;
		};
	}, [connectionId, isClickHouse, connected]);

	// One refresh: the health cards and the open view, together, so they never disagree.
	useEffect(() => {
		if (!connectionId || !isClickHouse || !connected || !currentScope) {
			return;
		}
		let alive = true;
		loadingRef.current = true;
		setLoading(true);
		const cid = connectionId;
		void Promise.all([
			readHealth(cid, currentScope).catch(() => null),
			read(cid, view.browse ? view.browse.sql(path)
				: view.filter && filter.trim() ? view.filter.sql(filter.trim(), currentScope)
				: view.sql(currentScope)).then((result) => ({ result, error: null as string | null })).catch((err: unknown) => ({ result: null, error: errorMessage(err) })),
		]).then(([items, rows]) => {
			loadingRef.current = false;
			if (!alive) {
				return;
			}
			setHealth(items);
			setData(rows.result);
			setError(rows.error);
			setRefreshedAt(new Date());
			setLoading(false);
		});
		return () => {
			alive = false;
		};
	}, [connectionId, isClickHouse, connected, viewId, seq, currentScope, path, filter]);

	useEffect(() => {
		if (!auto || !connected || !isClickHouse) {
			return;
		}
		const timer = setInterval(() => {
			if (!loadingRef.current) {
				setSeq((n) => n + 1);
			}
		}, REFRESH_MS);
		return () => clearInterval(timer);
	}, [auto, connected, isClickHouse]);

	/**
	 * Make (or find) the starter monitor for this connection and open it.
	 *
	 * Idempotent by NAME rather than by a marker on the monitor: a second click on a button that
	 * says "monitor over time" means "show me that", not "make me another one", and a monitor the
	 * user has since renamed is a monitor they have made their own, so a fresh one is right.
	 * The replica scope is baked into the SQL here because it is known here: the poller runs the
	 * string it is given and has no idea what a replica is.
	 */
	async function openStarterMonitor(): Promise<void> {
		if (!connectionId || !conn) {
			return;
		}
		const monitor = clickhouseStarterMonitor(connectionId, conn.label, () => crypto.randomUUID(), currentScope);
		const existing = (await window.sqlApi.monitors.list()).find((d) => d.name === monitor.name);
		if (existing) {
			onOpenMonitor?.(existing.id);
			return;
		}
		await window.sqlApi.monitors.save(monitor);
		onOpenMonitor?.(monitor.id);
	}

	function openView(id: OpsViewId, narrowTo = ''): void {
		if (id !== viewId || narrowTo !== filter) {
			setViewId(id);
			setData(null);
			setError(null);
			setSort(null);
			setPath(opsView(id).browse?.root ?? '/');
			setFilter(narrowTo);
		}
	}

	/** Follow a row to another view, narrowed by one of its columns: the log for THIS query. */
	function jump(rowIndex: number): void {
		const target = view.jump;
		if (!target || !data) {
			return;
		}
		const row = namedRows(data.fields, [data.rows[order[rowIndex]]])[0];
		openView(target.view, String(row[target.column] ?? ''));
	}

	/**
	 * Walk into a node.
	 *
	 * A LEAF has nothing to walk into, and its value is the thing worth seeing, so Open shows that
	 * instead of navigating to an empty listing. Keeper's leaves are where the answers are: a
	 * replica's `log_pointer` is a leaf, and it is the number that says how far behind it is.
	 */
	function descend(rowIndex: number): void {
		const browse = view.browse;
		if (!browse || !data) {
			return;
		}
		const row = namedRows(data.fields, [data.rows[order[rowIndex]]])[0];
		const name = String(row[browse.nameColumn] ?? '');
		if (num(row[browse.childrenColumn]) === 0) {
			setViewCell({ value: String(row.value ?? ''), columnName: name });
			return;
		}
		setData(null);
		setSort(null);
		setPath(keeperChild(path, name));
	}

	const fields = data?.fields ?? [];
	const rows = data?.rows ?? [];
	const widths = useMemo(() => computeColumnWidths(fields, rows.length, (i) => rows[i]), [data]);
	const order = useMemo(() => {
		const idx = rows.map((_, i) => i);
		if (sort && sort.col < fields.length) {
			const sign = sort.dir === 'asc' ? 1 : -1;
			idx.sort((a, b) => sign * compareCells(rows[a][sort.col], rows[b][sort.col]));
		}
		return idx;
	}, [data, sort]);

	async function runAction(rowIndex: number): Promise<void> {
		const action = view.action;
		if (!action || !connectionId || !data) {
			return;
		}
		const row = namedRows(data.fields, [data.rows[order[rowIndex]]])[0];
		if (!(await confirm({ title: `${action.label}?`, body: action.confirm(row), confirmLabel: action.label, danger: true }))) {
			return;
		}
		let res = await window.sqlApi.execute({ connectionId, sql: action.sql(row, currentScope) });
		if (!res.ok && currentScope?.cluster && action.local && /Keeper|ZooKeeper|NO_ELEMENTS_IN_CONFIG|distributed_ddl/i.test(res.error)) {
			// ON CLUSTER needs Keeper; a cluster without replication has none, so act where we landed.
			res = await window.sqlApi.execute({ connectionId, sql: action.local(row) });
		}
		if (!res.ok) {
			setError(res.error);
			return;
		}
		setSeq((n) => n + 1);
	}

	if (!connectionId || !conn) {
		return <div className="table-view"><div className="results-message">Select a ClickHouse connection in the sidebar.</div></div>;
	}
	if (!isClickHouse) {
		return <div className="table-view"><div className="results-message">Operations reads ClickHouse's own system tables. "{conn.label}" is not a ClickHouse connection.</div></div>;
	}

	return (
		<>
		<div className="table-view ch-ops">
			<div className="tv-head">
				<Icon name="server-process" className="tv-head-icon" />
				<span className="tv-title">ClickHouse Operations</span>
				<span className="muted">{conn.label}</span>
				<span className="spacer" />
				{currentScope && currentScope.replicas > 1 && (
					<span className={`ch-ops-scope muted small${currentScope.cluster ? '' : ' ch-ops-scope-warn'}`} title={currentScope.limitation ?? `Every view reads each replica with clusterAllReplicas('${currentScope.cluster}', ...), and Stop acts ON CLUSTER.`}>
						<Icon name={currentScope.cluster ? 'server-environment' : 'warning'} /> {currentScope.cluster ? `All ${currentScope.replicas} replicas` : `1 of ${currentScope.replicas} replicas`}
					</span>
				)}
				{refreshedAt && <span className="muted small">Updated {refreshedAt.toLocaleTimeString()}</span>}
				<button
					type="button"
					className={`ch-ops-auto${auto ? ' active' : ''}`}
					aria-pressed={auto}
					title={auto ? `Refreshing every ${REFRESH_MS / 1000} s. Click to pause.` : 'Paused. Click to refresh every few seconds.'}
					onClick={() => setAuto((on) => !on)}
				>
					<Icon name={auto ? 'sync' : 'debug-pause'} /> {auto ? 'Live' : 'Paused'}
				</button>
				{onOpenMonitor && (
					<button
						type="button"
						className="tv-collect"
						disabled={!connected}
						title="Make a monitor of these numbers, sampled every minute and kept for a day. This panel says what the server is doing now; a monitor says when it started."
						onClick={() => void openStarterMonitor()}
					>
						<Icon name="graph" /> Monitor over time
					</button>
				)}
				<button type="button" className="tv-collect" disabled={!connected || loading} onClick={() => setSeq((n) => n + 1)}>
					<Icon name="refresh" /> Refresh
				</button>
			</div>

			{!connected ? (
				<div className="results-message">Connect "{conn.label}" in the sidebar to see what it is doing.</div>
			) : (
				<>
					<div className="ch-ops-health">
						{(health ?? []).map((item) => (
							<button
								type="button"
								key={item.view}
								className={`ch-ops-card ${item.level}${item.view === viewId ? ' selected' : ''}`}
								onClick={() => openView(item.view)}
							>
								<span className="ch-ops-card-title"><span className="ch-ops-dot" />{item.title}</span>
								<span className="ch-ops-card-detail">{item.detail}</span>
							</button>
						))}
					</div>

					<div className="tabs tv-tabs" role="tablist" aria-label="Area">
						{OPS_GROUPS.map((group) => (
							<button key={group} type="button" role="tab" aria-selected={group === view.group} className={`tab${group === view.group ? ' active' : ''}`} onClick={() => openView(viewsIn(group)[0].id)}>{group}</button>
						))}
					</div>
					<div className="ch-ops-views" role="tablist" aria-label="View">
						{viewsIn(view.group).map((v) => (
							<button key={v.id} type="button" role="tab" aria-selected={v.id === viewId} className={`ch-ops-view${v.id === viewId ? ' active' : ''}`} onClick={() => openView(v.id)}>{v.label}</button>
						))}
					</div>
					<div className="ch-ops-blurb muted">{view.blurb}</div>
					{view.filter && (
						<div className="ch-ops-filter">
							<Icon name="search" />
							<input
								// Not type="search": Chromium draws its own clear button inside one, and the
								// strip already has the app's, so a search box shows two of them.
								type="text"
								aria-label={view.filter.label}
								placeholder={view.filter.placeholder}
								value={filter}
								onChange={(e) => { setData(null); setFilter(e.target.value); }}
							/>
							{filter && <button type="button" className="icon-btn" aria-label="Clear" onClick={() => { setData(null); setFilter(''); }}><Icon name="close" /></button>}
						</div>
					)}
					{view.browse && (
						<div className="ch-ops-crumbs" aria-label="Keeper path">
							{keeperTrail(path).map((crumb, i) => (
								<button
									key={crumb.path}
									type="button"
									className={`ch-ops-crumb${crumb.path === path ? ' active' : ''}`}
									disabled={crumb.path === path}
									onClick={() => { setData(null); setSort(null); setPath(crumb.path); }}
								>{i === 0 ? <Icon name="home" /> : crumb.name}</button>
							))}
						</div>
					)}
					{currentScope?.limitation && <div className="ch-ops-blurb ch-ops-scope-warn">{currentScope.limitation}</div>}

					<div className="qp-grid">
						{error && unavailableMessage(view, error)
							? <div className="results-message">{unavailableMessage(view, error)}</div>
							: error
							? <div className="qp-error"><div className="results-error">{error}</div></div>
							: !data
								? <div className="results-message">Reading {view.label.toLowerCase()}…</div>
								: rows.length === 0
									? <div className="results-message">{view.browse ? `Nothing is under ${path}.` : view.filter && filter.trim() ? `Nothing in the last day matches "${filter.trim()}".` : view.empty}</div>
									: (
										<DataGrid
											fields={fields}
											rowCount={order.length}
											getRow={(i) => rows[order[i]]}
											widths={widths}
											sort={sort}
											onSortColumn={(col) => setSort((prev) => (!prev || prev.col !== col ? { col, dir: 'desc' } : prev.dir === 'desc' ? { col, dir: 'asc' } : null))}
											resetKey={`${connectionId}:${viewId}`}
											onCopyCell={(i, col) => void navigator.clipboard.writeText(cellText(rows[order[i]][col]) ?? '')}
											onCopyRow={(i) => void navigator.clipboard.writeText(fields.map((_f, col) => cellText(rows[order[i]][col]) ?? '').join('\t'))}
											onViewCell={(i, col) => setViewCell({ value: cellText(rows[order[i]][col]), columnName: fields[col]?.name ?? '' })}
											rowActions={view.browse
												? [{ icon: 'folder-opened', title: 'Open', onClick: (i) => descend(i) }]
												: view.jump
													? [{ icon: view.jump.icon, title: view.jump.label, onClick: (i) => jump(i) }]
													: view.action ? [{ icon: view.action.icon, title: view.action.label, onClick: (i) => void runAction(i) }] : undefined}
											rowActionsLabel={view.browse ? 'Open' : view.jump?.label ?? view.action?.label}
										/>
									)}
						<div className="results-footer">
							<span>{data && rows.length > 0 ? `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}` : ''}</span>
							<span className="spacer" />
						</div>
					</div>
				</>
			)}
		</div>
		{confirmDialog}
		{viewCell && (
			<CellValueEditor
				columnName={viewCell.columnName}
				value={viewCell.value}
				readOnly
				onCommit={() => {}}
				onClose={() => setViewCell(null)}
			/>
		)}
		</>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { formatBytes } from '../formatBytes';
import { Icon } from './Icon';
import { ConnectionMarks, ConnectionTags } from './ConnectionMarks';
import { ConnectArt } from '../art/Illustrations';
import type { ConnectionConfig } from '../../../shared/connection';
import type { ConnectionsState } from '../../../shared/forms';
import type { ColumnInfo, DatabaseSchema, ObjectLineage, RoutineInfo, SchemaRef, TableInfo } from '../../../shared/schema';
import { listedInSchema, partitionRows, partitionsByParent, seriesKindLabel } from '../seriesTree';
import type { ObjectDetail } from './ObjectView';
import { withoutPlatformSchemas } from '../../../shared/cloudPlatform';
import { backendKindForDriver, profileFor, securitySupport } from '../../../shared/engine';

interface SidebarProps {
	state: ConnectionsState;
	activeId: string | undefined;
	onCollapse(): void;
	onAdd(): void;
	onImport(): void;
	onEdit(config: ConnectionConfig): void;
	onDelete(config: ConnectionConfig): void;
	/** Connect (or no-op if already). Resolves true once connected, false if it failed. */
	onConnect(id: string): Promise<boolean>;
	/** Give up on a slow connect that's still in flight (best-effort abort in main). */
	onCancelConnect(id: string): void;
	/** The connection ids currently establishing (any path: sidebar click, run-triggered
	 *  auto-connect, launch reconnect), so each row shows the spinner + Cancel. Driven by App so
	 *  all paths are covered and several can connect at once. */
	connectingIds: ReadonlySet<string>;
	onDisconnect(id: string): void;
	onSelectActive(id: string): void;
	/** Double-click a table (or click the pulse icon for `tab: 'telemetry'`) opens a
	 *  dedicated table view; the caller routes to the right inner tab. */
	onOpenTable(connectionId: string, table: TableInfo, opts?: { tab?: 'data' | 'properties' | 'telemetry' }): void;
	/** Create a new table in a connection's database (opens the designer). */
	onNewTable(connectionId: string, database: string): void;
	/** Create a new collection in a document (MongoDB) connection's database (name prompt). */
	onNewCollection(connectionId: string, database: string): void;
	/** Open the Users & Privileges tab for a connection. */
	onOpenSecurity(connectionId: string): void;
	/** Open Remote data (the table functions) for a ClickHouse connection. */
	onOpenClickHouseRemote(connectionId: string): void;
	/** Open ClickHouse Operations for a ClickHouse connection. */
	onOpenClickHouseOps(connectionId: string): void;
	/** Open (making it the first time) a monitor over a SnoutTime series' rollups. */
	onOpenSeriesMonitor(connectionId: string, table: TableInfo): void;
	/** Double-click a procedure/function/trigger opens a read-only detail view of its DDL. */
	onOpenObject(detail: ObjectDetail): void;
}


/** Group a connection's tables by their owning schema/database (as the tree shows). Dictionaries
 *  are left out: they are not tables, and they get their own folder under the database the way
 *  procedures do, so "which dictionaries are here" is one row to open rather than a scan of every
 *  table in the list. */
function groupByDatabase(schema: DatabaseSchema): Map<string, TableInfo[]> {
	const byDatabase = new Map<string, TableInfo[]>();
	// Seeded first, so a schema that exists but holds nothing still gets a row. Without this the
	// tree is built purely by grouping tables, and an empty database shows no schemas at all --
	// no `public`, and so nowhere to create the first table.
	for (const name of schema.emptySchemas ?? []) {
		byDatabase.set(name, []);
	}
	for (const table of schema.tables) {
		const db = table.schema ?? schema.database;
		const list = byDatabase.get(db) ?? [];
		// A partition is folded under its parent (seriesTree.ts), which gets a Partitions folder.
		if (table.kind !== 'dictionary' && listedInSchema(table, schema)) {
			list.push(table);
		}
		byDatabase.set(db, list);
	}
	return new Map([...byDatabase.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Dictionaries grouped by their owning database, for the folder beside Procedures. */
function dictionariesByDatabase(schema: DatabaseSchema): Map<string, TableInfo[]> {
	const out = new Map<string, TableInfo[]>();
	for (const table of schema.tables) {
		if (table.kind !== 'dictionary') {
			continue;
		}
		const db = table.schema ?? schema.database;
		const list = out.get(db) ?? [];
		list.push(table);
		out.set(db, list);
	}
	return out;
}

/** Every object in the schema by `schema.name`, so a lineage row can open the table it names. */
function tablesByRef(schema: DatabaseSchema): Map<string, TableInfo> {
	const out = new Map<string, TableInfo>();
	for (const table of schema.tables) {
		out.set(`${table.schema ?? schema.database}.${table.name}`, table);
	}
	return out;
}

/** Routines grouped by their owning schema so each database row shows only its own. */
function routinesByDatabase(schema: DatabaseSchema): Map<string, RoutineInfo[]> {
	const out = new Map<string, RoutineInfo[]>();
	for (const r of schema.routines ?? []) {
		const list = out.get(r.schema) ?? [];
		list.push(r);
		out.set(r.schema, list);
	}
	return out;
}

export function Sidebar(props: SidebarProps): JSX.Element {
	const { state, activeId } = props;
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [schemas, setSchemas] = useState<Record<string, DatabaseSchema | null>>({});
	const [filter, setFilter] = useState('');
	// The connections currently being established (tunnelled ones can take a while), so each row
	// shows a spinner + Cancel in place of its action icons. Driven by App (props.connectingIds) so
	// EVERY connect path lights it up: a sidebar click, a run-triggered auto-connect, launch reconnect.
	const connectingIds = props.connectingIds;
	// The connection currently re-introspecting, so its refresh icon spins.
	const [refreshingId, setRefreshingId] = useState<string | null>(null);
	const query = filter.trim().toLowerCase();

	// Re-introspect a connection and reload its cached schema (manual refresh button).
	async function refresh(id: string): Promise<void> {
		setRefreshingId(id);
		try {
			await window.sqlApi.refresh(id);
			const schema = await window.sqlApi.getSchema(id);
			setSchemas((prev) => ({ ...prev, [id]: schema }));
		} finally {
			setRefreshingId(null);
		}
	}

	// Connect; the in-flight spinner is driven by props.connectingIds (set in App's connect()).
	function connect(id: string): Promise<boolean> {
		return props.onConnect(id);
	}

	// Drop cached schema + collapse anything no longer connected.
	useEffect(() => {
		const live = new Set(state.connectedIds);
		setSchemas((prev) => {
			const next: Record<string, DatabaseSchema | null> = {};
			for (const [id, schema] of Object.entries(prev)) {
				if (live.has(id)) {
					next[id] = schema;
				}
			}
			return next;
		});
		setExpanded((prev) => {
			const next = new Set<string>();
			for (const key of prev) {
				const connId = key.split(':')[1];
				if (!key.startsWith('conn:') || live.has(connId)) {
					next.add(key);
				}
			}
			return next;
		});
	}, [state.connectedIds]);

	// Live schema index: re-fetch a connection's schema when the server reports a
	// structural change (only if we've already loaded it, i.e. it's been expanded).
	useEffect(() => {
		return window.sqlApi.onSchemaChanged(async (connectionId) => {
			const schema = await window.sqlApi.getSchema(connectionId);
			setSchemas((prev) => (connectionId in prev ? { ...prev, [connectionId]: schema } : prev));
		});
	}, []);

	function toggle(key: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}

	async function toggleConnection(id: string): Promise<void> {
		const key = `conn:${id}`;
		// Clicking the twisty on a disconnected connection connects it first, then
		// expands. Bail if the connection attempt failed.
		if (!state.connectedIds.includes(id)) {
			if (!(await connect(id))) {
				return;
			}
			if (!expanded.has(key)) {
				toggle(key);
			}
			if (schemas[id] === undefined) {
				const schema = await window.sqlApi.getSchema(id);
				setSchemas((prev) => ({ ...prev, [id]: schema }));
			}
			return;
		}
		const willExpand = !expanded.has(key);
		toggle(key);
		if (willExpand && schemas[id] === undefined) {
			const schema = await window.sqlApi.getSchema(id);
			setSchemas((prev) => ({ ...prev, [id]: schema }));
		}
	}

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<span>CONNECTIONS</span>
				<span className="spacer" />
				<button className="icon-btn" aria-label="Add connection" onClick={props.onAdd} data-tour="add-connection"><Icon name="add" /></button>
				<button className="icon-btn" aria-label="Import connections from DBeaver, DataGrip, pgAdmin and other tools" onClick={props.onImport} data-tour="import-connections"><Icon name="desktop-download" /></button>
				<button className="icon-btn" aria-label="Collapse" onClick={props.onCollapse}><Icon name="chevron-left" /></button>
			</div>
			{state.connections.length > 0 && (
				<div className="tree-filter">
					<Icon name="search" className="filter-icon" />
					<input
						className="filter-input"
						type="text"
						placeholder="Filter tables…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
					{filter && (
						<button className="icon-btn" aria-label="Clear filter" onClick={() => setFilter('')}><Icon name="close" /></button>
					)}
				</div>
			)}
			<div className="tree">
				{state.connections.length === 0 && (
					<div className="tree-empty">
						<ConnectArt className="tree-empty-art" />
						<p>No connections yet. Add one to browse its tables and query it.</p>
						<button type="button" className="ws-empty-cta" onClick={props.onAdd}><Icon name="add" /> Add connection</button>
					</div>
				)}
				{state.connections.map((config) => {
					const connected = state.connectedIds.includes(config.id);
					const isProd = config.environment === 'prod';
					const open = expanded.has(`conn:${config.id}`);
					// A hosted database hides what the platform put there (shared/cloudPlatform.ts).
					const cached = schemas[config.id];
					const schema = cached && (config.cloudProjectRef || config.localProjectId) ? withoutPlatformSchemas(cached) : cached;
					return (
						<div key={config.id}>
							<div
								className={`tree-row depth-0${activeId === config.id ? ' active' : ''}`}
								onClick={() => props.onSelectActive(config.id)}
							>
								<span
									className="twisty"
									onClick={(e) => { e.stopPropagation(); void toggleConnection(config.id); }}
								>
									<Icon name={open ? 'chevron-down' : 'chevron-right'} />
								</span>
								<ConnectionMarks config={config} connected={connected} />
								<span className={`tree-label${isProd ? ' prod' : ''}`}>{config.label}</span>
								<ConnectionTags config={config} />
								<span className={`row-actions${connectingIds.has(config.id) ? ' busy' : ''}`} onClick={(e) => e.stopPropagation()}>
									{connectingIds.has(config.id)
										? <span className="connect-inflight"><span className="icon-btn connecting" aria-label="Connecting…"><Icon name="loading" className="codicon-modifier-spin" /></span><button className="icon-btn cancel-connect" aria-label="Cancel connecting" onClick={() => props.onCancelConnect(config.id)}><Icon name="stop-circle" /></button></span>
										: <>
											{connected
												? <>
													<button className="icon-btn" aria-label="Refresh tables" disabled={refreshingId === config.id} onClick={() => void refresh(config.id)}><Icon name="refresh" className={refreshingId === config.id ? 'codicon-modifier-spin' : undefined} /></button>
													<button className="icon-btn" aria-label="Disconnect" onClick={() => props.onDisconnect(config.id)}><Icon name="debug-disconnect" /></button>
												</>
												: <button className="icon-btn" aria-label="Connect" onClick={() => void connect(config.id)}><Icon name="plug" /></button>}
											<button className="icon-btn" aria-label="Edit" onClick={() => props.onEdit(config)}><Icon name="edit" /></button>
											<button className="icon-btn" aria-label="Delete" onClick={() => props.onDelete(config)}><Icon name="trash" /></button>
										</>}
								</span>
							</div>

							{/* Security sits above the databases, the way a connection's own properties do: it is
							    about the SERVER, not about one database's tables. Hidden while filtering (it is
							    not a table and would survive every search), and hidden entirely on an engine
							    with no accounts — a permanent row that only ever says "SQLite has no users" is
							    clutter, where "Snowflake has users we do not read yet" is worth finding out. */}
							{connected && open && !query && securitySupport(config.driver).hasAccounts && (
								<div className="tree-row depth-1" onClick={() => props.onOpenSecurity(config.id)}>
									<span className="twisty" />
									<span className="tree-icon"><Icon name="shield" /></span>
									<span className="tree-label">Users &amp; Privileges</span>
								</div>
							)}
							{/* The server's own health, beside Users & Privileges and for the same reason: it is
							    about the SERVER. ClickHouse only, since it reads ClickHouse's system tables. */}
							{connected && open && !query && config.driver === 'clickhouse' && (
								<div className="tree-row depth-1" onClick={() => props.onOpenClickHouseOps(config.id)}>
									<span className="twisty" />
									<span className="tree-icon"><Icon name="server-process" /></span>
									<span className="tree-label">Operations</span>
								</div>
							)}
							{/* The data that is NOT in this database: a file in a bucket, a page, another
							    server. It sits with the other two because it is about the CONNECTION and
							    not about one of its databases. */}
							{connected && open && !query && config.driver === 'clickhouse' && (
								<div className="tree-row depth-1" onClick={() => props.onOpenClickHouseRemote(config.id)}>
									<span className="twisty" />
									<span className="tree-icon"><Icon name="globe" /></span>
									<span className="tree-label">Remote data</span>
								</div>
							)}
							{connected && open && schema === undefined && <div className="tree-row depth-1 muted">Loading…</div>}
							{connected && open && schema === null && <div className="tree-row depth-1 muted">No schema cached.</div>}
							{connected && open && schema && query && !schema.tables.some((t) => t.name.toLowerCase().includes(query)) && (
								<div className="tree-row depth-1 muted">No tables match “{filter.trim()}”.</div>
							)}
							{connected && open && schema && (() => {
								const byDb = groupByDatabase(schema);
								const routinesBy = routinesByDatabase(schema);
								const dictionariesBy = dictionariesByDatabase(schema);
								const byRef = tablesByRef(schema);
								const partitionsOf = partitionsByParent(schema);
								const childrenOf = (t: TableInfo): TableInfo[] => partitionsOf.get(`${t.schema ?? ''}.${t.name}`) ?? [];
								return [...byDb.entries()].map(([database, allTables]) => {
									// a search for a partition's name finds the table it is folded under
									const tables = query
										? allTables.filter((t) => t.name.toLowerCase().includes(query) || childrenOf(t).some((c) => c.name.toLowerCase().includes(query)))
										: allTables;
									const allDictionaries = dictionariesBy.get(database) ?? [];
									const dictionaries = query ? allDictionaries.filter((d) => d.name.toLowerCase().includes(query)) : allDictionaries;
									if (query && tables.length === 0 && dictionaries.length === 0) {
										return null;
									}
									const dbKey = `db:${config.id}:${database}`;
									const dbOpen = expanded.has(dbKey) || query !== '';
									const routines = routinesBy.get(database) ?? [];
									const newEntityLabel = profileFor(backendKindForDriver(config.driver)).newEntityLabel;
									return (
										<div key={dbKey}>
											<div className="tree-row depth-1" onClick={() => toggle(dbKey)}>
												<span className="twisty"><Icon name={dbOpen ? 'chevron-down' : 'chevron-right'} /></span>
												<span className="tree-icon"><Icon name="database" /></span>
												<span className="tree-label">{database}</span>
												<span className="muted count">{query ? `${tables.length}/${allTables.length}` : allTables.length}</span>
												<span className="row-actions" onClick={(e) => e.stopPropagation()}>
													{/* What can be created here is the BACKEND's answer, not this file's: a log
													    service's scopes belong to the provider and a read-only connection may not
													    write, so in both cases there is no "+" rather than one that leads nowhere. */}
													{newEntityLabel && !config.readOnly && (backendKindForDriver(config.driver) === 'document'
														? <button className="icon-btn" aria-label={newEntityLabel} onClick={() => props.onNewCollection(config.id, database)}><Icon name="add" /></button>
														: <button className="icon-btn" aria-label={newEntityLabel} onClick={() => props.onNewTable(config.id, database)}><Icon name="add" /></button>)}
												</span>
											</div>
											{dbOpen && tables.map((table) => renderTable(config.id, database, table, expanded, toggle, props.onOpenTable, props.onOpenObject, byRef, childrenOf(table), props.onOpenSeriesMonitor))}
											{dbOpen && dictionaries.length > 0 && renderDictionaries(config.id, database, dictionaries, expanded, toggle, props.onOpenTable)}
											{dbOpen && routines.length > 0 && renderRoutines(config.id, database, routines, expanded, toggle, props.onOpenObject)}
										</div>
									);
								});
							})()}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** Render one table row at depth-2 plus its child folders (Columns / Constraints / …)
 *  at depth-3 with leaves at depth-4. Folders are only shown when they have content.
 *  A right-side pulse icon (when catalog stats are present) opens the Telemetry tab —
 *  the tooltip surfaces the quick numbers, the click opens the full monitor. */
function renderTable(
	connectionId: string,
	database: string,
	table: TableInfo,
	expanded: Set<string>,
	toggle: (key: string) => void,
	onOpenTable: (connectionId: string, table: TableInfo, opts?: { tab?: 'data' | 'properties' | 'telemetry' }) => void,
	onOpenObject: (detail: ObjectDetail) => void,
	byRef: Map<string, TableInfo>,
	children: TableInfo[] = [],
	onOpenSeriesMonitor?: (connectionId: string, table: TableInfo) => void,
): JSX.Element {
	const baseKey = `table:${connectionId}:${database}:${table.name}`;
	const partitions = partitionRows(table, children);
	const kindLabel = seriesKindLabel(table, partitions.length > 0);
	const rollups = table.series?.rollups ?? [];
	const tableOpen = expanded.has(baseKey);
	const stats = table.stats;
	const hasStats = !!stats && (stats.rowCount !== undefined || stats.dataBytes !== undefined);
	const cons = table.primaryKey.length > 0;
	const fks = table.foreignKeys.length > 0;
	const idx = (table.indexes?.length ?? 0) > 0;
	const trg = (table.triggers?.length ?? 0) > 0;
	const statsTitle = hasStats
		? `Open telemetry: ∼${(stats!.rowCount ?? 0).toLocaleString()} rows · ${formatBytes(stats!.dataBytes)} data · ${formatBytes(stats!.indexBytes)} idx`
		: 'Open telemetry';
	return (
		<div key={baseKey}>
			<div
				className="tree-row depth-2"
				onClick={() => toggle(baseKey)}
				onDoubleClick={() => onOpenTable(connectionId, table)}
				title="Double-click to open"
			>
				<span className="twisty"><Icon name={tableOpen ? 'chevron-down' : 'chevron-right'} /></span>
				<span className="tree-icon"><Icon name={tableKindIcon(table.kind)} /></span>
				<span className="tree-label">{table.name}</span>
				{kindLabel
					? <span className="muted">{kindLabel}</span>
					: table.kind === 'view' && <span className="muted">{viewKindLabel(table)}</span>}
				{table.kind === 'collection' && <span className="muted">collection</span>}
				{table.kind === 'logGroup' && <span className="muted">log</span>}
				{hasStats && (
					<button
						type="button"
						className="icon-btn table-stats-btn"
						aria-label={statsTitle}
						onClick={(e) => { e.stopPropagation(); onOpenTable(connectionId, table, { tab: 'telemetry' }); }}
					><Icon name="pulse" /></button>
				)}
			</div>
			{tableOpen && lineageEdges(table.lineage).length > 0 && renderFolder(baseKey + ':lin', `Lineage (${lineageEdges(table.lineage).length})`, 'type-hierarchy', expanded, toggle, () => (
				<>
					{lineageEdges(table.lineage).map((edge) => {
						const target = byRef.get(`${edge.ref.schema}.${edge.ref.name}`);
						return (
							<div
								className="tree-row depth-4"
								key={`lin:${edge.relation}:${edge.ref.schema}.${edge.ref.name}`}
								title={target ? `${edge.title}\nDouble-click to open` : edge.title}
								onDoubleClick={target ? () => onOpenTable(connectionId, target) : undefined}
							>
								<span className="twisty" />
								<span className="tree-icon"><Icon name={edge.inbound ? 'arrow-left' : 'arrow-right'} /></span>
								<span className="tree-label">{edge.ref.schema === database ? edge.ref.name : `${edge.ref.schema}.${edge.ref.name}`}</span>
								<span className="muted col-type">{edge.relation}</span>
							</div>
						);
					})}
				</>
			))}
			{tableOpen && partitions.length > 0 && renderFolder(baseKey + ':parts', `Partitions (${partitions.length})`, 'layers', expanded, toggle, () => (
				<>
					{partitions.map((part) => {
						const target = byRef.get(`${part.schema}.${part.name}`);
						return (
							<div
								className="tree-row depth-4"
								key={'part:' + part.name}
								title={target ? `${part.title}${part.title ? '\n' : ''}Double-click to open` : part.title}
								onDoubleClick={target ? () => onOpenTable(connectionId, target) : undefined}
							>
								<span className="twisty" />
								<span className="tree-icon"><Icon name={part.state === 'sealed' ? 'archive' : part.state === 'tiered' ? 'cloud' : 'table'} /></span>
								<span className="tree-label">{part.name}</span>
								<span className="muted col-type">{part.detail}</span>
							</div>
						);
					})}
				</>
			))}
			{tableOpen && rollups.length > 0 && renderFolder(baseKey + ':rollups', `Rollups (${rollups.length})`, 'graph-line', expanded, toggle, () => (
				<>
					{onOpenSeriesMonitor && (
						<div
							className="tree-row depth-4"
							title="A monitor of these rollups' recent buckets, read from the database rather than sampled"
							onClick={() => onOpenSeriesMonitor(connectionId, table)}
						>
							<span className="twisty" />
							<span className="tree-icon"><Icon name="graph-line" /></span>
							<span className="tree-label">Open as a monitor</span>
						</div>
					)}
					{rollups.map((r) => {
						const target = byRef.get(`${r.schema}.${r.name}`);
						return (
							<div
								className="tree-row depth-4"
								key={'rollup:' + r.name}
								title={target ? 'Pre-aggregated by bucket. Double-click to open' : 'Pre-aggregated by bucket'}
								onDoubleClick={target ? () => onOpenTable(connectionId, target) : undefined}
							>
								<span className="twisty" />
								<span className="tree-icon"><Icon name="graph-line" /></span>
								<span className="tree-label">{r.schema === database ? r.name : `${r.schema}.${r.name}`}</span>
								<span className="muted col-type">{r.bucket} buckets</span>
							</div>
						);
					})}
				</>
			))}
			{tableOpen && renderFolder(baseKey + ':cols', `Columns (${table.columns.length})`, 'symbol-field', expanded, toggle, () => (
				<>
					{table.columns.map((column) => (
						<div className="tree-row depth-4" key={column.name} title={columnTitle(column)}>
							<span className="twisty" />
							<span className="tree-icon"><Icon name={column.isPrimaryKey ? 'key' : column.sortKey ? 'list-ordered' : 'symbol-field'} /></span>
							<span className="tree-label">{column.name}</span>
							<span className="muted col-type">{column.dataType}{column.nullable ? '' : ' · not null'}</span>
						</div>
					))}
				</>
			))}
			{tableOpen && cons && renderFolder(baseKey + ':cons', 'Constraints', 'key', expanded, toggle, () => (
				<div className="tree-row depth-4" title="Primary key">
					<span className="twisty" />
					<span className="tree-icon"><Icon name="key" /></span>
					<span className="tree-label">PRIMARY</span>
					<span className="muted col-type">{table.primaryKey.join(', ')}</span>
				</div>
			))}
			{tableOpen && fks && renderFolder(baseKey + ':fks', `Foreign Keys (${table.foreignKeys.length})`, 'references', expanded, toggle, () => (
				<>
					{table.foreignKeys.map((fk) => (
						<div className="tree-row depth-4" key={'fk:' + fk.constraintName} title={'Foreign key ' + fk.constraintName}>
							<span className="twisty" />
							<span className="tree-icon"><Icon name="references" /></span>
							<span className="tree-label">{fk.columns.join(', ')}</span>
							<span className="muted col-type">→ {fk.referencedTable}({fk.referencedColumns.join(', ')})</span>
						</div>
					))}
				</>
			))}
			{tableOpen && idx && renderFolder(baseKey + ':idx', `Indexes (${table.indexes!.length})`, 'list-tree', expanded, toggle, () => (
				<>
					{table.indexes!.map((ix) => (
						<div className="tree-row depth-4" key={'idx:' + ix.name} title={'Index ' + ix.name}>
							<span className="twisty" />
							<span className="tree-icon"><Icon name="list-tree" /></span>
							<span className="tree-label">{ix.name}</span>
							<span className="muted col-type">{ix.unique ? 'unique · ' : ''}{ix.columns.join(', ')}</span>
						</div>
					))}
				</>
			))}
			{tableOpen && trg && renderFolder(baseKey + ':trg', `Triggers (${table.triggers!.length})`, 'symbol-event', expanded, toggle, () => (
				<>
					{table.triggers!.map((tr) => (
						<div
							className="tree-row depth-4"
							key={'tr:' + tr.name}
							title="Double-click to open"
							onDoubleClick={() => onOpenObject({
								connectionId,
								kind: 'trigger',
								schema: table.schema,
								name: tr.name,
								meta: [
									{ label: 'Table', value: table.name },
									{ label: 'Timing', value: tr.timing },
									{ label: 'Event', value: tr.event },
								],
								ddl: tr.statement,
							})}
						>
							<span className="twisty" />
							<span className="tree-icon"><Icon name="symbol-event" /></span>
							<span className="tree-label">{tr.name}</span>
							<span className="muted col-type">{tr.timing} {tr.event}</span>
						</div>
					))}
				</>
			))}
		</div>
	);
}

/**
 * One lineage row: the object at the other end, which way the rows travel, and the sentence that
 * says why it is there.
 *
 * Read as a whole they answer the two questions a ClickHouse table cannot answer about itself:
 * "if I write here, what else gets written" and "where do these rows come from". The arrow is the
 * direction of the DATA, not of the reference, so every inbound row on one object is an outbound
 * row on another and the two screens cannot contradict each other.
 */
interface LineageEdge {
	ref: SchemaRef;
	relation: string;
	inbound: boolean;
	title: string;
}

function lineageEdges(lineage: ObjectLineage | undefined): LineageEdge[] {
	if (!lineage) {
		return [];
	}
	const edges: LineageEdge[] = [];
	for (const ref of lineage.readsFrom ?? []) {
		edges.push({ ref, relation: 'reads from', inbound: true, title: 'Every row inserted into this table runs this view.' });
	}
	if (lineage.writesTo) {
		edges.push({ ref: lineage.writesTo, relation: 'writes to', inbound: false, title: "The view's rows land in this table." });
	}
	for (const ref of lineage.feeds ?? []) {
		edges.push({ ref, relation: 'feeds', inbound: false, title: 'A materialized view that fires on every insert into this table.' });
	}
	for (const ref of lineage.writtenBy ?? []) {
		edges.push({ ref, relation: 'written by', inbound: true, title: 'A materialized view writes into this table. Its rows are not inserted by hand.' });
	}
	return edges;
}

/** What the engine calls this view, in words. "view" alone hides the difference that decides how
 *  you reason about it: a materialized view is an insert trigger with a table behind it, and a
 *  refreshable one is neither a trigger nor a stored SELECT but a scheduled job. */
function viewKindLabel(table: TableInfo): string {
	if (table.viewEngine === 'MaterializedView') {
		return table.lineage?.refreshable ? 'refreshable view' : 'materialized view';
	}
	if (table.viewEngine === 'LiveView') {
		return 'live view';
	}
	if (table.viewEngine === 'WindowView') {
		return 'window view';
	}
	return 'view';
}

/**
 * A schema-level "Dictionaries" folder at depth-2 (sibling to tables), listing the ClickHouse
 * dictionaries owned by `database` with the key each one is looked up by.
 *
 * Its own folder rather than a row in the table list, for the reason Procedures has one: a
 * dictionary is not a table (nothing writes to it, its rows come from its SOURCE), and "which
 * dictionaries are on this database" should be one row to open rather than a scan of two hundred.
 * Whether each one is LOADED or failing is deliberately not here: that is runtime state, it would
 * be read once and then shown stale for the rest of the session, and the Operations panel reads
 * it when it is asked.
 */
function renderDictionaries(
	connectionId: string,
	database: string,
	dictionaries: TableInfo[],
	expanded: Set<string>,
	toggle: (key: string) => void,
	onOpenTable: (connectionId: string, table: TableInfo, opts?: { tab?: 'data' | 'properties' | 'telemetry' }) => void,
): JSX.Element {
	const folderKey = `dicts:${connectionId}:${database}`;
	const open = expanded.has(folderKey);
	return (
		<div key={folderKey}>
			<div className="tree-row depth-2 folder" onClick={() => toggle(folderKey)}>
				<span className="twisty"><Icon name={open ? 'chevron-down' : 'chevron-right'} /></span>
				<span className="tree-icon"><Icon name="book" /></span>
				<span className="tree-label">Dictionaries</span>
				<span className="muted count">{dictionaries.length}</span>
			</div>
			{open && dictionaries.map((dict) => {
				const info = dict.dictionary;
				const dictKey = `dict:${connectionId}:${database}:${dict.name}`;
				const dictOpen = expanded.has(dictKey);
				return (
					<div key={dictKey}>
						<div
							className="tree-row depth-3"
							onClick={() => toggle(dictKey)}
							onDoubleClick={() => onOpenTable(connectionId, dict)}
							title={dictionaryTitle(info)}
						>
							<span className="twisty"><Icon name={dictOpen ? 'chevron-down' : 'chevron-right'} /></span>
							<span className="tree-icon"><Icon name="book" /></span>
							<span className="tree-label">{dict.name}</span>
							{/* The KEY, not the layout: `COMPLEX_KEY_HASHED` is eighteen characters and won the
							    row's width off the dictionary's own name, which is the one thing a reader is
							    scanning for. The layout is in the hover, beside where it loads from. */}
							{(info?.keyColumns.length ?? 0) > 0 && <span className="muted col-type">{info!.keyColumns.join(', ')}</span>}
						</div>
						{dictOpen && (info?.keyColumns ?? []).map((name) => (
							<div className="tree-row depth-4" key={'dk:' + name} title="The key dictGet looks a row up by.">
								<span className="twisty" />
								<span className="tree-icon"><Icon name="key" /></span>
								<span className="tree-label">{name}</span>
								<span className="muted col-type">key</span>
							</div>
						))}
						{dictOpen && (info?.attributes ?? []).map((attr) => (
							<div className="tree-row depth-4" key={'da:' + attr.name} title="An attribute dictGet can return.">
								<span className="twisty" />
								<span className="tree-icon"><Icon name="symbol-field" /></span>
								<span className="tree-label">{attr.name}</span>
								<span className="muted col-type">{attr.dataType}</span>
							</div>
						))}
					</div>
				);
			})}
		</div>
	);
}

/** A dictionary's hover: where it loads from and how it is held, which is what decides whether a
 *  dictGet is a memory read or a round trip. */
function dictionaryTitle(info: TableInfo['dictionary']): string {
	const lines = ['Double-click to open'];
	if ((info?.keyColumns.length ?? 0) > 0) {
		lines.push(`Key: ${info!.keyColumns.join(', ')}`);
	}
	if (info?.sourceKind) {
		lines.push(`Loaded from: ${info.sourceKind}`);
	}
	if (info?.layout) {
		lines.push(`Layout: ${info.layout}`);
	}
	return lines.join('\n');
}

/** A schema-level "Procedures" folder at depth-2 (sibling to tables) listing the
 *  stored procedures + functions owned by `database`. */
function renderRoutines(
	connectionId: string,
	database: string,
	routines: RoutineInfo[],
	expanded: Set<string>,
	toggle: (key: string) => void,
	onOpenObject: (detail: ObjectDetail) => void,
): JSX.Element {
	const key = `routines:${connectionId}:${database}`;
	const open = expanded.has(key);
	return (
		<div key={key}>
			<div className="tree-row depth-2 folder" onClick={() => toggle(key)}>
				<span className="twisty"><Icon name={open ? 'chevron-down' : 'chevron-right'} /></span>
				<span className="tree-icon"><Icon name="symbol-method" /></span>
				<span className="tree-label">Procedures</span>
				<span className="muted count">{routines.length}</span>
			</div>
			{open && routines.map((r) => (
				<div
					className="tree-row depth-3"
					key={'rt:' + r.kind + ':' + r.name}
					title="Double-click to open"
					onDoubleClick={() => onOpenObject({
						connectionId,
						kind: r.kind,
						schema: r.schema,
						name: r.name,
						meta: [
							{ label: 'Type', value: r.kind },
							...(r.returnType ? [{ label: 'Returns', value: r.returnType }] : []),
							...(r.language ? [{ label: 'Language', value: r.language }] : []),
						],
						parameters: r.parameters ?? [],
						ddl: r.definition,
					})}
				>
					<span className="twisty" />
					<span className="tree-icon"><Icon name={r.kind === 'function' ? 'symbol-method' : 'symbol-misc'} /></span>
					<span className="tree-label">{r.name}</span>
					<span className="muted col-type">{r.kind}{r.returnType ? ' · ' + r.returnType : ''}</span>
				</div>
			))}
		</div>
	);
}

/** Collapsible folder row at depth-3 with `children` rendered at depth-4 when open. */
function renderFolder(
	key: string,
	label: string,
	icon: string,
	expanded: Set<string>,
	toggle: (k: string) => void,
	children: () => JSX.Element,
): JSX.Element {
	const open = expanded.has(key);
	return (
		<div key={key}>
			<div className="tree-row depth-3 folder" onClick={() => toggle(key)}>
				<span className="twisty"><Icon name={open ? 'chevron-down' : 'chevron-right'} /></span>
				<span className="tree-icon"><Icon name={icon} /></span>
				<span className="tree-label">{label}</span>
			</div>
			{open && children()}
		</div>
	);
}

/** The glyph for a schema entity, by what it actually is. A cloud log scope reads as a stream of
 *  events rather than a table of rows, and showing it with the table glyph would promise a shape
 *  it does not have. */
/** A column's hover: where it sits in the key, its codec and what it takes on disk, where known. */
function columnTitle(column: ColumnInfo): string | undefined {
	const lines: string[] = [];
	if (column.sortKey === 'primary') {
		lines.push('In the sort key and the primary index: a filter on it skips granules.');
	} else if (column.sortKey === 'sort') {
		lines.push('In the sort key, after the primary index.');
	}
	if (column.codec) {
		lines.push(`Codec: ${column.codec}`);
	}
	if (column.storedBytes) {
		const { compressed, uncompressed } = column.storedBytes;
		lines.push(`On disk: ${formatBytes(compressed)} compressed, ${formatBytes(uncompressed)} raw${compressed > 0 ? ` (${(uncompressed / compressed).toFixed(1)}x)` : ''}`);
	}
	return lines.length > 0 ? lines.join('\n') : undefined;
}

function tableKindIcon(kind: TableInfo['kind']): string {
	switch (kind) {
		case 'view':
			return 'eye';
		case 'collection':
			return 'symbol-namespace';
		case 'index':
			return 'graph-scatter';
		case 'logGroup':
			return 'list-unordered';
		case 'dictionary':
			return 'book';
		default:
			return 'table';
	}
}

/** The tooltip on a connection's kind mark: what this driver is, in words, since the glyph names a
 *  family rather than a vendor and the vendor is already in the row's label. */

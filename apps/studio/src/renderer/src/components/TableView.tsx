/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { CellValueEditor } from './CellValueEditor';
import { DataGrid, cellText, computeColumnWidths, type GridFk, type SortState } from './DataGrid';
import { TableProperties } from './TableProperties';
import { CollectionProperties } from './CollectionProperties';
import { TableTelemetry } from './TableTelemetry';
import { lazyView } from '../lazyView';
import { GridEditToolbar } from './GridEditToolbar';
import { SaveChangesModal } from './SaveChangesModal';
import { LoadFileModal } from './LoadFileModal';
import { useGridEditing } from '../useGridEditing';
import { useGridSaveShortcut } from '../useGridSaveShortcut';
import { useFkLookup } from '../useFkLookup';
import { defaultAction, editRefusal, generateRowSql, isCellExpr, literalFromValue, NULL_VALUE, primaryKeyNames, type RowSqlKind } from '../dml';
import { quoteIdent, type TableDraft } from '../ddl';
import { errorMessage } from '../errors';
import { bulkFormatsFor, dialectFor, keysetCursorFrom, keysetKeyFor, keysetOrderBy, keysetSelect, type ConnectionPolicy, type KeysetKey, type LoadFileChoice, type MongoDdl, type MongoWrite } from '../../../shared/engine';
import type { QueryResult } from '../../../shared/query';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../shared/schema';
import { lockProdEditing, unlockProdEditing, useProdUnlocked } from '../prodUnlock';

// A double-clicked table opens here: a "Data" browser (server-paged so a table with millions of
// rows is never pulled into memory; fetches one page + 1 extra row to know if there's a next page,
// avoiding an expensive COUNT(*)). Paging is KEYSET when the table qualifies (a NOT NULL primary
// key — `keysetKeyFor`): each page seeks past the last row of the previous one, so page 50,000
// costs what page 1 costs. Tables that don't qualify (no usable PK, a view, a sort on a nullable
// column) keep the LIMIT/OFFSET path, which re-walks and discards every skipped row and so degrades
// with depth. Also a "Telemetry" dashboard (catalog stats + size breakdown + recent queries), and a
// "Properties" structure designer (add/drop/modify columns, generate + run DDL). With no `table`
// (create mode) it shows only the designer.
type InnerTab = 'properties' | 'data' | 'telemetry' | 'storage';

// The ClickHouse-only Storage tab: code-split, since a launch must not carry a tab that only
// appears on one engine's tables ("Startup is sacred").
const ClickHouseTableStorage = lazyView(() => import('./ClickHouseTableStorage').then((m) => ({ default: m.ClickHouseTableStorage })));
/** One server-side WHERE condition from a cell action or an FK navigation; many are AND'd. */
type FilterCond = { col: number; op: '=' | '<>'; value: unknown };
const PAGE_SIZES = [100, 200, 500, 1000];
const DEFAULT_PAGE_SIZE = 200;

/** Compact, honestly-approximate row count for the paginator ("~4.2M rows"). */
function formatApproxRows(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 10_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return n.toLocaleString();
}

interface TableViewProps {
	connectionId: string;
	driver: string;
	/** The result's connection is a `prod` environment. Cosmetic only (warning banners). */
	isProd: boolean;
	/** The connection's production policy, which decides whether rows may be edited here. */
	policy: ConnectionPolicy;
	/** Connection is flagged read-only — hides in-grid edit affordances. */
	readOnly: boolean;
	/** Edit mode: the table to browse/edit. Omit (with createInSchema) for create mode. */
	table?: TableInfo;
	/** Create mode: the schema/database the new table is created in. */
	createInSchema?: string;
	/** Create mode: prefill the designer with this draft (e.g. one the AI assistant proposed). */
	seedDraft?: TableDraft;
	/** Initial inner tab — the sidebar's pulse icon passes `'telemetry'` so the user lands
	 *  on the dashboard. Defaults to `'data'`. */
	defaultTab?: InnerTab;
	/** Seed the Data tab's filter (e.g. when navigated to from a foreign-key cell). One condition
	 *  per entry, AND'd together — a composite FK navigates with one per key column. */
	initialFilter?: { column: string; op: '=' | '<>'; value: unknown }[];
	/** The connection's schema, used to resolve foreign-key targets for the peek/labels. */
	schema?: DatabaseSchema | null;
	/** Resolve FK ids to inline labels (the peek card stays available regardless). On by default. */
	resolveFkLabels?: boolean;
	/** Navigate from an FK cell to the referenced row (open a table tab filtered to the key). */
	onNavigateFk?(table: TableInfo, filters: { column: string; value: unknown }[]): void;
	onRunDdl(connectionId: string, sql: string): Promise<{ ok: boolean; error?: string }>;
	/** Run the data-grid save's batch of statements (one at a time / transactional per driver). */
	onRunScript(connectionId: string, statements: string[]): Promise<{ ok: boolean; error?: string }>;
	/** Run the data-grid save's batch of Mongo writes (document backends). */
	onRunWrites(connectionId: string, writes: MongoWrite[]): Promise<{ ok: boolean; error?: string }>;
	/** Run a Mongo structure op batch (collection/index management) — document backends only. */
	onRunMongoDdl(connectionId: string, ops: MongoDdl[]): Promise<{ ok: boolean; error?: string }>;
	onPersisted(table: TableInfo): void;
	/** A collection was dropped from its Properties panel — close this tab. */
	onDropped(): void;
}

function qualifiedName(table: TableInfo, driver: string): string {
	const parts = table.schema ? [table.schema, table.name] : [table.name];
	return parts.map((p) => quoteIdent(p, driver)).join('.');
}

export function TableView({ connectionId, driver, isProd, policy, readOnly, table, createInSchema, seedDraft, defaultTab, initialFilter, schema, resolveFkLabels = true, onNavigateFk, onRunDdl, onRunScript, onRunWrites, onRunMongoDdl, onPersisted, onDropped }: TableViewProps): JSX.Element {
	const [tab, setTab] = useState<InnerTab>(defaultTab ?? 'data');
	// Honour later updates to `defaultTab` — when the user clicks the pulse icon for an
	// already-open table the parent re-seeds it to `'telemetry'`; without this effect
	// the inner state wouldn't move and the click would do nothing.
	useEffect(() => {
		if (defaultTab) {
			setTab(defaultTab);
		}
	}, [defaultTab]);

	// --- Data tab (server-paged). ---
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
	// A SnoutTime rollup opens newest bucket first: a view has no key to page by, so unsorted its
	// rows come back in whatever order its union produces, which reads as noise (2026-09-24). It is
	// an ordinary sort, shown on the header and cleared the usual way.
	const [sort, setSort] = useState<SortState | null>(() => {
		const col = table?.rollup ? table.columns.findIndex((c) => c.name === 'bucket') : -1;
		return col >= 0 ? { col, dir: 'desc' } : null;
	});
	// Server-side WHERE from a cell's "Filter to / Exclude this value" action or an FK navigation
	// (one condition per FK key column). Conditions are AND'd; empty = no filter.
	const [filter, setFilter] = useState<FilterCond[]>([]);
	const [data, setData] = useState<QueryResult | null>(null);
	const [hasNext, setHasNext] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reloadSeq, setReloadSeq] = useState(0);
	// Keyset cursors, indexed by page: `pages[n]` is the key tuple the page-n query seeks past (page
	// 0 has none). Each page records the cursor for the NEXT one as it lands, so Next always has a
	// seek position and Prev/First replay an exact one instead of re-counting from the top.
	//
	// A ref, not state: storing a cursor must not re-trigger the fetch effect that reads it. The
	// chain is stamped with the sequence it belongs to (`key`) and invalidated by comparison inside
	// that same effect, NOT by a reset effect — an effect that cleared the chain and called
	// setPage(0) would leave one render where the cursors are gone but the page number is still
	// deep, and the fetch would go out as a wasted deep-OFFSET query before the real one.
	const pageCursors = useRef<{ key: string; pages: (string[] | undefined)[] }>({ key: '', pages: [] });
	// Active "Edit value…" modal — row index is in DataGrid's frame (existing rows first,
	// then pending inserts), the same indexing the other edit callbacks use.
	const [bigEdit, setBigEdit] = useState<{ row: number; col: number; value: string | null; columnName: string } | null>(null);

	const fields = data?.fields ?? [];
	const rows = data?.rows ?? [];
	const dataWidths = useMemo(() => computeColumnWidths(fields, rows.length, (i) => rows[i]), [data]);
	// Per-field column default, matched by name against the table — shown muted in new
	// rows so the user sees what the DB will apply if they leave the cell empty.
	const columnDefaults = useMemo<(string | null | undefined)[] | undefined>(() => {
		if (!table || fields.length === 0) {
			return undefined;
		}
		const byName = new Map(table.columns.map((c) => [c.name.toLowerCase(), c.default ?? null]));
		return fields.map((f) => byName.get(f.name.toLowerCase()) ?? undefined);
	}, [table, fields]);
	// Column metadata aligned to the result fields — drives the type-aware "Set to default".
	const columnByField = useMemo<(ColumnInfo | undefined)[] | undefined>(() => {
		if (!table || fields.length === 0) {
			return undefined;
		}
		const byName = new Map(table.columns.map((c) => [c.name.toLowerCase(), c]));
		return fields.map((f) => byName.get(f.name.toLowerCase()));
	}, [table, fields]);
	// Editing needs a primary key to target rows safely, and a base table (not a view).
	// Read-only connections never expose edit affordances (main also blocks the DML/DDL).
	// The prod policy applies here exactly as it does to the results grid: a prod table tab is
	// look-only until the user opts into grid actions. (Before this, the two panes disagreed —
	// the same rows were look-only in one and editable in the other.)
	// A log scope is named explicitly rather than left to the primary-key test it also fails: it has
	// no write path at any point, and relying on the absence of a key would make it editable the day
	// a provider started reporting one.
	// `structurallyEditable` is everything but the prod lock, so a locked prod grid can still SHOW
	// its edit items (greyed) and offer "Allow editing" rather than hiding them all.
	const structurallyEditable = Boolean(table && table.kind !== 'view' && table.kind !== 'logGroup' && primaryKeyNames(table).length > 0) && !readOnly;
	const editable = structurallyEditable && policy.allowsGridActions(true);
	const prodLocked = structurallyEditable && policy.isProduction && !editable;
	const prodUnlocked = useProdUnlocked();
	const prodSessionUnlocked = structurallyEditable && policy.isProduction && prodUnlocked.has(connectionId);
	const realRowCount = rows.length;
	// The Storage tab. Only ClickHouse, and only for a real table: what it shows (partitions, parts,
	// projections, skip indexes) is what a MergeTree table IS, and no other engine here has one. A
	// view has no storage of its own, so it is left off there too.
	const hasStorageTab = driver === 'clickhouse' && table !== undefined && table.kind === 'table';
	// Loading a FILE into the table. Offered where the ENGINE takes one (the dialect's own list,
	// `bulkFormatsFor`), which is what keeps this out of every other driver's way, and only into a
	// real table a write is allowed on. It is deliberately NOT gated on `editable`: a ClickHouse
	// grid is read-only because a sort key addresses no single row, and that says nothing about
	// whether rows may be ADDED, which is the one write that engine is built for.
	const canLoadFile = table !== undefined && table.kind === 'table' && !readOnly && policy.allowsGridActions(true) && bulkFormatsFor(driver).length > 0;
	const [loadChoice, setLoadChoice] = useState<LoadFileChoice | null>(null);

	async function chooseFileToLoad(): Promise<void> {
		const choice = await window.sqlApi.chooseLoadFile({ connectionId }).catch(() => null);
		if (choice) {
			setLoadChoice(choice);
		}
	}

	// Inline edit/insert/delete state. Edits clear whenever the page/sort/dataset changes
	// (the row indices they key on would no longer line up).
	const filterKey = filter.map((f) => `${f.col}${f.op}${String(f.value)}`).join('&');
	const editResetKey = `${page}:${pageSize}:${sort?.col ?? ''}:${sort?.dir ?? ''}:${filterKey}:${reloadSeq}:${table?.schema ?? ''}.${table?.name ?? ''}`;
	const editing = useGridEditing(table, driver, fields, rows, editResetKey);
	const dirty = editing.dirty;
	// Ctrl+S commits the pending grid edits (opens the DML preview) rather than saving a SQL
	// file. A table tab only mounts while it's the active view, so it's always foreground here.
	useGridSaveShortcut(editable, dirty, editing.prepareSave);

	// FK value resolution (inline labels + the peek card) over this table's foreign keys.
	const lookup = useFkLookup({ connectionId, driver, sourceTable: table ?? null, tables: schema?.tables ?? [], fields });
	const fk: GridFk | undefined = lookup.anyFk && onNavigateFk ? {
		showLabels: resolveFkLabels,
		isFkColumn: lookup.isFkColumn,
		refTableName: lookup.refTableName,
		fkLabel: lookup.fkLabel,
		requestLabels: lookup.requestLabels,
		requestPeek: lookup.requestPeek,
		peekData: lookup.peekData,
		onNavigate: (col, row) => { const t = lookup.navTarget(col, row); if (t) { onNavigateFk(t.table, t.filters); } },
	} : undefined;

	// Seed the filter when navigated to from an FK cell (by column name → index into the table),
	// applied once per distinct initial filter so it doesn't fight the user clearing it.
	const appliedInitial = useRef<string | null>(null);
	useEffect(() => {
		if (!initialFilter || initialFilter.length === 0 || !table) {
			return;
		}
		const key = initialFilter.map((f) => `${f.column}${f.op}${String(f.value)}`).join('&');
		if (appliedInitial.current === key) {
			return;
		}
		const conds: FilterCond[] = [];
		for (const f of initialFilter) {
			const col = table.columns.findIndex((c) => c.name.toLowerCase() === f.column.toLowerCase());
			if (col >= 0) {
				conds.push({ col, op: f.op, value: f.value });
			}
		}
		if (conds.length === 0) {
			return;
		}
		appliedInitial.current = key;
		setFilter(conds);
		setPage(0);
	}, [initialFilter, table]);

	// Grid rows are existing rows first (0..realRowCount) then appended new rows; translate
	// the grid index to the matching edit-engine call.
	function getRow(i: number): unknown[] {
		return i < realRowCount ? editing.displayRow(i) : editing.displayInsert(i - realRowCount);
	}

	function isEdited(i: number, col: number): boolean {
		return i < realRowCount ? editing.isRowEdited(i, col) : editing.isInsertEdited(i - realRowCount, col);
	}

	function rowState(i: number): 'new' | 'deleted' | undefined {
		if (i >= realRowCount) {
			return 'new';
		}
		return editing.isDeleted(i) ? 'deleted' : undefined;
	}

	function editCell(i: number, col: number, value: string): void {
		if (i < realRowCount) {
			editing.editRow(i, col, value);
		} else {
			editing.editInsert(i - realRowCount, col, value);
		}
	}

	function toggleDelete(i: number): void {
		if (i < realRowCount) {
			editing.toggleDelete(i);
		} else {
			editing.removeInsert(i - realRowCount);
		}
	}

	// Copy a single cell / a whole row (tab-separated) to the clipboard.
	function copyCell(i: number, col: number): void {
		void navigator.clipboard.writeText(cellText(getRow(i)[col]) ?? '');
	}

	function copyRow(i: number): void {
		const row = getRow(i);
		void navigator.clipboard.writeText(fields.map((_f, col) => cellText(row[col]) ?? '').join('\t'));
	}

	// "Generate SQL ▸": build a standalone statement for the row and copy it to the clipboard.
	function generateSql(i: number, kind: RowSqlKind): void {
		if (!table) {
			return;
		}
		void navigator.clipboard.writeText(generateRowSql(kind, table, driver, fields, getRow(i)));
	}

	// The ordering this browse can be keyset-paged by, or null to stay on OFFSET. The engine owns
	// the whole eligibility rule (unique + NOT NULL, base table, PK appended to a user sort so the
	// tuple stays total) — see `keysetKeyFor`.
	const keysetKey = useMemo<KeysetKey | null>(() => {
		if (!table) {
			return null;
		}
		if (!sort) {
			return keysetKeyFor(table);
		}
		const sortColumn = table.columns[sort.col]?.name;
		return sortColumn ? keysetKeyFor(table, { column: sortColumn, dir: sort.dir }) : null;
	}, [table, sort]);

	// Identity of the paging SEQUENCE: a new sort, filter, page size or table means cursors collected
	// under the old one are meaningless. Every handler that changes one of these already calls
	// setPage(0) in the same event, so the page reset is theirs; this string only decides when to
	// drop the cursor chain. Keyed on the VALUES rather than the objects, so a schema re-introspect
	// (which hands us a fresh `table` object for the same table) keeps the chain and re-reads the
	// current page, instead of throwing the user back to page 1.
	const browseResetKey = `${table?.schema ?? ''}.${table?.name ?? ''}:${pageSize}:${sort?.col ?? ''}:${sort?.dir ?? ''}:${filterKey}`;

	useEffect(() => {
		if (tab !== 'data' || !table) {
			return;
		}
		let cancelled = false;
		const qname = qualifiedName(table, driver);
		const orderBy = sort ? ` ORDER BY ${quoteIdent(table.columns[sort.col]?.name ?? '', driver)} ${sort.dir.toUpperCase()}` : '';
		// WHERE from the cell "Filter to / Exclude this value" action or an FK navigation; conditions
		// are AND'd, and a null value uses IS [NOT] NULL.
		const conditions = filter.map((f) => {
			const col = quoteIdent(table.columns[f.col]?.name ?? '', driver);
			if (f.value === null || f.value === undefined) {
				return `${col} IS ${f.op === '=' ? '' : 'NOT '}NULL`;
			}
			return `${col} ${f.op} ${literalFromValue(f.value, driver)}`;
		});
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
		// Fetch one extra row to learn whether a next page exists (no COUNT on huge tables).
		const probe = pageSize + 1;
		// A sort/filter/page-size change starts a new sequence, so the old cursors are dropped here —
		// synchronously, in the same run that issues the query, so there is never a render where the
		// chain and the page number disagree.
		if (pageCursors.current.key !== browseResetKey) {
			pageCursors.current = { key: browseResetKey, pages: [] };
		}
		// Keyset when the table qualifies AND we hold the cursor this page seeks past (page 0 needs
		// none). A later page with no cursor can only be served by OFFSET — but it is served in the
		// KEY's order, not the raw sort order: a page fetched under a different ORDER BY than the one
		// before it would repeat or skip rows at the boundary. Ordering is a property of the whole
		// sequence, so it is decided once, here, for both branches.
		const cursor = pageCursors.current.pages[page];
		const useKeyset = keysetKey !== null && (page === 0 || cursor !== undefined);
		const sequenceOrderBy = keysetKey ? keysetOrderBy(keysetKey, driver) : orderBy;
		const sql = useKeyset
			? keysetSelect({ select: `SELECT * FROM ${qname}`, conditions, key: keysetKey, after: cursor, limit: probe }, driver)
			// OFFSET fallback. The pagination clause (LIMIT/OFFSET vs OFFSET/FETCH) is dialect
			// specific; OFFSET/FETCH dialects need a deterministic ORDER BY, so fall back to the
			// first column when the browse is unsorted and not keyed either.
			: dialectFor(driver).paginatedSelect(`SELECT * FROM ${qname}${where}`, {
				limit: probe,
				offset: page * pageSize,
				orderBy: sequenceOrderBy,
				fallbackOrderBy: table.columns.length > 0 ? quoteIdent(table.columns[0].name, driver) : '(SELECT NULL)',
			});
		setLoading(true);
		setError(null);
		void window.sqlApi.execute({ connectionId, sql }).then((res) => {
			if (cancelled) {
				return;
			}
			if (!res.ok) {
				setError(res.error);
				setData(null);
				setHasNext(false);
			} else {
				const all = res.result.rows;
				const more = all.length > pageSize;
				const shown = all.slice(0, pageSize);
				setHasNext(more);
				setData({ ...res.result, rows: shown });
				// Record where the NEXT page picks up: the key of the last row shown (never the probe
				// row, which belongs to that next page). If the cursor can't be read — a key column
				// isn't projected, or its value is NULL — drop the chain from here so the next page
				// falls back to OFFSET rather than seeking from a wrong position.
				if (useKeyset && keysetKey && pageCursors.current.key === browseResetKey) {
					const last = shown[shown.length - 1];
					pageCursors.current.pages[page + 1] = more && last
						? keysetCursorFrom(keysetKey, res.result.fields, last, (v) => literalFromValue(v, driver)) ?? undefined
						: undefined;
				}
			}
			setLoading(false);
		}).catch((err: unknown) => {
			if (cancelled) {
				return;
			}
			setError(errorMessage(err));
			setData(null);
			setLoading(false);
		});
		return () => { cancelled = true; };
	}, [tab, connectionId, driver, table, page, pageSize, sort, filter, reloadSeq, keysetKey]);

	function sortColumn(col: number): void {
		setSort((prev) => {
			if (!prev || prev.col !== col) {
				return { col, dir: 'asc' };
			}
			return prev.dir === 'asc' ? { col, dir: 'desc' } : null;
		});
		setPage(0);
	}

	const start = page * pageSize;
	const showing = rows.length;
	// Cheap "truth about size": the table's approximate row count straight from the
	// catalog stats (no COUNT scan), shown only for an unfiltered browse — a filter changes the real
	// total, so we don't imply the filtered set is this big.
	const approxTotalRows = filter.length === 0 && table?.stats?.rowCount != null ? formatApproxRows(table.stats.rowCount) : undefined;

	// Create mode: just the designer (no data to browse yet).
	if (!table) {
		return (
			<div className="table-view">
				<div className="tv-head">
					<Icon name="add" className="tv-head-icon" />
					<span className="tv-title">New table</span>
					{createInSchema && <span className="muted">in {createInSchema}</span>}
				</div>
				<TableProperties
					connectionId={connectionId}
					driver={driver}
					isProd={isProd}
					mode="create"
					targetSchema={createInSchema}
					seedDraft={seedDraft}
					onRunDdl={onRunDdl}
					onPersisted={onPersisted}
				/>
			</div>
		);
	}

	return (
		<div className="table-view">
			<div className="tv-head">
				<Icon name={table.kind === 'view' ? 'eye' : table.kind === 'collection' ? 'symbol-namespace' : table.kind === 'dictionary' ? 'book' : 'table'} className="tv-head-icon" />
				<span className="tv-title">{table.schema ? `${table.schema}.${table.name}` : table.name}</span>
				{table.kind === 'view' && <span className="muted">view</span>}
				{table.kind === 'collection' && <span className="muted">collection</span>}
				{table.kind === 'dictionary' && <span className="muted">dictionary</span>}
				{table.comment && <span className="tv-comment">{table.comment}</span>}
			</div>
			<div className="tabs tv-tabs">
				<button type="button" className={`tab${tab === 'properties' ? ' active' : ''}`} onClick={() => setTab('properties')}>Properties</button>
				<button type="button" className={`tab${tab === 'telemetry' ? ' active' : ''}`} onClick={() => setTab('telemetry')}>Telemetry</button>
				{hasStorageTab && <button type="button" className={`tab${tab === 'storage' ? ' active' : ''}`} onClick={() => setTab('storage')}>Storage</button>}
				<button type="button" className={`tab${tab === 'data' ? ' active' : ''}`} onClick={() => setTab('data')}>Data</button>
			</div>

			{tab === 'properties' && (
				table.kind === 'collection'
					? <CollectionProperties
						connectionId={connectionId}
						isProd={isProd}
						readOnly={readOnly}
						base={table}
						runMongoDdl={onRunMongoDdl}
						onPersisted={onPersisted}
						onDropped={onDropped}
					/>
					: <TableProperties
						connectionId={connectionId}
						driver={driver}
						isProd={isProd}
						mode="edit"
						base={table}
						onRunDdl={onRunDdl}
						onPersisted={onPersisted}
					/>
			)}

			{tab === 'telemetry' && (
				<TableTelemetry connectionId={connectionId} table={table} />
			)}

			{tab === 'storage' && hasStorageTab && (
				<ClickHouseTableStorage
					connectionId={connectionId}
					schema={table.schema ?? ''}
					table={table.name}
					isProd={isProd}
					readOnly={readOnly || !policy.allowsGridActions(true)}
					onRunDdl={onRunDdl}
				/>
			)}

			{tab === 'data' && (
				<>
					{prodSessionUnlocked && (
						<div className="grid-edit-note muted small">
							<Icon name="unlock" />
							<span>Editing is allowed on this production connection until the app restarts. Saving still shows the statements first.</span>
							<button type="button" className="link-btn" onClick={() => lockProdEditing(connectionId)}>Lock again</button>
						</div>
					)}
					{editable ? (
						<GridEditToolbar
							dirty={dirty}
							saving={editing.saving}
							onAddRow={editing.addInsert}
							onRevert={editing.revert}
							onSave={editing.prepareSave}
						/>
					) : (
						// Say WHY there is no Add row, where the Add row would have been. Without
						// this the toolbar is simply absent and the only thing to do is guess,
						// which is what happened the first time anybody imported a hosted
						// database: two of its tables had no primary key, the refusal was
						// correct, and the missing sentence made it look like cloud connections
						// were second-class. See `editRefusal`.
						editRefusal(table, { readOnly, gridActionsAllowed: policy.allowsGridActions(true) }) && (
							<div className="grid-edit-note muted small">
								<Icon name="info" />
								<span>{editRefusal(table, { readOnly, gridActionsAllowed: policy.allowsGridActions(true) })}</span>
								{prodLocked && <button type="button" className="link-btn" onClick={() => unlockProdEditing(connectionId)}>Allow editing for this session</button>}
							</div>
						)
					)}
					{/* Adding rows is a different question from editing them, so this sits outside the
					    toolbar/refusal pair above rather than inside either arm of it. */}
					{canLoadFile && (
						<div className="grid-load-bar">
							<button type="button" className="grid-load-file" onClick={() => void chooseFileToLoad()}>
								<Icon name="cloud-upload" />
								Load a file
							</button>
						</div>
					)}
					{filter.length > 0 && (
						<div className="filter-bar">
							<Icon name="filter" className="filter-bar-icon" />
							{filter.map((f, i) => (
								<span className="filter-clause" key={`${f.col}-${i}`}>
									{i > 0 && <span className="filter-and">AND </span>}
									<b>{fields[f.col]?.name ?? table.columns[f.col]?.name}</b> {f.value === null || f.value === undefined ? (f.op === '=' ? 'IS NULL' : 'IS NOT NULL') : `${f.op === '=' ? '=' : '≠'} ${String(f.value)}`}
								</span>
							))}
							<button type="button" className="filter-clear" title="Clear filter" onClick={() => { setFilter([]); setPage(0); }}><Icon name="close" /></button>
						</div>
					)}
					{editing.savePreview === null && editing.saveError && <div className="results-error">{editing.saveError}</div>}
					{error
						? <div className="results-error">{error}</div>
						: (
							<DataGrid
								fields={fields}
								rowCount={realRowCount + editing.inserts.length}
								getRow={getRow}
								widths={dataWidths}
								rowOffset={start}
								sort={sort}
								onSortColumn={dirty ? undefined : sortColumn}
								resetKey={`${page}:${pageSize}:${reloadSeq}`}
								editable={structurallyEditable}
								editLocked={prodLocked}
								onUnlock={prodLocked ? () => unlockProdEditing(connectionId) : undefined}
								onCopyCell={copyCell}
								onCopyRow={copyRow}
								onGenerateSql={generateSql}
								isEdited={isEdited}
								rowState={rowState}
								onEditCell={editCell}
								onToggleDelete={toggleDelete}
								columnDefaults={structurallyEditable ? columnDefaults : undefined}
								onDuplicateRow={structurallyEditable ? (i) => { if (i < realRowCount) { editing.duplicateRow(i); } } : undefined}
								onOpenCellEditor={structurallyEditable ? (i, col) => {
									const row = i < realRowCount ? editing.displayRow(i) : editing.displayInsert(i - realRowCount);
									setBigEdit({ row: i, col, value: cellText(row[col]), columnName: fields[col]?.name ?? '' });
								} : undefined}
							defaultActionLabel={structurallyEditable ? (col) => defaultAction(columnByField?.[col])?.label ?? null : undefined}
							onSetDefault={structurallyEditable ? (i, col) => {
								const action = defaultAction(columnByField?.[col]);
								if (!action) { return; }
								if (i < realRowCount) { editing.editRow(i, col, action.value); }
								else { editing.editInsert(i - realRowCount, col, action.value); }
							} : undefined}
							onSetNull={structurallyEditable ? (i, col) => {
								if (i < realRowCount) { editing.editRow(i, col, NULL_VALUE); }
								else { editing.editInsert(i - realRowCount, col, NULL_VALUE); }
							} : undefined}
							onCopyFromAdjacent={structurallyEditable ? (i, col, dir) => {
								const ni = i + dir;
								if (ni < 0 || ni >= realRowCount + editing.inserts.length) { return; }
								const src = getRow(ni)[col];
								const value = isCellExpr(src) ? src : (cellText(src) ?? '');
								if (i < realRowCount) { editing.editRow(i, col, value); }
								else { editing.editInsert(i - realRowCount, col, value); }
							} : undefined}
							onOrderBy={dirty ? undefined : (col, dir) => { setSort({ col, dir }); setPage(0); }}
							onFilterByValue={dirty ? undefined : (i, col, op) => {
								if (i >= realRowCount) { return; }
								setFilter([{ col, op, value: rows[i][col] }]);
								setPage(0);
							}}
							fk={fk}
							/>
						)}
					<div className="results-footer">
						<span>{loading ? 'Loading…' : showing === 0 ? 'No rows' : `Rows ${(start + 1).toLocaleString()}–${(start + showing).toLocaleString()}`}</span>
						<button type="button" className="page-btn" title="Refresh" disabled={dirty} onClick={() => setReloadSeq((s) => s + 1)}><Icon name="refresh" /></button>
						<span className="spacer" />
						<div className="paginator">
							<label className="page-size">Rows per page
								<select value={pageSize} disabled={dirty} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
									{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
								</select>
							</label>
							<span className="page-range">Page {(page + 1).toLocaleString()}{approxTotalRows ? ` · ~${approxTotalRows} rows` : ''}</span>
							<button type="button" className="page-btn first" title="First page" disabled={page === 0 || dirty} onClick={() => setPage(0)}><span className="pg-bar" /><Icon name="chevron-left" /></button>
							<button type="button" className="page-btn" title="Previous page" disabled={page === 0 || dirty} onClick={() => setPage((p) => Math.max(0, p - 1))}><Icon name="chevron-left" /></button>
							<button type="button" className="page-btn" title="Next page" disabled={!hasNext || dirty} onClick={() => setPage((p) => p + 1)}><Icon name="chevron-right" /></button>
						</div>
					</div>
				</>
			)}

			{editing.savePreview !== null && (
				<SaveChangesModal
					sql={editing.savePreview}
					isProd={isProd}
					saving={editing.saving}
					error={editing.saveError}
					note={editing.saveNote}
					onCancel={editing.cancelSave}
					onRun={() => void editing.applySave((plan) => plan.kind === 'sql' ? onRunScript(connectionId, plan.statements) : onRunWrites(connectionId, plan.writes), () => setReloadSeq((s) => s + 1))}
				/>
			)}
			{loadChoice && table && (
				<LoadFileModal
					connectionId={connectionId}
					driver={driver}
					schema={table.schema}
					table={table.name}
					choice={loadChoice}
					onClose={() => setLoadChoice(null)}
					onLoaded={() => setReloadSeq((s) => s + 1)}
				/>
			)}
			{bigEdit && (
				<CellValueEditor
					columnName={bigEdit.columnName}
					value={bigEdit.value}
					readOnly={!editable}
					onCommit={(value) => {
						if (bigEdit.row < realRowCount) {
							editing.editRow(bigEdit.row, bigEdit.col, value);
						} else {
							editing.editInsert(bigEdit.row - realRowCount, bigEdit.col, value);
						}
					}}
					onClose={() => setBigEdit(null)}
				/>
			)}
		</div>
	);
}

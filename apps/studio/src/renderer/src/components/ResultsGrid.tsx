/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../formatBytes';
import { Icon } from './Icon';
import { ResultsArt } from '../art/Illustrations';
import { formatShortcut } from '../shortcuts';
import { CellValueEditor } from './CellValueEditor';
import { DataGrid, FULL_WRAP_MAX_ROWS, cellText, computeColumnWidths, type GridFk, type SortState, type WrapMode } from './DataGrid';
import { GridEditToolbar } from './GridEditToolbar';
import { lockProdEditing, unlockProdEditing, useProdUnlocked } from '../prodUnlock';
import { RecordView } from './RecordView';
import { LogView } from './LogView';
import { SaveChangesModal } from './SaveChangesModal';
import { useGridEditing } from '../useGridEditing';
import { useGridSaveShortcut } from '../useGridSaveShortcut';
import { useFkLookup } from '../useFkLookup';
import { useCapabilities } from '../capabilities/useCapability';
import { publishGrid } from '../gridBridge';
import type { CapabilityResult } from '../../../shared/capabilities';
import type { CapabilityHandler } from '../capabilities/registry';
import { defaultAction, generateRowSql, isCellExpr, NULL_VALUE, type RowSqlKind } from '../dml';
import { logShapeOf } from '../logLine';
import type { RunLogsQuery } from '../logContext';
import { buildDocumentUpdate, type DocumentFieldEdit } from '../mongoDml';
import type { AmbientCell } from '../../../shared/ai';
import { looksLikeConnectionLoss, policyFor, type ConnectionPolicy, type MongoWrite } from '../../../shared/engine';
import type { ExecuteQueryResult } from '../../../shared/protocol';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../shared/schema';

// The query results view: a virtualized DataGrid plus header-click
// sorting and a footer with row/time details + a client-side paginator. The whole
// result set is in memory, so sorting and paging are done here over an index array.
// 0 means "All rows on one page".
const PAGE_SIZES = [10, 25, 50, 100, 0];
const DEFAULT_PAGE_SIZE = 100;
// How many lines a row gets in the middle wrap state. Uniform across rows, so it is a
// compromise: tall enough that a paragraph is readable in place, short enough that a screen
// still shows a useful number of rows. The third state ('full') drops the compromise and gives
// every row the height its own value needs.
const WRAP_LINES = 4;
const WRAP_KEY = 'positron-db.gridWrap';
/** Off → a few lines → every row as tall as it needs. The footer button cycles these. */
const WRAP_ORDER: WrapMode[] = ['off', 'lines', 'full'];

function loadWrap(): WrapMode {
	try {
		const stored = localStorage.getItem(WRAP_KEY);
		return WRAP_ORDER.includes(stored as WrapMode) ? stored as WrapMode : 'off';
	} catch {
		return 'off';
	}
}

/** What the footer's wrap button says it will do next, and what it is doing now. */
function wrapTitle(mode: WrapMode, pageRows: number): string {
	if (mode === 'off') {
		return `Wrap long text over ${WRAP_LINES} lines (click again to expand every row to fit)`;
	}
	if (mode === 'lines') {
		return `Wrapping over ${WRAP_LINES} lines. Click to expand every row to fit its whole value.`;
	}
	return pageRows > FULL_WRAP_MAX_ROWS
		? `Too many rows on this page to expand each one, so they stay ${WRAP_LINES} lines. Click for single-line rows.`
		: "Rows expanded to fit their whole value. Click for single-line rows.";
}

function saveWrap(mode: WrapMode): void {
	try {
		localStorage.setItem(WRAP_KEY, mode);
	} catch {
		// ignore storage failures — the toggle still works for this session
	}
}

/** The unrestricted reading, so callers without a prod connection need not pass a policy. */
const DEFAULT_POLICY = policyFor(undefined);

// Caps for the get_query_result AI capability (the precise, on-demand read of the loaded rows).
// Modest defaults so a single call can't blow the model's context (the tool layer also caps the
// serialized result); the model pages with offset/limit for more.
const GET_RESULT_DEFAULT_ROWS = 30;
const GET_RESULT_MAX_ROWS = 100;
const GET_RESULT_CELL_CHARS = 200;

/** How the result is presented: the table grid, the log reader, a single-record vertical view,
 *  that record as JSON, or an expandable document tree. Record/JSON/tree are DBeaver/Compass-style
 *  read-only views over one row at a time (the tree is the nested-document viewer);
 *  `log` is the stream reader a telemetry result opens in (see {@link LogView}). */
type ViewMode = 'grid' | 'log' | 'record' | 'json' | 'tree';

// Stable per-result identity for the grid's scroll-reset key (objects don't stringify).
let resultSeq = 0;

/** Treat null/undefined/empty-string as "no value" for sorting. */
function isEmpty(value: unknown): boolean {
	return value === null || value === undefined || value === '';
}

/** Numeric view of a value, or NaN if it isn't a number. */
function asNumber(value: unknown): number {
	return typeof value === 'number' ? value : Number(value);
}

/** A display slot: an existing result row (by original index) or a pending insert (by its
 *  index in the editing hook's `inserts`). The grid renders these in order, so a duplicate
 *  can sit directly below its source row instead of at the very end. */
type Slot = { orig: number } | { insert: number };

/** A client-side row filter. `=`/`<>` are exact (string) equality; `contains` is a
 *  case-insensitive substring match (e.g. a year against a timestamp). The cell right-click
 *  uses `=`/`<>`; `contains` is reachable via the AI filter capability. */
interface CellFilter { col: number; op: '=' | '<>' | 'contains'; value: unknown; }

/** Does a cell value satisfy the active filter? Null compares via IS [NOT] NULL; otherwise an
 *  exact or substring string match, matching how the grid renders values. */
function rowMatchesFilter(value: unknown, filter: CellFilter): boolean {
	if (filter.value === null || filter.value === undefined) {
		const isNull = value === null || value === undefined;
		return filter.op === '<>' ? !isNull : isNull;
	}
	const v = String(value);
	const target = String(filter.value);
	if (filter.op === 'contains') {
		return v.toLowerCase().includes(target.toLowerCase());
	}
	const eq = v === target;
	return filter.op === '=' ? eq : !eq;
}

/** Does any cell in the row contain `query`? A case-insensitive substring match across EVERY
 *  column, against the same text the grid renders (so a JSON document matches on its nested
 *  values, and NULL matches nothing). `query` must already be lowercased by the caller. */
function rowMatchesSearch(row: unknown[], query: string): boolean {
	for (const value of row) {
		const text = cellText(value);
		if (text !== null && text.toLowerCase().includes(query)) {
			return true;
		}
	}
	return false;
}

/** Compare two non-empty cell values: numerically when both look numeric, else by text. */
function compareNonEmpty(a: unknown, b: unknown): number {
	const na = asNumber(a);
	const nb = asNumber(b);
	if (Number.isFinite(na) && Number.isFinite(nb)) {
		return na - nb;
	}
	return String(a).localeCompare(String(b));
}

/** Supplied when the result traces to a single editable table, to enable in-grid editing. */
export interface ResultsGridEdit {
	table: TableInfo;
	driver: string;
	connectionId: string;
	isProd: boolean;
	/** Run the save's batch of statements (one at a time / transactional per driver). */
	onRunScript(connectionId: string, statements: string[]): Promise<{ ok: boolean; error?: string }>;
	/** Run the save's batch of Mongo writes (document backends). */
	onRunWrites(connectionId: string, writes: MongoWrite[]): Promise<{ ok: boolean; error?: string }>;
	/** Re-run the query so the grid reflects saved changes. */
	onReload(): void;
}

interface ResultsGridProps {
	response: ExecuteQueryResult | null;
	/** True while the connection is being (re)established, so the pane shows a spinner here
	 *  where the user is looking, rather than only in the status line above the editor. */
	connecting?: boolean;
	/** The results pane is the foreground view (a SQL editor tab is active, not a table/object
	 *  tab). Gates the Ctrl+S-saves-the-grid shortcut so a hidden-but-dirty grid never grabs it. */
	active?: boolean;
	/** The connection that produced these rows is currently connected. The grid keeps showing
	 *  the rows and already-resolved FK labels regardless, but live actions (cell edit, FK peek,
	 *  navigate) are disabled while this is false — so a dropped connection leaves the grid
	 *  pristine instead of blanking it out. Defaults true. */
	live?: boolean;
	/** When set, an auto-LIMIT of this size was appended to the run (badge in the footer). */
	appliedLimit?: number;
	/**
	 * Fetch the next window of the same query and APPEND it to `response`, resolving with how many
	 * rows arrived and whether more are likely. Present only when the result can be paged past its
	 * cap at all (see the engine's `windowQuery`: a Pinecone result or a self-capped statement
	 * can't be). Absent ⇒ the paginator stays purely client-side, exactly as before.
	 *
	 * This is what keeps "Next" enabled on the last loaded page instead of the grid having to know
	 * the true total: clicking it just tries, and an empty (or short) window retires the button.
	 */
	onFetchMore?(): Promise<{ added: number; more: boolean }>;
	/**
	 * Identity of the RUN behind `response`. Changes only when a new query lands, never when
	 * `onFetchMore` appends rows to the current one, so a fetched window leaves the sort, filter
	 * and page exactly where the user had them. Falls back to the response identity when unset.
	 */
	resultKey?: string;
	/** Present only when the result is editable (single-table SELECT with its PK selected). */
	edit?: ResultsGridEdit | null;
	/** Why this result is NOT editable, when it isn't — shown behind the footer's "Read-only"
	 *  badge. Editing has nine preconditions and used to fail every one of them in silence. */
	notEditableReason?: string;
	/** The result's connection is a `prod` environment. Cosmetic only (warnings, styling). */
	isProd?: boolean;
	/**
	 * The connection's production policy, which decides whether grid actions are offered.
	 * Defaults to the unrestricted (non-prod) reading so the prop stays optional.
	 */
	policy?: ConnectionPolicy;
	/** The active connection's schema, used to resolve foreign-key targets for the peek/labels. */
	schema?: DatabaseSchema | null;
	/** Resolve FK ids to inline labels (the peek card stays available regardless). On by default. */
	resolveFkLabels?: boolean;
	/** Navigate from an FK cell to the referenced row (open a table tab filtered to the key). */
	onNavigateFk?(table: TableInfo, filters: { column: string; value: unknown }[]): void;
	/**
	 * What a TELEMETRY result covered, and how to ask for a different range. Absent on every other
	 * backend, whose queries are not bounded by time.
	 *
	 * `fromSql` false means the range came from the app's default rather than the statement, which
	 * is the one fact an empty log result must not hide.
	 */
	logWindow?: {
		start: number;
		end: number;
		fromSql: boolean;
		/** Whether {@link onRerun} writes the range into the statement (`WHERE ts >= ago('6h')`)
		 *  rather than running it against a window nothing on the screen shows. True for any statement
		 *  the rewrite can be made safely on, which is why a range that came `fromSql` can still be
		 *  changed here: this control wrote it. */
		editsSql?: boolean;
		/** Re-run the same statement over the last `ms`. Absent when there is nothing to re-run
		 *  (a disconnected connection, a result restored from history). */
		onRerun?(ms: number): void;
	};
	/** The true row count ignoring the limit, once computed on demand (null = not yet). */
	totalCount?: number | null;
	/** True while the total is being counted. */
	countingTotal?: boolean;
	/** Run a COUNT(*) for the true total; absent when counting doesn't apply (e.g. non-SELECT). */
	onCountTotal?(): void;
	/** Reconnect + re-run the last query — surfaced as an action button when the error
	 *  reads like a dropped connection (a query that died because the socket was gone,
	 *  not a SQL syntax error the user has to fix themselves). */
	onReconnect?(): void;
	/** Report the focused cell (column + value) and its row to the parent, so the AI can ground
	 *  in "the value the user is looking at" (ambient context). null when nothing is focused. */
	onSelectionChange?(sel: { selectedCell: AmbientCell; selectedRow: AmbientCell[] } | null): void;
	/** Register the AI grid-action capabilities (filter/sort the live results) while mounted —
	 *  set ONLY on the primary results pane, never the pinned-snapshot tab, so the capability
	 *  names register exactly once. */
	aiActions?: boolean;
	/** The result came from a document (MongoDB) backend. Surfaces a per-row "View document" quick
	 *  action that opens the row in the expandable document tree — the Compass-style click affordance
	 *  for nested documents. The tree view is reachable from the footer toggle
	 *  regardless; this just makes it one click from a row. */
	documentView?: boolean;
	/**
	 * The result came from a cloud LOG service, so the pane offers its log READER (see
	 * {@link LogView}) and opens in it.
	 *
	 * Decided by the caller, from the connection's backend kind, rather than here from the column
	 * names: `ts` + `message` is the log contract but it is also a perfectly ordinary pair of
	 * columns on a relational table, and that table belongs in the grid.
	 */
	logView?: boolean;
	/** How the log reader reads the events around a line (its "Surrounding events"): a structured
	 *  query against the connection that produced this result. Absent hides the action. */
	runLogContext?: RunLogsQuery;
}

/*---------------------------------------------------------------------------------------------
 *  A telemetry result's TIME RANGE.
 *
 *  Every log query is bounded, so a log result is not readable without saying when was searched.
 *  The compiler gives a statement that names no range the last hour, which is the right default and
 *  was, until this, completely invisible: an empty grid meant "there is nothing" when it meant
 *  "there is nothing in an hour you did not choose".
 *--------------------------------------------------------------------------------------------*/

/** The ranges the footer offers. Coarse on purpose: these re-run a metered query, so the list is
 *  the handful of answers to "look further back", not a duration picker. */
const LOG_RANGES: { ms: number; label: string }[] = [
	{ ms: 15 * 60_000, label: 'Last 15 minutes' },
	{ ms: 60 * 60_000, label: 'Last hour' },
	{ ms: 6 * 60 * 60_000, label: 'Last 6 hours' },
	{ ms: 24 * 60 * 60_000, label: 'Last 24 hours' },
	{ ms: 7 * 24 * 60 * 60_000, label: 'Last 7 days' },
	{ ms: 30 * 24 * 60 * 60_000, label: 'Last 30 days' },
];

/** How a range reads in the footer: a preset by name, anything else by its length, and a range the
 *  SQL chose by its ends, because that one is a fact about the statement rather than a setting. */
function describeLogWindow(start: number, end: number, fromSql: boolean): string {
	if (fromSql) {
		return `${formatWindowEdge(start)} to ${formatWindowEdge(end)}`;
	}
	const span = end - start;
	const preset = LOG_RANGES.find((range) => Math.abs(range.ms - span) < 60_000);
	return preset ? preset.label.toLowerCase() : `${formatDuration(span)} to ${formatWindowEdge(end)}`;
}

/** An absolute instant, in the reader's own zone, without the date when it is today. */
function formatWindowEdge(at: number): string {
	const date = new Date(at);
	const today = new Date().toDateString() === date.toDateString();
	return today
		? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 90) {
		return `${minutes} min`;
	}
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

export function ResultsGrid({ response, connecting = false, active = true, live = true, appliedLimit, onFetchMore, resultKey, edit, notEditableReason, isProd = false, policy = DEFAULT_POLICY, schema, resolveFkLabels = true, onNavigateFk, totalCount = null, countingTotal = false, onCountTotal, logWindow, onReconnect, onSelectionChange, aiActions = false, documentView = false, logView = false, runLogContext }: ResultsGridProps): JSX.Element {
	const [sort, setSort] = useState<SortState | null>(null);
	const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
	const [page, setPage] = useState(0);
	// View toggle + the active record for the record/JSON views (an index into the full ordered,
	// filtered slot list — not page-relative, so navigating a record walks the whole result).
	const [viewMode, setViewMode] = useState<ViewMode>('grid');
	// Every line of the log reader open at once. A reading preference for the pane, not the result,
	// so it survives paging and a re-run over a different window.
	const [expandAllLines, setExpandAllLines] = useState(false);
	const [recordIndex, setRecordIndex] = useState(0);
	// Client-side row filter from a cell's "Filter to / Exclude this value" action.
	const [filter, setFilter] = useState<CellFilter | null>(null);
	// Free-text search across all columns (the footer box). Independent of `filter`: both apply,
	// so you can search within a filtered column. Like the filter it only sees LOADED rows.
	const [search, setSearch] = useState('');
	// How long cell values are shown: clipped to a line, wrapped over a few, or every row as tall
	// as its own value needs. A grid-wide reading preference, so it is remembered across results
	// and reloads rather than reset per query.
	const [wrap, setWrap] = useState(loadWrap);
	// Read-only "View value…" modal — the whole value of the clicked cell, for grids that can't
	// edit (a wrapped cell still cuts off eventually; this never does).
	const [viewCell, setViewCell] = useState<{ value: string | null; columnName: string; raw?: unknown; dataType?: string } | null>(null);
	// Active "Edit value…" modal — the clicked display slot + column.
	const [bigEdit, setBigEdit] = useState<{ slot: Slot; col: number; value: string | null; columnName: string; raw?: unknown; dataType?: string } | null>(null);
	// Pending nested-field edits from the document tree, awaiting confirm in
	// the save dialog. `write` is the built updateOne; the preview is its shell rendering.
	const [docSave, setDocSave] = useState<{ preview: string; write: MongoWrite } | null>(null);
	const [docSaving, setDocSaving] = useState(false);
	const [docSaveError, setDocSaveError] = useState<string | null>(null);
	// Paging past the loaded rows: `fetching` is the in-flight window, `exhausted` latches once one
	// comes back empty or short. Both reset with the run (see the new-result effect).
	const [fetching, setFetching] = useState(false);
	const [exhausted, setExhausted] = useState(false);

	const result = response && response.ok ? response.result : null;
	const fields = result?.fields ?? [];
	const rows = result?.rows ?? [];
	const resultId = useMemo(() => ++resultSeq, [result]);
	// Identity of the RUN behind these rows, as opposed to `result`'s object identity: appending a
	// fetched window (see `onFetchMore`) necessarily builds a new result object, but it only ADDS
	// rows at the end, leaving every existing row index (and so the sort, filter, page and any
	// pending cell edits) valid. Everything that must survive an append keys on this instead.
	const runKey = resultKey ?? result;
	// Is this result a stream of log EVENTS rather than a table? Non-null carries where the log
	// contract's columns sit, which is everything the reader needs to lay one out.
	// A GROUPED log result is a table: its rows are groups, not events. The driver says so on the
	// result (`cost.grouped`) because a column list cannot — `SELECT message, count(*) … GROUP BY
	// message` has a message column and is nothing like a stream of lines.
	const logShape = useMemo(() => (logView && !result?.cost?.grouped ? logShapeOf(fields) : null), [result, logView]);
	// A log result OPENS in the reader and a table opens in the grid, but only when the kind
	// changes: switching to the grid to sort a column has to survive the next run of the same
	// statement, and re-deciding on every result would take it away again.
	const wasLogShaped = useRef<boolean | null>(null);
	useEffect(() => {
		const isLog = logShape !== null;
		if (wasLogShaped.current !== isLog) {
			wasLogShaped.current = isLog;
			setViewMode(isLog ? 'log' : 'grid');
		}
	}, [logShape]);
	// What is actually drawn. The reader needs the log contract, so a result that lost it (an
	// aggregate, a different connection) falls back to the grid for the render that precedes the
	// effect above rather than drawing nothing.
	const mode: ViewMode = viewMode === 'log' && logShape === null ? 'grid' : viewMode;

	// Widths sample the full result so columns stay stable across pages.
	const widths = useMemo(() => computeColumnWidths(fields, rows.length, (i) => rows[i]), [result]);
	// Per-field column default, matched by name against the editable table's columns — shown
	// muted in new rows so the user sees what the DB will apply if they leave the cell empty.
	const columnDefaults = useMemo<(string | null | undefined)[] | undefined>(() => {
		if (!edit?.table) {
			return undefined;
		}
		const byName = new Map(edit.table.columns.map((c) => [c.name.toLowerCase(), c.default ?? null]));
		return fields.map((f) => byName.get(f.name.toLowerCase()) ?? undefined);
	}, [edit, fields]);
	// The editable table's column metadata, aligned to the result fields by name — drives the
	// type-aware "Set to default" action (date → current time, has-default → DEFAULT, etc.).
	const columnByField = useMemo<(ColumnInfo | undefined)[] | undefined>(() => {
		if (!edit?.table) {
			return undefined;
		}
		const byName = new Map(edit.table.columns.map((c) => [c.name.toLowerCase(), c]));
		return fields.map((f) => byName.get(f.name.toLowerCase()));
	}, [edit, fields]);

	// Order is a permutation of original row indices: filtered first (client-side), then sorted;
	// empties always sink to the bottom.
	const order = useMemo(() => {
		let idx = rows.map((_, i) => i);
		if (filter && filter.col < fields.length) {
			idx = idx.filter((i) => rowMatchesFilter(rows[i][filter.col], filter));
		}
		const query = search.trim().toLowerCase();
		if (query !== '') {
			idx = idx.filter((i) => rowMatchesSearch(rows[i], query));
		}
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
	}, [result, sort, filter, search, fields.length]);

	// Inline editing, when the result traces to a single editable table. Edits are keyed by
	// each row's original index (stable across client-side sort/paging); new rows are appended
	// after the sorted rows. Edits clear when a new result arrives.
	const canEdit = Boolean(edit);
	// Mutating grid actions (edit, set null/default, delete, paste) are always offered on
	// dev/stage; on prod they're hidden until the user opts in via Settings, so a prod result
	// grid is write-locked by default. A dropped connection also makes it look-only (we keep
	// showing the rows, just can't write). Read-only actions (copy cell/row, generate SQL) are
	// never gated — they don't touch the database — so Ctrl+C works on any result, prod included.
	const actionsAllowed = policy.allowsGridActions(live);
	// The prod lock can be lifted for this connection, this session, from the grid itself
	// (`prodUnlock.ts`); the policy App hands in already reflects it.
	const prodUnlocked = useProdUnlocked();
	const unlockConnectionId = edit?.connectionId;
	const prodLocked = canEdit && live && policy.isProduction && !actionsAllowed;
	const prodSessionUnlocked = canEdit && policy.isProduction && unlockConnectionId !== undefined && prodUnlocked.has(unlockConnectionId);
	const editing = useGridEditing(edit?.table, edit?.driver ?? '', fields, rows, runKey);
	// …and a backend with no write path at all (a cloud log service) is never editable, whatever
	// the environment policy says: there is no API to change an ingested event through.
	const editingEnabled = canEdit && actionsAllowed && editing.editable;
	// Why the grid is look-only, in the user's terms. The prod lock is decided here (the policy is
	// this component's); every other reason is decided by the caller, which is the only place that
	// knows the query, the schema and the connection.
	const readOnlyReason = editingEnabled
		? undefined
		: canEdit && !actionsAllowed
			? 'This is a production connection, so editing is locked. Click to allow editing for this session.'
			: !editing.editable
				? 'This backend has no write path: an ingested log event cannot be changed.'
				: notEditableReason;
	// Ctrl+S commits the pending grid edits (opens the DML preview) rather than saving the
	// SQL file, while this pane is the foreground view and has unsaved edits.
	useGridSaveShortcut(active && editingEnabled, editing.dirty, editing.prepareSave);

	// AI grid actions (A4): let the assistant filter/sort the live results so "filter to rows
	// like this" / "sort by date desc" just happen. These are CLIENT-SIDE view operations on the
	// already-fetched rows — no DB round-trip, no persisted state, instantly reversible — so they
	// run without an approval prompt (mutates:false) and the chat reply states what it did, which
	// with the visibly-changed grid is self-evident (no prod/sqlGuard concern; nothing is run).
	// Handlers read the latest state through a ref so the (stable) capability set never goes stale.
	// `order` is the current filtered+sorted permutation of row indices (what the grid shows), so
	// get_query_result can return rows in the order the user is looking at, not raw fetch order.
	const gridActionsRef = useRef({ fields, rows, order, setFilter, setSort, setPage, connectionId: edit?.connectionId });
	gridActionsRef.current = { fields, rows, order, setFilter, setSort, setPage, connectionId: edit?.connectionId };
	const resolveColumn = (name: unknown): number => {
		const want = String(name ?? '').trim().toLowerCase();
		return gridActionsRef.current.fields.findIndex((f) => f.name.toLowerCase() === want);
	};
	const columnList = (): string => gridActionsRef.current.fields.map((f) => f.name).join(', ');
	const gridCapabilities = useMemo<CapabilityHandler[]>(() => [
		{
			spec: {
				name: 'filter_results',
				description: "Filter the result grid currently shown by ONE column, using text comparison on the rows ALREADY LOADED in the grid: operator '=' (exact), '!=' (exclude), or 'contains' (case-insensitive substring — use this for a year against a timestamp, e.g. last_update contains '2026'). Pass value null for IS NULL. IMPORTANT: this is a SINGLE filter that REPLACES any previous one (filters do NOT stack), it only sees the loaded page of rows, and it compares as text. For date/number RANGES, combining MULTIPLE conditions, or filtering the whole table, rewrite the query's WHERE clause and re-run it instead of using this. The result reports how many rows matched — if it's 0, the filter was wrong (e.g. an exact match on a timestamp); try 'contains' or re-run the query.",
				parameters: {
					type: 'object',
					properties: {
						column: { type: 'string', description: 'A column name from the current result.' },
						operator: { type: 'string', enum: ['=', '!=', 'contains'], description: "Match (=), exclude (!=), or substring (contains). Defaults to '='." },
						value: { type: ['string', 'number', 'null'], description: 'The value to match; null means IS NULL.' },
					},
					required: ['column'],
				},
				domain: 'grid',
				mutates: false,
				implicitConnection: 'result',
				returnsData: 'values',
			},
			run: (args, ctx) => {
				const { fields: cols, rows: loaded, setFilter: applyFilter, setPage: goPage, connectionId } = gridActionsRef.current;
				if (cols.length === 0) {
					return { ok: false, summary: '', error: 'No results are loaded to filter.' };
				}
				const col = resolveColumn(args.column);
				if (col < 0) {
					return { ok: false, summary: '', error: `No column "${String(args.column)}" in the result. Columns: ${columnList()}.` };
				}
				const op: '=' | '<>' | 'contains' = args.operator === '!=' ? '<>' : args.operator === 'contains' ? 'contains' : '=';
				const value = args.value === null || args.value === undefined ? null : args.value;
				const next: CellFilter = { col, op, value };
				applyFilter(next);
				goPage(0);
				// Report the matched count so the model (and user) see the real outcome — a 0 here is
				// the signal that an exact match hit a timestamp/number and 'contains' or a re-run is needed.
				const matched = loaded.reduce((n, r) => (rowMatchesFilter(r[col], next) ? n + 1 : n), 0);
				const opLabel = value === null ? `IS ${op === '<>' ? 'NOT ' : ''}NULL` : op === 'contains' ? `contains "${String(value)}"` : `${op === '=' ? '=' : '≠'} ${String(value)}`;
				// The count is read from the rows, so main checks what the AI may see of the database they
				// came from before it is handed on (dataAccess.ts).
				return {
					ok: true,
					summary: `Filtered to ${cols[col].name} ${opLabel} (${matched} of ${loaded.length} loaded rows match). This replaced any previous filter; filters don't stack.`,
					dataConnectionId: connectionId ?? ctx.app.resultConnectionId?.(),
				};
			},
		},
		{
			spec: {
				name: 'sort_results',
				description: 'Sort the result grid currently shown by a column, ascending or descending. Operates on the loaded rows in place. Use a column name from the shown result.',
				parameters: {
					type: 'object',
					properties: {
						column: { type: 'string', description: 'A column name from the current result.' },
						direction: { type: 'string', enum: ['asc', 'desc'], description: "Sort direction; defaults to 'asc'." },
					},
					required: ['column'],
				},
				domain: 'grid',
				mutates: false,
				implicitConnection: 'result',
				returnsData: 'schema',
			},
			run: (args) => {
				const { fields: cols, setSort: applySort } = gridActionsRef.current;
				if (cols.length === 0) {
					return { ok: false, summary: '', error: 'No results are loaded to sort.' };
				}
				const col = resolveColumn(args.column);
				if (col < 0) {
					return { ok: false, summary: '', error: `No column "${String(args.column)}" in the result. Columns: ${columnList()}.` };
				}
				const dir: 'asc' | 'desc' = args.direction === 'desc' ? 'desc' : 'asc';
				applySort({ col, dir });
				return { ok: true, summary: `Sorted the results by ${cols[col].name} ${dir === 'asc' ? 'ascending' : 'descending'}` };
			},
		},
		{
			spec: {
				name: 'clear_results_filter',
				description: 'Remove any filter applied to the result grid, showing all loaded rows again.',
				parameters: { type: 'object', properties: {} },
				domain: 'grid',
				mutates: false,
				implicitConnection: 'result',
				returnsData: 'none',
			},
			run: () => {
				gridActionsRef.current.setFilter(null);
				return { ok: true, summary: 'Cleared the results filter' };
			},
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
	], []);
	useCapabilities(aiActions ? gridCapabilities : []);

	// `get_query_result` is ONE capability, registered statically in capabilities/results.ts, and it
	// reads through here while a grid is on screen (src/renderer/src/gridBridge.ts explains why it is
	// not registered from this component). The rich behaviour — offset/limit, a column subset, and
	// the grid's current filter and sort order — stays here, because it is this component's state.
	const readResult = useCallback((args: Record<string, unknown>): CapabilityResult => {
				const { fields: cols, rows: loaded, order: ordered } = gridActionsRef.current;
				if (cols.length === 0) {
					return { ok: false, summary: '', error: 'No results are loaded to read.' };
				}
				// Pick the column subset (by name, case-insensitive); an unknown name is reported rather
				// than silently dropped so the model can correct it.
				let picked = cols.map((f, i) => ({ name: f.name, index: i }));
				if (Array.isArray(args.columns) && args.columns.length > 0) {
					const want = (args.columns as unknown[]).map((c) => String(c).trim().toLowerCase());
					const missing = want.filter((w) => !cols.some((f) => f.name.toLowerCase() === w));
					if (missing.length > 0) {
						return { ok: false, summary: '', error: `No column(s) "${missing.join('", "')}" in the result. Columns: ${columnList()}.` };
					}
					picked = want.map((w) => { const i = cols.findIndex((f) => f.name.toLowerCase() === w); return { name: cols[i].name, index: i }; });
				}
				const total = ordered.length;
				const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
				const limit = Math.min(GET_RESULT_MAX_ROWS, Math.max(1, Math.floor(Number(args.limit) || GET_RESULT_DEFAULT_ROWS)));
				const slice = ordered.slice(offset, offset + limit);
				const data = slice.map((rowIdx) => {
					const row = loaded[rowIdx];
					const out: Record<string, string> = {};
					for (const { name, index } of picked) {
						const text = cellText(row[index]) ?? 'NULL';
						out[name] = text.length > GET_RESULT_CELL_CHARS ? `${text.slice(0, GET_RESULT_CELL_CHARS)}…` : text;
					}
					return out;
				});
				const end = offset + data.length;
				const summary = total === 0
					? 'The loaded result has no rows.'
					: `Returned rows ${offset + 1}-${end} of ${total} loaded${end < total ? ' (call again with a higher offset for more)' : ''}.`;
				return { ok: true, summary, data: { columns: picked.map((p) => p.name), rows: data, offset, returned: data.length, totalLoaded: total } };
	}, []);

	useEffect(() => {
		if (!aiActions) {
			return;
		}
		publishGrid({ getQueryResult: readResult });
		return () => publishGrid(null);
	}, [aiActions, readResult]);

	// FK value resolution context, pinned to the *current result* rather than the live active
	// connection. If that connection briefly drops (idle cull, reconnect), `edit`/`schema` go
	// null upstream, but the displayed rows haven't changed — so we keep the last-known context
	// for this result and the already-resolved FK labels stay on screen. A new result adopts a
	// fresh context. (Live FK fetches/peeks are still gated by `live` below.)
	const fkCtxRef = useRef<{ result: unknown; connectionId: string; driver: string; sourceTable: TableInfo | null; tables: TableInfo[] }>({ result: undefined, connectionId: '', driver: '', sourceTable: null, tables: [] });
	if (fkCtxRef.current.result !== result) {
		fkCtxRef.current = { result, connectionId: edit?.connectionId ?? '', driver: edit?.driver ?? '', sourceTable: edit?.table ?? null, tables: schema?.tables ?? [] };
	} else {
		if (edit?.connectionId) { fkCtxRef.current.connectionId = edit.connectionId; }
		if (edit?.driver) { fkCtxRef.current.driver = edit.driver; }
		if (edit?.table) { fkCtxRef.current.sourceTable = edit.table; }
		if (schema?.tables?.length) { fkCtxRef.current.tables = schema.tables; }
	}
	const fkCtx = fkCtxRef.current;
	const lookup = useFkLookup({
		connectionId: fkCtx.connectionId,
		driver: fkCtx.driver,
		sourceTable: fkCtx.sourceTable,
		tables: fkCtx.tables,
		fields,
	});
	// FK affordances stay visible (labels render from cache), but anything that hits the DB —
	// resolving new labels, the peek card, navigating to the referenced row — only fires while
	// the connection is live, so a disconnected grid never throws or churns.
	const fk: GridFk | undefined = lookup.anyFk && onNavigateFk ? {
		showLabels: resolveFkLabels,
		isFkColumn: lookup.isFkColumn,
		refTableName: lookup.refTableName,
		fkLabel: lookup.fkLabel,
		requestLabels: live ? lookup.requestLabels : () => undefined,
		requestPeek: live ? lookup.requestPeek : () => undefined,
		peekData: lookup.peekData,
		onNavigate: live ? (col, row) => { const t = lookup.navTarget(col, row); if (t) { onNavigateFk(t.table, t.filters); } } : () => undefined,
	} : undefined;

	// New result: drop a stale sort (its columns may differ) and jump back to page 1. Keyed on the
	// run, not the response object, so a fetched window leaves the view where the user had it.
	useEffect(() => {
		setSort(null);
		setPage(0);
		setFilter(null);
		setSearch('');
		setRecordIndex(0);
		setDocSave(null);
		setDocSaveError(null);
		setExhausted(false);
	}, [runKey]);

	// Persist a batch of nested-field edits from the document tree: build the correctly-pathed
	// updateOne and open the save dialog (reusing the grid's confirm flow, so prod gets the same
	// warning). The edits key on the document's own `_id`.
	function saveDocumentEdits(document: Record<string, unknown>, edits: DocumentFieldEdit[]): void {
		if (!edit?.table || edits.length === 0) {
			return;
		}
		const built = buildDocumentUpdate({ table: edit.table, document, edits });
		if ('error' in built) {
			setDocSave(null);
			setDocSaveError(built.error);
			return;
		}
		setDocSaveError(null);
		setDocSave(built);
	}

	async function runDocumentSave(): Promise<void> {
		if (!edit || !docSave) {
			return;
		}
		setDocSaving(true);
		const res = await edit.onRunWrites(edit.connectionId, [docSave.write]);
		setDocSaving(false);
		if (res.ok) {
			setDocSave(null);
			edit.onReload();
		} else {
			setDocSaveError(res.error ?? 'The write failed.');
		}
	}

	// Tree editing rides the same gate as grid editing (an editable, unlocked, live result).
	const docTreeEditable = documentView && Boolean(edit) && actionsAllowed;

	// The display order, interleaving pending inserts: each slot is either an existing row (by
	// original index) or a pending insert (by its index in `editing.inserts`). A duplicate is
	// anchored to render directly below its source row (DBeaver-style); toolbar-added rows (and
	// any whose anchor was filtered out) fall to the end.
	const slots = useMemo<Slot[]>(() => {
		if (!canEdit || editing.inserts.length === 0) {
			return order.map((orig) => ({ orig }));
		}
		const byAnchor = new Map<number, number[]>();
		const appended: number[] = [];
		editing.inserts.forEach((ins, k) => {
			if (ins.after === null) {
				appended.push(k);
				return;
			}
			const arr = byAnchor.get(ins.after);
			if (arr) { arr.push(k); } else { byAnchor.set(ins.after, [k]); }
		});
		const placed = new Set<number>();
		const out: Slot[] = [];
		for (const orig of order) {
			out.push({ orig });
			const ks = byAnchor.get(orig);
			if (ks) { for (const k of ks) { out.push({ insert: k }); placed.add(k); } }
		}
		for (const k of appended) { out.push({ insert: k }); placed.add(k); }
		// An insert whose anchor row was filtered out would otherwise vanish — keep it at the end.
		editing.inserts.forEach((_ins, k) => { if (!placed.has(k)) { out.push({ insert: k }); } });
		return out;
	}, [order, editing.inserts, canEdit]);

	const total = slots.length;
	const per = pageSize === 0 ? Math.max(total, 1) : pageSize;
	const pageCount = Math.max(1, Math.ceil(total / per));
	const safePage = Math.min(page, pageCount - 1);
	const start = safePage * per;
	const end = Math.min(total, start + per);

	if (connecting) {
		// `connecting` is set only by an explicit Run/Ctrl+Enter that hit a not-yet-connected
		// connection — never by a picker/sidebar connect — so showing it here is the feedback
		// the user is looking for, and a plain connect leaves the grid untouched.
		return <div className="results-message results-connecting"><Icon name="loading" className="codicon-modifier-spin" /> Connecting to the database…</div>;
	}
	if (!response) {
		return (
			<div className="results-empty">
				<ResultsArt className="results-empty-art" />
				<p>Run a query to see its results here.</p>
				<p className="results-empty-keys"><kbd>{formatShortcut('Mod+Enter')}</kbd> runs the statement under the cursor, or the selection.</p>
			</div>
		);
	}
	if (!response.ok) {
		// A dropped socket is recoverable by reconnecting; a real SQL error is something the
		// assistant can fix against the schema. Offer the action that fits the error.
		// A real SQL error can be fixed by the assistant, but that action lives on the failure
		// notification ("Ask AI") so it isn't duplicated here. A dropped socket is recoverable
		// by reconnecting, which only makes sense in-grid against the last query.
		const isConnectionLoss = looksLikeConnectionLoss(response.error);
		const showReconnect = onReconnect && isConnectionLoss;
		return (
			<div className="results-error">
				<span>{response.error}</span>
				{showReconnect && (
					<button type="button" className="secondary results-error-action" onClick={onReconnect}>
						<Icon name="plug" /> Reconnect &amp; retry
					</button>
				)}
			</div>
		);
	}
	// A write (DELETE/INSERT/UPDATE/DDL) returns no columns — the driver carries the
	// affected-row count in `rowCount`. Show that instead of an empty grid + "0 rows".
	if (fields.length === 0) {
		const n = response.result.rowCount;
		return (
			<div className="results-message">
				{n.toLocaleString()} {n === 1 ? 'row' : 'rows'} affected
				<span className="sep"> · </span>{response.result.durationMs} ms
			</div>
		);
	}

	function clickHeader(col: number): void {
		setSort((prev) => {
			if (!prev || prev.col !== col) {
				return { col, dir: 'asc' };
			}
			return prev.dir === 'asc' ? { col, dir: 'desc' } : null;
		});
	}

	// The display slot for a page-relative grid row (existing row or pending insert).
	function slotAt(i: number): Slot | undefined {
		return slots[start + i];
	}

	// Resolve a display slot to its row values (existing row by original index, or a pending insert).
	function rowForSlot(slot: Slot | undefined): unknown[] {
		if (!slot) {
			return [];
		}
		if ('orig' in slot) {
			return canEdit ? editing.displayRow(slot.orig) : rows[slot.orig];
		}
		return editing.displayInsert(slot.insert);
	}

	// Translate a page-relative grid row to either an existing row (by original index) or a
	// pending new row.
	function getRow(i: number): unknown[] {
		return rowForSlot(slotAt(i));
	}

	// Copy a single cell's text (NULL/empty cells copy as an empty string).
	function copyCell(i: number, col: number): void {
		void navigator.clipboard.writeText(cellText(getRow(i)[col]) ?? '');
	}

	// Copy a whole row as tab-separated values (spreadsheet-friendly).
	function copyRow(i: number): void {
		const row = getRow(i);
		void navigator.clipboard.writeText(fields.map((_f, col) => cellText(row[col]) ?? '').join('\t'));
	}

	// "Generate SQL ▸": build a standalone statement for the row and copy it to the clipboard.
	function generateSql(i: number, kind: RowSqlKind): void {
		if (!edit?.table) {
			return;
		}
		void navigator.clipboard.writeText(generateRowSql(kind, edit.table, edit.driver, fields, getRow(i)));
	}

	const atFirst = safePage <= 0;
	const atLast = safePage >= pageCount - 1;
	// On the last loaded page, "Next" may still have somewhere to go: it fetches the next window
	// from the database. No advance knowledge of the total is needed (and none is asked for) —
	// the fetch itself reports whether anything was left.
	const canFetchMore = onFetchMore !== undefined && !exhausted;

	// "Next": advance a page while there are loaded rows to show, otherwise fetch a window and land
	// on the page it created. An empty or short window means we've reached the end, so the button
	// retires itself and the grid is left exactly as it was.
	//
	// Every relative move is computed from `safePage` (the clamped value the user is actually
	// looking at), not from the raw `page` state, so a page index left past the end — by a filter,
	// or by a fetched window whose rows that filter excludes — self-corrects on the next click
	// instead of needing several.
	async function nextPage(): Promise<void> {
		if (!atLast) {
			setPage(Math.min(pageCount - 1, safePage + 1));
			return;
		}
		if (!onFetchMore || fetching) {
			return;
		}
		setFetching(true);
		try {
			const { added, more } = await onFetchMore();
			if (!more) {
				setExhausted(true);
			}
			if (added > 0) {
				// "Rows per page: All" keeps one page, so there's nothing to advance to — the rows
				// simply appear below the ones already shown.
				setPage(pageSize === 0 ? safePage : safePage + 1);
			}
		} finally {
			setFetching(false);
		}
	}
	// The record/JSON views address the full ordered list, not the current page; keep their index
	// in range as the result shrinks (filter/delete).
	const recIdx = Math.min(recordIndex, Math.max(0, total - 1));

	return (
		<>
			{editingEnabled && (
				<GridEditToolbar
					dirty={editing.dirty}
					saving={editing.saving}
					onAddRow={() => { editing.addInsert(); setPage(Number.MAX_SAFE_INTEGER); }}
					onRevert={editing.revert}
					onSave={editing.prepareSave}
				/>
			)}
			{editingEnabled && editing.savePreview === null && editing.saveError && <div className="results-error">{editing.saveError}</div>}
			{filter && (
				<div className="filter-bar">
					<Icon name="filter" className="filter-bar-icon" />
					<span className="filter-clause"><b>{fields[filter.col]?.name}</b> {filter.value === null || filter.value === undefined ? (filter.op === '<>' ? 'IS NOT NULL' : 'IS NULL') : filter.op === 'contains' ? `contains ${String(filter.value)}` : `${filter.op === '=' ? '=' : '≠'} ${String(filter.value)}`}</span>
					<button type="button" className="filter-clear" title="Clear filter" onClick={() => { setFilter(null); setPage(0); }}><Icon name="close" /></button>
				</div>
			)}
			{/* The RESULT's own count, not `total`: a client-side filter that hides every row must not
			    be reported as an empty window. */}
			{logWindow && response.result.rowCount === 0 && (
				<div className="log-empty">
					<Icon name="watch" className="log-empty-icon" />
					<div className="log-empty-text">
						<b>No events {describeLogWindow(logWindow.start, logWindow.end, logWindow.fromSql && !logWindow.editsSql)}.</b>
						{!logWindow.fromSql && (logWindow.editsSql
							? <span> The statement named no time range, so that is what ran. Looking further back writes the range into your SQL, as <code>WHERE ts &gt;= ago('24h')</code>.</span>
							: <span> The statement named no time range, so that is what ran. Look further back, or add a bound of your own with <code>WHERE ts &gt;= ago('24h')</code>.</span>
						)}
					</div>
					{logWindow.onRerun && (
						<div className="log-empty-actions">
							{LOG_RANGES.filter((range) => range.ms > logWindow.end - logWindow.start).slice(0, 3).map((range) => (
								<button key={range.ms} type="button" className="secondary" onClick={() => logWindow.onRerun?.(range.ms)}>{range.label}</button>
							))}
						</div>
					)}
				</div>
			)}
			{mode === 'log' && logShape ? (
				<LogView
					shape={logShape}
					fields={fields}
					count={end - start}
					getRow={getRow}
					rowOffset={start}
					// Everything that decides WHICH rows `getRow` hands back, not just how many. The
					// reader parses its lines once per key, so a key that omitted the search kept the
					// old lines whenever a new search happened to leave the same number of rows —
					// a different row, reading as the one before it.
					resetKey={`${resultId}:${safePage}:${pageSize}:${sort?.col ?? ''}${sort?.dir ?? ''}:${filter ? `${filter.col}${filter.op}${String(filter.value)}` : ''}:${search}`}
					search={search}
					expandAll={expandAllLines}
					context={runLogContext && result?.cost?.scope ? { scope: result.cost.scope, run: runLogContext } : undefined}
					onActiveRow={onSelectionChange ? (i) => {
						if (i === null) {
							onSelectionChange(null);
							return;
						}
						const rowVals = getRow(i);
						const cellVal = (col: number): string => cellText(rowVals[col]) ?? 'NULL';
						onSelectionChange({
							selectedCell: { column: fields[logShape.message]?.name ?? 'message', value: cellVal(logShape.message) },
							selectedRow: fields.map((f, c) => ({ column: f.name, value: cellVal(c) })),
						});
					} : undefined}
				/>
			) : mode === 'grid' ? (
			<DataGrid
				fields={fields}
				rowCount={end - start}
				getRow={getRow}
				widths={widths}
				rowOffset={start}
				sort={sort}
				onSortColumn={editingEnabled && editing.dirty ? undefined : clickHeader}
				resetKey={`${resultId}:${safePage}:${pageSize}`}
				onActiveChange={onSelectionChange ? (cell) => {
					if (!cell) {
						onSelectionChange(null);
						return;
					}
					const rowVals = getRow(cell.row);
					const cellVal = (col: number): string => cellText(rowVals[col]) ?? 'NULL';
					onSelectionChange({
						selectedCell: { column: fields[cell.col]?.name ?? '', value: cellVal(cell.col) },
						selectedRow: fields.map((f, i) => ({ column: f.name, value: cellVal(i) })),
					});
				} : undefined}
				editable={canEdit}
				editLocked={canEdit && !actionsAllowed}
				onUnlock={prodLocked && unlockConnectionId ? () => unlockProdEditing(unlockConnectionId) : undefined}
				onCopyCell={copyCell}
				onCopyRow={copyRow}
				onGenerateSql={edit?.table ? generateSql : undefined}
				isEdited={canEdit ? (i, col) => {
					const slot = slotAt(i);
					if (!slot) { return false; }
					return 'orig' in slot ? editing.isRowEdited(slot.orig, col) : editing.isInsertEdited(slot.insert, col);
				} : undefined}
				rowState={canEdit ? (i) => {
					const slot = slotAt(i);
					if (!slot) { return undefined; }
					if ('insert' in slot) { return 'new'; }
					return editing.isDeleted(slot.orig) ? 'deleted' : undefined;
				} : undefined}
				onEditCell={canEdit ? (i, col, value) => {
					const slot = slotAt(i);
					if (!slot) { return; }
					if ('orig' in slot) { editing.editRow(slot.orig, col, value); }
					else { editing.editInsert(slot.insert, col, value); }
				} : undefined}
				onToggleDelete={canEdit ? (i) => {
					const slot = slotAt(i);
					if (!slot) { return; }
					if ('orig' in slot) { editing.toggleDelete(slot.orig); }
					else { editing.removeInsert(slot.insert); }
				} : undefined}
				columnDefaults={canEdit ? columnDefaults : undefined}
				onDuplicateRow={canEdit ? (i) => {
					const slot = slotAt(i);
					if (slot && 'orig' in slot) {
						editing.duplicateRow(slot.orig); // renders directly below this row via the slot model
					}
				} : undefined}
				onOpenCellEditor={canEdit ? (i, col) => {
					const slot = slotAt(i);
					if (!slot) { return; }
					const row = 'orig' in slot ? editing.displayRow(slot.orig) : editing.displayInsert(slot.insert);
					setBigEdit({ slot, col, value: cellText(row[col]), columnName: fields[col]?.name ?? '', raw: row[col], dataType: fields[col]?.dataType });
				} : undefined}
			defaultActionLabel={canEdit ? (col) => defaultAction(columnByField?.[col])?.label ?? null : undefined}
			onSetDefault={canEdit ? (i, col) => {
				const action = defaultAction(columnByField?.[col]);
				if (!action) { return; }
				const slot = slotAt(i);
				if (!slot) { return; }
				if ('orig' in slot) { editing.editRow(slot.orig, col, action.value); }
				else { editing.editInsert(slot.insert, col, action.value); }
			} : undefined}
			onSetNull={canEdit ? (i, col) => {
				const slot = slotAt(i);
				if (!slot) { return; }
				if ('orig' in slot) { editing.editRow(slot.orig, col, NULL_VALUE); }
				else { editing.editInsert(slot.insert, col, NULL_VALUE); }
			} : undefined}
			onCopyFromAdjacent={canEdit ? (i, col, dir) => {
				const ni = i + dir;
				if (ni < 0 || ni >= end - start) { return; }
				const src = getRow(ni)[col];
				const value = isCellExpr(src) ? src : (cellText(src) ?? '');
				const slot = slotAt(i);
				if (!slot) { return; }
				if ('orig' in slot) { editing.editRow(slot.orig, col, value); }
				else { editing.editInsert(slot.insert, col, value); }
			} : undefined}
			onOrderBy={editingEnabled && editing.dirty ? undefined : (col, dir) => setSort({ col, dir })}
			onFilterByValue={editingEnabled && editing.dirty ? undefined : (i, col, op) => {
				const slot = slotAt(i);
				if (!slot || !('orig' in slot)) { return; }
				setFilter({ col, op, value: rows[slot.orig][col] });
				setPage(0);
			}}
			wrapMode={wrap}
			wrapLines={WRAP_LINES}
			// Shift+Enter / "View value…" — on an editable grid that shortcut already opens the
			// EDITOR, so the viewer is what a read-only grid gets in its place.
			onViewCell={canEdit ? undefined : (i, col) => setViewCell({ value: cellText(getRow(i)[col]), columnName: fields[col]?.name ?? '', raw: getRow(i)[col], dataType: fields[col]?.dataType })}
			fk={fk}
			rowActions={documentView ? [{
				icon: 'json',
				title: 'View document',
				// Jump the one-row tree view to this row (i is page-relative → global slot index).
				onClick: (i) => { setRecordIndex(start + i); setViewMode('tree'); },
			}] : undefined}
			/>
			) : (
				<RecordView
					mode={mode as 'record' | 'json' | 'tree'}
					fields={fields}
					row={rowForSlot(slots[recIdx])}
					index={recIdx}
					total={total}
					onPrev={() => setRecordIndex((i) => Math.max(0, i - 1))}
					onNext={() => setRecordIndex((i) => Math.min(total - 1, i + 1))}
					editable={docTreeEditable}
					onSaveDocument={saveDocumentEdits}
					resetKey={resultId}
				/>
			)}
			<div className="results-footer">
				<div className="view-toggle" role="tablist">
					{logShape && (
						<button type="button" role="tab" aria-selected={mode === 'log'} className={mode === 'log' ? 'active' : ''} title="Log reader (one line per event, expandable)" onClick={() => setViewMode('log')}><Icon name="output" /></button>
					)}
					<button type="button" role="tab" aria-selected={mode === 'grid'} className={mode === 'grid' ? 'active' : ''} title="Grid view" onClick={() => setViewMode('grid')}><Icon name="table" /></button>
					<button type="button" role="tab" aria-selected={mode === 'record'} className={mode === 'record' ? 'active' : ''} title="Record view (one row at a time)" onClick={() => setViewMode('record')}><Icon name="list-selection" /></button>
					<button type="button" role="tab" aria-selected={mode === 'json'} className={mode === 'json' ? 'active' : ''} title="JSON view (active row)" onClick={() => setViewMode('json')}><Icon name="json" /></button>
					<button type="button" role="tab" aria-selected={mode === 'tree'} className={mode === 'tree' ? 'active' : ''} title="Document tree (active row, expandable)" onClick={() => setViewMode('tree')}><Icon name="list-tree" /></button>
				</div>
				{mode === 'log' && (
					<button
						type="button"
						className={`grid-wrap-toggle${expandAllLines ? ' active' : ''}`}
						aria-pressed={expandAllLines}
						title={expandAllLines ? "Every line is open. Click to close them all." : "Open every line (payloads pretty-printed)"}
						onClick={() => setExpandAllLines((on) => !on)}
					><Icon name={expandAllLines ? 'collapse-all' : 'expand-all'} /></button>
				)}
				{mode === 'grid' && (
					<button
						type="button"
						className={`grid-wrap-toggle${wrap === 'off' ? '' : ' active'}`}
						aria-pressed={wrap !== 'off'}
						title={wrapTitle(wrap, end - start)}
						onClick={() => { setWrap((mode) => { const next = WRAP_ORDER[(WRAP_ORDER.indexOf(mode) + 1) % WRAP_ORDER.length]; saveWrap(next); return next; }); }}
					><Icon name={wrap === 'full' ? 'expand-all' : 'word-wrap'} /></button>
				)}
				{/* Free-text search over every column. Not gated on `viewMode`: it narrows `order`,
				    which the record/JSON/tree views walk too. */}
				<div className="grid-search">
					<Icon name="search" className="grid-search-icon" />
					<input
						type="text"
						value={search}
						placeholder="Search"
						aria-label={mode === 'log' ? "Search the loaded lines" : "Search all columns"}
						title={mode === 'log'
							// The reader narrows to the matching LINES, and shows a fragment from around
							// the hit when it is buried in one — so say what it searches, which is the
							// whole event and not only the part the line is showing.
							? "Search the lines loaded in the reader. Matches anywhere in an event, including inside a folded-away payload."
							: "Search all columns of the rows loaded in the grid"}
						onChange={(e) => { setSearch(e.target.value); setPage(0); setRecordIndex(0); }}
					/>
					{search !== '' && (
						<button type="button" className="grid-search-clear" title="Clear search" onClick={() => { setSearch(''); setPage(0); }}><Icon name="close" /></button>
					)}
				</div>
				<span>{total.toLocaleString()} {total === 1 ? 'row' : 'rows'}</span>
				{onCountTotal && (totalCount !== null
					? <span className="total-count" title="True total, ignoring the fetch limit">of {totalCount.toLocaleString()} total</span>
					: <button type="button" className="count-total-btn" disabled={countingTotal} onClick={onCountTotal}>{countingTotal ? 'Counting…' : 'Count total'}</button>
				)}
				<span className="sep">·</span>
				<span>{response.result.durationMs} ms</span>
				{logWindow && (logWindow.onRerun ? (
					<label className="log-range" title={`Searched ${new Date(logWindow.start).toLocaleString()} to ${new Date(logWindow.end).toLocaleString()}. Changing this ${logWindow.editsSql ? "writes the range into the statement and runs it" : "re-runs the statement"}.`}>
						<Icon name="watch" />
						<select
							value={String(LOG_RANGES.find((range) => Math.abs(range.ms - (logWindow.end - logWindow.start)) < 60_000)?.ms ?? '')}
							onChange={(e) => logWindow.onRerun?.(Number(e.target.value))}
						>
							{!LOG_RANGES.some((range) => Math.abs(range.ms - (logWindow.end - logWindow.start)) < 60_000) && (
								<option value="">{describeLogWindow(logWindow.start, logWindow.end, logWindow.fromSql)}</option>
							)}
							{LOG_RANGES.map((range) => <option key={range.ms} value={range.ms}>{range.label}</option>)}
						</select>
					</label>
				) : (
					<span className="limit-badge info" title={`Searched ${new Date(logWindow.start).toLocaleString()} to ${new Date(logWindow.end).toLocaleString()}.`}>
						{describeLogWindow(logWindow.start, logWindow.end, logWindow.fromSql && !logWindow.editsSql)}
					</span>
				))}
				{logWindow && logWindow.fromSql && !logWindow.editsSql && (
					<span className="limit-badge info" title="This range came from the statement, so the control above does not apply to it. Remove the time bound from the WHERE to use it.">from SQL</span>
				)}
				{response.result.cost?.recordsScanned !== undefined && (
					<span className="limit-badge info" title={response.result.cost.recordsMatched !== undefined
						? `${response.result.cost.recordsScanned.toLocaleString()} ${logView ? 'events' : 'rows'} were read to answer this, of which ${response.result.cost.recordsMatched.toLocaleString()} matched. ${response.result.cost.engine ?? ''}`.trim()
						: `${response.result.cost.recordsScanned.toLocaleString()} ${logView ? 'events' : 'rows'} were read to answer this.`}>
						{response.result.cost.recordsScanned.toLocaleString()} scanned
					</span>
				)}
				{response.result.cost?.bytesScanned !== undefined && (
					<span className="limit-badge info" title="Bytes the database read to answer this. On a columnar engine it is what a query costs, whatever the number of rows it returns.">
						{formatBytes(response.result.cost.bytesScanned)} read
					</span>
				)}
				{response.result.cost?.truncated && (
					<span className="limit-badge" title="A cap stopped the read before the end of the range, so this is a prefix of the answer and not all of it. Narrow the range or add a filter.">cut short</span>
				)}
				{readOnlyReason && (prodLocked && unlockConnectionId
					? <button type="button" className="limit-badge limit-badge-btn" title={readOnlyReason} onClick={() => unlockProdEditing(unlockConnectionId)}><Icon name="lock" />Read-only</button>
					: <span className="limit-badge" title={readOnlyReason}>Read-only</span>)}
				{prodSessionUnlocked && unlockConnectionId && (
					<button type="button" className="limit-badge limit-badge-btn" title="Editing is allowed on this production connection until the app restarts. Click to lock it again." onClick={() => lockProdEditing(unlockConnectionId)}><Icon name="unlock" />Editing prod</button>
				)}
				{appliedLimit !== undefined && (
					<span className="limit-badge" title={onFetchMore
						? `Auto-LIMIT ${appliedLimit} was appended. Next past the last row fetches another ${appliedLimit}. Change the size in Settings → Editor & Query.`
						: `Auto-LIMIT ${appliedLimit} was appended. Change it in Settings → Editor & Query.`}>LIMIT {appliedLimit}</span>
				)}
				<span className="spacer" />
				{(mode === 'grid' || mode === 'log') && <div className="paginator">
					<label className="page-size">Rows per page
						<select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
							{PAGE_SIZES.map((n) => <option key={n} value={n}>{n === 0 ? 'All' : n}</option>)}
						</select>
					</label>
					<span className="page-range">{total === 0 ? '0 of 0' : `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}</span>
					<button type="button" className="page-btn first" title="First page" disabled={atFirst} onClick={() => setPage(0)}><span className="pg-bar" /><Icon name="chevron-left" /></button>
					<button type="button" className="page-btn" title="Previous page" disabled={atFirst} onClick={() => setPage(Math.max(0, safePage - 1))}><Icon name="chevron-left" /></button>
					<button type="button" className="page-btn" title={atLast && canFetchMore ? (appliedLimit ? `Fetch the next ${appliedLimit.toLocaleString()} rows` : "Fetch more rows") : "Next page"} disabled={(atLast && !canFetchMore) || fetching} onClick={() => void nextPage()}><Icon name={fetching ? 'loading' : 'chevron-right'} className={fetching ? 'codicon-modifier-spin' : undefined} /></button>
					{/* "Last" stays client-side: jumping to the end of an unknown-length result would mean
					    fetching all of it, so it means the last LOADED page. */}
					<button type="button" className="page-btn last" title="Last loaded page" disabled={atLast} onClick={() => setPage(pageCount - 1)}><Icon name="chevron-right" /><span className="pg-bar" /></button>
				</div>}
			</div>
			{canEdit && edit && editing.savePreview !== null && (
				<SaveChangesModal
					sql={editing.savePreview}
					isProd={edit.isProd}
					saving={editing.saving}
					error={editing.saveError}
					note={editing.saveNote}
					onCancel={editing.cancelSave}
					onRun={() => void editing.applySave((plan) => plan.kind === 'sql' ? edit.onRunScript(edit.connectionId, plan.statements) : edit.onRunWrites(edit.connectionId, plan.writes), edit.onReload)}
				/>
			)}
		{docSave && edit && (
			<SaveChangesModal
				sql={docSave.preview}
				isProd={edit.isProd}
				saving={docSaving}
				error={docSaveError}
				onCancel={() => { setDocSave(null); setDocSaveError(null); }}
				onRun={() => void runDocumentSave()}
			/>
		)}
		{docSave === null && docSaveError && <div className="results-error">{docSaveError}</div>}
		{viewCell && (
			<CellValueEditor
				columnName={viewCell.columnName}
				value={viewCell.value}
				raw={viewCell.raw}
				dataType={viewCell.dataType}
				readOnly
				onCommit={() => {}}
				onClose={() => setViewCell(null)}
			/>
		)}
		{bigEdit && (
			<CellValueEditor
				columnName={bigEdit.columnName}
				value={bigEdit.value}
				raw={bigEdit.raw}
				dataType={bigEdit.dataType}
				onCommit={(value) => {
					if ('orig' in bigEdit.slot) {
						editing.editRow(bigEdit.slot.orig, bigEdit.col, value);
					} else {
						editing.editInsert(bigEdit.slot.insert, bigEdit.col, value);
					}
				}}
				onClose={() => setBigEdit(null)}
			/>
		)}
		</>
	);
}

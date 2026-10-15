/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { FkPeekCard } from './FkPeekCard';
import { isCellExpr } from '../dml';
import { compositeCount } from '../../../shared/cellValue';
import type { FkPeekData } from '../useFkLookup';
import type { QueryField } from '../../../shared/query';

/** Foreign-key resolution the grid renders (inline labels + the hover/right-click peek card).
 *  The parent builds this from {@link useFkLookup}; absent when the result isn't a known table. */
export interface GridFk {
	/** Render the auto-resolved inline label (`id · label`). Off = ids only; the peek card,
	 *  which is an explicit hover/right-click action, stays available regardless. */
	showLabels: boolean;
	isFkColumn(col: number): boolean;
	/** The resolved inline label for a cell value, once known. */
	fkLabel(col: number, value: unknown): string | undefined;
	/** Ask to batch-resolve labels for the currently visible FK cells (debounced). */
	requestLabels(cells: { col: number; value: unknown }[]): void;
	/** Ask to fetch the referenced row for the peek card (`row` is the source row's values, so a
	 *  composite key's parts can be gathered). */
	requestPeek(col: number, row: unknown[]): void;
	peekData(col: number, row: unknown[]): FkPeekData | undefined;
	/** Referenced table name for a column, shown in the peek header. */
	refTableName(col: number): string | undefined;
	/** Navigate to the referenced row (open a filtered tab); `row` is the source row's values. */
	onNavigate(col: number, row: unknown[]): void;
}

// Ported from the original VSCode extension's media/results.js: a single scroll container with
// vertically virtualized rows (only the visible window is in the DOM) so large
// result sets stay responsive. Purely presentational — it owns no data model: the
// parent supplies fields + an index-addressed row accessor and decides what sorting
// and paging mean (client-side for query results, server-side for table browsing).
const ROW_H = 24; // keep in sync with --row-h in styles.css
const CELL_LINE_H = 20; // one wrapped line: --row-h minus the cell's 2px top/bottom padding
const OVERSCAN = 8;
const GUTTER_W = 56;
const COL_OVERSCAN = 3;
const MIN_COL_W = 48; // floor for a drag-resized column
// Cap how much text a single cell paints into the DOM. A longtext/JSON/img value can be
// hundreds of KB; a giant text node is costly to lay out and re-render every scroll frame. The
// full value stays available everywhere it matters (copy, the cell value editor, the record/JSON
// views, and the AI read tools all use the uncapped value) — only the grid cell's display is bounded.
const MAX_CELL_DISPLAY_CHARS = 300;

function capDisplay(text: string, max: number = MAX_CELL_DISPLAY_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// About a screenful of the hover card at 512px wide: what the value peek shows before it ellipsises.
const PEEK_CHARS = 1600;

// "Expand rows to fit" (wrapMode 'full') paints a whole value into a cell, so it needs a far
// higher cap than a one-line cell — but still a cap: a 500 KB blob is a row nothing can read.
// Past this the viewer ("View value…") is what has the rest.
const FULL_CELL_DISPLAY_CHARS = 8000;
// Expanding every row means measuring every row (each one's height is its own), which means
// reading every row's text. Worth it for a page of results; not for a million-row "All" page,
// where the rows fall back to the fixed multi-line height.
export const FULL_WRAP_MAX_ROWS = 5000;
// Horizontal padding + border a cell spends before any text: 8px each side, 1px border.
const CELL_PAD_X = 17;

// Width of one character in the grid's monospace cell font, measured once off a real cell (so a
// theme's font stack, not a guess, decides it). Every cell uses the same font at the same size,
// which is why one number is enough to count wrapped lines without touching the DOM per row.
let cachedCharW = 0;
function cellCharWidth(grid: HTMLElement | null): number {
	if (cachedCharW > 0) {
		return cachedCharW;
	}
	const ctx = document.createElement('canvas').getContext('2d');
	const cell = grid?.querySelector('.grid-body .cell');
	const font = cell ? getComputedStyle(cell).font : '';
	if (!ctx) {
		return 7.2;
	}
	ctx.font = font || '12px monospace';
	const w = ctx.measureText('M'.repeat(50)).width / 50;
	if (w > 0) {
		cachedCharW = w;
	}
	return w > 0 ? w : 7.2;
}

/**
 * How many lines `text` takes in a cell `cols` characters wide — the greedy break `white-space:
 * pre-wrap` + `overflow-wrap: anywhere` performs: at spaces, and inside a word longer than the
 * line. Exact for a monospace font. It is used to SIZE the row, and it is deliberately allowed
 * to run a line over rather than under (the caller floors `cols`): a row that is a line too tall
 * shows blank space, a row that is a line too short hides text, which is the bug being fixed.
 */
export function wrappedLines(text: string, cols: number): number {
	if (cols < 1) {
		return 1;
	}
	let total = 0;
	for (const para of text.split('\n')) {
		let lines = 1;
		let used = 0;
		for (const word of para.split(' ')) {
			const need = word.length + (used > 0 ? 1 : 0);
			if (used + need <= cols) {
				used += need;
				continue;
			}
			// Doesn't fit the line in progress: start a new one, and let a word longer than the
			// whole line spill over as many more as it needs.
			lines++;
			let len = word.length;
			while (len > cols) {
				lines++;
				len -= cols;
			}
			used = len;
		}
		total += lines;
	}
	return total;
}

/** Index of the row containing pixel `y`, given running row-top offsets (binary search). */
function rowAt(offsets: number[], y: number): number {
	let lo = 0;
	let hi = offsets.length - 2; // last row index
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= y) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return Math.max(0, lo);
}

export type SortDir = 'asc' | 'desc';
/** How a long cell value is shown: clipped to one line, wrapped over a few, or in full. */
export type WrapMode = 'off' | 'lines' | 'full';
export interface SortState { col: number; dir: SortDir; }

export function cellText(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

/** Estimate column widths from the header and a sample of rows (8px/char). */
export function computeColumnWidths(fields: QueryField[], rowCount: number, getRow: (index: number) => unknown[]): number[] {
	const sample = Math.min(rowCount, 200);
	return fields.map((field, col) => {
		let longest = String(field.name).length;
		for (let r = 0; r < sample; r++) {
			const text = cellText(getRow(r)[col]);
			if (text && text.length > longest) {
				longest = text.length;
			}
		}
		return Math.min(Math.max(longest * 8 + 16, 60), 400);
	});
}

interface DataGridProps {
	fields: QueryField[];
	rowCount: number;
	getRow(index: number): unknown[];
	/** Column widths (owned by the parent so they stay stable across pages). */
	widths: number[];
	/** Absolute number of the first row, shown in the # gutter (default 0). */
	rowOffset?: number;
	/** Current sort indicator; pass alongside onSortColumn to make headers sortable. */
	sort?: SortState | null;
	onSortColumn?(col: number): void;
	/** Scroll back to the top whenever this changes (page/dataset identity). */
	resetKey?: unknown;
	/** Enable inline editing: double-click a cell to edit, click the # gutter
	 *  to mark a row for deletion. The parent owns the edit/insert/delete state. */
	editable?: boolean;
	/** Editing is supported but currently locked (e.g. a prod connection without the
	 *  inline-edit opt-in): edit menu items render greyed/disabled instead of hidden. */
	editLocked?: boolean;
	/** Lift {@link editLocked} for this session (the prod override). When given, a locked grid's
	 *  menu offers "Allow editing" instead of leaving the user with greyed items only. */
	onUnlock?(): void;
	/** Per-column default value (shown muted in new rows when the user hasn't typed one). */
	columnDefaults?: (string | null | undefined)[];
	/** True for a cell the parent considers changed (edited, or a filled new-row cell). */
	isEdited?(rowIndex: number, colIndex: number): boolean;
	/** Per-row status for styling: a new (inserted) row or one marked for deletion. */
	rowState?(rowIndex: number): 'new' | 'deleted' | undefined;
	/** Commit a cell edit (the raw typed string). */
	onEditCell?(rowIndex: number, colIndex: number, value: string): void;
	/** Toggle a row's delete mark (or drop a new row), from a # gutter click. */
	onToggleDelete?(rowIndex: number): void;
	/** Right-click "Duplicate row" (add-copy): seed a new insert from this row. */
	onDuplicateRow?(rowIndex: number): void;
	/** Right-click "Edit value…": open a multi-line editor for the picked cell. */
	onOpenCellEditor?(rowIndex: number, colIndex: number): void;
	/** Right-click "View value…": open a read-only multi-line viewer for the picked cell (the
	 *  viewer-only counterpart to onOpenCellEditor, for non-editable grids like Query Performance). */
	onViewCell?(rowIndex: number, colIndex: number): void;
	/** Type-aware "Set to default" menu label for a column (e.g. "Set to current time"),
	 *  or null when the column has no sensible default action. Pair with {@link onSetDefault}. */
	defaultActionLabel?(colIndex: number): string | null;
	/** Right-click "Set to default": apply the column's type-aware default to the cell. */
	onSetDefault?(rowIndex: number, colIndex: number): void;
	/** Right-click "Set to NULL": set the cell to an explicit NULL. */
	onSetNull?(rowIndex: number, colIndex: number): void;
	/** "Copy from row above/below" (Ctrl+D / Ctrl+Alt+D): copy the adjacent row's value into
	 *  this cell. `dir` is -1 for the row above, +1 for the row below. */
	onCopyFromAdjacent?(rowIndex: number, colIndex: number, dir: -1 | 1): void;
	/** "Order ascending/descending": sort the whole grid by this column. */
	onOrderBy?(colIndex: number, dir: 'asc' | 'desc'): void;
	/** "Filter to/Exclude this value": restrict the grid by the clicked cell's value. */
	onFilterByValue?(rowIndex: number, colIndex: number, op: '=' | '<>'): void;
	/** Right-click "Copy": copy the clicked cell's text to the clipboard. */
	onCopyCell?(rowIndex: number, colIndex: number): void;
	/** Right-click "Copy row": copy the whole row (tab-separated) to the clipboard. */
	onCopyRow?(rowIndex: number): void;
	/** Right-click "Generate SQL ▸": build a SELECT/INSERT/UPDATE/DELETE for the row and copy
	 *  it to the clipboard. Absent when the result doesn't trace to a single table. */
	onGenerateSql?(rowIndex: number, kind: 'select' | 'insert' | 'update' | 'delete'): void;
	/** Foreign-key resolution: inline labels + the hover/right-click peek card. */
	fk?: GridFk;
	/** Notified whenever the active (focused) cell changes — null when it's cleared (reset/page
	 *  change). Lets the parent surface "the cell the user is looking at" to the AI (ambient
	 *  context) without owning the cursor. */
	onActiveChange?(cell: { row: number; col: number } | null): void;
	/** Optional per-row action buttons, shown in a cell pinned to the right edge of every row (it
	 *  stays in view through horizontal scroll, mirroring the # gutter on the left). The Query
	 *  Performance grid uses this for the per-statement Analyze / Suggest-optimization actions. */
	rowActions?: { icon: string; title: string; onClick(rowIndex: number): void }[];
	/** Header text over the {@link rowActions} column. Defaults to "AI", which is what the two grids
	 *  that had row actions first used them for; a grid whose actions are not AI says so. */
	rowActionsLabel?: string;
	/**
	 * How a long cell value is shown. `off` (the default) clips it to one line. `lines` wraps it
	 * over {@link wrapLines} lines, every row the same height. `full` gives each row the height
	 * ITS OWN longest value needs, so nothing is cut off in the grid at all — the reading mode
	 * an extracted paragraph or a document column wants.
	 *
	 * `full` costs more than the other two: row heights stop being one number, so they are
	 * computed per row from the text (see {@link wrappedLines}) and the rows lay out in normal
	 * flow between two spacers instead of being positioned absolutely. Past
	 * {@link FULL_WRAP_MAX_ROWS} rows it falls back to `lines`.
	 */
	wrapMode?: WrapMode;
	/** Lines a wrapped row gets in `lines` mode (ignored otherwise). */
	wrapLines?: number;
	/** Tooltip on the # gutter when the grid is editable. Defaults to the mark-then-save wording the
	 *  SQL grids use; a grid whose delete is immediate must not promise a save step. */
	deleteHint?: string;
}

export function DataGrid({ fields, rowCount, getRow, widths, rowOffset = 0, sort = null, onSortColumn, resetKey, editable = false, editLocked = false, onUnlock, columnDefaults, isEdited, rowState, onEditCell, onToggleDelete, onDuplicateRow, onOpenCellEditor, onCopyCell, onCopyRow, onGenerateSql, defaultActionLabel, onSetDefault, onSetNull, onCopyFromAdjacent, onOrderBy, onFilterByValue, fk, onActiveChange, rowActions, rowActionsLabel = 'AI', deleteHint = 'Click to mark this row for deletion', onViewCell, wrapMode = 'off', wrapLines = 4 }: DataGridProps): JSX.Element {
	const gridRef = useRef<HTMLDivElement>(null);
	// Width of the sticky right-edge actions cell (28px per icon button + padding), 0 when unused.
	const actionsW = rowActions && rowActions.length > 0 ? rowActions.length * 28 + 8 : 0;
	// The height every row gets in `off` and `lines` mode — wrapping just makes it taller (n lines
	// plus the cell's padding). In `full` mode each row has its own height (`rowHeights` below)
	// and this is only the fallback the row count can push it back to. The header stays one line.
	const rowH = wrapMode !== 'off' && wrapLines > 1 ? wrapLines * CELL_LINE_H + 4 : ROW_H;
	// A wrapped cell paints several lines instead of one, so the per-cell display cap grows with
	// it — otherwise the wrap would run out of text before it ran out of room.
	const cellChars = wrapMode === 'full' ? FULL_CELL_DISPLAY_CHARS
		: wrapMode === 'lines' ? MAX_CELL_DISPLAY_CHARS * Math.max(1, wrapLines)
		: MAX_CELL_DISPLAY_CHARS;
	// Force a re-render on scroll/resize so the visible window recomputes.
	const [, bump] = useReducer((n: number) => n + 1, 0);
	// The cell currently being edited (inline <input>), or null.
	const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
	// User-dragged column-width overrides (col index -> px), layered over the computed `widths`.
	// Cleared whenever a new result recomputes `widths` (see the reset effect below).
	const [widthOverrides, setWidthOverrides] = useState<Record<number, number>>({});
	// Right-click context menu — page-relative coords + which row/cell was clicked.
	const [menu, setMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
	// Which nested flyout (Generate SQL / Edit / Filter & sort / Foreign key) is open, by id.
	const [submenu, setSubmenu] = useState<string | null>(null);
	// The context menu opens at the cursor; near a screen edge it would spill off-screen, so we
	// measure it after layout and clamp left/top back into the viewport before paint.
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	// A submenu opens beside its parent row at the row's height; a tall flyout (e.g. "Edit row")
	// near the bottom would spill off-screen, so we measure it and shift it up. Parent-relative
	// `top` override (null = use the CSS default until measured, kept hidden to avoid a flash).
	const submenuRef = useRef<HTMLDivElement>(null);
	const [submenuTop, setSubmenuTop] = useState<number | null>(null);
	// The selected ("active") cell — drives keyboard navigation and the cell shortcuts.
	const [active, setActive] = useState<{ row: number; col: number } | null>(null);
	// Notify the parent when the active cell changes (for ambient AI context). Held in a ref so
	// the effect fires on `active` changes only, always calling the latest callback — no churn
	// from the parent re-creating the handler each render.
	const onActiveChangeRef = useRef(onActiveChange);
	onActiveChangeRef.current = onActiveChange;
	useEffect(() => {
		onActiveChangeRef.current?.(active);
	}, [active]);
	// The open FK peek card (referenced-row preview), anchored at a cell's link affordance.
	// `rowValues` is the whole source row (a composite key's parts span columns); `value` is the
	// clicked cell's value, shown in the card header.
	const [peek, setPeek] = useState<{ row: number; col: number; value: unknown; rowValues: unknown[]; x: number; y: number } | null>(null);
	// Hover-intent timers so the card opens after a short dwell and survives the gap between
	// the cell affordance and the card itself.
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	function clearPeekTimers(): void {
		if (openTimer.current !== null) { clearTimeout(openTimer.current); openTimer.current = null; }
		if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
	}
	function openPeek(row: number, col: number, value: unknown, anchor: DOMRect): void {
		clearPeekTimers();
		const rowValues = getRow(row);
		fk?.requestPeek(col, rowValues);
		setPeek({ row, col, value, rowValues, x: anchor.left, y: anchor.bottom + 2 });
	}
	function scheduleOpenPeek(row: number, col: number, value: unknown, target: HTMLElement): void {
		if (!fk) { return; }
		const anchor = target.getBoundingClientRect();
		clearPeekTimers();
		openTimer.current = setTimeout(() => openPeek(row, col, value, anchor), 250);
	}
	function scheduleClosePeek(): void {
		if (openTimer.current !== null) { clearTimeout(openTimer.current); openTimer.current = null; }
		closeTimer.current = setTimeout(() => setPeek(null), 200);
	}
	useEffect(() => clearPeekTimers, []);

	// The whole of a value that does not fit its cell, on hover.
	//
	// A grid cell clips to one line, so a JSON log message, a stack trace or a long URL reads as its
	// first forty characters and nothing tells the user there is more. This shows the rest where the
	// eye already is, wrapped over as many lines as it takes, instead of making them open the value
	// viewer to find out whether it was worth opening. Only when the cell is ACTUALLY cut off —
	// measured, not guessed — so a grid of short values never flickers a card.
	const [valuePeek, setValuePeek] = useState<{ text: string; x: number; y: number } | null>(null);
	const valueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	function clearValueTimer(): void {
		if (valueTimer.current !== null) { clearTimeout(valueTimer.current); valueTimer.current = null; }
	}
	function scheduleValuePeek(cell: HTMLElement, full: string, capped: boolean): void {
		clearValueTimer();
		setValuePeek(null);
		// `capped` covers the text the renderer itself shortened (capDisplay); the measurement covers
		// what CSS clipped — horizontally in the default one-line mode, vertically when wrapping.
		if (!capped && cell.scrollWidth <= cell.clientWidth + 1 && cell.scrollHeight <= cell.clientHeight + 1) {
			return;
		}
		const rect = cell.getBoundingClientRect();
		// A hover card is not the value viewer: past about a screenful it says so with an ellipsis
		// rather than growing into a wall the user cannot scroll (it is pointer-transparent) — the
		// rest is a right-click and "View value…" away.
		const shown = full.length > PEEK_CHARS ? `${full.slice(0, PEEK_CHARS)}…` : full;
		valueTimer.current = setTimeout(() => setValuePeek({ text: shown, x: rect.left, y: rect.bottom + 2 }), 450);
	}
	function closeValuePeek(): void {
		clearValueTimer();
		setValuePeek(null);
	}
	useEffect(() => clearValueTimer, []);
	// Active editing is allowed only when editable and not locked; locked still shows the menu
	// items (greyed) so the capability stays discoverable on prod.
	const canEditNow = editable && !editLocked;
	const lockTitle = editLocked ? 'This is a production connection, so editing is locked. Choose "Allow editing" to unlock it for this session.' : undefined;

	// Dismiss the context menu on outside click or Escape.
	useEffect(() => {
		if (!menu) {
			return;
		}
		const onDown = (): void => setMenu(null);
		const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setMenu(null); } };
		window.addEventListener('mousedown', onDown);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('mousedown', onDown);
			window.removeEventListener('keydown', onKey);
		};
	}, [menu]);

	// Clamp the menu inside the viewport once its real size is known (before the browser paints).
	useLayoutEffect(() => {
		if (!menu) { setMenuPos(null); return; }
		const el = menuRef.current;
		if (!el) { return; }
		const rect = el.getBoundingClientRect();
		const margin = 4;
		let x = menu.x;
		let y = menu.y;
		if (x + rect.width > window.innerWidth - margin) { x = Math.max(margin, window.innerWidth - rect.width - margin); }
		if (y + rect.height > window.innerHeight - margin) { y = Math.max(margin, window.innerHeight - rect.height - margin); }
		setMenuPos({ x, y });
	}, [menu]);

	// Clamp the open submenu vertically: measure its height (independent of the applied offset)
	// and shift it up so it can't spill past the bottom of the viewport.
	useLayoutEffect(() => {
		if (!submenu) { setSubmenuTop(null); return; }
		const el = submenuRef.current;
		const parent = el?.parentElement;
		if (!el || !parent) { return; }
		const pRect = parent.getBoundingClientRect();
		const height = el.offsetHeight;
		const margin = 4;
		let viewTop = pRect.top - 5; // the CSS default (top: -5px) in viewport coords
		if (viewTop + height > window.innerHeight - margin) { viewTop = window.innerHeight - margin - height; }
		if (viewTop < margin) { viewTop = margin; }
		setSubmenuTop(Math.round(viewTop - pRect.top));
	}, [submenu, menuPos]);

	useEffect(() => {
		const el = gridRef.current;
		if (!el) {
			return;
		}
		// Coalesce scroll into at most one re-render per animation frame. A fast wheel/trackpad
		// fires many scroll events per frame, and each render walks the whole visible window
		// (rows × columns), so re-rendering per event drops frames on wide or large results.
		let raf: number | null = null;
		const onScroll = (): void => {
			clearPeekTimers();
			setPeek(null);
			if (raf !== null) {
				return;
			}
			raf = requestAnimationFrame(() => { raf = null; bump(); });
		};
		el.addEventListener('scroll', onScroll);
		const observer = new ResizeObserver(() => bump());
		observer.observe(el);
		return () => {
			el.removeEventListener('scroll', onScroll);
			observer.disconnect();
			if (raf !== null) { cancelAnimationFrame(raf); }
		};
	}, []);

	// Reset scroll to the top (and drop any open editor) whenever the page/dataset changes.
	useEffect(() => {
		if (gridRef.current) {
			gridRef.current.scrollTop = 0;
		}
		setEditing(null);
		setActive(null);
		clearPeekTimers();
		setPeek(null);
	}, [resetKey]);

	// Computed widths with the user's drag-resize overrides applied. Everything below (layout,
	// virtualization, per-cell width) uses these, so a resized column is reflected everywhere.
	const effectiveWidths = useMemo(() => widths.map((w, i) => widthOverrides[i] ?? w), [widths, widthOverrides]);
	// A new result recomputes `widths` (new column set) — drop any stale overrides so they don't
	// bleed onto a different result's columns.
	useEffect(() => { setWidthOverrides({}); }, [widths]);

	// Cumulative left edge of each column (index 0..n), for horizontal virtualization. colOffsets[c]
	// is the x where column c starts; colOffsets[n] is the total columns width (excludes the gutter).
	const colOffsets = useMemo(() => {
		const offs = new Array<number>(effectiveWidths.length + 1);
		offs[0] = 0;
		for (let c = 0; c < effectiveWidths.length; c++) {
			offs[c + 1] = offs[c] + (effectiveWidths[c] ?? 0);
		}
		return offs;
	}, [effectiveWidths]);

	// `full` mode: one height per row, computed from the row's own text at the current column
	// widths. Rows then lay out in normal flow (so a row is never SHORTER than its content, even
	// if this count is a line out) and these heights are what the spacers above and below the
	// visible window are made of. Recomputed when the data (resetKey), the row count or a column
	// width changes — an inline cell edit doesn't resize its row until one of those does, which
	// is fine for a reading mode.
	const rowHeights = useMemo(() => {
		if (wrapMode !== 'full' || rowCount === 0 || rowCount > FULL_WRAP_MAX_ROWS) {
			return null;
		}
		const charW = cellCharWidth(gridRef.current);
		const cols = effectiveWidths.map((w) => Math.max(1, Math.floor(((w ?? 0) - CELL_PAD_X) / charW)));
		const heights = new Array<number>(rowCount);
		for (let i = 0; i < rowCount; i++) {
			const row = getRow(i);
			let lines = 1;
			for (let c = 0; c < cols.length; c++) {
				const cur = row[c];
				const text = isCellExpr(cur) ? cur.display : cellText(cur);
				if (text === null || text.length === 0) {
					continue;
				}
				const n = wrappedLines(capDisplay(text, cellChars), cols[c]);
				if (n > lines) {
					lines = n;
				}
			}
			heights[i] = lines * CELL_LINE_H + 4;
		}
		return heights;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `getRow` is re-created every
		// render; `resetKey` is the parent's statement that the rows behind it changed.
	}, [wrapMode, rowCount, effectiveWidths, cellChars, resetKey]);

	// Running top edge of every row (index 0..n), the variable-height twin of `colOffsets`.
	const rowOffsets = useMemo(() => {
		if (!rowHeights) {
			return null;
		}
		const offs = new Array<number>(rowHeights.length + 1);
		offs[0] = 0;
		for (let i = 0; i < rowHeights.length; i++) {
			offs[i + 1] = offs[i] + rowHeights[i];
		}
		return offs;
	}, [rowHeights]);

	const el = gridRef.current;
	const scrollTop = el?.scrollTop ?? 0;
	const clientH = el?.clientHeight ?? 0;
	// The visible row window. With uniform rows it is division; with per-row heights it is a
	// binary search over the running offsets.
	const first = rowOffsets
		? Math.max(0, rowAt(rowOffsets, scrollTop) - OVERSCAN)
		: Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
	const last = rowOffsets
		? Math.min(rowCount, rowAt(rowOffsets, scrollTop + clientH) + 1 + OVERSCAN)
		: Math.min(rowCount, Math.ceil((scrollTop + clientH) / rowH) + OVERSCAN);
	const totalH = rowOffsets ? rowOffsets[rowCount] : rowCount * rowH;

	const visible: number[] = [];
	for (let i = first; i < last; i++) {
		visible.push(i);
	}

	// Visible COLUMN window — horizontal virtualization, the mirror of the row window above. A
	// `select *` on a 50+ column table would otherwise paint every column of every visible row;
	// here we render only the on-screen columns, with leading/trailing spacers preserving the
	// total width so the horizontal scrollbar extent stays stable. The sticky # gutter overlays
	// the left edge; COL_OVERSCAN covers the columns it hides.
	const scrollLeft = el?.scrollLeft ?? 0;
	const clientW = el?.clientWidth ?? 0;
	let firstCol = 0;
	while (firstCol < widths.length && colOffsets[firstCol + 1] <= scrollLeft) {
		firstCol++;
	}
	let lastCol = firstCol;
	while (lastCol < widths.length && colOffsets[lastCol] < scrollLeft + clientW) {
		lastCol++;
	}
	firstCol = Math.max(0, firstCol - COL_OVERSCAN);
	lastCol = Math.min(widths.length, lastCol + COL_OVERSCAN);
	const leadW = colOffsets[firstCol];
	const trailW = colOffsets[widths.length] - colOffsets[lastCol];
	const visibleCols: number[] = [];
	for (let c = firstCol; c < lastCol; c++) {
		visibleCols.push(c);
	}

	// Resolve inline FK labels for just the visible window (the hook batches + debounces, and
	// skips anything already cached), so scrolling a huge result never bulk-resolves.
	useEffect(() => {
		if (!fk || !fk.showLabels) {
			return;
		}
		const cells: { col: number; value: unknown }[] = [];
		for (let i = first; i < last; i++) {
			const row = getRow(i);
			for (let col = 0; col < fields.length; col++) {
				if (fk.isFkColumn(col)) {
					const v = row[col];
					if (!isCellExpr(v) && v !== null && v !== undefined) {
						cells.push({ col, value: v });
					}
				}
			}
		}
		if (cells.length > 0) {
			fk.requestLabels(cells);
		}
	}, [fk, first, last, resetKey, rowCount]);

	function ensureRowVisible(row: number): void {
		const node = gridRef.current;
		if (!node) {
			return;
		}
		// In `full` mode the rows have their own heights, so the row's top and height come from
		// the offsets rather than from one number.
		const top = rowOffsets ? rowOffsets[row] : row * rowH;
		const h = rowHeights ? rowHeights[row] : rowH;
		const headerH = ROW_H; // the sticky header overlaps one row's height
		if (top < node.scrollTop) {
			node.scrollTop = top;
		} else if (top + h > node.scrollTop + node.clientHeight - headerH) {
			node.scrollTop = top + h + headerH - node.clientHeight;
		}
	}

	// Keep the active column on screen when keyboard nav lands on a horizontally-virtualized
	// column (off-screen columns aren't in the DOM, so without this the active cell would vanish).
	function ensureColVisible(col: number): void {
		const node = gridRef.current;
		if (!node) {
			return;
		}
		const left = colOffsets[col];
		const right = colOffsets[col + 1];
		if (left < node.scrollLeft + GUTTER_W) {
			node.scrollLeft = Math.max(0, left - GUTTER_W);
		} else if (right > node.scrollLeft + node.clientWidth) {
			node.scrollLeft = right - node.clientWidth;
		}
	}

	function moveActive(dRow: number, dCol: number): void {
		if (rowCount === 0 || fields.length === 0) {
			return;
		}
		setActive((prev) => {
			const base = prev ?? { row: 0, col: 0 };
			const row = Math.max(0, Math.min(rowCount - 1, base.row + dRow));
			const col = Math.max(0, Math.min(fields.length - 1, base.col + dCol));
			ensureRowVisible(row);
			ensureColVisible(col);
			return { row, col };
		});
	}

	// Drag a header column's right edge to resize it. Tracks the pointer on window listeners so the
	// drag continues outside the handle; the override is layered over the computed width and floored
	// at MIN_COL_W. preventDefault/stopPropagation keep the drag from triggering the header's sort.
	function startResize(col: number, e: import('react').MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startW = effectiveWidths[col];
		const onMove = (ev: MouseEvent): void => {
			const w = Math.max(MIN_COL_W, Math.round(startW + (ev.clientX - startX)));
			setWidthOverrides((prev) => (prev[col] === w ? prev : { ...prev, [col]: w }));
		};
		const onUp = (): void => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			document.body.classList.remove('col-resizing');
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		document.body.classList.add('col-resizing');
	}

	// Keyboard model on the focused grid: arrows move the active cell; Enter/F2 edit it inline;
	// Shift+Enter opens the value editor; Ctrl+Backspace / Delete / Ctrl+(Alt+)D mirror the menu.
	function onGridKeyDown(e: import('react').KeyboardEvent<HTMLDivElement>): void {
		if (editing) {
			return; // the inline <input> owns its own keys
		}
		switch (e.key) {
			case 'ArrowDown': e.preventDefault(); moveActive(1, 0); return;
			case 'ArrowUp': e.preventDefault(); moveActive(-1, 0); return;
			case 'ArrowLeft': e.preventDefault(); moveActive(0, -1); return;
			case 'ArrowRight': e.preventDefault(); moveActive(0, 1); return;
			default: break;
		}
		const a = active;
		if (!a) {
			return;
		}
		const state = rowState?.(a.row);
		const mod = e.ctrlKey || e.metaKey;
		if (e.key === 'Enter' && e.shiftKey) {
			if (canEditNow && onOpenCellEditor) { e.preventDefault(); onOpenCellEditor(a.row, a.col); }
			else if (onViewCell) { e.preventDefault(); onViewCell(a.row, a.col); }
		} else if ((e.key === 'Enter' || e.key === 'F2') && canEditNow && state !== 'deleted') {
			e.preventDefault();
			setEditing({ row: a.row, col: a.col });
		} else if (mod && e.altKey && (e.key === 'd' || e.key === 'D')) {
			if (canEditNow && onCopyFromAdjacent) { e.preventDefault(); onCopyFromAdjacent(a.row, a.col, 1); }
		} else if (mod && e.altKey && e.key === 'Insert') {
			if (canEditNow && onDuplicateRow) { e.preventDefault(); onDuplicateRow(a.row); }
		} else if (mod && (e.key === 'd' || e.key === 'D')) {
			if (canEditNow && onCopyFromAdjacent) { e.preventDefault(); onCopyFromAdjacent(a.row, a.col, -1); }
		} else if (mod && (e.key === 'c' || e.key === 'C')) {
			if (onCopyCell) { e.preventDefault(); onCopyCell(a.row, a.col); }
		} else if (mod && (e.key === 'v' || e.key === 'V')) {
			if (canEditNow && onEditCell) { e.preventDefault(); void pasteCell(a.row, a.col); }
		} else if (mod && e.key === 'Backspace') {
			if (canEditNow && onSetDefault) { e.preventDefault(); onSetDefault(a.row, a.col); }
		} else if (e.altKey && e.key === 'Delete') {
			if (canEditNow && onToggleDelete) { e.preventDefault(); onToggleDelete(a.row); }
		} else if (e.key === 'Delete') {
			if (canEditNow && onSetNull && state !== 'deleted') { e.preventDefault(); onSetNull(a.row, a.col); }
		}
	}

	async function pasteCell(row: number, col: number): Promise<void> {
		if (!onEditCell) {
			return;
		}
		try {
			const text = await navigator.clipboard.readText();
			onEditCell(row, col, text);
		} catch {
			// clipboard read denied/unavailable — ignore
		}
	}

	return (
		<>
		<div
			className={`grid${wrapMode !== 'off' ? ' grid-wrap' : ''}${rowHeights ? ' grid-wrap-full' : ''}`}
			ref={gridRef}
			tabIndex={0}
			onKeyDown={onGridKeyDown}
			style={wrapMode !== 'off' ? ({ '--row-h-wrap': `${rowH}px` } as CSSProperties) : undefined}
		>
			<div className="grid-head">
				<div className="cell head-cell gutter" style={{ width: GUTTER_W }}>#</div>
				{leadW > 0 && <div style={{ flex: '0 0 auto', width: leadW }} />}
				{visibleCols.map((col) => (
					<div
						className={`cell head-cell${onSortColumn ? ' sortable' : ''}${sort?.col === col ? ' sorted' : ''}`}
						style={{ width: effectiveWidths[col] }}
						key={col}
						onClick={onSortColumn ? () => onSortColumn(col) : undefined}
						title={onSortColumn ? 'Click to sort' : undefined}
					>
						<span className="head-label">{fields[col].name}</span>
						{sort?.col === col && <Icon name={sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'} className="sort-caret" />}
						<div
							className="col-resizer"
							title="Drag to resize column"
							onMouseDown={(e) => startResize(col, e)}
							onClick={(e) => e.stopPropagation()}
							onDoubleClick={(e) => { e.stopPropagation(); setWidthOverrides((prev) => { const next = { ...prev }; delete next[col]; return next; }); }}
						/>
					</div>
				))}
				{trailW > 0 && <div style={{ flex: '0 0 auto', width: trailW }} />}
				{actionsW > 0 && <div className="cell head-cell grid-row-actions" style={{ width: actionsW }}>{rowActionsLabel}</div>}
			</div>
			<div className="grid-body" style={{ height: rowHeights ? undefined : totalH }}>
				{/* Variable-height rows lay out in normal flow, with a spacer standing in for the
				    rows above and below the window — the vertical mirror of the column spacers.
				    That way a row is sized by its own content and can never be cut short by a
				    height computed for it. */}
				{rowOffsets && <div style={{ height: rowOffsets[first] }} />}
				{visible.map((i) => {
					const row = getRow(i);
					const state = rowState?.(i);
					const isNew = state === 'new';
					return (
						<div
							className={`row${state ? ` row-${state}` : ''}`}
							style={rowHeights ? { minHeight: rowHeights[i] } : { top: i * rowH }}
							key={i}
						>
							<div
								className={`cell gutter${canEditNow ? ' deletable' : ''}`}
								style={{ width: GUTTER_W }}
								onClick={canEditNow ? () => onToggleDelete?.(i) : undefined}
								title={canEditNow ? deleteHint : undefined}
							>
								{isNew ? '✱' : rowOffset + i + 1}
							</div>
							{leadW > 0 && <div style={{ flex: '0 0 auto', width: leadW }} />}
							{visibleCols.map((col) => {
								if (canEditNow && editing && editing.row === i && editing.col === col) {
									const cur = row[col];
									const text = isCellExpr(cur) ? '' : cellText(cur);
									return (
										<input
											className="cell cell-input"
											style={{ width: effectiveWidths[col] }}
											defaultValue={text ?? ''}
											autoFocus
											key={col}
											onKeyDown={(e) => {
												e.stopPropagation();
												if (e.key === 'Enter') {
													e.preventDefault();
													onEditCell?.(i, col, e.currentTarget.value);
													setEditing(null);
												} else if (e.key === 'Escape') {
													e.preventDefault();
													setEditing(null);
												}
											}}
											onBlur={(e) => { onEditCell?.(i, col, e.currentTarget.value); setEditing(null); }}
										/>
									);
								}
								const cur = row[col];
								const expr = isCellExpr(cur) ? cur : null;
								const text = expr ? null : cellText(cur);
								const edited = isEdited?.(i, col) ? ' cell-edited' : '';
								const showDefault = isNew && text === null && columnDefaults?.[col] != null;
								const display = expr ? expr.display : text === null ? (showDefault ? String(columnDefaults![col]) : 'NULL') : capDisplay(text, cellChars);
								const isFk = Boolean(fk && !expr && cur !== null && cur !== undefined && fk.isFkColumn(col));
								// A value with structure inside it (a ClickHouse Array/Map/Tuple/JSON, a Postgres
								// array or jsonb, a Mongo document) says how much is in there, and the count opens
								// the tree. Only for a value the driver already handed over as one: parsing every
								// string that looks like JSON, on every cell, on every scroll, is not worth it.
								const inner = !expr && cur !== null && typeof cur === 'object' ? compositeCount(cur) : undefined;
								const fkLabel = isFk && fk!.showLabels ? fk!.fkLabel(col, cur) : undefined;
								const cls = (expr ? ' cell-placeholder' : '') + (text === null && !showDefault && !expr ? ' null' : '') + (showDefault ? ' cell-placeholder' : '') + edited + (isFk ? ' cell-fk' : '') + (inner !== undefined ? ' cell-inner' : '') + (active && active.row === i && active.col === col ? ' cell-active' : '');
								return (
									<div
										className={`cell${cls}`}
										style={{ width: effectiveWidths[col] }}
										key={col}
										onClick={() => setActive({ row: i, col })}
										onMouseEnter={text === null || expr ? undefined : (e) => scheduleValuePeek(e.currentTarget, text, display !== text)}
										onMouseLeave={text === null || expr ? undefined : closeValuePeek}
										title={expr ? expr.display : showDefault ? `Column default: leave blank to use "${columnDefaults![col]}"` : fkLabel ? `${display} · ${fkLabel}` : undefined}
										onDoubleClick={canEditNow && state !== 'deleted' ? () => setEditing({ row: i, col }) : undefined}
										onContextMenu={(onCopyCell || onCopyRow || onGenerateSql || onOrderBy || onFilterByValue || editable || isFk || onViewCell) ? (e) => { e.preventDefault(); e.stopPropagation(); setActive({ row: i, col }); setSubmenu(null); setMenu({ row: i, col, x: e.clientX, y: e.clientY }); } : undefined}
									>
										<span className="cell-text">{display}</span>
										{inner !== undefined && (
											<span
												className="cell-count"
												title={onViewCell ? "Open this value as a tree" : `${inner} inside`}
												onClick={onViewCell ? (e) => { e.stopPropagation(); onViewCell(i, col); } : undefined}
											>{inner}</span>
										)}
										{fkLabel && <span className="fk-label"> · {fkLabel}</span>}
										{isFk && (
											<span
												className="fk-link"
												title="Peek referenced row"
												onMouseEnter={(e) => scheduleOpenPeek(i, col, cur, e.currentTarget)}
												onMouseLeave={scheduleClosePeek}
												onClick={(e) => { e.stopPropagation(); openPeek(i, col, cur, e.currentTarget.getBoundingClientRect()); }}
											>
												<Icon name="references" />
											</span>
										)}
									</div>
								);
							})}
							{trailW > 0 && <div style={{ flex: '0 0 auto', width: trailW }} />}
							{actionsW > 0 && (
								<div className="cell grid-row-actions" style={{ width: actionsW }}>
									{rowActions!.map((a, k) => (
										<button
											type="button"
											key={k}
											className="row-action-btn"
											title={a.title}
											onMouseDown={(e) => e.stopPropagation()}
											onClick={(e) => { e.stopPropagation(); a.onClick(i); }}
										>
											<Icon name={a.icon} />
										</button>
									))}
								</div>
							)}
						</div>
					);
				})}
				{rowOffsets && <div style={{ height: totalH - rowOffsets[last] }} />}
			</div>
		</div>
		{menu && (() => {
			// Open submenus toward the screen interior so a flyout next to the right edge
			// doesn't spill off-screen.
			const menuX = menuPos?.x ?? menu.x;
			const submenuSide = menuX > window.innerWidth / 2 ? 'left' : 'right';
			const isFkCol = Boolean(fk?.isFkColumn(menu.col));
			const hasSubmenus = Boolean(onGenerateSql || editable || onOrderBy || onFilterByValue || isFkCol);
			return (
			<div ref={menuRef} className="ctx-menu" style={{ position: 'fixed', left: menuPos?.x ?? menu.x, top: menuPos?.y ?? menu.y, visibility: menuPos ? 'visible' : 'hidden' }} onMouseDown={(e) => e.stopPropagation()}>
				{onCopyCell && <button type="button" className="ctx-menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { onCopyCell(menu.row, menu.col); setMenu(null); }}><span className="ctx-label"><Icon name="copy" />Copy</span><span className="shortcut">Ctrl+C</span></button>}
				{editable && <button type="button" className="ctx-menu-item" disabled={editLocked} title={lockTitle} onMouseEnter={() => setSubmenu(null)} onClick={() => { if (!editLocked) { void pasteCell(menu.row, menu.col); } setMenu(null); }}><span className="ctx-label"><Icon name="clippy" />Paste</span><span className="shortcut">Ctrl+V</span></button>}
				{onCopyRow && <button type="button" className="ctx-menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { onCopyRow(menu.row); setMenu(null); }}><span className="ctx-label"><Icon name="list-flat" />Copy row</span></button>}
				{onViewCell && <button type="button" className="ctx-menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { onViewCell(menu.row, menu.col); setMenu(null); }}><span className="ctx-label"><Icon name="eye" />View value…</span><span className="shortcut">Shift+Enter</span></button>}
				{editable && (
					<>
						<div className="ctx-sep" />
						{editLocked && onUnlock && <button type="button" className="ctx-menu-item" onMouseEnter={() => setSubmenu(null)} onClick={() => { onUnlock(); setMenu(null); }}><span className="ctx-label"><Icon name="unlock" />Allow editing (this session)</span></button>}
						{onDuplicateRow && <button type="button" className="ctx-menu-item" disabled={editLocked} title={lockTitle} onMouseEnter={() => setSubmenu(null)} onClick={() => { if (!editLocked) { onDuplicateRow(menu.row); } setMenu(null); }}><span className="ctx-label"><Icon name="add" />Duplicate row</span><span className="shortcut">Ctrl+Alt+Ins</span></button>}
						{onToggleDelete && <button type="button" className="ctx-menu-item" disabled={editLocked} title={lockTitle} onMouseEnter={() => setSubmenu(null)} onClick={() => { if (!editLocked) { onToggleDelete(menu.row); } setMenu(null); }}><span className="ctx-label"><Icon name="trash" />{rowState?.(menu.row) === 'deleted' ? 'Undo delete' : rowState?.(menu.row) === 'new' ? 'Remove row' : 'Delete row'}</span><span className="shortcut">Alt+Delete</span></button>}
					</>
				)}
				{hasSubmenus && <div className="ctx-sep" />}

				{onGenerateSql && (
					<div className="ctx-menu-item has-submenu" role="menuitem" aria-haspopup="menu" onMouseEnter={() => setSubmenu('sql')} onClick={() => setSubmenu(submenu === 'sql' ? null : 'sql')}>
						<span className="ctx-label"><Icon name="database" />Generate SQL</span>
						<Icon name="chevron-right" />
						{submenu === 'sql' && (
							<div ref={submenuRef} className={`ctx-menu submenu submenu-${submenuSide}`} role="menu" style={{ top: submenuTop ?? undefined, visibility: submenuTop === null ? 'hidden' : undefined }}>
								<button type="button" className="ctx-menu-item" onClick={() => { onGenerateSql(menu.row, 'select'); setMenu(null); }}><span className="ctx-label"><Icon name="search" />SELECT</span></button>
								<button type="button" className="ctx-menu-item" onClick={() => { onGenerateSql(menu.row, 'insert'); setMenu(null); }}><span className="ctx-label"><Icon name="add" />INSERT</span></button>
								<button type="button" className="ctx-menu-item" onClick={() => { onGenerateSql(menu.row, 'update'); setMenu(null); }}><span className="ctx-label"><Icon name="edit" />UPDATE</span></button>
								<button type="button" className="ctx-menu-item" onClick={() => { onGenerateSql(menu.row, 'delete'); setMenu(null); }}><span className="ctx-label"><Icon name="trash" />DELETE</span></button>
							</div>
						)}
					</div>
				)}

				{editable && (
					<div className="ctx-menu-item has-submenu" role="menuitem" aria-haspopup="menu" onMouseEnter={() => setSubmenu('edit')} onClick={() => setSubmenu(submenu === 'edit' ? null : 'edit')}>
						<span className="ctx-label"><Icon name="edit" />Edit cell</span>
						<Icon name="chevron-right" />
						{submenu === 'edit' && (
							<div ref={submenuRef} className={`ctx-menu submenu submenu-${submenuSide}`} role="menu" style={{ top: submenuTop ?? undefined, visibility: submenuTop === null ? 'hidden' : undefined }}>
								<button type="button" className="ctx-menu-item" disabled={editLocked} title={lockTitle} onClick={() => { if (!editLocked) { onOpenCellEditor?.(menu.row, menu.col); } setMenu(null); }}><span className="ctx-label"><Icon name="edit" />Edit value…</span><span className="shortcut">Shift+Enter</span></button>
								{defaultActionLabel?.(menu.col) && <button type="button" className="ctx-menu-item" disabled={editLocked} title={lockTitle} onClick={() => { if (!editLocked) { onSetDefault?.(menu.row, menu.col); } setMenu(null); }}><span className="ctx-label"><Icon name="discard" />{defaultActionLabel(menu.col)}</span><span className="shortcut">Ctrl+Backspace</span></button>}
								{defaultActionLabel?.(menu.col) !== 'Set to NULL' && <button type="button" className="ctx-menu-item" disabled={editLocked} title={lockTitle} onClick={() => { if (!editLocked) { onSetNull?.(menu.row, menu.col); } setMenu(null); }}><span className="ctx-label"><Icon name="circle-slash" />Set to NULL</span><span className="shortcut">Delete</span></button>}
								<div className="ctx-sep" />
								<button type="button" className="ctx-menu-item" disabled={editLocked || menu.row <= 0} title={lockTitle} onClick={() => { if (!editLocked) { onCopyFromAdjacent?.(menu.row, menu.col, -1); } setMenu(null); }}><span className="ctx-label"><Icon name="arrow-up" />Copy from row above</span><span className="shortcut">Ctrl+D</span></button>
								<button type="button" className="ctx-menu-item" disabled={editLocked || menu.row >= rowCount - 1} title={lockTitle} onClick={() => { if (!editLocked) { onCopyFromAdjacent?.(menu.row, menu.col, 1); } setMenu(null); }}><span className="ctx-label"><Icon name="arrow-down" />Copy from row below</span><span className="shortcut">Ctrl+Alt+D</span></button>
							</div>
						)}
					</div>
				)}

				{(onOrderBy || onFilterByValue) && (
					<div className="ctx-menu-item has-submenu" role="menuitem" aria-haspopup="menu" onMouseEnter={() => setSubmenu('filter')} onClick={() => setSubmenu(submenu === 'filter' ? null : 'filter')}>
						<span className="ctx-label"><Icon name="filter" />Filter &amp; sort</span>
						<Icon name="chevron-right" />
						{submenu === 'filter' && (
							<div ref={submenuRef} className={`ctx-menu submenu submenu-${submenuSide}`} role="menu" style={{ top: submenuTop ?? undefined, visibility: submenuTop === null ? 'hidden' : undefined }}>
								{onOrderBy && <button type="button" className="ctx-menu-item" onClick={() => { onOrderBy(menu.col, 'asc'); setMenu(null); }}><span className="ctx-label"><Icon name="arrow-up" />Order ascending</span></button>}
								{onOrderBy && <button type="button" className="ctx-menu-item" onClick={() => { onOrderBy(menu.col, 'desc'); setMenu(null); }}><span className="ctx-label"><Icon name="arrow-down" />Order descending</span></button>}
								{onFilterByValue && <button type="button" className="ctx-menu-item" onClick={() => { onFilterByValue(menu.row, menu.col, '='); setMenu(null); }}><span className="ctx-label"><Icon name="filter" />Filter to this value</span></button>}
								{onFilterByValue && <button type="button" className="ctx-menu-item" onClick={() => { onFilterByValue(menu.row, menu.col, '<>'); setMenu(null); }}><span className="ctx-label"><Icon name="filter" />Exclude this value</span></button>}
							</div>
						)}
					</div>
				)}

				{isFkCol && fk && (
					<div className="ctx-menu-item has-submenu" role="menuitem" aria-haspopup="menu" onMouseEnter={() => setSubmenu('fk')} onClick={() => setSubmenu(submenu === 'fk' ? null : 'fk')}>
						<span className="ctx-label"><Icon name="references" />Foreign key</span>
						<Icon name="chevron-right" />
						{submenu === 'fk' && (
							<div ref={submenuRef} className={`ctx-menu submenu submenu-${submenuSide}`} role="menu" style={{ top: submenuTop ?? undefined, visibility: submenuTop === null ? 'hidden' : undefined }}>
								<button type="button" className="ctx-menu-item" onClick={() => { openPeek(menu.row, menu.col, getRow(menu.row)[menu.col], new DOMRect(menu.x, menu.y, 0, 0)); setMenu(null); }}><span className="ctx-label"><Icon name="references" />Peek referenced row</span></button>
								<button type="button" className="ctx-menu-item" onClick={() => { fk.onNavigate(menu.col, getRow(menu.row)); setMenu(null); }}><span className="ctx-label"><Icon name="link-external" />Open referenced row</span></button>
							</div>
						)}
					</div>
				)}
			</div>
			);
		})()}
		{valuePeek && (
			// Pointer-transparent: the card is a reading aid over the grid, and must never eat the
			// click, the context menu or the hover of whatever it covers.
			<div className="cell-peek" style={{ left: Math.min(valuePeek.x, Math.max(8, window.innerWidth - 520)), top: valuePeek.y }}>
				{valuePeek.text}
			</div>
		)}
		{peek && fk && (
			<div
				className="fk-peek-anchor"
				style={{ position: 'fixed', left: peek.x, top: peek.y, zIndex: 30 }}
				onMouseEnter={clearPeekTimers}
				onMouseLeave={scheduleClosePeek}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<FkPeekCard
					refTable={fk.refTableName(peek.col) ?? ''}
					value={peek.value}
					data={fk.peekData(peek.col, peek.rowValues)}
					onOpen={() => { fk.onNavigate(peek.col, peek.rowValues); setPeek(null); }}
				/>
			</div>
		)}
		</>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveFkTarget, buildLabelSql, buildPeekSql, type FkTarget } from './fkResolve';
import { isCellExpr } from './dml';
import type { QueryField } from '../../shared/query';
import type { TableInfo } from '../../shared/schema';

// React state/cache/querying for FK value resolution (the pure SQL builders live in
// fkResolve.ts). Everything is lazy: inline labels are batch-resolved one query per FK column
// over only the *visible* cells (debounced on scroll), and a peek fetches a single referenced
// row by its key on demand. A million-row result therefore never bulk-resolves. Composite keys
// resolve via the per-row peek (their parts come from the whole row, not one cell value).

const LABEL_DEBOUNCE_MS = 120;

/** The peek card's data for one referenced row, by load status. */
export interface FkPeekData {
	status: 'loading' | 'done' | 'error';
	/** Referenced column names (the handful fetched), present once loaded. */
	columns?: string[];
	/** Their values, aligned to {@link columns}. */
	values?: unknown[];
	/** Error text when the lookup failed, or when the row no longer exists. */
	error?: string;
}

/** Where a "Open referenced row" action should navigate: the referenced table + the key
 *  column/value filters to restrict it to (one per FK column; AND'd together). */
export interface FkNavTarget {
	table: TableInfo;
	filters: { column: string; value: unknown }[];
}

export interface FkLookup {
	/** Any FK columns at all? Lets the grid skip all FK affordances cheaply when there are none. */
	anyFk: boolean;
	isFkColumn(col: number): boolean;
	/** Referenced table name for a column (for the peek header), or undefined for non-FK columns. */
	refTableName(col: number): string | undefined;
	/** The resolved inline label for a cell's value, once known (undefined = unknown/none yet). */
	fkLabel(col: number, value: unknown): string | undefined;
	/** Ask to resolve labels for the currently visible FK cells (batched + debounced). */
	requestLabels(cells: { col: number; value: unknown }[]): void;
	/** Ask to fetch the referenced row for the peek card (`row` is the source row's values). */
	requestPeek(col: number, row: unknown[]): void;
	/** The peek card data for a cell, if requested (`row` is the source row's values). */
	peekData(col: number, row: unknown[]): FkPeekData | undefined;
	/** The navigation target for a cell (referenced table + filters), or null when not resolvable. */
	navTarget(col: number, row: unknown[]): FkNavTarget | null;
}

interface FkLookupArgs {
	connectionId: string;
	driver: string;
	/** The source table whose rows the grid shows (carries the foreign keys). */
	sourceTable: TableInfo | null | undefined;
	/** All tables in the connection's schema, used to resolve referenced tables. */
	tables: TableInfo[];
	/** The result fields, aligned by index to grid columns. */
	fields: QueryField[];
}

/** A scalar value as label text (objects → JSON, null → empty). */
function labelText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

export function useFkLookup({ connectionId, driver, sourceTable, tables, fields }: FkLookupArgs): FkLookup {
	// One resolved FK target per grid column (null for non-FK columns).
	const targets = useMemo<(FkTarget | null)[]>(() => {
		if (!sourceTable || tables.length === 0) {
			return fields.map(() => null);
		}
		return fields.map((f) => resolveFkTarget(sourceTable, f.name, tables));
	}, [sourceTable, tables, fields]);

	// For each FK column, the result-field indices of its source key columns (in refColumns order),
	// or null when a part of the key isn't present in the result (then the FK can't be resolved).
	const sourceIndices = useMemo<(number[] | null)[]>(() => {
		const byName = new Map(fields.map((f, i) => [f.name.toLowerCase(), i]));
		return targets.map((t) => {
			if (!t) {
				return null;
			}
			const idx = t.sourceColumns.map((c) => byName.get(c.toLowerCase()) ?? -1);
			return idx.some((i) => i < 0) ? null : idx;
		});
	}, [targets, fields]);

	const anyFk = useMemo(() => targets.some((t, col) => t && sourceIndices[col]), [targets, sourceIndices]);

	// Caches keyed by referenced table + value tuple, so columns pointing at the same table share
	// hits. A `bump` forces a re-render when a cache fills in (the Maps live in refs to stay stable).
	const labelCache = useRef(new Map<string, string | null>());
	const peekCache = useRef(new Map<string, FkPeekData>());
	const [, bump] = useState(0);
	const rerender = useCallback(() => bump((n) => n + 1), []);

	// Reset caches whenever the connection or schema identity changes — stale labels would be wrong.
	useEffect(() => {
		labelCache.current = new Map();
		peekCache.current = new Map();
		rerender();
	}, [connectionId, sourceTable, rerender]);

	function refKey(target: FkTarget, values: unknown[]): string {
		return `${target.refTable.schema ?? ''}.${target.refTable.name} ${values.map(labelText).join('')}`;
	}

	/** Gather the source-key tuple for a cell from the whole row (composite keys span columns),
	 *  or null when a part is missing/null/pending — those can't be looked up. */
	const keyTuple = useCallback((col: number, row: unknown[]): unknown[] | null => {
		const idx = sourceIndices[col];
		if (!idx) {
			return null;
		}
		const values = idx.map((i) => row[i]);
		if (values.some((v) => v === null || v === undefined || isCellExpr(v))) {
			return null;
		}
		return values;
	}, [sourceIndices]);

	// --- Inline labels: batched per FK column over the visible window, debounced on scroll.
	// Single-column FKs only (buildLabelSql returns null for composite, which then resolve via peek). ---
	const pendingLabels = useRef(new Set<string>()); // refKeys with an in-flight or queued fetch
	const queued = useRef(new Map<number, Set<unknown>>()); // col -> values awaiting a batch
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flushLabels = useCallback(() => {
		timer.current = null;
		const byCol = queued.current;
		queued.current = new Map();
		byCol.forEach((values, col) => {
			const target = targets[col];
			if (!target) {
				return;
			}
			const fresh = [...values].filter((v) => v !== null && v !== undefined && !labelCache.current.has(refKey(target, [v])));
			if (fresh.length === 0) {
				return;
			}
			const sql = buildLabelSql(target, fresh, driver);
			if (!sql) {
				// No label column (or composite): cache nulls so we don't keep re-queuing these cells.
				fresh.forEach((v) => labelCache.current.set(refKey(target, [v]), null));
				return;
			}
			fresh.forEach((v) => pendingLabels.current.add(refKey(target, [v])));
			void window.sqlApi.execute({ connectionId, sql }).then((res) => {
				if (res.ok) {
					const found = new Map<string, string>();
					for (const row of res.result.rows) {
						found.set(labelText(row[0]), labelText(row[1]));
					}
					fresh.forEach((v) => {
						const label = found.get(labelText(v));
						labelCache.current.set(refKey(target, [v]), label ?? null);
					});
				} else {
					fresh.forEach((v) => labelCache.current.set(refKey(target, [v]), null));
				}
			}).catch(() => {
				fresh.forEach((v) => labelCache.current.set(refKey(target, [v]), null));
			}).finally(() => {
				fresh.forEach((v) => pendingLabels.current.delete(refKey(target, [v])));
				rerender();
			});
		});
	}, [targets, driver, connectionId, rerender]);

	const requestLabels = useCallback((cells: { col: number; value: unknown }[]) => {
		let added = false;
		for (const { col, value } of cells) {
			const target = targets[col];
			if (!target || target.composite || value === null || value === undefined) {
				continue;
			}
			const key = refKey(target, [value]);
			if (labelCache.current.has(key) || pendingLabels.current.has(key)) {
				continue;
			}
			const set = queued.current.get(col) ?? new Set<unknown>();
			if (!set.has(value)) {
				set.add(value);
				queued.current.set(col, set);
				added = true;
			}
		}
		if (added && timer.current === null) {
			timer.current = setTimeout(flushLabels, LABEL_DEBOUNCE_MS);
		}
	}, [targets, flushLabels]);

	useEffect(() => () => { if (timer.current !== null) { clearTimeout(timer.current); } }, []);

	const fkLabel = useCallback((col: number, value: unknown): string | undefined => {
		const target = targets[col];
		if (!target || target.composite || value === null || value === undefined) {
			return undefined;
		}
		const label = labelCache.current.get(refKey(target, [value]));
		return label ? label : undefined;
	}, [targets]);

	// --- Peek: a single referenced row fetched on demand by its key (the tuple from the row). ---
	const requestPeek = useCallback((col: number, row: unknown[]) => {
		const target = targets[col];
		const values = keyTuple(col, row);
		if (!target || !values) {
			return;
		}
		const key = refKey(target, values);
		if (peekCache.current.has(key)) {
			return; // already loaded or loading
		}
		peekCache.current.set(key, { status: 'loading' });
		rerender();
		void window.sqlApi.execute({ connectionId, sql: buildPeekSql(target, values, driver) }).then((res) => {
			if (!res.ok) {
				peekCache.current.set(key, { status: 'error', error: res.error });
			} else if (res.result.rows.length === 0) {
				peekCache.current.set(key, { status: 'error', error: 'No referenced row found.' });
			} else {
				peekCache.current.set(key, { status: 'done', columns: res.result.fields.map((f) => f.name), values: res.result.rows[0] });
			}
		}).catch((err: unknown) => {
			peekCache.current.set(key, { status: 'error', error: err instanceof Error ? err.message : String(err) });
		}).finally(rerender);
	}, [targets, keyTuple, connectionId, driver, rerender]);

	const peekData = useCallback((col: number, row: unknown[]): FkPeekData | undefined => {
		const target = targets[col];
		const values = keyTuple(col, row);
		if (!target || !values) {
			return undefined;
		}
		return peekCache.current.get(refKey(target, values));
	}, [targets, keyTuple]);

	const navTarget = useCallback((col: number, row: unknown[]): FkNavTarget | null => {
		const target = targets[col];
		const values = keyTuple(col, row);
		if (!target || !values) {
			return null;
		}
		return { table: target.refTable, filters: target.refColumns.map((column, i) => ({ column, value: values[i] })) };
	}, [targets, keyTuple]);

	const isFkColumn = useCallback((col: number): boolean => Boolean(targets[col] && sourceIndices[col]), [targets, sourceIndices]);
	const refTableName = useCallback((col: number): string | undefined => targets[col]?.refTable.name, [targets]);

	return { anyFk, isFkColumn, refTableName, fkLabel, requestLabels, requestPeek, peekData, navTarget };
}

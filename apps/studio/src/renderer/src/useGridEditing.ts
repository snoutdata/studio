/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { cellText } from './components/DataGrid';
import { buildDml, isCellExpr, type CellValue, type RowInsert, type RowUpdate } from './dml';
import { buildMongoWrites } from './mongoDml';
import { backendKindForDriver, type MongoWrite } from '../../shared/engine';
import type { QueryField } from '../../shared/query';
import type { TableInfo } from '../../shared/schema';

// The inline edit/insert/delete state machine shared by the table-browser ("Data" tab) and
// the editable query-results grid. Edits, deletes and inserts batch in memory until Save,
// which previews the generated DML and runs it. Everything is keyed by the row's index into
// the `rows` array the caller passes in, so the caller decides what those rows are (a
// server-paged slice for TableView, the full result set for ResultsGrid) and translates its
// own display rows to those indices.

/** The prepared save: a relational backend yields SQL statements run one at a time (transactional
 *  where the driver supports it); a document backend yields a batch of native Mongo writes. The
 *  parent dispatches each kind to the matching IPC (executeScript / executeWrites). */
export type SavePlan =
	| { kind: 'sql'; statements: string[] }
	| { kind: 'mongo'; writes: MongoWrite[] };

/** Runs the prepared save (the connection layer runs the steps one at a time). */
type RunSave = (plan: SavePlan) => Promise<{ ok: boolean; error?: string }>;

export interface GridEditing {
	/** False when this backend has no write path at all (a cloud log service), so the grid hides
	 *  its edit affordances rather than offering an action that can only ever be refused. */
	editable: boolean;
	dirty: boolean;
	/** Pending new rows. `after` is the original-row index a duplicate should render directly
	 *  below (DBeaver-style add-copy); `null` means append after the existing rows (toolbar
	 *  Add row). A caller that doesn't interleave just renders them all after the existing rows. */
	inserts: { values: Map<number, CellValue>; after: number | null }[];
	/** Generated DML awaiting confirmation, or null when no save is pending. */
	savePreview: string | null;
	/** An advisory note for the pending save (e.g. a non-transactional Mongo batch warning), or null. */
	saveNote: string | null;
	saving: boolean;
	saveError: string | null;
	/** Display values for an existing row, merging its pending edits. */
	displayRow(index: number): unknown[];
	/** Display values for a new row, by insert index. */
	displayInsert(k: number): unknown[];
	isRowEdited(index: number, col: number): boolean;
	isInsertEdited(k: number, col: number): boolean;
	isDeleted(index: number): boolean;
	/** Set a cell on an existing row: a typed string literal, or a {@link CellValue} expr
	 *  (DEFAULT / NULL / current time). Reverts to unedited when the literal matches the
	 *  original or an explicit NULL matches an already-null cell. */
	editRow(index: number, col: number, value: CellValue): void;
	editInsert(k: number, col: number, value: CellValue): void;
	toggleDelete(index: number): void;
	addInsert(): void;
	/** DBeaver-style add-copy: seed a new insert from an existing row, blanking PK columns. */
	duplicateRow(index: number): void;
	removeInsert(k: number): void;
	revert(): void;
	/** Generate the batch DML and open the confirmation preview (or surface an error). */
	prepareSave(): void;
	cancelSave(): void;
	/** Run the previewed save; on success clear the edits and call onSaved (to reload). */
	applySave(run: RunSave, onSaved: () => void): Promise<void>;
}

export function useGridEditing(
	table: TableInfo | undefined,
	driver: string,
	fields: QueryField[],
	rows: unknown[][],
	/** Edits clear whenever this changes (a new page/sort/dataset the row indices no longer fit). */
	resetKey: unknown,
): GridEditing {
	const [edits, setEdits] = useState<Map<string, CellValue>>(new Map()); // "rowIndex:colIndex" → new value
	const [deletes, setDeletes] = useState<Set<number>>(new Set());
	const [inserts, setInserts] = useState<{ values: Map<number, CellValue>; after: number | null }[]>([]);
	const [savePreview, setSavePreview] = useState<string | null>(null);
	const [savePlan, setSavePlan] = useState<SavePlan | null>(null); // the previewed save (SQL statements or Mongo writes)
	const [saving, setSaving] = useState(false);
	const backendKind = backendKindForDriver(driver);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		setEdits(new Map());
		setDeletes(new Set());
		setInserts([]);
		setSaveError(null);
		setSavePreview(null);
		setSavePlan(null);
	}, [resetKey]);

	function displayRow(i: number): unknown[] {
		if (edits.size === 0) {
			return rows[i];
		}
		const copy = rows[i].slice();
		for (let col = 0; col < fields.length; col++) {
			const key = `${i}:${col}`;
			if (edits.has(key)) {
				copy[col] = edits.get(key);
			}
		}
		return copy;
	}

	function displayInsert(k: number): unknown[] {
		const ins = inserts[k];
		return fields.map((_f, col) => (ins.values.has(col) ? ins.values.get(col) : null));
	}

	function isRowEdited(i: number, col: number): boolean {
		return edits.has(`${i}:${col}`);
	}

	function isInsertEdited(k: number, col: number): boolean {
		return inserts[k].values.has(col);
	}

	function isDeleted(i: number): boolean {
		return deletes.has(i);
	}

	function editRow(i: number, col: number, value: CellValue): void {
		setEdits((prev) => {
			const next = new Map(prev);
			const key = `${i}:${col}`;
			if (isCellExpr(value)) {
				// An explicit NULL on an already-null cell is a no-op, like clearing a literal
				// back to its original. Other exprs (DEFAULT / current time) are always a change.
				const wasNull = rows[i][col] === null || rows[i][col] === undefined;
				if (value.sql === 'NULL' && wasNull) {
					next.delete(key);
				} else {
					next.set(key, value);
				}
			} else if (value === (cellText(rows[i][col]) ?? '')) {
				next.delete(key);
			} else {
				next.set(key, value);
			}
			return next;
		});
	}

	function editInsert(k: number, col: number, value: CellValue): void {
		setInserts((prev) => prev.map((row, idx) => (idx === k ? { ...row, values: new Map(row.values).set(col, value) } : row)));
	}

	function toggleDelete(i: number): void {
		setDeletes((prev) => {
			const next = new Set(prev);
			if (next.has(i)) {
				next.delete(i);
			} else {
				next.add(i);
			}
			return next;
		});
	}

	function addInsert(): void {
		setInserts((prev) => [...prev, { values: new Map(), after: null }]);
	}

	function duplicateRow(index: number): void {
		if (!table) {
			return;
		}
		// Seed a new insert from the source row's current display values; skip PK columns
		// (auto-increment / identity PKs should regenerate, others should be re-entered).
		const source = displayRow(index);
		const pkSet = new Set(table.primaryKey.map((n) => n.toLowerCase()));
		const values = new Map<number, CellValue>();
		for (let col = 0; col < fields.length; col++) {
			if (pkSet.has(fields[col].name.toLowerCase())) {
				continue;
			}
			const value = source[col];
			if (isCellExpr(value)) {
				values.set(col, value);
				continue;
			}
			const text = cellText(value);
			if (text !== null) {
				values.set(col, text);
			}
		}
		// Anchor the copy to its source so the caller can render it directly below that row.
		setInserts((prev) => [...prev, { values, after: index }]);
	}

	function removeInsert(k: number): void {
		setInserts((prev) => prev.filter((_, idx) => idx !== k));
	}

	function revert(): void {
		setEdits(new Map());
		setDeletes(new Set());
		setInserts([]);
		setSaveError(null);
	}

	function prepareSave(): void {
		if (!table) {
			return;
		}
		const byRow = new Map<number, Map<number, CellValue>>();
		for (const [key, val] of edits) {
			const [r, c] = key.split(':').map(Number);
			let set = byRow.get(r);
			if (!set) {
				set = new Map();
				byRow.set(r, set);
			}
			set.set(c, val);
		}
		const updates: RowUpdate[] = [...byRow.entries()].map(([r, set]) => ({ original: rows[r], set }));
		const deleteRows = [...deletes].map((r) => rows[r]);
		const insertRows: RowInsert[] = inserts.filter((ins) => ins.values.size > 0);
		const nothingToSave = 'Nothing to save. Fill in a new row or change a cell first.';

		if (backendKind === 'telemetry') {
			// A cloud log service has no write path we expose and none is planned: an event that has
			// been ingested cannot be edited or deleted through any of these APIs. Refused by name
			// here rather than left to fall through, where `buildDml` would reject it for the wrong
			// reason ("no primary key") and imply that a keyed log scope would be editable.
			setSaveError('Log events cannot be edited: a cloud log service is read-only.');
			return;
		}
		if (backendKind === 'document') {
			const result = buildMongoWrites({ table, fields, updates, deletes: deleteRows, inserts: insertRows });
			if ('error' in result) {
				setSaveError(result.error);
				return;
			}
			if (result.writes.length === 0) {
				setSaveError(nothingToSave);
				return;
			}
			setSaveError(null);
			setSavePreview(result.preview);
			setSavePlan({ kind: 'mongo', writes: result.writes });
			return;
		}

		const result = buildDml({ table, driver, fields, updates, deletes: deleteRows, inserts: insertRows });
		if ('error' in result) {
			setSaveError(result.error);
			return;
		}
		if (!result.sql.trim()) {
			setSaveError(nothingToSave);
			return;
		}
		setSaveError(null);
		setSavePreview(result.sql);
		setSavePlan({ kind: 'sql', statements: result.statements });
	}

	function cancelSave(): void {
		setSavePreview(null);
		setSavePlan(null);
	}

	async function applySave(run: RunSave, onSaved: () => void): Promise<void> {
		if (savePreview === null || savePlan === null) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		let result: { ok: boolean; error?: string };
		try {
			result = await run(savePlan);
		} catch (err) {
			// A rejected save (transport fault, a missing IPC handler after a partial dev reload)
			// must surface as an error and clear the spinner, never leave it spinning forever.
			setSaving(false);
			setSaveError(err instanceof Error ? err.message : String(err));
			return;
		}
		if (!result.ok) {
			setSaving(false);
			setSaveError(result.error ?? 'Failed to save changes.');
			return;
		}
		setSaving(false);
		setSavePreview(null);
		setEdits(new Map());
		setDeletes(new Set());
		setInserts([]);
		onSaved();
	}

	// Mongo writes run op-by-op with no surrounding transaction, so a multi-op batch can apply
	// partially if one op fails. Surface that in the confirm dialog (relational saves are either
	// transactional or single-statement, so no note there).
	const saveNote =
		savePlan?.kind === 'mongo' && savePlan.writes.length > 1
			? 'These changes are applied one at a time, not as a single transaction. If one fails, the earlier changes will already be saved.'
			: null;

	return {
		/** False when this backend has no write path at all, so the grid can hide its edit
		 *  affordances instead of offering an action that can only ever be refused. */
		editable: backendKind !== 'telemetry',
		dirty: edits.size > 0 || deletes.size > 0 || inserts.length > 0,
		inserts,
		savePreview,
		saveNote,
		saving,
		saveError,
		displayRow,
		displayInsert,
		isRowEdited,
		isInsertEdited,
		isDeleted,
		editRow,
		editInsert,
		toggleDelete,
		addInsert,
		duplicateRow,
		removeInsert,
		revert,
		prepareSave,
		cancelSave,
		applySave,
	};
}

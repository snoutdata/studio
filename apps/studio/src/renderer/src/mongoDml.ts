/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, TableInfo } from '../../shared/schema';
import type { QueryField } from '../../shared/query';
import { describeMongoWrite, type MongoWrite } from '../../shared/engine';
import { isCellExpr, type CellValue, type RowInsert, type RowUpdate } from './dml';

// The document (MongoDB) counterpart to dml.ts. Where dml.ts turns the
// editable grid's pending edits into SQL UPDATE/INSERT/DELETE strings, this turns the SAME edits
// into native Mongo write ops: a changed cell -> updateOne({_id},{$set}), a new row -> insertOne,
// a deleted row -> deleteOne. Rows are targeted by their `_id` (Mongo's de-facto primary key), so a
// result without `_id` can only accept inserts. Pure + DOM-free so it stays node-testable like dml.

/** Returned by {@link coerceWriteValue} for a cell that should be left out of the write entirely
 *  (a DB-default expr — Mongo has no column defaults, so there's nothing to write). */
const OMIT = Symbol('omit');

/** A canonical 24-hex-character ObjectId string. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** A canonical hyphenated UUID string. */
const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the `_id` filter value for an update/delete. A true ObjectId `_id` column (known from
 * introspection: its inferred type includes `objectid`) gets an explicit `{ $oid }` Extended-JSON
 * wrapper so the driver revives it precisely; a string/numeric `_id` is passed through as-is. This
 * is the fix for the silent-no-op write: without the type signal the driver had to guess from the
 * shape, so a genuine 24-hex STRING `_id` was coerced to an ObjectId and matched no document.
 */
function idFilterValue(value: unknown, idColumn: ColumnInfo | undefined): unknown {
	const type = (idColumn?.dataType ?? '').toLowerCase();
	if (type.includes('objectid') && typeof value === 'string' && OBJECT_ID_HEX.test(value)) {
		return { $oid: value };
	}
	return value;
}

/** A user-typed cell value, interpreted against the field's inferred BSON type so the document is
 *  stored with the right primitive (numbers/booleans/null) rather than everything-as-string. A
 *  {@link CellValue} expr maps to its Mongo meaning: NULL -> `null`, "current time" -> a `$date`
 *  Extended-JSON wrapper the driver revives to a `Date`, a DB-default -> {@link OMIT}. */
function coerceWriteValue(value: CellValue, column: ColumnInfo | undefined): unknown | typeof OMIT {
	if (isCellExpr(value)) {
		if (value.sql === 'NULL') {
			return null;
		}
		if (value.sql === 'CURRENT_TIMESTAMP') {
			return { $date: new Date().toISOString() };
		}
		// DB-default and any other expr have no document equivalent — drop the field.
		return OMIT;
	}
	const type = (column?.dataType ?? '').toLowerCase();
	const raw = value;
	if (raw === '') {
		return column?.nullable ? null : '';
	}
	// Known id types → explicit Extended-JSON wrappers the driver revives precisely.
	// This is type-DRIVEN, not the read path's shape-guessing: we only wrap when introspection
	// says the field IS an ObjectId/UUID, so a genuine string field is never coerced.
	if (type.includes('objectid')) {
		return OBJECT_ID_HEX.test(raw.trim()) ? { $oid: raw.trim() } : raw;
	}
	if (type.includes('uuid')) {
		return UUID_HEX.test(raw.trim()) ? { $uuid: raw.trim() } : raw;
	}
	if (type.includes('bool')) {
		const t = raw.trim().toLowerCase();
		return t === 'true' || t === '1' || t === 't' || t === 'yes' || t === 'y';
	}
	if (type.includes('int') || type.includes('long')) {
		return /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
	}
	if (type.includes('double') || type.includes('decimal')) {
		return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw;
	}
	if (type.includes('date') || type.includes('timestamp')) {
		// A date-typed field stores a real Date, not a string: parse the typed value and emit the
		// `{ $date }` Extended-JSON wrapper the driver revives to a Date. If it doesn't parse, keep the
		// raw string rather than write an invalid date (the save preview shows what will be written).
		const t = raw.trim();
		const ms = Date.parse(t);
		return Number.isNaN(ms) ? raw : { $date: new Date(ms).toISOString() };
	}
	// Objects/arrays/strings are stored as the typed string the user entered. (Editing a whole
	// object/array node wholesale isn't offered — the tree edits its scalar leaves, which is what
	// covers nested/array-element/date values.)
	return raw;
}

/** Normalise a concrete `$set` path to the introspected dotted-path form so its type can be looked
 *  up: array indices collapse to `[]` (`items.0.sku` → `items[].sku`), matching how introspection
 *  names arrays-of-subdocument fields. */
function normalizePath(path: string): string {
	return path.replace(/\.\d+(?=\.|$)/g, '[]');
}

/** The introspected column (with its inferred BSON type) for a concrete leaf path, matching the
 *  literal path first, then its array-normalised form. Undefined when the path isn't in the schema
 *  (a field only some documents carry) — coercion then falls back to string. */
function columnForPath(columns: ColumnInfo[], path: string): ColumnInfo | undefined {
	return columns.find((c) => c.name === path) ?? columns.find((c) => c.name === normalizePath(path));
}

/** One edited leaf from the document tree: a dotted/indexed path to the value and the raw text the
 *  user typed (or a {@link CellValue} expr for NULL/current-time). */
export interface DocumentFieldEdit {
	/** Dotted path to the leaf: `user.address.city`, `items.0.sku`, `tags.0`. */
	path: string;
	value: CellValue;
}

/**
 * Build the Mongo write for a set of nested-field edits made in the document tree viewer.
 * Every changed leaf becomes one correctly-pathed `$set` entry
 * (`updateOne({_id},{$set:{'a.b.c':v}})`), each coerced by the inferred type of its dotted path.
 * Targets the document by its `_id` (like the grid writes), so a document without one can't be
 * saved. Pure + DOM-free so it stays node-testable.
 */
export function buildDocumentUpdate(input: { table: TableInfo; document: Record<string, unknown>; edits: DocumentFieldEdit[] }): { preview: string; write: MongoWrite } | { error: string } {
	const { table, document, edits } = input;
	if (!('_id' in document) || document._id === undefined || document._id === null) {
		return { error: "This document has no _id, so nested field edits can't be saved. Use the pipeline editor instead." };
	}
	const idColumn = table.columns.find((c) => c.name === '_id');
	const set: Record<string, unknown> = {};
	for (const edit of edits) {
		// Never rewrite the key we filter on (and there's no sane meaning to editing it here).
		if (edit.path === '_id') {
			continue;
		}
		const coerced = coerceWriteValue(edit.value, columnForPath(table.columns, edit.path));
		if (coerced !== OMIT) {
			set[edit.path] = coerced;
		}
	}
	if (Object.keys(set).length === 0) {
		return { error: 'No changes to save.' };
	}
	const write: MongoWrite = { op: 'updateOne', collection: table.name, filter: { _id: idFilterValue(document._id, idColumn) }, update: { $set: set } };
	return { preview: describeMongoWrite(write), write };
}

export interface MongoWriteInput {
	/** The collection being edited (its `name` + inferred `columns`). */
	table: TableInfo;
	/** The result fields, index-aligned to the row arrays (a `SELECT *`, so field order). */
	fields: QueryField[];
	updates: RowUpdate[];
	/** Original row arrays to delete. */
	deletes: unknown[][];
	inserts: RowInsert[];
}

/**
 * Build the Mongo write batch for a set of grid edits (deletes -> updates -> inserts, the same
 * order dml.ts emits SQL). Updates and deletes key on `_id`, so a result without an `_id` field is
 * an error rather than an unsafe whole-collection write. Returns `{ preview, writes }` (preview is
 * the shell-style rendering shown in the save dialog) or `{ error }`.
 */
export function buildMongoWrites(input: MongoWriteInput): { preview: string; writes: MongoWrite[] } | { error: string } {
	const { table, fields } = input;
	const collection = table.name;
	const idIndex = fields.findIndex((f) => f.name === '_id');
	const needsKey = input.updates.length > 0 || input.deletes.length > 0;
	if (needsKey && idIndex < 0) {
		return { error: "This result has no _id column, so edits and deletes can't be saved safely. Add documents only, or use the pipeline editor." };
	}
	const columnFor = (index: number): ColumnInfo | undefined => table.columns.find((c) => c.name === fields[index]?.name);
	const idColumn = table.columns.find((c) => c.name === '_id');
	const writes: MongoWrite[] = [];

	for (const original of input.deletes) {
		writes.push({ op: 'deleteOne', collection, filter: { _id: idFilterValue(original[idIndex], idColumn) } });
	}

	for (const update of input.updates) {
		const set: Record<string, unknown> = {};
		for (const [col, val] of [...update.set.entries()].sort((a, b) => a[0] - b[0])) {
			const coerced = coerceWriteValue(val, columnFor(col));
			if (coerced !== OMIT) {
				set[fields[col].name] = coerced;
			}
		}
		if (Object.keys(set).length > 0) {
			writes.push({ op: 'updateOne', collection, filter: { _id: idFilterValue(update.original[idIndex], idColumn) }, update: { $set: set } });
		}
	}

	for (const insert of input.inserts) {
		const document: Record<string, unknown> = {};
		for (const [col, val] of [...insert.values.entries()].sort((a, b) => a[0] - b[0])) {
			const coerced = coerceWriteValue(val, columnFor(col));
			if (coerced !== OMIT) {
				document[fields[col].name] = coerced;
			}
		}
		if (Object.keys(document).length > 0) {
			writes.push({ op: 'insertOne', collection, document });
		}
	}

	return { preview: writes.map(describeMongoWrite).join('\n'), writes };
}

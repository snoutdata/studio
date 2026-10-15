/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../shared/engine';
import type { ColumnInfo, TableInfo } from '../../shared/schema';
import type { QueryField } from '../../shared/query';
import { quoteIdent } from './ddl';

// Pure, driver-aware DML generation for the editable data grid (inline cell editing).
// Kept free of DOM/React so it stays node-testable, like ddl.ts/sqlGuard. The
// grid collects edits/inserts/deletes as plain values; here we turn them into UPDATE,
// INSERT and DELETE statements keyed by the table's primary key. Identifier quoting is reused
// from ddl.ts and boolean literals come from the central dialect strategy; this module adds the
// value-literal escaping the DDL path never needed.

/** A raw value that bypasses literal quoting: the DB `DEFAULT`, `NULL`, or a function like
 *  `CURRENT_TIMESTAMP`. `sql` is emitted verbatim into the statement; `display` is what the
 *  grid shows in the cell; `omitOnInsert` drops the column from an INSERT so the database
 *  applies its own default (the right behavior for auto-increment / identity / expression
 *  defaults, which an explicit value would fight). */
export interface CellExpr {
	sql: string;
	display: string;
	omitOnInsert?: boolean;
}

/** A pending cell value: either a user-typed literal (a plain string, quoted/typed by
 *  {@link valueLiteral}) or a {@link CellExpr} emitted verbatim. */
export type CellValue = string | CellExpr;

export function isCellExpr(value: unknown): value is CellExpr {
	return typeof value === 'object' && value !== null && 'sql' in value && 'display' in value;
}

/** "Set to NULL" — an explicit NULL the user chose (distinct from clearing a cell to ''). */
export const NULL_VALUE: CellExpr = { sql: 'NULL', display: 'NULL' };

/** An edit to one existing row: the original row values (for the PK WHERE) + new cell values
 *  keyed by column index. */
export interface RowUpdate {
	original: unknown[];
	set: Map<number, CellValue>;
}

/** A new row: cell values keyed by column index (only the columns the user filled in). */
export interface RowInsert {
	values: Map<number, CellValue>;
}

export interface DmlInput {
	table: TableInfo;
	driver: string;
	/** The result fields, index-aligned to the row arrays (a `SELECT *`, so column order). */
	fields: QueryField[];
	updates: RowUpdate[];
	/** Original row arrays to delete. */
	deletes: unknown[][];
	inserts: RowInsert[];
}

function qualified(table: TableInfo, driver: string): string {
	const parts = table.schema ? [table.schema, table.name] : [table.name];
	return parts.map((p) => quoteIdent(p, driver)).join('.');
}

function isNumericType(type: string): boolean {
	return /\b(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|double|real|serial|money|year)\b/i.test(type);
}

function isBooleanType(type: string): boolean {
	return /\b(bool|boolean)\b/i.test(type);
}

function isTemporalType(type: string): boolean {
	return /\b(date|time|datetime|timestamp|timestamptz|year)\b/i.test(type);
}

/** What "Set to default" means for a column, given its type/default/nullability — the menu
 *  label and the value to apply. Returns null when the column has no sensible default action
 *  (a non-nullable column with no declared default and no temporal fallback). The label is
 *  user-facing copy; the value is a {@link CellExpr} emitted verbatim by {@link buildDml}. */
export interface DefaultAction {
	label: string;
	value: CellExpr;
}

export function defaultAction(column: ColumnInfo | undefined): DefaultAction | null {
	if (!column) {
		return null;
	}
	if (column.default !== null && column.default !== undefined) {
		// Let the database resolve the declared default (handles expression defaults like
		// nextval()/uuid_generate_v4() too): UPDATE emits `col = DEFAULT`, INSERT omits it.
		return { label: `Set to default (${column.default})`, value: { sql: 'DEFAULT', display: '(default)', omitOnInsert: true } };
	}
	if (isTemporalType(column.dataType)) {
		return { label: 'Set to current time', value: { sql: 'CURRENT_TIMESTAMP', display: '(current time)' } };
	}
	if (column.nullable) {
		return { label: 'Set to NULL', value: NULL_VALUE };
	}
	return null;
}

/** A quoted string literal. On an engine where a backslash is an escape (MySQL, MariaDB,
 *  ClickHouse) it is doubled, or a value ending in one would swallow its own closing quote. */
function quoteString(text: string, driver: string): string {
	const body = dialectFor(driver).backslashEscapes ? text.replace(/\\/g, '\\\\') : text;
	return `'${body.replace(/'/g, "''")}'`;
}

/** A SQL literal for an *original* value from a query row (number/string/boolean/null as it
 *  came over IPC — Dates/Buffers have already been JSON-serialised to string/object). */
export function literalFromValue(value: unknown, driver: string): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}
	if (typeof value === 'boolean') {
		return dialectFor(driver).booleanLiteral(value);
	}
	if (typeof value === 'object') {
		return quoteString(JSON.stringify(value), driver);
	}
	return quoteString(String(value), driver);
}

/** A SQL literal for a *user-typed* cell value, interpreted against the column's type:
 *  numbers pass through (when they look numeric), booleans map per dialect, an empty string
 *  becomes NULL on a nullable column, everything else is a quoted string. */
export function valueLiteral(raw: string, column: ColumnInfo | undefined, driver: string): string {
	const type = column?.dataType ?? '';
	if (raw === '') {
		return column?.nullable || isNumericType(type) ? 'NULL' : quoteString('', driver);
	}
	if (isNumericType(type) && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
		return raw.trim();
	}
	if (isBooleanType(type)) {
		const t = raw.trim().toLowerCase();
		const truthy = t === 'true' || t === '1' || t === 't' || t === 'yes' || t === 'y';
		return dialectFor(driver).booleanLiteral(truthy);
	}
	return quoteString(raw, driver);
}

/** A SQL literal for a pending cell value: a {@link CellExpr} is emitted verbatim (DEFAULT /
 *  NULL / CURRENT_TIMESTAMP), a plain string goes through {@link valueLiteral}. */
function cellLiteral(value: CellValue, column: ColumnInfo | undefined, driver: string): string {
	return isCellExpr(value) ? value.sql : valueLiteral(value, column, driver);
}

/** The primary-key column names for a table (explicit PK, else the isPrimaryKey columns). */
export function primaryKeyNames(table: TableInfo): string[] {
	return table.primaryKey && table.primaryKey.length > 0
		? table.primaryKey
		: table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
}

/** The four DBeaver-style "Generate SQL" statement kinds for a single row. */
export type RowSqlKind = 'select' | 'insert' | 'update' | 'delete';

/**
 * Generate a standalone SQL statement for one row (the right-click "Generate SQL" actions).
 * Unlike {@link buildDml} this never runs — it produces editor/clipboard text, so it works on
 * any single-table result regardless of editability. UPDATE/DELETE/SELECT target the row by its
 * primary key when one is present, falling back to matching every column. Cell values that are a
 * {@link CellExpr} (DEFAULT/NULL/CURRENT_TIMESTAMP) are emitted verbatim.
 */
export function generateRowSql(kind: RowSqlKind, table: TableInfo, driver: string, fields: QueryField[], row: unknown[]): string {
	const qname = qualified(table, driver);
	const ident = (index: number): string => quoteIdent(fields[index]?.name ?? '', driver);
	const lit = (index: number): string => {
		const value = row[index];
		return isCellExpr(value) ? value.sql : literalFromValue(value, driver);
	};
	const eq = (index: number): string => {
		const value = row[index];
		return value === null || value === undefined ? `${ident(index)} IS NULL` : `${ident(index)} = ${lit(index)}`;
	};

	// Prefer the primary key for the WHERE; if it isn't in the result, match on every column.
	const pkNames = primaryKeyNames(table);
	const pkIndices = pkNames.map((name) => fields.findIndex((f) => f.name === name));
	const keyIndices = pkNames.length > 0 && pkIndices.every((i) => i >= 0) ? pkIndices : fields.map((_f, i) => i);
	const where = keyIndices.map((i) => eq(i)).join(' AND ');

	switch (kind) {
		case 'select':
			return `SELECT ${fields.map((_f, i) => ident(i)).join(', ')}\nFROM ${qname}\nWHERE ${where};`;
		case 'insert':
			return `INSERT INTO ${qname} (${fields.map((_f, i) => ident(i)).join(', ')})\nVALUES (${fields.map((_f, i) => lit(i)).join(', ')});`;
		case 'update':
			return `UPDATE ${qname}\nSET ${fields.map((_f, i) => `${ident(i)} = ${lit(i)}`).join(', ')}\nWHERE ${where};`;
		case 'delete':
			return `DELETE FROM ${qname}\nWHERE ${where};`;
	}
}

/**
 * Build the UPDATE/INSERT/DELETE statements for a batch of grid edits. Updates and deletes
 * are keyed by the primary key (read from the original row), so a missing PK is an error
 * rather than an unsafe full-table write. Returns `{ sql, statements }` (deletes → updates →
 * inserts; `sql` is the statements newline-joined for the preview, `statements` is the array
 * the save path runs one at a time so a multi-row save isn't one giant multi-statement query)
 * or `{ error }`.
 */
export function buildDml(input: DmlInput): { sql: string; statements: string[] } | { error: string } {
	const { table, driver, fields } = input;
	const qname = qualified(table, driver);
	const colFor = (index: number): ColumnInfo | undefined => table.columns.find((c) => c.name === fields[index]?.name);
	const ident = (index: number): string => quoteIdent(fields[index]?.name ?? '', driver);

	const needsKey = input.updates.length > 0 || input.deletes.length > 0;
	const pkNames = primaryKeyNames(table);
	const pkIndices = pkNames.map((name) => fields.findIndex((f) => f.name === name));
	if (needsKey && (pkNames.length === 0 || pkIndices.some((i) => i < 0))) {
		return { error: "This table has no primary key in the result, so edits and deletes can't be saved safely. Add rows only, or use the SQL editor." };
	}

	const whereForRow = (original: unknown[]): string =>
		pkIndices
			.map((idx, k) => {
				const value = original[idx];
				return value === null || value === undefined
					? `${quoteIdent(pkNames[k], driver)} IS NULL`
					: `${quoteIdent(pkNames[k], driver)} = ${literalFromValue(value, driver)}`;
			})
			.join(' AND ');

	const statements: string[] = [];

	for (const original of input.deletes) {
		statements.push(`DELETE FROM ${qname} WHERE ${whereForRow(original)};`);
	}

	for (const update of input.updates) {
		const sets = [...update.set.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([col, val]) => `${ident(col)} = ${cellLiteral(val, colFor(col), driver)}`)
			.join(', ');
		if (sets) {
			statements.push(`UPDATE ${qname} SET ${sets} WHERE ${whereForRow(update.original)};`);
		}
	}

	for (const insert of input.inserts) {
		// Columns set to the DB default are omitted so the database fills them in.
		const cols = [...insert.values.keys()]
			.filter((c) => { const v = insert.values.get(c); return !(isCellExpr(v) && v.omitOnInsert); })
			.sort((a, b) => a - b);
		if (cols.length === 0) {
			continue;
		}
		const names = cols.map((c) => ident(c)).join(', ');
		const vals = cols.map((c) => cellLiteral(insert.values.get(c) ?? '', colFor(c), driver)).join(', ');
		statements.push(`INSERT INTO ${qname} (${names}) VALUES (${vals});`);
	}

	return { sql: statements.join('\n'), statements };
}

/**
 * Why this table cannot be edited in the grid, in a sentence, or null when it can.
 *
 * The rule itself lives in `TableView` and has for a long time; what was missing is
 * saying it out loud. When a table is not editable the edit toolbar is simply not
 * rendered, so somebody who expects an "Add row" button sees nothing at all and has to
 * guess. That happened on 2026-09-06 against the first hosted database anybody
 * had imported: two of its three tables have no primary key, the app correctly refused,
 * and with no reason on screen the natural conclusion was that a cloud connection is
 * different from an ordinary one. It is not.
 *
 * Ordered by what the user can do about it, most actionable first. Every sentence names
 * the thing to change rather than the state it is in.
 */
export function editRefusal(
	table: Pick<TableInfo, 'kind' | 'primaryKey' | 'columns'> | undefined,
	options: { readOnly: boolean; gridActionsAllowed: boolean }
): string | null {
	if (!table) {
		return null;
	}
	if (table.kind === 'view') {
		return 'A view has no rows of its own to change. Edit the tables underneath it.';
	}
	if (table.kind === 'logGroup') {
		return 'Log events cannot be changed: the provider has no write path for them.';
	}
	if (table.kind === 'dictionary') {
		return 'A dictionary holds a copy of what its SOURCE returns. Change the source, then reload the dictionary.';
	}
	if (options.readOnly) {
		return 'This connection is marked read-only, so nothing here can be written. Change it on the connection.';
	}
	if (!options.gridActionsAllowed) {
		return 'This connection is marked production, so the grid is look-only.';
	}
	if (primaryKeyNames(table as TableInfo).length === 0) {
		return 'This table has no primary key, so there is no safe way to say which row an edit belongs to. Add one, or write the INSERT yourself in the editor.';
	}
	return null;
}

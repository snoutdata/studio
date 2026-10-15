/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Foreign-key value resolution for the data grid: turn a meaningless FK id (e.g.
// customer_id = 4815) into something human (a "· Acme Corp" inline label and a peek card
// of the referenced row). Pure + node-testable; the React state/cache/querying lives in
// useFkLookup.ts. Everything here is lazy by design — callers fetch one referenced row by
// its PK and only for the cells the user is actually looking at, so a million-row result
// never bulk-resolves.

import { literalFromValue } from './dml';
import { quoteIdent } from './ddl';
import { dialectFor } from '../../shared/engine';
import type { ForeignKeyInfo, TableInfo } from '../../shared/schema';

/** How many columns the peek card fetches for the referenced row (kept small to stay fast
 *  on very wide tables — a single-row PK lookup is cheap, but the payload still shouldn't be). */
const PEEK_COLUMN_LIMIT = 8;

/** Column-name patterns that make a good human label, most-preferred first. */
const LABEL_PATTERNS: RegExp[] = [
	/^(display_?name|full_?name)$/i,
	/^(name|title|label)$/i,
	/^(username|login|email)$/i,
	/^(code|slug|key|reference|ref)$/i,
	/_?name$/i,
];

/** A resolved FK target for one source column: which referenced table/columns to look up by,
 *  the columns worth fetching for the peek card, and the column that makes the inline label.
 *  Composite (multi-column) keys carry every part, aligned `sourceColumns[i] -> refColumns[i]`. */
export interface FkTarget {
	fk: ForeignKeyInfo;
	/** The referenced table, resolved from the loaded schema. */
	refTable: TableInfo;
	/** The referenced (usually PK) columns we look up by, aligned to {@link sourceColumns}. */
	refColumns: string[];
	/** The source FK columns in this table, aligned to {@link refColumns}. */
	sourceColumns: string[];
	/** Columns to fetch for the peek card (lookup columns first, then a handful), capped. */
	peekColumns: string[];
	/** The column whose value reads as a human label, or null when nothing beats the raw id. */
	labelColumn: string | null;
	/** True when the key spans more than one column: peeking needs the whole tuple from the row,
	 *  and the batched inline label (which keys on a single value per column) is skipped. */
	composite: boolean;
}

/** The foreign key whose source columns include `fieldName`, or undefined. Prefers a
 *  single-column FK on the column; otherwise the composite FK that includes it. */
export function fkForColumn(table: TableInfo, fieldName: string): ForeignKeyInfo | undefined {
	const lower = fieldName.toLowerCase();
	return table.foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0].toLowerCase() === lower)
		?? table.foreignKeys.find((fk) => fk.columns.some((c) => c.toLowerCase() === lower));
}

/** Pick the column whose value reads as a human label (a name/title/email/…), preferring a
 *  text column and never a lookup column. Returns null when nothing beats the id. */
export function pickLabelColumn(refTable: TableInfo, refColumns: string[]): string | null {
	const lookup = new Set(refColumns.map((c) => c.toLowerCase()));
	const candidates = refTable.columns.filter((c) => !lookup.has(c.name.toLowerCase()));
	for (const pattern of LABEL_PATTERNS) {
		const hit = candidates.find((c) => pattern.test(c.name));
		if (hit) {
			return hit.name;
		}
	}
	// No name-y column: fall back to the first textual column so the label still says something.
	const textual = candidates.find((c) => /char|text|string|uuid|enum/i.test(c.dataType));
	return textual?.name ?? null;
}

/** Columns to fetch for the peek card: the lookup columns first, then the label, then fill from
 *  the table's column order up to {@link PEEK_COLUMN_LIMIT}. */
export function pickPeekColumns(refTable: TableInfo, refColumns: string[], labelColumn: string | null): string[] {
	const out: string[] = [...refColumns];
	if (labelColumn && !out.some((c) => c.toLowerCase() === labelColumn.toLowerCase())) {
		out.push(labelColumn);
	}
	for (const col of refTable.columns) {
		if (out.length >= PEEK_COLUMN_LIMIT) {
			break;
		}
		if (!out.some((c) => c.toLowerCase() === col.name.toLowerCase())) {
			out.push(col.name);
		}
	}
	return out;
}

/** Resolve a source column to its FK lookup target using the loaded schema, or null when the
 *  column isn't an FK or the referenced table isn't in the schema. Prefers a referenced table
 *  in the same schema as the source when the name is ambiguous. Handles composite keys. */
export function resolveFkTarget(table: TableInfo, fieldName: string, tables: TableInfo[]): FkTarget | null {
	const fk = fkForColumn(table, fieldName);
	if (!fk || fk.columns.length === 0 || fk.referencedColumns.length !== fk.columns.length) {
		return null;
	}
	const wanted = fk.referencedTable.toLowerCase();
	const matches = tables.filter((t) => t.name.toLowerCase() === wanted);
	if (matches.length === 0) {
		return null;
	}
	const refTable = matches.find((t) => (t.schema ?? '').toLowerCase() === (table.schema ?? '').toLowerCase()) ?? matches[0];
	const refColumns = fk.referencedColumns;
	const sourceColumns = fk.columns;
	const labelColumn = pickLabelColumn(refTable, refColumns);
	return {
		fk,
		refTable,
		refColumns,
		sourceColumns,
		peekColumns: pickPeekColumns(refTable, refColumns, labelColumn),
		labelColumn,
		composite: refColumns.length > 1,
	};
}

/** Qualified, driver-quoted name for the referenced table (schema-qualified when known). */
function qualifyRef(target: FkTarget, driver: string): string {
	const t = target.refTable;
	return t.schema ? `${quoteIdent(t.schema, driver)}.${quoteIdent(t.name, driver)}` : quoteIdent(t.name, driver);
}

/** SQL to fetch the inline labels for a batch of FK values in one round-trip:
 *  `SELECT refCol, labelCol FROM ref WHERE refCol IN (…)`. Returns null when there's no label
 *  column (the id is all we have), no values, or the key is composite (those resolve only via
 *  the per-row peek, since the batch keys on a single value per column). Values are de-duplicated. */
export function buildLabelSql(target: FkTarget, values: unknown[], driver: string): string | null {
	if (!target.labelColumn || target.composite) {
		return null;
	}
	const seen = new Set<string>();
	const literals: string[] = [];
	for (const v of values) {
		if (v === null || v === undefined) {
			continue;
		}
		const lit = literalFromValue(v, driver);
		if (!seen.has(lit)) {
			seen.add(lit);
			literals.push(lit);
		}
	}
	if (literals.length === 0) {
		return null;
	}
	const ref = quoteIdent(target.refColumns[0], driver);
	const label = quoteIdent(target.labelColumn, driver);
	return `SELECT ${ref}, ${label} FROM ${qualifyRef(target, driver)} WHERE ${ref} IN (${literals.join(', ')})`;
}

/** SQL to fetch the single referenced row for the peek card, looked up by its key:
 *  `SELECT <handful> FROM ref WHERE refCol = value [AND …]` (one row). `values` is the source-key
 *  tuple, aligned to {@link FkTarget.refColumns} (length 1 for a simple FK). */
export function buildPeekSql(target: FkTarget, values: unknown[], driver: string): string {
	const cols = target.peekColumns.map((c) => quoteIdent(c, driver)).join(', ');
	const where = target.refColumns
		.map((rc, i) => `${quoteIdent(rc, driver)} = ${literalFromValue(values[i], driver)}`)
		.join(' AND ');
	return dialectFor(driver).peekOne(cols, `${qualifyRef(target, driver)} WHERE ${where}`);
}

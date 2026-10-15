/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Decides whether a query's result set can be edited in place (DBeaver-style). A result
// is editable only when the query is a plain single-table SELECT — no joins, grouping,
// DISTINCT, aggregates, set operations or subqueries — because anything that combines or
// collapses rows breaks the one-row-maps-to-one-table-row assumption that UPDATE/DELETE
// keyed by primary key relies on. Pure/deterministic (no Monaco/DOM), so it stays
// node-testable like sqlStatement.ts and sqlGuard.ts. The caller still confirms the table
// has a primary key and that the selected columns map to real columns before enabling edits.

export interface EditableSource {
	/** Schema/database the table was qualified with, when the query named one. */
	schema?: string;
	table: string;
}

/** Strip a wrapping pair of double quotes or backticks from an identifier. */
function unquote(ident: string): string {
	const t = ident.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('`') && t.endsWith('`'))) {
		return t.slice(1, -1);
	}
	return t;
}

/**
 * The single source table of a plain `SELECT`, or null when the query isn't a single-table
 * select. Recognises an optional schema qualifier and a table alias; rejects everything that
 * would make the rows non-editable.
 */
export function editableSource(sql: string): EditableSource | null {
	const text = sql.trim().replace(/;\s*$/, '');
	const lower = text.toLowerCase();
	if (!/^select\b/.test(lower)) {
		return null;
	}
	// Anything that joins, combines or collapses rows makes the result non-editable.
	if (/\bjoin\b|\bunion\b|\bintersect\b|\bexcept\b|\bgroup\s+by\b|\bdistinct\b|\bhaving\b|\bover\s*\(/.test(lower)) {
		return null;
	}
	const fromMatch = /\bfrom\b/.exec(lower);
	if (!fromMatch) {
		return null;
	}
	// The FROM clause runs until the next top-level clause keyword (or the end of the query).
	const rest = text.slice(fromMatch.index + "from".length);
	const clause = /\b(where|group\s+by|having|order\s+by|limit|offset|window|for|fetch)\b/.exec(rest.toLowerCase());
	const fromClause = (clause ? rest.slice(0, clause.index) : rest).trim();
	// One table only: a comma is a cross join, a paren is a subquery/derived table.
	if (!fromClause || fromClause.includes(',') || fromClause.includes('(')) {
		return null;
	}
	// `schema.table [AS] alias` → the first whitespace-separated token is the table reference.
	const tableRef = fromClause.split(/\s+/)[0];
	const parts = tableRef.split('.').map(unquote);
	if (parts.length === 0 || parts.length > 2 || parts.some((p) => p === '')) {
		return null;
	}
	return parts.length === 2 ? { schema: parts[0], table: parts[1] } : { table: parts[0] };
}

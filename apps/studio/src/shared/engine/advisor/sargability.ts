/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Static sargability linter (query advisor, Pillar 2 Tier A). Parses a SQL statement with
// node-sql-parser (already a dependency, see transcribe/sqlToMongo.ts) and flags WHERE/JOIN
// predicates that defeat an index on an indexed column — the classic large-table footgun
// `WHERE DATE(event_date) = '…'` that forces a full scan even though `event_date` is indexed.
//
// Deterministic and fully local (no round-trip, no model): it only needs the connection's
// already-cached schema (indexes + column types). Surfaced as inline Monaco squiggles at
// author time. Never throws — a parse failure (mid-typing, unsupported syntax) yields [].

import { Parser } from 'node-sql-parser';

import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../schema';
import type { Advisory } from './types';

const parser = new Parser();

/** node-sql-parser grammar per driver id. Falls back to postgresql (the most permissive of the
 *  common grammars for our read subset) for vendors without a dedicated grammar. */
function grammarFor(driver: string | undefined): string {
	switch (driver) {
		case 'mysql-aurora':
		case 'mariadb':
			return 'mysql';
		case 'postgres':
			return 'postgresql';
		case 'sqlserver':
			return 'transactsql';
		case 'sqlite':
			return 'sqlite';
		case 'snowflake':
			return 'snowflake';
		case 'db2':
			return 'db2';
		default:
			return 'postgresql';
	}
}

// Minimal shapes of the node-sql-parser v5 AST nodes we read (see the probe in the plan work).
interface ColumnRef {
	type: 'column_ref';
	table: string | null;
	column: string | { expr?: { value?: string } };
}
interface FuncNode {
	type: 'function';
	name?: { name?: { value?: string }[] };
	args?: { type?: string; value?: ExprNode[] };
}
interface CastNode { type: 'cast'; expr?: ExprNode; target?: { dataType?: string }[] }
interface BinaryExpr { type: 'binary_expr'; operator: string; left: ExprNode; right: ExprNode }
interface Literal { type: string; value?: unknown }
type ExprNode = ColumnRef | FuncNode | CastNode | BinaryExpr | Literal;

interface FromItem { db?: string | null; table?: string; as?: string | null }
interface SelectAst {
	type: string;
	from?: FromItem[] | null;
	where?: ExprNode | null;
}

const COMPARISON_OPS = new Set(['=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN']);
const ARITH_OPS = new Set(['+', '-', '*', '/', '%']);

/** Lint one SQL string against a connection's schema. Returns the advisories (possibly empty).
 *  Never throws. */
export function lintSargability(sql: string, schema: DatabaseSchema | undefined, driver?: string): Advisory[] {
	if (!sql.trim() || !schema || schema.tables.length === 0) {
		return [];
	}
	let ast: unknown;
	try {
		ast = parser.astify(sql, { database: grammarFor(driver) });
	} catch {
		return []; // unparseable (mid-typing / unsupported) — stay silent
	}
	const statements = Array.isArray(ast) ? ast : [ast];
	const out: Advisory[] = [];
	for (const stmt of statements) {
		const select = stmt as SelectAst;
		if (!select || select.type !== 'select' || !select.from) {
			continue;
		}
		lintSelect(select, schema, sql, out);
	}
	return out;
}

function lintSelect(select: SelectAst, schema: DatabaseSchema, sql: string, out: Advisory[]): void {
	// Map alias/table name (lowercased) → TableInfo for column resolution.
	const byAlias = new Map<string, TableInfo>();
	const fromTables: TableInfo[] = [];
	for (const item of select.from ?? []) {
		if (!item.table) {
			continue;
		}
		const table = findTable(schema, item.table);
		if (!table) {
			continue;
		}
		fromTables.push(table);
		byAlias.set(item.table.toLowerCase(), table);
		if (item.as) {
			byAlias.set(item.as.toLowerCase(), table);
		}
	}
	if (fromTables.length === 0) {
		return;
	}
	const ctx: LintCtx = { schema, byAlias, fromTables, sql, out, seen: new Set() };
	// WHERE predicates + any JOIN ON conditions.
	if (select.where) {
		walkPredicate(select.where, ctx);
	}
	for (const item of select.from ?? []) {
		const on = (item as unknown as { on?: ExprNode }).on;
		if (on) {
			walkPredicate(on, ctx);
		}
	}
}

interface LintCtx {
	schema: DatabaseSchema;
	byAlias: Map<string, TableInfo>;
	fromTables: TableInfo[];
	sql: string;
	out: Advisory[];
	/** De-dupe by table.column|kind so a column used twice doesn't double-report. */
	seen: Set<string>;
}

/** Recurse an AND/OR/comparison tree, inspecting each comparison's operands. */
function walkPredicate(node: ExprNode, ctx: LintCtx): void {
	if (!node || node.type !== 'binary_expr') {
		return;
	}
	const bin = node as BinaryExpr;
	if (bin.operator === 'AND' || bin.operator === 'OR') {
		walkPredicate(bin.left, ctx);
		walkPredicate(bin.right, ctx);
		return;
	}
	if (!COMPARISON_OPS.has(bin.operator)) {
		return;
	}
	// A comparison: inspect both sides (predicates are sometimes written literal-first).
	inspectOperand(bin.left, bin.right, bin.operator, ctx);
	inspectOperand(bin.right, bin.left, bin.operator, ctx);
}

/** Inspect one side of a comparison for a non-sargable wrap of an indexed column; `other` is the
 *  opposite side (the literal, for LIKE/type-mismatch checks). */
function inspectOperand(side: ExprNode, other: ExprNode, operator: string, ctx: LintCtx): void {
	if (!side) {
		return;
	}
	// fn(col) — function wrapping.
	if (side.type === 'function') {
		const col = soleColumnArg((side as FuncNode).args?.value);
		const fnName = funcName(side as FuncNode);
		if (col && fnName) {
			reportWrap(col, ctx, 'non-sargable-function', fnName, other, operator);
		}
		return;
	}
	// CAST(col AS ...).
	if (side.type === 'cast') {
		const inner = (side as CastNode).expr;
		if (inner && inner.type === 'column_ref') {
			reportWrap(inner as ColumnRef, ctx, 'non-sargable-cast', 'CAST', other, operator);
		}
		return;
	}
	// col +/-/*/÷ x arithmetic.
	if (side.type === 'binary_expr' && ARITH_OPS.has((side as BinaryExpr).operator)) {
		const bin = side as BinaryExpr;
		const col = bin.left?.type === 'column_ref' ? (bin.left as ColumnRef)
			: bin.right?.type === 'column_ref' ? (bin.right as ColumnRef) : undefined;
		if (col) {
			reportWrap(col, ctx, 'non-sargable-arith', bin.operator, other, operator);
		}
		return;
	}
	// Bare column: LIKE leading-wildcard and type-mismatch checks.
	if (side.type === 'column_ref') {
		const resolved = resolveColumn(side as ColumnRef, ctx);
		if (!resolved || !isIndexed(resolved.table, resolved.column.name)) {
			return;
		}
		if ((operator === 'LIKE' || operator === 'NOT LIKE') && isLeadingWildcard(other)) {
			pushOnce(ctx, resolved, 'leading-wildcard-like',
				`\`${operator} '%…'\` on the indexed column ${label(resolved)} can't use its index.`,
				"A leading `%` means the b-tree index on this column can't be used, so the query scans every row. Consider a full-text index, a trigram index (Postgres `pg_trgm`), or anchoring the pattern (`prefix%`).",
				undefined, columnRange(ctx, side as ColumnRef));
		} else if (isTypeMismatch(resolved.column, other)) {
			pushOnce(ctx, resolved, 'type-mismatch',
				`Comparing the string column ${label(resolved)} to a numeric literal forces an implicit cast.`,
				"When a string column is compared to a number, the engine converts every row's value to compare, which defeats the index on this column (a common MySQL footgun). Quote the literal so the types match.",
				undefined, columnRange(ctx, side as ColumnRef));
		}
	}
}

/** Emit an advisory for a function/cast/arith wrap, IF the wrapped column is indexed. */
function reportWrap(colRef: ColumnRef, ctx: LintCtx, kind: Advisory['kind'], op: string, other: ExprNode, operator: string): void {
	const resolved = resolveColumn(colRef, ctx);
	if (!resolved || !isIndexed(resolved.table, resolved.column.name)) {
		return;
	}
	const lbl = label(resolved);
	let message: string;
	let suggestedSql: string | undefined;
	if (kind === 'non-sargable-function') {
		message = `\`${op}(${resolved.column.name})\` can't use the index on ${lbl} — the function runs on every row.`;
		suggestedSql = rewriteSuggestion(op, resolved, other, operator);
	} else if (kind === 'non-sargable-cast') {
		message = `\`CAST(${resolved.column.name} …)\` can't use the index on ${lbl}.`;
	} else {
		message = `Arithmetic on ${lbl} (\`${resolved.column.name} ${op} …\`) can't use its index — move the math to the other side.`;
	}
	const rationale = "Wrapping an indexed column in a function or expression means the index (which stores the raw column value) can't be used, so the query scans the whole table. Rewrite so the bare column is on one side of the comparison, or add an expression index on the wrapped form.";
	pushOnce(ctx, resolved, kind, message, rationale, suggestedSql, callRange(ctx, op, resolved, colRef));
}

/** For `DATE(col) = 'yyyy-mm-dd'`, suggest the sargable half-open-range rewrite. Uses plain date
 *  literals (no engine-specific interval math) so the suggestion is valid on every vendor. */
function rewriteSuggestion(fnName: string, resolved: Resolved, other: ExprNode, operator: string): string | undefined {
	const col = resolved.column.name;
	const upper = fnName.toUpperCase();
	if ((upper === 'DATE' || upper === 'CAST') && operator === '=' && isStringLiteral(other)) {
		const day = String((other as Literal).value).slice(0, 10);
		const next = nextDayLiteral(day);
		if (next) {
			// A day-precision half-open range keeps the index usable, in vendor-neutral SQL.
			return `${col} >= '${day}' AND ${col} < '${next}'`;
		}
	}
	// Generic: an expression index on the wrapped form.
	return `CREATE INDEX ON ${resolved.tableName} ((${upper}(${col})));`;
}

/** The day after a `YYYY-MM-DD` literal, or null if it doesn't parse as one. */
function nextDayLiteral(day: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
	if (!m) {
		return null;
	}
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

// ---- column resolution + index/type checks -------------------------------------------------

interface Resolved { table: TableInfo; tableName: string; column: ColumnInfo }

function resolveColumn(ref: ColumnRef, ctx: LintCtx): Resolved | undefined {
	const colName = columnName(ref);
	if (!colName || colName === '*') {
		return undefined;
	}
	// Qualified: the qualifier is an alias or table name.
	if (ref.table) {
		const table = ctx.byAlias.get(ref.table.toLowerCase());
		if (!table) {
			return undefined;
		}
		const column = findColumn(table, colName);
		return column ? { table, tableName: table.name, column } : undefined;
	}
	// Unqualified: unambiguous only if exactly one FROM table has such a column.
	const matches = ctx.fromTables.filter((t) => findColumn(t, colName));
	if (matches.length !== 1) {
		return undefined;
	}
	const column = findColumn(matches[0], colName)!;
	return { table: matches[0], tableName: matches[0].name, column };
}

/** True when `column` is the PRIMARY KEY or the LEADING column of some secondary index — the case
 *  where wrapping it in a function actually costs a usable index. A non-leading composite member is
 *  a weaker signal and is deliberately not flagged (avoids noise). */
function isIndexed(table: TableInfo, column: string): boolean {
	const lc = column.toLowerCase();
	if (table.primaryKey.some((c) => c.toLowerCase() === lc)) {
		return true;
	}
	for (const idx of table.indexes ?? []) {
		if (idx.columns.length > 0 && idx.columns[0].toLowerCase() === lc) {
			return true;
		}
	}
	return false;
}

function isTypeMismatch(column: ColumnInfo, other: ExprNode): boolean {
	// Only the dangerous direction: a STRING column compared to a NUMERIC literal (the engine casts
	// every row's string to a number → index unusable). The reverse casts only the literal.
	return typeCategory(column.dataType) === 'string' && isNumericLiteral(other);
}

type TypeCat = 'string' | 'numeric' | 'temporal' | 'other';
function typeCategory(dataType: string): TypeCat {
	const t = dataType.toLowerCase();
	if (/\b(char|text|string|clob|enum|uuid)\b/.test(t) || t.startsWith('varchar') || t.startsWith('nvarchar') || t.startsWith('char')) {
		return 'string';
	}
	if (/\b(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|double|real|money|number|serial)\b/.test(t) || t.startsWith('dec') || t.startsWith('num')) {
		return 'numeric';
	}
	if (/\b(date|time|timestamp|datetime|year)\b/.test(t)) {
		return 'temporal';
	}
	return 'other';
}

// ---- small AST accessors -------------------------------------------------------------------

function columnName(ref: ColumnRef): string {
	const c = ref.column;
	if (typeof c === 'string') {
		return c;
	}
	if (c && typeof c === 'object' && c.expr && typeof c.expr.value === 'string') {
		return c.expr.value;
	}
	return '';
}

function funcName(fn: FuncNode): string {
	const first = fn.name?.name?.[0]?.value;
	return typeof first === 'string' ? first : '';
}

/** The single column_ref argument of a function call, or undefined (0 or 2+ args, or non-column). */
function soleColumnArg(args: ExprNode[] | undefined): ColumnRef | undefined {
	if (!args || args.length !== 1) {
		return undefined;
	}
	return args[0]?.type === 'column_ref' ? (args[0] as ColumnRef) : undefined;
}

function isStringLiteral(node: ExprNode): boolean {
	const t = node?.type;
	return t === 'single_quote_string' || t === 'string' || t === 'double_quote_string';
}
function isNumericLiteral(node: ExprNode): boolean {
	return node?.type === 'number';
}
function isLeadingWildcard(node: ExprNode): boolean {
	return isStringLiteral(node) && typeof (node as Literal).value === 'string' && (String((node as Literal).value).startsWith('%') || String((node as Literal).value).startsWith('_'));
}

function findTable(schema: DatabaseSchema, name: string): TableInfo | undefined {
	const lc = name.toLowerCase();
	return schema.tables.find((t) => t.name.toLowerCase() === lc);
}
function findColumn(table: TableInfo, name: string): ColumnInfo | undefined {
	const lc = name.toLowerCase();
	return table.columns.find((c) => c.name.toLowerCase() === lc);
}

function label(r: Resolved): string {
	return `${r.tableName}.${r.column.name}`;
}

function pushOnce(ctx: LintCtx, r: Resolved, kind: Advisory['kind'], message: string, rationale: string, suggestedSql: string | undefined, range: Advisory['range']): void {
	const key = `${r.tableName}.${r.column.name}|${kind}`;
	if (ctx.seen.has(key)) {
		return;
	}
	ctx.seen.add(key);
	ctx.out.push({ level: 'warn', kind, table: r.tableName, column: r.column.name, message, rationale, suggestedSql, range });
}

// ---- best-effort source ranges (for the inline squiggle) -----------------------------------
// node-sql-parser's astify drops source locations, so we locate the offending span by a unique
// textual search. A range is produced only when the pattern matches exactly once (avoids
// mis-anchoring); otherwise the advisory still surfaces in the strip, just without a squiggle.

function uniqueRange(sql: string, re: RegExp): Advisory['range'] {
	let match: RegExpExecArray | null;
	let found: Advisory['range'] | undefined;
	re.lastIndex = 0;
	while ((match = re.exec(sql)) !== null) {
		if (found) {
			return undefined; // ambiguous
		}
		found = { start: match.index, end: match.index + match[0].length };
	}
	return found;
}

function esc(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Range of a `fn( … col … )` call, spanning the function name through its closing paren. */
function callRange(ctx: LintCtx, op: string, r: Resolved, ref: ColumnRef): Advisory['range'] {
	const qualifier = ref.table ? `${esc(ref.table)}\\s*\\.\\s*` : '';
	// Function/cast name, an open paren, up to a close paren that mentions the column.
	const re = new RegExp(`\\b${esc(op)}\\s*\\(\\s*${qualifier}${esc(r.column.name)}\\b[^)]*\\)`, 'gi');
	return uniqueRange(ctx.sql, re);
}

/** Range of a bare (optionally qualified) column occurrence. */
function columnRange(ctx: LintCtx, ref: ColumnRef): Advisory['range'] {
	const qualifier = ref.table ? `${esc(ref.table)}\\s*\\.\\s*` : '';
	const re = new RegExp(`\\b${qualifier}${esc(columnName(ref))}\\b`, 'gi');
	return uniqueRange(ctx.sql, re);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Shared SQL-AST plumbing for the deterministic compilers. `sqlToMongo` and
 *  `sqlToPinecone` both parse the SAME flavour — node-sql-parser's PostgreSQL grammar, regardless
 *  of the connection, because the SQL here targets a document/vector backend, not a relational
 *  vendor (the `mongodb` / `pinecone` Dialects generate Postgres-style SQL to match). This module
 *  holds what they agree on: the parser, the AST shapes we read, literal/identifier extraction,
 *  and the three error kinds a compiler can raise.
 *
 *  The three errors mean different things to the orchestrator (`src/main/transcribe.ts`):
 *  - {@link UnsupportedQueryError} — "this is valid SQL, we just can't express it here". The AI
 *    transcriber may be able to, so the caller MAY offer to spend budget on it.
 *  - {@link CompileError} — "this query is wrong for this connection" (unknown collection, a
 *    filter on a column that isn't filterable). A model can't fix it, so it surfaces straight to
 *    the user as an error and never triggers the consent prompt.
 *  - {@link SqlSyntaxError} — "this isn't SQL". A CompileError, so also terminal, but it carries
 *    the position and (where we recognise the mistake) the fix, which is what the editor underlines
 *    and what the error message leads with.
 *--------------------------------------------------------------------------------------------*/

import { Parser } from 'node-sql-parser';

import type { DatabaseSchema } from '../../schema';
import { describeParseFailure, formatSyntaxProblem, quotedValueWarnings, type SqlSyntaxProblem } from './sqlSyntax';
import { splitStatementSpans } from '../parse/sqlStatement';

/** Thrown when a SQL statement falls outside the deterministic compiler's supported subset. The
 *  orchestrator treats it as the signal to try the AI transcriber, not as a hard failure. */
export class UnsupportedQueryError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'UnsupportedQueryError';
	}
}

/** Thrown when a statement is deterministically WRONG for this connection rather than merely
 *  beyond the compiler — an unknown collection, a predicate on a non-filterable pseudo-column.
 *  Terminal: the orchestrator surfaces it as-is and never offers the AI fallback (see the module
 *  header), because there is nothing for a model to translate. */
export class CompileError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'CompileError';
	}
}

/**
 * Thrown when the statement is not valid SQL at all: a typo, a stray character, an operator from
 * another dialect. A {@link CompileError} (so every caller that already treats that as terminal
 * treats this as terminal too), because there is even less for a model to do here than with a
 * wrong-for-this-connection query — the AI transcriber would be handed something it cannot read,
 * spend the user's budget and come back with nothing, which is exactly what used to happen.
 * Carries the {@link SqlSyntaxProblem} so the editor can underline the characters at fault.
 */
export class SqlSyntaxError extends CompileError {
	readonly problem: SqlSyntaxProblem;

	constructor(problem: SqlSyntaxProblem) {
		super(formatSyntaxProblem(problem));
		this.name = 'SqlSyntaxError';
		this.problem = problem;
	}
}

const parser = new Parser();

/** One branch of a `CASE` expression: a `when` (with its condition) or the `else`. */
export interface CaseBranch {
	type: string;
	cond?: ExprAst;
	result: ExprAst;
}

/** A node in the expression tree. Structurally typed rather than exhaustively modelled — the
 *  compilers narrow on `type` and read only the fields that type carries. */
export interface ExprAst {
	type: string;
	operator?: string;
	left?: ExprAst;
	right?: ExprAst;
	/** unary_expr / cast: the operand. */
	expr?: ExprAst;
	/** column_ref: the qualifier (`t` in `t.col`); with `schema` set for a 3-part `a.b.c`. */
	table?: string | null;
	schema?: string | null;
	column?: string | { expr: { type?: string; value: string } };
	/** Literals carry their JS value here; an `expr_list` carries its items. */
	value?: unknown;
	/** aggr_func: `COUNT` / `SUM` / …. Plain functions carry the v5 nested-name shape instead. */
	name?: string | { name: { value: string }[] };
	/** aggr_func args (single expr + optional DISTINCT), a plain function's `expr_list`, or a
	 *  `case` node's WHEN/ELSE branches. */
	args?: { expr?: ExprAst; distinct?: string | null } | { type: string; value: ExprAst[] } | CaseBranch[];
	/** cast: the target type. */
	target?: { dataType: string }[];
}

/** One entry of the FROM list. The first is the base table; later entries carry `join`/`on`. */
export interface FromAst {
	db?: string | null;
	table?: string;
	as?: string | null;
	join?: string;
	on?: ExprAst | null;
	/** Set for a subquery in FROM (which no compiler here supports). */
	expr?: unknown;
}

export interface ColumnAst {
	expr: ExprAst;
	as: string | null;
}

export interface SelectAst {
	type: string;
	with?: unknown[] | null;
	distinct?: { type: string | null };
	columns: ColumnAst[] | '*';
	from?: FromAst[] | null;
	where?: ExprAst | null;
	groupby?: { columns: ExprAst[] } | null;
	having?: ExprAst | null;
	orderby?: { expr: ExprAst; type: string | null }[] | null;
	limit?: { seperator: string; value: { type: string; value: number }[] } | null;
	/** The right-hand side of a set operation (`UNION`, `UNION ALL`, …). */
	_next?: SelectAst | null;
	set_op?: string | null;
}

/** Any statement the compilers accept. Callers narrow on `type` and cast to the shape that type
 *  carries (each compiler models only the statements it supports). */
export interface StatementAst {
	type: string;
}

/**
 * Parse ONE SQL statement with the PostgreSQL grammar. Rejects an empty batch or multiple
 * statements (both {@link UnsupportedQueryError} — the caller authored something we can't map to a
 * single native query).
 */
export function parseOneStatement(sql: string): StatementAst {
	let ast: unknown;
	try {
		ast = parser.astify(sql, { database: 'postgresql' });
	} catch (err) {
		// NOT an UnsupportedQueryError: this is invalid SQL, not SQL we can't express. The difference
		// decides whether the user is offered the AI transcriber and whether they are told to "try a
		// simpler SELECT" when the real answer is one character (see sqlSyntax.ts).
		throw new SqlSyntaxError(describeParseFailure(sql, err));
	}
	if (Array.isArray(ast)) {
		if (ast.length !== 1) {
			throw new UnsupportedQueryError('only a single statement is supported.');
		}
		ast = ast[0];
	}
	return ast as StatementAst;
}

/** Reject the SELECT-level clauses no deterministic compiler here supports, with a reason that
 *  names the clause (so the AI-fallback prompt and the error message both stay specific). Set
 *  operations and CTEs are checked here because BOTH compilers would otherwise silently compile
 *  only the first branch / ignore the WITH and return wrong rows. */
export function rejectUnsupportedSelectClauses(select: SelectAst): void {
	if (select._next || select.set_op) {
		throw new UnsupportedQueryError(`${(select.set_op ?? 'UNION').toUpperCase()} of several SELECTs is not supported.`);
	}
	if (Array.isArray(select.with) && select.with.length > 0) {
		throw new UnsupportedQueryError('WITH (common table expressions) is not supported.');
	}
}

/** Extract a column name from a column_ref's `column`, which is either a plain string (`*`) or the
 *  nested `{ expr: { value } }` shape node-sql-parser v5 uses for identifiers (quoted or not). */
export function columnName(ref: ExprAst): string {
	const c = ref.column;
	if (typeof c === 'string') {
		return c;
	}
	if (c && typeof c === 'object' && c.expr && typeof c.expr.value === 'string') {
		return c.expr.value;
	}
	throw new UnsupportedQueryError('unsupported column reference.');
}

/**
 * A name a document or vector store will use as a field: a column, a dotted path, an alias, a SET
 * target, an index key. Each dot-separated segment must be non-empty and must not start with `$`,
 * because a key starting with `$` is an OPERATOR to MongoDB and Pinecone (`{ $comment: 'x' }` is a
 * filter that matches every document, `$where` runs JavaScript) and a field path starting with `$`
 * is an expression. Such a name is refused outright, with no fallback to a model, since no
 * translation of it is safe.
 */
export function assertDocumentField(path: string): string {
	for (const segment of path.split('.')) {
		if (segment === '') {
			throw new CompileError(`"${path}" is not a field name: it has an empty part between dots.`);
		}
		if (segment.startsWith('$')) {
			throw new CompileError(`"${path}" is not a field name: a name starting with "$" would be read as an operator, not a field.`);
		}
	}
	return path;
}

/** The qualifier of a column reference — everything before the final name. `t.col` → `t`;
 *  `a.b.c` → `a.b` (the parser splits a 3-part name into schema + table + column). */
export function qualifierOf(ref: ExprAst): string | undefined {
	const parts = [ref.schema, ref.table].filter((p): p is string => typeof p === 'string' && p.length > 0);
	return parts.length > 0 ? parts.join('.') : undefined;
}

/** True for the `*` in `SELECT *` (a column_ref) or in `COUNT(*)` (a star node). */
export function isStar(node: ExprAst | undefined): boolean {
	return !!node && (node.type === 'star' || (node.type === 'column_ref' && node.column === '*'));
}

/** A plain function's name, upper-cased. v5 nests it as `{ name: [{ value }] }`. */
export function functionName(node: ExprAst): string {
	const raw = node.name;
	if (typeof raw === 'string') {
		return raw.toUpperCase();
	}
	if (raw && typeof raw === 'object' && Array.isArray(raw.name)) {
		return raw.name.map((part) => part.value).join('.').toUpperCase();
	}
	throw new UnsupportedQueryError('unsupported function reference.');
}

/** The argument list of a plain function call (`expr_list`), or `[]` for a no-arg call. */
export function functionArgs(node: ExprAst): ExprAst[] {
	const args = node.args as { type?: string; value?: ExprAst[] } | undefined;
	if (!args) {
		return [];
	}
	return Array.isArray(args.value) ? args.value : [];
}

/** A literal node → its JS value. Anything that isn't a literal (a subquery, an expression) is
 *  rejected here so the caller can decide whether an expression form is available instead. */
export function literalValue(node: ExprAst): unknown {
	switch (node.type) {
		case 'number':
		case 'bool':
			return node.value;
		case 'single_quote_string':
		case 'string':
		case 'double_quote_string':
			return node.value;
		case 'null':
			return null;
		case 'unary_expr':
			// A negative literal in some positions: `-1` usually folds into `number`, but not always.
			if (node.operator === '-' && node.expr && typeof (node.expr as ExprAst).value === 'number') {
				return -((node.expr as ExprAst).value as number);
			}
			throw new UnsupportedQueryError(`unsupported literal: ${node.operator ?? node.type}`);
		default:
			throw new UnsupportedQueryError(`unsupported literal: ${node.type}`);
	}
}

/** True when a node is a literal {@link literalValue} can read. */
export function isLiteral(node: ExprAst | undefined): boolean {
	if (!node) {
		return false;
	}
	try {
		literalValue(node);
		return true;
	} catch {
		return false;
	}
}

/** The nodes of an `IN (...)` list. Rejects the subquery form (`IN (SELECT …)`) by name. */
export function exprListNodes(node: ExprAst): ExprAst[] {
	const list = node as unknown as { type: string; value: ExprAst[] };
	if (list.type !== 'expr_list' || !Array.isArray(list.value)) {
		throw new UnsupportedQueryError('expected a value list.');
	}
	for (const item of list.value) {
		if (item && typeof item === 'object' && 'ast' in item) {
			throw new UnsupportedQueryError('a subquery inside IN (...) is not supported.');
		}
	}
	return list.value;
}

/** A SQL LIKE pattern → an anchored regex source. `%`→`.*`, `_`→`.`; every regex metacharacter in
 *  the literal text is escaped first. Case sensitivity is the CALLER's choice (SQL `LIKE` is
 *  case-sensitive, `ILIKE` is not), so no flags are applied here. */
export function likeToRegex(pattern: string): string {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return '^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$';
}

/** LIMIT/OFFSET as the parser reports it. `LIMIT 10 OFFSET 5` → both; a bare `OFFSET 5` →
 *  `{ skip: 5 }` with NO limit (the `offset` separator with a single value is an OFFSET, not a
 *  LIMIT — reading it as a limit silently truncated the result). */
export function limitAndOffset(limit: { seperator: string; value: { value: number }[] } | null | undefined): { skip?: number; limit?: number } {
	if (!limit || !Array.isArray(limit.value) || limit.value.length === 0) {
		return {};
	}
	if (limit.seperator === 'offset') {
		if (limit.value.length === 1) {
			return { skip: limit.value[0].value };
		}
		return { limit: limit.value[0].value, skip: limit.value[1]?.value };
	}
	return { limit: limit.value[0].value };
}

/** Introspected field types for one collection/index: field path (dotted for nested) → the
 *  inferred type label, lower-cased. Empty when the schema doesn't know the entity. */
export type FieldTypes = ReadonlyMap<string, string>;

/**
 * The introspected schema a compiler was handed, indexed for lookup. Absent/empty means
 * "compile schema-blind" — every schema-driven behaviour (type coercion, the unknown-collection
 * check) degrades to the previous, mechanical mapping rather than guessing.
 */
export class SchemaIndex {
	private readonly byName = new Map<string, FieldTypes>();
	/** Entity names as introspection spelled them, for the "did you mean" in an unknown-entity error. */
	readonly names: string[] = [];

	constructor(schema?: DatabaseSchema | null) {
		for (const table of schema?.tables ?? []) {
			const fields = new Map<string, string>();
			for (const column of table.columns) {
				fields.set(column.name, (column.dataType ?? '').toLowerCase());
			}
			// A namespaced entity (Pinecone `ns.index`) is addressable both ways.
			this.byName.set(table.name.toLowerCase(), fields);
			if (table.schema) {
				this.byName.set(`${table.schema}.${table.name}`.toLowerCase(), fields);
			}
			this.names.push(table.schema ? `${table.schema}.${table.name}` : table.name);
		}
	}

	/** True when we have a schema at all (an empty one means "not introspected", not "no tables"). */
	get known(): boolean {
		return this.names.length > 0;
	}

	/** The field types of one entity, or undefined when unknown/schema-blind. */
	fields(name: string): FieldTypes | undefined {
		return this.byName.get(name.toLowerCase());
	}

	/** True when this entity exists (always true when schema-blind, so nothing is falsely rejected). */
	has(name: string): boolean {
		return !this.known || this.byName.has(name.toLowerCase());
	}
}

/** A 24-hex ObjectId string. */
export const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;
/** A canonical 8-4-4-4-12 UUID string. */
export const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One thing wrong with the buffer, positioned in the BUFFER (not in the statement it was found
 *  in), ready to become an editor marker. */
export interface SqlSyntaxDiagnostic {
	severity: 'error' | 'warning';
	message: string;
	suggestion?: string;
	start: number;
	end: number;
}

/**
 * Everything wrong with an editor buffer that can be known WITHOUT a database: statements this
 * grammar cannot parse, and values quoted the way another dialect quotes them. For the backends
 * whose SQL is compiled here (document, vector, telemetry) this is the only chance to catch a typo
 * before the query is sent, because there is no server to send it to that would answer with a
 * syntax error of its own. Deterministic, local and fast, so it can run on every (debounced) edit
 * like the rest of the advisor diagnostics.
 *
 * A failure is reported ONLY when {@link describeParseFailure} recognised the mistake: half-typed
 * SQL is a syntax error at every keystroke, and underlining that would be noise rather than help.
 */
export function sqlSyntaxDiagnostics(text: string): SqlSyntaxDiagnostic[] {
	const out: SqlSyntaxDiagnostic[] = [];
	for (const span of splitStatementSpans(text)) {
		try {
			parser.astify(span.sql, { database: 'postgresql' });
		} catch (err) {
			const problem = describeParseFailure(span.sql, err);
			if (problem.confident) {
				out.push({
					severity: 'error',
					message: problem.message,
					suggestion: problem.suggestion,
					start: span.start + problem.start,
					end: span.start + problem.end,
				});
			}
			continue; // a statement that didn't parse has nothing further worth saying about it
		}
		for (const warning of quotedValueWarnings(span.sql)) {
			out.push({
				severity: 'warning',
				message: warning.message,
				suggestion: warning.suggestion,
				start: span.start + warning.start,
				end: span.start + warning.end,
			});
		}
	}
	return out;
}

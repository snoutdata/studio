/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Deterministic SQL -> MongoDB compiler. Turns an authored SQL statement into the
 *  native form a document backend executes: a read becomes an aggregation pipeline, a write becomes
 *  a `mongo-write` batch, a structure change a `mongo-ddl` batch. Anything outside the supported
 *  subset throws {@link UnsupportedQueryError}, which the main-process orchestrator catches to offer
 *  the (consent-gated) AI transcriber; a statement that is deterministically WRONG for the
 *  connection instead throws {@link CompileError}, which is terminal (see sqlAst.ts).
 *
 *  Reads cover: SELECT (columns, expressions, CASE, functions, CAST), WHERE (all comparison
 *  operators, AND/OR/NOT, BETWEEN, IN, LIKE/ILIKE, IS [NOT] NULL, column-to-column and expression
 *  predicates via `$expr`), INNER/LEFT JOIN (`$lookup` + `$unwind`), GROUP BY + HAVING, DISTINCT,
 *  aggregates with or without GROUP BY, ORDER BY (columns, aliases, ordinals, expressions), and
 *  LIMIT/OFFSET.
 *
 *  Two semantic rules the compiler holds to, because SQL and MongoDB disagree by default:
 *  1. **SQL three-valued logic.** A negated predicate (`<>`, `NOT IN`, `NOT LIKE`, `NOT BETWEEN`)
 *     must NOT match a document where the field is missing or null — SQL excludes those rows, while
 *     a bare `$ne` includes them. So `a <> 1` compiles to `{a: {$nin: [1, null]}}`.
 *  2. **`LIKE` is case-SENSITIVE** (`ILIKE` is not). Emitting `$options: 'i'` for `LIKE`, as this
 *     compiler once did, silently turned every `LIKE` into an `ILIKE`.
 *
 *  Given the connection's introspected schema (see {@link MongoCompileOptions}) it also coerces
 *  literals to the field's real BSON type — `created_at > '2024-01-01'` compares against a Date,
 *  not a string, which is the difference between the right rows and a silent zero.
 *
 *  We parse with node-sql-parser's PostgreSQL grammar regardless of the connection (the SQL here
 *  targets Mongo, not a relational vendor) — the `mongodb` Dialect generates Postgres-style SQL to
 *  match (double-quoted identifiers, LIMIT/OFFSET).
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSchema } from '../../schema';
import type { MongoDdl, MongoWrite, NativeQuery } from './native';
import {
	assertDocumentField,
	CompileError,
	columnName,
	exprListNodes,
	functionArgs,
	functionName,
	isLiteral,
	isStar,
	likeToRegex,
	limitAndOffset,
	literalValue,
	OBJECT_ID_HEX,
	parseOneStatement,
	qualifierOf,
	rejectUnsupportedSelectClauses,
	SchemaIndex,
	SqlSyntaxError,
	UnsupportedQueryError,
	UUID_HEX,
	type CaseBranch,
	type ColumnAst,
	type ExprAst,
	type FieldTypes,
	type FromAst,
	type SelectAst,
	type StatementAst,
} from './sqlAst';

// Re-exported so existing callers keep importing the errors from here (and through `shared/engine`).
export { CompileError, SqlSyntaxError, UnsupportedQueryError };

/** What the compiler is allowed to know about the connection. Schema-blind compilation still works
 *  (every schema-driven step degrades to the mechanical mapping); with a schema it also type-coerces
 *  literals and catches an unknown collection or a mistyped qualifier at compile time. */
export interface MongoCompileOptions {
	schema?: DatabaseSchema | null;
}

/** A mongo read query — the narrow return of the SELECT path. */
type MongoRead = Extract<NativeQuery, { lang: 'mongo' }>;

/**
 * Compile a single SQL statement into the document backend's {@link NativeQuery}. Reads produce a
 * `mongo` aggregation, writes a `mongo-write` batch, structure changes a `mongo-ddl` batch.
 */
export function sqlToMongo(sql: string, options?: MongoCompileOptions): NativeQuery {
	// A leading EXPLAIN [ANALYZE] compiles to the same pipeline with the explain flag set, so it runs
	// through the driver's aggregate(...).explain() instead of the model. This
	// keeps `EXPLAIN SELECT …` a fast, offline, deterministic path — never an AI transcribe.
	const explainPrefix = /^\s*explain\s+(?:analyze\s+)?/i.exec(sql);
	if (explainPrefix) {
		const inner = sqlToMongo(sql.slice(explainPrefix[0].length), options);
		if (inner.lang !== 'mongo') {
			throw new UnsupportedQueryError('only a SELECT can be explained.');
		}
		return { ...inner, explain: true };
	}
	const ast = parseOneStatement(sql);
	const schema = new SchemaIndex(options?.schema);
	switch (ast.type) {
		case 'select':
			return compileSelect(ast as unknown as SelectAst, schema);
		case 'insert':
			return compileInsert(ast, schema);
		case 'update':
			return compileUpdate(ast, schema);
		case 'delete':
			return compileDelete(ast, schema);
		case 'truncate':
			return compileTruncate(ast);
		case 'create':
			return compileCreate(ast);
		case 'drop':
			return compileDrop(ast);
		default:
			throw new UnsupportedQueryError(`${ast.type.toUpperCase()} statements can't be translated to MongoDB.`);
	}
}

/** Compile a SELECT only — the read path, for callers that want the narrow type. */
export function sqlToMongoRead(sql: string, options?: MongoCompileOptions): MongoRead {
	const native = sqlToMongo(sql, options);
	if (native.lang !== 'mongo') {
		throw new UnsupportedQueryError('expected a SELECT statement.');
	}
	return native;
}

// ---------------------------------------------------------------------------------------------
// Context: what the compiler knows about the sources a statement reads.
// ---------------------------------------------------------------------------------------------

/** One collection a statement reads: the base (FROM) or a joined one. */
interface Source {
	/** The collection name in MongoDB. */
	collection: string;
	/** How the SQL refers to it (its alias, else the collection name). */
	alias: string;
	/** Where its fields live in the pipeline's documents: `''` for the base, `'<alias>.'` joined. */
	prefix: string;
	/** Introspected field types, when the schema knows this collection. */
	fields?: FieldTypes;
}

/** Post-`$group` name resolution, used to compile HAVING against the group's OUTPUT fields. */
interface PostGroup {
	/** A column reference in HAVING → the output path it means (`_id`, `_id.k`, or an alias). */
	column(name: string): string | undefined;
	/** An aggregate in HAVING → the `$group` output field holding it (registering it if needed). */
	aggregate(node: ExprAst): string;
}

interface Ctx {
	base: Source;
	joins: Source[];
	schema: SchemaIndex;
	/** Set while compiling HAVING: names resolve to post-`$group` outputs, not source fields. */
	post?: PostGroup;
}

/** Build the source list from the FROM clause, compiling each join to a `$lookup` + `$unwind`. */
function compileFrom(from: FromAst[], schema: SchemaIndex): { ctx: Ctx; stages: object[] } {
	const first = from[0];
	if (!first?.table) {
		throw new UnsupportedQueryError('a subquery in FROM is not supported.');
	}
	const base: Source = { collection: first.table, alias: sourceAlias(first.as || first.table), prefix: '', fields: schema.fields(first.table) };
	const ctx: Ctx = { base, joins: [], schema };
	const stages: object[] = [];

	for (const entry of from.slice(1)) {
		if (!entry.table) {
			throw new UnsupportedQueryError('a subquery in FROM is not supported.');
		}
		const kind = (entry.join ?? '').toUpperCase();
		if (kind !== 'INNER JOIN' && kind !== 'LEFT JOIN') {
			throw new UnsupportedQueryError(`${kind || 'CROSS JOIN'} is not supported (only INNER JOIN and LEFT JOIN).`);
		}
		if (!entry.on) {
			throw new UnsupportedQueryError('a JOIN without ON is not supported.');
		}
		const joined: Source = { collection: entry.table, alias: sourceAlias(entry.as || entry.table), prefix: `${sourceAlias(entry.as || entry.table)}.`, fields: schema.fields(entry.table) };
		// The ON must be one equality between an already-known source and the collection being joined:
		// that is exactly what $lookup's localField/foreignField express.
		const on = entry.on;
		if (on.type !== 'binary_expr' || on.operator !== '=' || !on.left || !on.right) {
			throw new UnsupportedQueryError('only a single `ON left.field = right.field` join condition is supported.');
		}
		const sides = [on.left, on.right].map((ref) => {
			if (ref.type !== 'column_ref') {
				throw new UnsupportedQueryError('a JOIN condition must compare two columns.');
			}
			return ref;
		});
		const foreignIndex = sides.findIndex((ref) => qualifierOf(ref) === joined.alias || qualifierOf(ref) === joined.collection);
		if (foreignIndex < 0) {
			throw new UnsupportedQueryError(`the ON condition must reference "${joined.alias}".`);
		}
		const foreign = sides[foreignIndex];
		const local = sides[1 - foreignIndex];
		stages.push({
			$lookup: {
				from: joined.collection,
				localField: fieldPath(local, ctx),
				foreignField: assertDocumentField(columnName(foreign)),
				as: joined.alias,
			},
		});
		// INNER drops documents with no match; LEFT keeps them with the joined field absent — which is
		// exactly $unwind's preserveNullAndEmptyArrays.
		stages.push({ $unwind: { path: `$${joined.alias}`, preserveNullAndEmptyArrays: kind === 'LEFT JOIN' } });
		ctx.joins.push(joined);
	}
	return { ctx, stages };
}

/** A source's alias, which a join turns into a field (`$lookup`'s `as`) and a path (`$unwind`). */
function sourceAlias(name: string): string {
	return assertDocumentField(name);
}

/**
 * The document path a column reference means. An unqualified name is a field of the base
 * collection; a qualifier that names a source resolves through that source; anything else is read
 * as a nested path (`address.city`) — and, when the schema knows the collection, is rejected if it
 * isn't one (a typo'd alias used to compile into a nested path that silently matched nothing).
 */
function fieldPath(ref: ExprAst, ctx: Ctx): string {
	return assertDocumentField(resolveFieldPath(ref, ctx));
}

function resolveFieldPath(ref: ExprAst, ctx: Ctx): string {
	if (ref.type !== 'column_ref') {
		throw new UnsupportedQueryError('expected a column reference.');
	}
	const col = columnName(ref);
	if (ctx.post) {
		const resolved = ctx.post.column(col);
		if (!resolved) {
			throw new UnsupportedQueryError(`HAVING can only reference grouped columns or aggregates ("${col}" is neither).`);
		}
		return resolved;
	}
	const qualifier = qualifierOf(ref);
	if (!qualifier || qualifier === ctx.base.alias || qualifier === ctx.base.collection) {
		return col;
	}
	const joined = ctx.joins.find((source) => qualifier === source.alias || qualifier === source.collection);
	if (joined) {
		return `${joined.prefix}${col}`;
	}
	const path = `${qualifier}.${col}`;
	const fields = ctx.base.fields;
	if (fields && fields.size > 0 && !fields.has(path) && !fields.has(qualifier) && ![...fields.keys()].some((f) => f.startsWith(`${qualifier}.`))) {
		const sources = [ctx.base, ...ctx.joins].map((s) => `"${s.alias}"`).join(', ');
		throw new CompileError(`"${qualifier}" is not a field of collection "${ctx.base.collection}", nor one of its sources (${sources}).`);
	}
	return path;
}

/** The introspected type of a document path, or `''` when unknown. Joined paths resolve against the
 *  joined collection's own fields. */
function fieldTypeOf(path: string, ctx: Ctx): string {
	for (const source of ctx.joins) {
		if (path.startsWith(source.prefix)) {
			return source.fields?.get(path.slice(source.prefix.length)) ?? '';
		}
	}
	return ctx.base.fields?.get(path) ?? '';
}

/** The single non-null type in an inferred label (`'date'`, `'date | null'`), or `''` when the field
 *  holds more than one type — an ambiguous field is never coerced, since we'd have to guess. */
function soleType(label: string): string {
	const types = label.split('|').map((t) => t.trim()).filter((t) => t && t !== 'null');
	return types.length === 1 ? types[0] : '';
}

const NUMERIC_TYPES = new Set(['int', 'int32', 'long', 'double', 'decimal', 'decimal128', 'number']);

/**
 * A SQL literal interpreted against the field's real BSON type. `NativeQuery` is JSON, so a Date /
 * ObjectId / UUID travels as the Extended-JSON wrapper the Mongo driver revives (`{$date}`,
 * `{$oid}`, `{$uuid}`) — the same wrappers the editable grid already emits on the write path.
 * Without a schema (or on an ambiguous field) the value passes through untouched.
 */
function coerceLiteral(value: unknown, path: string, ctx: Ctx): unknown {
	if (typeof value !== 'string' || ctx.post) {
		return value;
	}
	const type = soleType(fieldTypeOf(path, ctx));
	if (!type) {
		return value;
	}
	const raw = value.trim();
	if (type === 'objectid' && OBJECT_ID_HEX.test(raw)) {
		return { $oid: raw };
	}
	if (type === 'uuid' && UUID_HEX.test(raw)) {
		return { $uuid: raw };
	}
	if (type === 'date') {
		const parsed = new Date(raw);
		if (!Number.isNaN(parsed.getTime())) {
			return { $date: parsed.toISOString() };
		}
	}
	if (NUMERIC_TYPES.has(type) && raw !== '' && !Number.isNaN(Number(raw))) {
		return Number(raw);
	}
	if (type === 'bool' && (raw.toLowerCase() === 'true' || raw.toLowerCase() === 'false')) {
		return raw.toLowerCase() === 'true';
	}
	return value;
}

// ---------------------------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------------------------

function compileSelect(select: SelectAst, schema: SchemaIndex): MongoRead {
	rejectUnsupportedSelectClauses(select);
	if (!Array.isArray(select.from) || select.from.length === 0) {
		throw new UnsupportedQueryError('a SELECT without FROM has no collection to run against.');
	}
	const { ctx, stages: joinStages } = compileFrom(select.from, schema);
	if (!schema.has(ctx.base.collection)) {
		throw new CompileError(`Collection "${ctx.base.collection}" does not exist on this connection.`);
	}
	const columns = normalizeColumns(select.columns);
	const pipeline: object[] = [];

	// $lookup before $match only when the filter reads a joined field — otherwise filter first, so a
	// join runs over the rows that survive the WHERE rather than the whole collection.
	const match = select.where ? compileWhere(select.where, ctx) : undefined;
	const joinsFirst = joinStages.length > 0 && !!select.where && referencesJoin(select.where, ctx);
	if (joinsFirst) {
		pipeline.push(...joinStages);
	}
	if (match) {
		pipeline.push({ $match: match });
	}
	if (!joinsFirst) {
		pipeline.push(...joinStages);
	}

	const distinct = !!select.distinct?.type;
	const groupCols = select.groupby?.columns ?? [];
	const aggregated = groupCols.length > 0 || columns.some((c) => containsAggregate(c.expr));

	if (aggregated) {
		pipeline.push(...compileGrouped(select, columns, groupCols, ctx));
		pipeline.push(...compileTail(select, columns, ctx, /*afterProject*/ true));
		return { lang: 'mongo', collection: ctx.base.collection, pipeline };
	}
	if (distinct) {
		pipeline.push(...compileDistinct(columns, ctx));
		pipeline.push(...compileTail(select, columns, ctx, /*afterProject*/ true));
		return { lang: 'mongo', collection: ctx.base.collection, pipeline };
	}

	// Ungrouped: the projection normally goes LAST (so ORDER BY can sort by a column that isn't
	// selected), unless the sort reads a computed alias that only exists after it.
	const projection = compileProjection(columns, ctx);
	const sortNeedsProjection = orderByNeedsProjection(select.orderby, columns);
	if (sortNeedsProjection && projection) {
		pipeline.push(projection);
		pipeline.push(...compileTail(select, columns, ctx, true));
	} else {
		pipeline.push(...compileTail(select, columns, ctx, false));
		if (projection) {
			pipeline.push(projection);
		}
	}
	return { lang: 'mongo', collection: ctx.base.collection, pipeline };
}

/** ORDER BY + LIMIT/OFFSET, in pipeline order. `afterProject` says whether the projection has
 *  already run, which decides how an ORDER BY name is resolved (output alias vs source field). */
function compileTail(select: SelectAst, columns: ColumnAst[], ctx: Ctx, afterProject: boolean): object[] {
	const stages: object[] = [];
	const { sort, hidden } = compileOrderBy(select.orderby, columns, ctx, afterProject);
	if (sort) {
		if (Object.keys(hidden).length > 0) {
			stages.push({ $addFields: hidden });
		}
		stages.push({ $sort: sort });
		if (Object.keys(hidden).length > 0) {
			stages.push({ $unset: Object.keys(hidden) });
		}
	}
	const { skip, limit } = limitAndOffset(select.limit);
	if (skip !== undefined && skip > 0) {
		stages.push({ $skip: skip });
	}
	if (limit !== undefined) {
		stages.push({ $limit: limit });
	}
	return stages;
}

/** The SELECT list as a uniform array. */
function normalizeColumns(columns: ColumnAst[] | '*'): ColumnAst[] {
	if (columns === '*') {
		return [{ expr: { type: 'column_ref', column: '*' }, as: null }];
	}
	return columns;
}

/** True when the SELECT list is exactly `*`. */
function isStarOnly(columns: ColumnAst[]): boolean {
	return columns.length === 1 && isStar(columns[0].expr);
}

/**
 * The output name of one SELECT item: its alias, else the name SQL would give the column — the
 * FINAL segment of the path (`SELECT address.city` returns a column called `city`, and `SELECT b.x`
 * over a join returns `x`). Projecting under the dotted path instead would rebuild the nesting, so
 * the grid showed one `address` column holding a JSON blob rather than the field that was asked for.
 * `taken` disambiguates a collision (two paths ending in the same name) by keeping the full path.
 */
function outputName(column: ColumnAst, ctx: Ctx, taken?: ReadonlySet<string>): string {
	if (column.as) {
		return assertDocumentField(column.as);
	}
	if (column.expr.type === 'column_ref') {
		const path = fieldPath(column.expr, ctx);
		const short = path.slice(path.lastIndexOf('.') + 1);
		return taken?.has(short) ? path : short;
	}
	if (column.expr.type === 'aggr_func') {
		return String(column.expr.name ?? 'value').toLowerCase();
	}
	throw new UnsupportedQueryError('an expression in the SELECT list needs an alias (`… AS name`).');
}

/** The output names of a whole SELECT list, resolved left to right so an earlier column keeps the
 *  short name and a later collision falls back to its full path. */
function outputNames(columns: ColumnAst[], ctx: Ctx): string[] {
	const taken = new Set<string>();
	return columns.map((column) => {
		if (isStar(column.expr)) {
			return '*';
		}
		const name = outputName(column, ctx, taken);
		taken.add(name);
		return name;
	});
}

/** Compile the SELECT list to a `$project` (or `$addFields` when it extends `*`), or undefined for
 *  a bare `SELECT *`. */
function compileProjection(columns: ColumnAst[], ctx: Ctx): object | undefined {
	if (isStarOnly(columns)) {
		return undefined;
	}
	const names = outputNames(columns, ctx);
	if (columns.some((c) => isStar(c.expr))) {
		// `SELECT *, <expr> AS x` — keep the document and add the computed fields.
		const added: Record<string, unknown> = {};
		columns.forEach((column, index) => {
			if (isStar(column.expr) || (column.expr.type === 'column_ref' && !column.as)) {
				return; // the star covers it, or it's already in the document
			}
			added[names[index]] = compileExpr(column.expr, ctx);
		});
		return Object.keys(added).length > 0 ? { $addFields: added } : undefined;
	}
	const project: Record<string, unknown> = {};
	let selectsId = false;
	columns.forEach((column, index) => {
		const out = names[index];
		if (out === '_id') {
			selectsId = true;
		}
		if (column.expr.type === 'column_ref') {
			const source = fieldPath(column.expr, ctx);
			// `b AS bb` → { bb: '$b' }; a plain column → { a: 1 }.
			project[out] = out === source ? 1 : `$${source}`;
		} else {
			project[out] = compileExpr(column.expr, ctx);
		}
	});
	// SQL only returns the named columns; suppress Mongo's implicit _id unless it was selected.
	if (!selectsId) {
		project._id = 0;
	}
	return { $project: project };
}

/** `SELECT DISTINCT a, b` → group by the selected values, then flatten back to those names. */
function compileDistinct(columns: ColumnAst[], ctx: Ctx): object[] {
	if (columns.some((c) => isStar(c.expr))) {
		throw new UnsupportedQueryError('SELECT DISTINCT * is not supported (name the columns).');
	}
	const id: Record<string, unknown> = {};
	const project: Record<string, unknown> = { _id: 0 };
	const names = outputNames(columns, ctx);
	columns.forEach((column, index) => {
		const out = names[index];
		const key = keyName(out);
		id[key] = compileExpr(column.expr, ctx);
		project[out] = `$_id.${key}`;
	});
	return [{ $group: { _id: id } }, { $project: project }];
}

/** A `$group._id` sub-key name for a path: Mongo forbids dots in an `_id` key, so nest→underscore. */
function keyName(path: string): string {
	return path.replace(/\./g, '_');
}

// ---------------------------------------------------------------------------------------------
// GROUP BY / aggregates / HAVING
// ---------------------------------------------------------------------------------------------

const ACCUMULATORS: Record<string, string> = { SUM: '$sum', AVG: '$avg', MIN: '$min', MAX: '$max' };

/** True when an expression tree contains an aggregate call anywhere. */
function containsAggregate(node: ExprAst | undefined): boolean {
	if (!node || typeof node !== 'object') {
		return false;
	}
	if (node.type === 'aggr_func') {
		return true;
	}
	for (const child of childExprs(node)) {
		if (containsAggregate(child)) {
			return true;
		}
	}
	return false;
}

/** The child expression nodes of any node, for generic tree walks. */
function childExprs(node: ExprAst): ExprAst[] {
	const out: ExprAst[] = [];
	for (const child of [node.left, node.right, node.expr]) {
		if (child && typeof child === 'object') {
			out.push(child);
		}
	}
	const args = node.args;
	if (Array.isArray(args)) {
		for (const branch of args) {
			if (branch.cond) {
				out.push(branch.cond);
			}
			if (branch.result) {
				out.push(branch.result);
			}
		}
	} else if (args && typeof args === 'object') {
		const list = (args as { value?: ExprAst[] }).value;
		if (Array.isArray(list)) {
			out.push(...list);
		}
		const single = (args as { expr?: ExprAst }).expr;
		if (single && typeof single === 'object') {
			out.push(single);
		}
	}
	return out;
}

/** True when a predicate reads a field of a joined collection (so the $lookup must run first). */
function referencesJoin(node: ExprAst, ctx: Ctx): boolean {
	if (node.type === 'column_ref') {
		const qualifier = qualifierOf(node);
		return !!qualifier && ctx.joins.some((s) => qualifier === s.alias || qualifier === s.collection);
	}
	return childExprs(node).some((child) => referencesJoin(child, ctx));
}

/**
 * `$group` (+ a HAVING `$match`) + the flattening `$project`. Handles GROUP BY with any number of
 * keys AND the ungrouped-aggregate case (`SELECT COUNT(*) FROM c`), which groups on a null key.
 */
function compileGrouped(select: SelectAst, columns: ColumnAst[], groupCols: ExprAst[], ctx: Ctx): object[] {
	if (columns.some((c) => isStar(c.expr))) {
		throw new UnsupportedQueryError('SELECT * with GROUP BY is not supported (name the columns).');
	}
	// Group keys, each addressable by the path/alias the SELECT list will use to refer to it.
	const keys = groupCols.map((ref) => {
		if (ref.type !== 'column_ref') {
			throw new UnsupportedQueryError('only plain columns are supported in GROUP BY.');
		}
		const path = fieldPath(ref, ctx);
		return { path, key: keyName(path) };
	});
	const id: unknown = keys.length === 0 ? null : keys.length === 1 ? `$${keys[0].path}` : Object.fromEntries(keys.map((k) => [k.key, `$${k.path}`]));
	const group: Record<string, unknown> = { _id: id };
	const project: Record<string, unknown> = { _id: 0 };
	/** Aggregate signature → the `$group` field holding it, so HAVING reuses the same accumulator. */
	const aggregates = new Map<string, string>();
	/** Output name → the post-group path HAVING should read it from. */
	const outputs = new Map<string, string>();
	/** COUNT(DISTINCT x) collects a set in $group and takes its size in $project. */
	const distinctCounts: { out: string; setField: string }[] = [];

	const addAggregate = (node: ExprAst, out: string): void => {
		const signature = aggregateSignature(node, ctx);
		const fn = String(node.name ?? '').toUpperCase();
		const args = (node.args ?? {}) as { expr?: ExprAst; distinct?: string | null };
		const arg = args.expr;
		const isDistinct = typeof args.distinct === 'string' && args.distinct.toUpperCase() === 'DISTINCT';
		if (fn === 'COUNT') {
			if (isStar(arg)) {
				group[out] = { $sum: 1 };
			} else if (!arg) {
				throw new UnsupportedQueryError('COUNT needs an argument.');
			} else if (isDistinct) {
				const setField = `__set_${out}`;
				group[setField] = { $addToSet: compileExpr(arg, ctx) };
				distinctCounts.push({ out, setField });
			} else {
				// SQL COUNT(col) counts NON-NULL values; a plain $sum:1 would count every document.
				group[out] = { $sum: { $cond: [{ $in: [{ $type: compileExpr(arg, ctx) }, ['missing', 'null']] }, 0, 1] } };
			}
		} else {
			const accumulator = ACCUMULATORS[fn];
			if (!accumulator) {
				throw new UnsupportedQueryError(`unsupported aggregate: ${fn}`);
			}
			if (!arg || isStar(arg)) {
				throw new UnsupportedQueryError(`${fn} requires a column argument.`);
			}
			if (isDistinct) {
				throw new UnsupportedQueryError(`${fn}(DISTINCT …) is not supported.`);
			}
			group[out] = { [accumulator]: compileExpr(arg, ctx) };
		}
		aggregates.set(signature, out);
	};

	const names = outputNames(columns, ctx);
	columns.forEach((column, position) => {
		const expr = column.expr;
		const out = names[position];
		if (expr.type === 'column_ref') {
			const path = fieldPath(expr, ctx);
			const index = keys.findIndex((k) => k.path === path);
			if (index < 0) {
				throw new UnsupportedQueryError(`column "${path}" must appear in GROUP BY or an aggregate.`);
			}
			const source = keys.length === 1 ? '$_id' : `$_id.${keys[index].key}`;
			project[out] = source;
			outputs.set(out, source.slice(1));
		} else if (expr.type === 'aggr_func') {
			addAggregate(expr, out);
			project[out] = 1;
			outputs.set(out, out);
		} else {
			throw new UnsupportedQueryError('only grouped columns and aggregates are allowed with GROUP BY.');
		}
	});
	for (const { out, setField } of distinctCounts) {
		project[out] = { $size: `$${setField}` };
	}

	const stages: object[] = [{ $group: group }];
	if (select.having) {
		const post: PostGroup = {
			column: (name) => {
				const direct = outputs.get(name);
				if (direct) {
					return direct;
				}
				const index = keys.findIndex((k) => k.path === name || k.key === name);
				if (index < 0) {
					return undefined;
				}
				return keys.length === 1 ? '_id' : `_id.${keys[index].key}`;
			},
			aggregate: (node) => {
				const signature = aggregateSignature(node, ctx);
				const existing = aggregates.get(signature);
				if (existing) {
					return existing;
				}
				// An aggregate used only in HAVING still needs computing; add it under a hidden name that
				// the flattening $project (which lists the SELECT outputs explicitly) then drops.
				const hidden = `__having_${aggregates.size}`;
				addAggregate(node, hidden);
				return hidden;
			},
		};
		stages.push({ $match: compileWhere(select.having, { ...ctx, post }) });
	}
	stages.push({ $project: project });
	return stages;
}

/** A stable identity for an aggregate call, so `HAVING COUNT(*) > 1` reuses the `COUNT(*)` the
 *  SELECT list already computes instead of adding a second accumulator. */
function aggregateSignature(node: ExprAst, ctx: Ctx): string {
	const args = (node.args ?? {}) as { expr?: ExprAst; distinct?: string | null };
	const fn = String(node.name ?? '').toUpperCase();
	const distinct = typeof args.distinct === 'string' ? 'DISTINCT ' : '';
	const arg = isStar(args.expr) ? '*' : args.expr ? JSON.stringify(compileExpr(args.expr, { ...ctx, post: undefined })) : '';
	return `${fn}(${distinct}${arg})`;
}

// ---------------------------------------------------------------------------------------------
// ORDER BY
// ---------------------------------------------------------------------------------------------

/** True when a sort key names an alias that only exists once the projection has run (a computed
 *  column). Sorting before the projection would then sort on a field that isn't there yet. */
function orderByNeedsProjection(orderby: SelectAst['orderby'], columns: ColumnAst[]): boolean {
	if (!orderby || orderby.length === 0) {
		return false;
	}
	const computed = new Set(columns.filter((c) => c.as && c.expr.type !== 'column_ref').map((c) => c.as as string));
	return orderby.some((item) => {
		if (item.expr.type === 'number') {
			const index = Number(item.expr.value) - 1;
			const target = columns[index];
			return !!target && target.expr.type !== 'column_ref';
		}
		return item.expr.type === 'column_ref' && computed.has(columnName(item.expr));
	});
}

/**
 * ORDER BY → a `$sort` document. Sort keys may be columns, output aliases, 1-based ordinals, or
 * expressions; an expression is materialized into a hidden field (`hidden`) the caller adds with
 * `$addFields` and removes again with `$unset`.
 */
function compileOrderBy(
	orderby: SelectAst['orderby'],
	columns: ColumnAst[],
	ctx: Ctx,
	afterProject: boolean,
): { sort?: Record<string, 1 | -1>; hidden: Record<string, unknown> } {
	const hidden: Record<string, unknown> = {};
	if (!orderby || orderby.length === 0) {
		return { hidden };
	}
	const sort: Record<string, 1 | -1> = {};
	const aliases = new Map<string, ColumnAst>();
	for (const column of columns) {
		if (column.as) {
			aliases.set(column.as, column);
		}
	}
	for (const item of orderby) {
		let expr = item.expr;
		// `ORDER BY 1` — the first item of the SELECT list.
		if (expr.type === 'number') {
			const index = Number(expr.value) - 1;
			const target = columns[index];
			if (!target) {
				throw new CompileError(`ORDER BY ${expr.value} refers to a column the SELECT list doesn't have.`);
			}
			expr = target.as ? { type: 'column_ref', column: target.as } : target.expr;
		}
		const direction: 1 | -1 = (item.type ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
		if (expr.type === 'column_ref') {
			const name = columnName(expr);
			const aliased = aliases.get(name);
			if (aliased) {
				// An alias over a plain column can sort on the SOURCE field (so the sort may precede the
				// projection); an alias over an expression only exists after the projection.
				sort[afterProject || aliased.expr.type !== 'column_ref' ? name : fieldPath(aliased.expr, ctx)] = direction;
			} else {
				sort[fieldPath(expr, ctx)] = direction;
			}
			continue;
		}
		// An expression: materialize it, sort on it, drop it again.
		const field = `__sort_${Object.keys(hidden).length}`;
		hidden[field] = compileExpr(expr, ctx);
		sort[field] = direction;
	}
	return { sort, hidden };
}

// ---------------------------------------------------------------------------------------------
// WHERE / HAVING
// ---------------------------------------------------------------------------------------------

/** Comparison operators inverted, for pushing a NOT down into the predicate (De Morgan). Inverting
 *  in place keeps SQL's null semantics exact, where a blanket `$nor` wrapper would not. */
const INVERSE: Record<string, string> = {
	'=': '!=',
	'!=': '=',
	'<>': '=',
	'>': '<=',
	'>=': '<',
	'<': '>=',
	'<=': '>',
	IN: 'NOT IN',
	'NOT IN': 'IN',
	LIKE: 'NOT LIKE',
	'NOT LIKE': 'LIKE',
	ILIKE: 'NOT ILIKE',
	'NOT ILIKE': 'ILIKE',
	IS: 'IS NOT',
	'IS NOT': 'IS',
	BETWEEN: 'NOT BETWEEN',
	'NOT BETWEEN': 'BETWEEN',
};

/** Compile a WHERE/HAVING/ON expression tree to a `$match` document. `negate` carries a NOT down
 *  through the tree rather than wrapping the result. */
function compileWhere(node: ExprAst, ctx: Ctx, negate = false): Record<string, unknown> {
	// `NOT (…)` parses as a function call named NOT (and, in some positions, a unary_expr).
	if ((node.type === 'function' && functionName(node) === 'NOT') || (node.type === 'unary_expr' && (node.operator ?? '').toUpperCase() === 'NOT')) {
		const inner = node.type === 'function' ? functionArgs(node)[0] : node.expr;
		if (!inner) {
			throw new UnsupportedQueryError('NOT without an operand.');
		}
		return compileWhere(inner, ctx, !negate);
	}
	// A bare boolean column (`WHERE active`), which SQL allows as a predicate on its own.
	if (node.type === 'column_ref' && !isStar(node)) {
		return { [fieldPath(node, ctx)]: !negate };
	}
	if (node.type !== 'binary_expr' || !node.operator) {
		throw new UnsupportedQueryError(`unsupported WHERE expression: ${node.type}`);
	}
	const op = node.operator.toUpperCase();
	if (op === 'AND' || op === 'OR') {
		const branches = [compileWhere(node.left!, ctx, negate), compileWhere(node.right!, ctx, negate)];
		// NOT (a AND b) is (NOT a) OR (NOT b), and vice versa.
		const combinator = (op === 'AND') === !negate ? '$and' : '$or';
		return { [combinator]: branches };
	}
	const effective = negate ? INVERSE[op] : op;
	if (!effective) {
		throw new UnsupportedQueryError(`NOT is not supported over ${op}.`);
	}
	return compileComparison(effective, node.left!, node.right!, ctx);
}

/** The document path a node can be matched on directly: a column, or — while compiling HAVING —
 *  an aggregate, which by then is a real field of the `$group` output. Undefined for anything that
 *  has to be computed, which is what sends a comparison down the `$expr` path. */
function matchField(node: ExprAst, ctx: Ctx): string | undefined {
	if (node.type === 'column_ref' && !isStar(node)) {
		return fieldPath(node, ctx);
	}
	if (node.type === 'aggr_func' && ctx.post) {
		return ctx.post.aggregate(node);
	}
	return undefined;
}

/** One comparison, in whichever form Mongo can express it: the field-operand form when a plain
 *  column is compared to a literal, `$expr` when either side is an expression or another column. */
function compileComparison(op: string, left: ExprAst, right: ExprAst, ctx: Ctx): Record<string, unknown> {
	if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
		const [lo, hi] = exprListNodes(right);
		const field = fieldPath(left, ctx);
		const low = coerceLiteral(literalValue(lo), field, ctx);
		const high = coerceLiteral(literalValue(hi), field, ctx);
		if (op === 'BETWEEN') {
			return { [field]: { $gte: low, $lte: high } };
		}
		// NOT BETWEEN is `< low OR > high`; a missing field matches neither, which is what SQL means.
		return { $or: [{ [field]: { $lt: low } }, { [field]: { $gt: high } }] };
	}
	if (op === 'IN' || op === 'NOT IN') {
		const field = fieldPath(left, ctx);
		const values = exprListNodes(right).map((item) => coerceLiteral(literalValue(item), field, ctx));
		// `NOT IN` must also exclude missing/null (SQL's three-valued logic), which `$nin` alone doesn't.
		return op === 'IN' ? { [field]: { $in: values } } : { [field]: { $nin: [...values, null] } };
	}
	if (op === 'IS' || op === 'IS NOT') {
		const field = fieldPath(left, ctx);
		if (right.type !== 'null') {
			throw new UnsupportedQueryError('IS is only supported against NULL.');
		}
		// In a document backend a missing field IS the absent value, so `{field: null}` (which matches
		// both missing and explicit null) is the honest reading of IS NULL.
		return op === 'IS' ? { [field]: null } : { [field]: { $ne: null } };
	}

	const field = matchField(left, ctx);
	// Normalize `1 < a` to `a > 1` so the field-operand form still applies.
	if (field === undefined && isLiteral(left) && matchField(right, ctx) !== undefined) {
		const flipped: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=', '!=': '!=', '<>': '<>' };
		const swapped = flipped[op];
		if (swapped) {
			return compileComparison(swapped, right, left, ctx);
		}
	}
	if (field !== undefined && isLiteral(right)) {
		const value = coerceLiteral(literalValue(right), field, ctx);
		switch (op) {
			case '=':
				return { [field]: value };
			case '!=':
			case '<>':
				// SQL excludes rows where the field is null/missing from a `<>` result; `$ne` alone keeps them.
				return { [field]: { $nin: [value, null] } };
			case '>':
				return { [field]: { $gt: value } };
			case '>=':
				return { [field]: { $gte: value } };
			case '<':
				return { [field]: { $lt: value } };
			case '<=':
				return { [field]: { $lte: value } };
			case 'LIKE':
			case 'ILIKE':
				return { [field]: { $regex: likeToRegex(String(value)), ...(op === 'ILIKE' ? { $options: 'i' } : {}) } };
			case 'NOT LIKE':
			case 'NOT ILIKE': {
				// `$options` is not allowed inside `$not`, so case-insensitivity goes inline as `(?i)`.
				const pattern = (op === 'NOT ILIKE' ? '(?i)' : '') + likeToRegex(String(value));
				return { [field]: { $not: { $regex: pattern }, $ne: null } };
			}
			default:
				throw new UnsupportedQueryError(`unsupported operator: ${op}`);
		}
	}

	// Column-to-column, or an expression on either side: only `$expr` can compare two live values.
	if (op === 'LIKE' || op === 'ILIKE' || op === 'NOT LIKE' || op === 'NOT ILIKE') {
		const regex = { $regexMatch: { input: compileExpr(left, ctx), regex: likeToRegex(String(literalValue(right))), ...(op.endsWith('ILIKE') ? { options: 'i' } : {}) } };
		return { $expr: op.startsWith('NOT') ? { $not: regex } : regex };
	}
	const operator = EXPR_BINARY[op];
	if (!operator) {
		throw new UnsupportedQueryError(`unsupported operator: ${op}`);
	}
	return { $expr: { [operator]: [compileExpr(left, ctx), compileExpr(right, ctx)] } };
}

// ---------------------------------------------------------------------------------------------
// Expressions (the aggregation-expression form, used by $project, $group and $expr)
// ---------------------------------------------------------------------------------------------

/** SQL scalar function → the aggregation operator it maps to, for the single-argument cases. */
const UNARY_FUNCTIONS: Record<string, string> = {
	UPPER: '$toUpper',
	LOWER: '$toLower',
	LENGTH: '$strLenCP',
	CHAR_LENGTH: '$strLenCP',
	CHARACTER_LENGTH: '$strLenCP',
	ABS: '$abs',
	FLOOR: '$floor',
	CEIL: '$ceil',
	CEILING: '$ceil',
	SQRT: '$sqrt',
	EXP: '$exp',
	LN: '$ln',
	LOG10: '$log10',
	YEAR: '$year',
	MONTH: '$month',
	DAY: '$dayOfMonth',
	DAYOFMONTH: '$dayOfMonth',
	DAYOFWEEK: '$dayOfWeek',
	DAYOFYEAR: '$dayOfYear',
	HOUR: '$hour',
	MINUTE: '$minute',
	SECOND: '$second',
	SIZE: '$size',
	ARRAY_LENGTH: '$size',
	TRIM: '$trim',
	LTRIM: '$ltrim',
	RTRIM: '$rtrim',
};

/** Arithmetic/logical operators inside an expression. */
const EXPR_BINARY: Record<string, string> = {
	'+': '$add',
	'-': '$subtract',
	'*': '$multiply',
	'/': '$divide',
	'%': '$mod',
	'=': '$eq',
	'!=': '$ne',
	'<>': '$ne',
	'>': '$gt',
	'>=': '$gte',
	'<': '$lt',
	'<=': '$lte',
	AND: '$and',
	OR: '$or',
};

/** CAST target → the conversion operator. */
const CAST_TARGETS: Record<string, string> = {
	INT: '$toInt',
	INTEGER: '$toInt',
	SMALLINT: '$toInt',
	BIGINT: '$toLong',
	DECIMAL: '$toDecimal',
	NUMERIC: '$toDecimal',
	FLOAT: '$toDouble',
	DOUBLE: '$toDouble',
	REAL: '$toDouble',
	TEXT: '$toString',
	VARCHAR: '$toString',
	CHAR: '$toString',
	STRING: '$toString',
	BOOL: '$toBool',
	BOOLEAN: '$toBool',
	DATE: '$toDate',
	TIMESTAMP: '$toDate',
	DATETIME: '$toDate',
	OBJECTID: '$toObjectId',
};

/** Compile any scalar expression to its MongoDB aggregation-expression form. */
function compileExpr(node: ExprAst, ctx: Ctx): unknown {
	switch (node.type) {
		case 'column_ref': {
			if (isStar(node)) {
				throw new UnsupportedQueryError('`*` is not an expression.');
			}
			return `$${fieldPath(node, ctx)}`;
		}
		case 'number':
		case 'bool':
			return node.value;
		case 'null':
			return null;
		case 'single_quote_string':
		case 'string':
		case 'double_quote_string': {
			const value = node.value as string;
			// A string starting with `$` would read as a field path; `$literal` keeps it a value.
			return value.startsWith('$') ? { $literal: value } : value;
		}
		case 'unary_expr': {
			if ((node.operator ?? '') === '-' && node.expr) {
				return { $multiply: [-1, compileExpr(node.expr, ctx)] };
			}
			if ((node.operator ?? '').toUpperCase() === 'NOT' && node.expr) {
				return { $not: [compileExpr(node.expr, ctx)] };
			}
			throw new UnsupportedQueryError(`unsupported unary operator: ${node.operator}`);
		}
		case 'binary_expr': {
			const operator = EXPR_BINARY[(node.operator ?? '').toUpperCase()];
			if (!operator) {
				throw new UnsupportedQueryError(`unsupported operator in an expression: ${node.operator}`);
			}
			return { [operator]: [compileExpr(node.left!, ctx), compileExpr(node.right!, ctx)] };
		}
		case 'aggr_func': {
			if (!ctx.post) {
				throw new UnsupportedQueryError('an aggregate is only allowed in the SELECT list of a grouped query.');
			}
			return `$${ctx.post.aggregate(node)}`;
		}
		case 'case':
			return compileCase(node, ctx);
		case 'cast': {
			const target = (node.target?.[0]?.dataType ?? '').toUpperCase();
			const operator = CAST_TARGETS[target];
			if (!operator || !node.expr) {
				throw new UnsupportedQueryError(`unsupported CAST target: ${target || '(none)'}`);
			}
			return { [operator]: compileExpr(node.expr, ctx) };
		}
		case 'function':
			return compileFunction(node, ctx);
		default:
			throw new UnsupportedQueryError(`unsupported expression: ${node.type}`);
	}
}

/** `CASE WHEN … THEN … ELSE … END` → `$switch`. */
function compileCase(node: ExprAst, ctx: Ctx): unknown {
	const branches = Array.isArray(node.args) ? (node.args as CaseBranch[]) : [];
	const subject = node.expr; // `CASE <expr> WHEN v THEN …`
	const cases: object[] = [];
	let fallback: unknown = null;
	for (const branch of branches) {
		if (branch.type === 'else') {
			fallback = compileExpr(branch.result, ctx);
			continue;
		}
		if (!branch.cond) {
			throw new UnsupportedQueryError('a CASE branch without a condition.');
		}
		const condition = subject
			? { $eq: [compileExpr(subject, ctx), compileExpr(branch.cond, ctx)] }
			: compileExpr(branch.cond, ctx);
		cases.push({ case: condition, then: compileExpr(branch.result, ctx) });
	}
	return { $switch: { branches: cases, default: fallback } };
}

/** A scalar SQL function call → its aggregation-operator form. */
function compileFunction(node: ExprAst, ctx: Ctx): unknown {
	const name = functionName(node);
	const args = functionArgs(node).map((arg) => compileExpr(arg, ctx));
	const unary = UNARY_FUNCTIONS[name];
	if (unary) {
		if (args.length !== 1) {
			throw new UnsupportedQueryError(`${name} takes one argument.`);
		}
		// The trim family takes an { input } document rather than a bare operand.
		return unary === '$trim' || unary === '$ltrim' || unary === '$rtrim' ? { [unary]: { input: args[0] } } : { [unary]: args[0] };
	}
	switch (name) {
		case 'CONCAT':
			return { $concat: args };
		case 'COALESCE':
		case 'IFNULL': {
			if (args.length < 2) {
				throw new UnsupportedQueryError(`${name} takes at least two arguments.`);
			}
			// Nested two-argument $ifNull, which every supported server version accepts.
			return args.slice(0, -1).reduceRight((rest, value) => ({ $ifNull: [value, rest] }), args[args.length - 1]);
		}
		case 'NULLIF': {
			if (args.length !== 2) {
				throw new UnsupportedQueryError('NULLIF takes two arguments.');
			}
			return { $cond: [{ $eq: [args[0], args[1]] }, null, args[0]] };
		}
		case 'GREATEST':
			return { $max: args };
		case 'LEAST':
			return { $min: args };
		case 'MOD':
			return { $mod: args };
		case 'POW':
		case 'POWER':
			return { $pow: args };
		case 'ROUND':
			return { $round: args };
		case 'REPLACE': {
			if (args.length !== 3) {
				throw new UnsupportedQueryError('REPLACE takes three arguments.');
			}
			return { $replaceAll: { input: args[0], find: args[1], replacement: args[2] } };
		}
		case 'SUBSTR':
		case 'SUBSTRING': {
			if (args.length < 2) {
				throw new UnsupportedQueryError('SUBSTRING takes at least two arguments.');
			}
			// SQL positions are 1-based, $substrCP is 0-based; an omitted length means "to the end".
			const start = typeof args[1] === 'number' ? args[1] - 1 : { $subtract: [args[1], 1] };
			return { $substrCP: [args[0], start, args.length > 2 ? args[2] : { $strLenCP: args[0] }] };
		}
		case 'NOW':
		case 'CURRENT_TIMESTAMP':
			return '$$NOW';
		default:
			throw new UnsupportedQueryError(`unsupported function: ${name}()`);
	}
}

// ---------------------------------------------------------------------------------------------
// INSERT / UPDATE / DELETE / TRUNCATE  →  a `mongo-write` batch
// ---------------------------------------------------------------------------------------------

interface TableRef {
	db?: string | null;
	table: string;
	as?: string | null;
}

interface InsertAst extends StatementAst {
	table: TableRef[];
	columns: { value: string }[] | string[] | null;
	values: { values: ExprAst[] } | ExprAst[];
}

interface UpdateAst extends StatementAst {
	table: TableRef[];
	set: (ExprAst & { value: ExprAst })[];
	where?: ExprAst | null;
}

interface DeleteAst extends StatementAst {
	from?: TableRef[];
	table?: TableRef[];
	where?: ExprAst | null;
}

/** The single target collection of a write statement. */
function writeTarget(tables: TableRef[] | undefined, schema: SchemaIndex, what: string): Ctx {
	const target = tables?.[0];
	if (!target?.table || (tables?.length ?? 0) !== 1) {
		throw new UnsupportedQueryError(`${what} must name exactly one collection.`);
	}
	const base: Source = { collection: target.table, alias: sourceAlias(target.as || target.table), prefix: '', fields: schema.fields(target.table) };
	return { base, joins: [], schema };
}

function compileInsert(ast: StatementAst, schema: SchemaIndex): NativeQuery {
	const insert = ast as InsertAst;
	const ctx = writeTarget(insert.table, schema, 'INSERT');
	const names = (insert.columns ?? []).map((column) => assertDocumentField(typeof column === 'string' ? column : column.value));
	if (names.length === 0) {
		throw new UnsupportedQueryError('INSERT needs an explicit column list (a document has no column order).');
	}
	const rows = Array.isArray(insert.values) ? insert.values : insert.values?.values ?? [];
	const writes: MongoWrite[] = [];
	for (const row of rows as ExprAst[]) {
		const values = exprListNodes(row);
		if (values.length !== names.length) {
			throw new CompileError(`INSERT lists ${names.length} column(s) but ${values.length} value(s).`);
		}
		const document: Record<string, unknown> = {};
		names.forEach((name, index) => {
			document[name] = coerceLiteral(literalValue(values[index]), name, ctx);
		});
		writes.push({ op: 'insertOne', collection: ctx.base.collection, document });
	}
	if (writes.length === 0) {
		throw new UnsupportedQueryError('INSERT needs at least one VALUES row.');
	}
	return { lang: 'mongo-write', writes };
}

function compileUpdate(ast: StatementAst, schema: SchemaIndex): NativeQuery {
	const update = ast as UpdateAst;
	const ctx = writeTarget(update.table, schema, 'UPDATE');
	const set: Record<string, unknown> = {};
	for (const assignment of update.set ?? []) {
		const name = assertDocumentField(columnName(assignment));
		if (!isLiteral(assignment.value)) {
			// `SET a = a + 1` needs Mongo's pipeline-update form, which `MongoWrite.update` doesn't carry.
			throw new UnsupportedQueryError('only literal values are supported in SET (not expressions over other columns).');
		}
		set[name] = coerceLiteral(literalValue(assignment.value), name, ctx);
	}
	if (Object.keys(set).length === 0) {
		throw new UnsupportedQueryError('UPDATE needs at least one assignment.');
	}
	const filter = update.where ? compileWhere(update.where, ctx) : {};
	return { lang: 'mongo-write', writes: [{ op: 'updateMany', collection: ctx.base.collection, filter, update: { $set: set } }] };
}

function compileDelete(ast: StatementAst, schema: SchemaIndex): NativeQuery {
	const remove = ast as DeleteAst;
	const ctx = writeTarget(remove.from ?? remove.table, schema, 'DELETE');
	const filter = remove.where ? compileWhere(remove.where, ctx) : {};
	return { lang: 'mongo-write', writes: [{ op: 'deleteMany', collection: ctx.base.collection, filter }] };
}

function compileTruncate(ast: StatementAst): NativeQuery {
	const truncate = ast as StatementAst & { name?: TableRef[] };
	const target = truncate.name?.[0]?.table;
	if (!target) {
		throw new UnsupportedQueryError('TRUNCATE must name one collection.');
	}
	// Mongo has no TRUNCATE; emptying the collection (rather than dropping it) is the closer meaning,
	// since a dropped collection loses its indexes too.
	return { lang: 'mongo-write', writes: [{ op: 'deleteMany', collection: target, filter: {} }] };
}

// ---------------------------------------------------------------------------------------------
// CREATE / DROP  →  a `mongo-ddl` batch
// ---------------------------------------------------------------------------------------------

interface CreateAst extends StatementAst {
	keyword: string;
	index?: string;
	index_type?: string | null;
	table?: TableRef[] | { db?: string | null; table: string };
	index_columns?: (ExprAst & { order_by?: string | null })[];
}

interface DropAst extends StatementAst {
	keyword: string;
	name: TableRef[] | ExprAst;
}

function compileCreate(ast: StatementAst): NativeQuery {
	const create = ast as CreateAst;
	const keyword = (create.keyword ?? '').toLowerCase();
	if (keyword === 'table') {
		const target = Array.isArray(create.table) ? create.table[0]?.table : create.table?.table;
		if (!target) {
			throw new UnsupportedQueryError('CREATE TABLE must name one collection.');
		}
		// Collections are schemaless, so any column definitions are advisory only — the collection is
		// created, the columns are not (documents carry their own shape).
		return { lang: 'mongo-ddl', ops: [{ op: 'createCollection', collection: target }] };
	}
	if (keyword === 'index') {
		const target = Array.isArray(create.table) ? create.table[0]?.table : create.table?.table;
		if (!target) {
			throw new UnsupportedQueryError('CREATE INDEX must name the collection to index.');
		}
		const keys: Record<string, 1 | -1> = {};
		for (const column of create.index_columns ?? []) {
			keys[assertDocumentField(columnName(column))] = (column.order_by ?? '').toLowerCase() === 'desc' ? -1 : 1;
		}
		if (Object.keys(keys).length === 0) {
			throw new UnsupportedQueryError('CREATE INDEX needs at least one column.');
		}
		const ddl: MongoDdl = {
			op: 'createIndex',
			collection: target,
			keys,
			...(create.index ? { name: create.index } : {}),
			...((create.index_type ?? '').toLowerCase() === 'unique' ? { unique: true } : {}),
		};
		return { lang: 'mongo-ddl', ops: [ddl] };
	}
	throw new UnsupportedQueryError(`CREATE ${keyword.toUpperCase()} is not supported on a document connection.`);
}

function compileDrop(ast: StatementAst): NativeQuery {
	const drop = ast as DropAst;
	const keyword = (drop.keyword ?? '').toLowerCase();
	if (keyword === 'table') {
		const target = Array.isArray(drop.name) ? drop.name[0]?.table : undefined;
		if (!target) {
			throw new UnsupportedQueryError('DROP TABLE must name one collection.');
		}
		return { lang: 'mongo-ddl', ops: [{ op: 'dropCollection', collection: target }] };
	}
	if (keyword === 'index') {
		// Mongo drops an index BY COLLECTION, which bare `DROP INDEX name` doesn't say — require the
		// qualified form so we never guess which collection to touch.
		const ref = Array.isArray(drop.name) ? undefined : (drop.name as ExprAst);
		const collection = ref ? qualifierOf(ref) : undefined;
		if (!ref || !collection) {
			throw new CompileError('DROP INDEX needs the collection: `DROP INDEX <collection>.<index>`.');
		}
		return { lang: 'mongo-ddl', ops: [{ op: 'dropIndex', collection, name: columnName(ref) }] };
	}
	throw new UnsupportedQueryError(`DROP ${keyword.toUpperCase()} is not supported on a document connection.`);
}

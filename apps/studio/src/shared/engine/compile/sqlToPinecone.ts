/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Deterministic SQL -> Pinecone query compiler. Compiles the read subset a
 *  vector index can actually serve:
 *
 *    SELECT <fields> FROM [namespace.]<index>
 *     WHERE <metadata predicates> [AND similar_to('<text>')] [AND id = '<vector id>']
 *     [ORDER BY score] LIMIT <topK> [OFFSET n]
 *
 *  Three things make this more than a metadata filter:
 *  - **`similar_to('text')`** is the SQL spelling of a similarity search. It compiles to
 *    `PineconeQuery.embedText`, which main turns into a query vector through the embeddings model
 *    before dispatch. Without it a filter-only query has no vector at all and the driver has to run
 *    it against a zero vector, whose ordering is meaningless — so we say so rather than implying
 *    the rows came back "most similar first".
 *  - **`id`, `score` and `values` are pseudo-columns, not metadata.** `WHERE id = 'x'` is a
 *    fetch/query-by-id, not a filter on a metadata field named "id" (which would silently match
 *    nothing); `score`/`values` can't be filtered at all, and saying so beats an empty grid.
 *  - **The SELECT list drives what comes back.** Asking for metadata only skips fetching a
 *    1536-float vector per row.
 *
 *  Anything outside the subset throws {@link UnsupportedQueryError} (the AI fallback declines for
 *  vector backends, so it surfaces as a message); a query that is deterministically wrong for the
 *  index throws {@link CompileError}.
 *
 *  We parse with node-sql-parser's PostgreSQL grammar regardless of the connection (the `pinecone`
 *  Dialect generates Postgres-style SQL to match: double-quoted identifiers, LIMIT/OFFSET).
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSchema } from '../../schema';
import type { NativeQuery, PineconeQuery } from './native';
import {
	assertDocumentField,
	CompileError,
	columnName,
	exprListNodes,
	functionArgs,
	functionName,
	isStar,
	limitAndOffset,
	literalValue,
	parseOneStatement,
	qualifierOf,
	rejectUnsupportedSelectClauses,
	SchemaIndex,
	UnsupportedQueryError,
	type ExprAst,
	type SelectAst,
} from './sqlAst';

/** Default topK when the SQL omits LIMIT — Pinecone always needs a bound, the grid pages by it. */
const DEFAULT_TOP_K = 10;

/** Pinecone's hard ceiling on topK. Asking for more fails at the API with an opaque error, so the
 *  compiler says it plainly instead. (Requesting values/metadata lowers it further server-side.) */
const MAX_TOP_K = 10_000;

/** The pseudo-columns an index exposes as table columns. None of them is metadata, so none of them
 *  can appear in a metadata filter — `id` gets its own query form, the other two get an error. */
const PSEUDO_COLUMNS = new Set(['id', 'score', 'values']);

/** What the compiler is allowed to know about the connection (see the Mongo compiler's twin). */
export interface PineconeCompileOptions {
	schema?: DatabaseSchema | null;
}

/** Metadata types Pinecone can order by. `$gt`/`$lt` on anything else is a runtime error there. */
const ORDERABLE_TYPES = new Set(['int', 'double', 'number', 'long', 'decimal']);

/** The pieces a WHERE clause contributes to the final query. */
interface Predicates {
	filter?: object;
	id?: string;
	embedText?: string;
}

/**
 * Compile a single SELECT statement into a Pinecone read {@link NativeQuery}.
 */
export function sqlToPinecone(sql: string, options?: PineconeCompileOptions): Extract<NativeQuery, { lang: 'pinecone' }> {
	const ast = parseOneStatement(sql);
	if (ast.type !== 'select') {
		throw new UnsupportedQueryError(`${ast.type.toUpperCase()} is not supported on a vector index (reads only).`);
	}
	const select = ast as unknown as SelectAst;
	rejectUnsupportedSelectClauses(select);
	if (select.distinct?.type) {
		throw new UnsupportedQueryError('SELECT DISTINCT is not supported.');
	}
	if (select.groupby && Array.isArray(select.groupby.columns) && select.groupby.columns.length > 0) {
		throw new UnsupportedQueryError('GROUP BY is not supported (Pinecone has no aggregation).');
	}
	if (select.having) {
		throw new UnsupportedQueryError('HAVING is not supported.');
	}
	if (!Array.isArray(select.from) || select.from.length !== 1 || !select.from[0].table) {
		throw new UnsupportedQueryError('exactly one FROM index (no joins/subqueries) is supported.');
	}
	const index = select.from[0].table;
	// Pinecone namespaces partition an index; SQL spells one as the schema qualifier (`ns.index`).
	const namespace = select.from[0].db || undefined;
	const schema = new SchemaIndex(options?.schema);
	const qualified = namespace ? `${namespace}.${index}` : index;
	if (!schema.has(qualified) && !schema.has(index)) {
		throw new CompileError(`Index "${qualified}" does not exist on this connection.`);
	}
	const fields = schema.fields(qualified) ?? schema.fields(index);

	// Pinecone returns matches ordered by similarity score and nothing else, so ORDER BY score is a
	// no-op we accept (it documents what the engine already does) and any other key is a hard no.
	for (const item of select.orderby ?? []) {
		const name = item.expr.type === 'column_ref' ? columnName(item.expr).toLowerCase() : '';
		if (name !== 'score') {
			throw new UnsupportedQueryError('ORDER BY is not supported, except `ORDER BY score` (results always come back ordered by similarity score).');
		}
		if ((item.type ?? 'ASC').toUpperCase() === 'ASC') {
			throw new UnsupportedQueryError('results are ordered by DESCENDING score; `ORDER BY score ASC` cannot be honoured.');
		}
	}

	const { limit, skip } = limitAndOffset(select.limit);
	const topK = limit ?? DEFAULT_TOP_K;
	if (topK <= 0) {
		throw new CompileError('LIMIT must be greater than zero.');
	}
	if (topK + (skip ?? 0) > MAX_TOP_K) {
		throw new CompileError(`Pinecone returns at most ${MAX_TOP_K.toLocaleString('en-US')} vectors per query (LIMIT + OFFSET is ${topK + (skip ?? 0)}).`);
	}

	const predicates = select.where ? compilePredicates(select.where, fields) : {};
	const { includeValues, includeMetadata } = projectionFlags(select.columns, fields);

	const query: PineconeQuery = { topK };
	if (skip !== undefined && skip > 0) {
		query.offset = skip;
	}
	if (namespace) {
		query.namespace = namespace;
	}
	if (predicates.filter) {
		query.filter = predicates.filter;
	}
	if (predicates.id) {
		query.id = predicates.id;
	}
	if (predicates.embedText !== undefined) {
		query.embedText = predicates.embedText;
	}
	if (includeValues) {
		query.includeValues = true;
	}
	if (!includeMetadata) {
		query.includeMetadata = false;
	}
	return { lang: 'pinecone', index, query };
}

/** Which of the two heavyweight parts of a vector the query should ask for. `SELECT *` wants both;
 *  a named list only pays for what it named. */
function projectionFlags(columns: SelectAst['columns'], fields: ReturnType<SchemaIndex['fields']>): { includeValues: boolean; includeMetadata: boolean } {
	const list = columns === '*' ? [] : columns;
	if (list.length === 0 || list.some((column) => isStar(column.expr))) {
		return { includeValues: true, includeMetadata: true };
	}
	let includeValues = false;
	let includeMetadata = false;
	for (const column of list) {
		if (column.expr.type !== 'column_ref') {
			throw new UnsupportedQueryError('only plain column references are supported in the SELECT list (an index has no expressions).');
		}
		const name = columnName(column.expr);
		if (name === 'values') {
			includeValues = true;
			continue;
		}
		if (name === 'id' || name === 'score') {
			continue; // always returned
		}
		if (fields && fields.size > 0 && !fields.has(name)) {
			throw new CompileError(`"${name}" is not a metadata field of this index.`);
		}
		includeMetadata = true;
	}
	return { includeValues, includeMetadata };
}

/**
 * Split a WHERE clause into the three things a Pinecone query can carry: a metadata filter, a
 * vector id, and the text to embed. Only a top-level AND chain can mix them — an id or a
 * `similar_to` inside an OR has no meaning in the API.
 */
function compilePredicates(node: ExprAst, fields: ReturnType<SchemaIndex['fields']>): Predicates {
	const conjuncts = flattenAnd(node);
	const out: Predicates = {};
	const filters: object[] = [];
	for (const conjunct of conjuncts) {
		if (conjunct.type === 'function') {
			const name = functionName(conjunct);
			const args = functionArgs(conjunct);
			if (name === 'SIMILAR_TO') {
				if (args.length !== 1) {
					throw new CompileError("similar_to() takes one argument: the text to search for, e.g. similar_to('a happy dog').");
				}
				const text = literalValue(args[0]);
				if (typeof text !== 'string' || text.trim() === '') {
					throw new CompileError('similar_to() takes a non-empty text literal.');
				}
				if (out.embedText !== undefined) {
					throw new CompileError('only one similar_to() is supported per query.');
				}
				out.embedText = text;
				continue;
			}
			throw new UnsupportedQueryError(`unsupported function in WHERE: ${name}()`);
		}
		// `id = 'vec-1'` is a query BY VECTOR, not a metadata filter (metadata has no `id` field).
		if (conjunct.type === 'binary_expr' && conjunct.left?.type === 'column_ref' && columnName(conjunct.left) === 'id') {
			if ((conjunct.operator ?? '') !== '=') {
				throw new CompileError('`id` supports only `id = \'<vector id>\'` (Pinecone looks a vector up by id; it cannot range over ids).');
			}
			const value = literalValue(conjunct.right!);
			if (typeof value !== 'string') {
				throw new CompileError('a vector id is a string.');
			}
			if (out.id !== undefined) {
				throw new CompileError('only one `id =` is supported per query.');
			}
			out.id = value;
			continue;
		}
		filters.push(compileFilter(conjunct, fields));
	}
	if (out.id !== undefined && out.embedText !== undefined) {
		throw new CompileError('a query searches either by `id` or by similar_to() text, not both.');
	}
	if (filters.length === 1) {
		out.filter = filters[0];
	} else if (filters.length > 1) {
		out.filter = { $and: filters };
	}
	return out;
}

/** A top-level AND chain, flattened. Anything else is a single conjunct. */
function flattenAnd(node: ExprAst): ExprAst[] {
	if (node.type === 'binary_expr' && (node.operator ?? '').toUpperCase() === 'AND') {
		return [...flattenAnd(node.left!), ...flattenAnd(node.right!)];
	}
	return [node];
}

/** Compile a metadata predicate to a Pinecone filter (Mongo-style operators). Unlike the Mongo
 *  compiler, equality must use an explicit `$eq` (Pinecone requires an operator object). */
function compileFilter(node: ExprAst, fields: ReturnType<SchemaIndex['fields']>): object {
	if (node.type !== 'binary_expr' || !node.operator) {
		throw new UnsupportedQueryError(`unsupported WHERE expression: ${node.type}`);
	}
	const op = node.operator.toUpperCase();
	if (op === 'AND') {
		return { $and: [compileFilter(node.left!, fields), compileFilter(node.right!, fields)] };
	}
	if (op === 'OR') {
		return { $or: [compileFilter(node.left!, fields), compileFilter(node.right!, fields)] };
	}
	const field = fieldName(node.left!);
	if (PSEUDO_COLUMNS.has(field)) {
		throw new CompileError(`"${field}" is not a metadata field, so it can't be filtered (only \`id = '…'\` is supported).`);
	}
	if (fields && fields.size > 0 && !fields.has(field)) {
		throw new CompileError(`"${field}" is not a metadata field of this index.`);
	}
	const right = node.right!;
	switch (op) {
		case '=':
			return { [field]: { $eq: literal(right) } };
		case '<>':
		case '!=':
			return { [field]: { $ne: literal(right) } };
		case '>':
		case '>=':
		case '<':
		case '<=': {
			const value = literal(right);
			// Pinecone orders numbers only; a string bound is a 4xx from the API, not an empty result.
			if (typeof value !== 'number') {
				throw new CompileError(`\`${op}\` needs a number: Pinecone can only order numeric metadata (got ${JSON.stringify(value)}).`);
			}
			const type = fields?.get(field);
			if (type && !type.split('|').map((t) => t.trim()).some((t) => ORDERABLE_TYPES.has(t))) {
				throw new CompileError(`metadata field "${field}" holds ${type}, which Pinecone cannot compare with \`${op}\`.`);
			}
			const operators: Record<string, string> = { '>': '$gt', '>=': '$gte', '<': '$lt', '<=': '$lte' };
			return { [field]: { [operators[op]]: value } };
		}
		case 'IN':
			return { [field]: { $in: exprListNodes(right).map(literal) } };
		case 'NOT IN':
			return { [field]: { $nin: exprListNodes(right).map(literal) } };
		// Pinecone has no null type; `IS [NOT] NULL` maps to metadata presence via $exists.
		case 'IS':
			return { [field]: { $exists: false } };
		case 'IS NOT':
			return { [field]: { $exists: true } };
		case 'BETWEEN': {
			const [lo, hi] = exprListNodes(right).map(literal);
			if (typeof lo !== 'number' || typeof hi !== 'number') {
				throw new CompileError('BETWEEN needs numeric bounds (Pinecone can only order numeric metadata).');
			}
			return { [field]: { $gte: lo, $lte: hi } };
		}
		case 'LIKE':
		case 'ILIKE':
		case 'NOT LIKE':
			throw new UnsupportedQueryError('LIKE is not supported (Pinecone metadata filters have no pattern matching).');
		default:
			throw new UnsupportedQueryError(`unsupported operator: ${op} (Pinecone supports =, !=, <, <=, >, >=, IN, NOT IN, BETWEEN, IS [NOT] NULL).`);
	}
}

/** The metadata field name for a column reference (Pinecone metadata is flat — no table qualifier,
 *  and no nested paths). */
function fieldName(ref: ExprAst): string {
	if (ref.type !== 'column_ref') {
		throw new UnsupportedQueryError('expected a metadata field reference.');
	}
	const qualifier = qualifierOf(ref);
	if (qualifier) {
		throw new CompileError(`"${qualifier}.${columnName(ref)}" — Pinecone metadata is flat, so a field can't be qualified or nested.`);
	}
	return assertDocumentField(columnName(ref));
}

/** A WHERE literal → its JS value (Pinecone metadata values: string/number/bool/list of strings). */
function literal(node: ExprAst): unknown {
	const value = literalValue(node);
	if (value === null) {
		throw new UnsupportedQueryError('NULL is not a Pinecone metadata value (use IS [NOT] NULL).');
	}
	return value;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  SQL -> {@link LogsQuery}: the deterministic compiler that makes a log scope queryable as a table.
 *  The sibling of `sqlToMongo` and `sqlToPinecone`, parsing the same PostgreSQL grammar through the
 *  same `sqlAst` helpers, and raising the same two errors — the distinction between them is what
 *  decides whether the user is offered the consent-gated AI transcriber (`UnsupportedQueryError`)
 *  or told plainly that the query is wrong (`CompileError`, terminal).
 *
 *  ONE COMPILER, THREE VENDORS. Nothing here knows what CloudWatch, Azure Monitor or Cloud Logging
 *  call anything: it produces the neutral {@link LogsQuery} and each driver renders that into its
 *  own language. A fourth log service therefore costs a driver and not a line of this file.
 *
 *  THE WINDOW IS THE ONE THING IT INVENTS. Every other clause is a faithful translation of what the
 *  user wrote, but a `LogsQuery` may not be unbounded (an unbounded Logs Insights query is a bill,
 *  not a slow query), so a statement whose WHERE names no time bound is given the caller's default
 *  window rather than rejected. That is the single place this compiler decides something the SQL
 *  did not say, and {@link CompiledLogsQuery.windowFromSql} reports it so the UI can say so too.
 *
 *  WHAT IS DELIBERATELY NOT SUPPORTED, because a wrong answer is worse than a refusal: JOINs (there
 *  is one scope per query on every provider), OR at the top of a WHERE (the predicate list is
 *  ANDed; the AI transcriber can express it in the provider's own language), HAVING, DISTINCT
 *  outside `count(DISTINCT x)`, OFFSET (a log stream has no stable numeric offset — page by time),
 *  and every write statement (a log scope is read-only, and that is a `CompileError`, not something
 *  a model should be asked to translate).
 *--------------------------------------------------------------------------------------------*/

import {
	canonicalLogField,
	LOG_FIELDS,
	type LogAgg,
	type LogAggFn,
	type LogAggregate,
	type LogOrder,
	type LogPredicate,
	type LogScalar,
	type LogsQuery,
} from './logs';
import {
	columnName,
	CompileError,
	exprListNodes,
	functionArgs,
	functionName,
	isStar,
	limitAndOffset,
	literalValue,
	parseOneStatement,
	rejectUnsupportedSelectClauses,
	SchemaIndex,
	SqlSyntaxError,
	UnsupportedQueryError,
	type ColumnAst,
	type ExprAst,
	type SelectAst,
	type StatementAst,
} from './sqlAst';
import type { DatabaseSchema } from '../../schema';

/** How long a query with no time bound in its WHERE covers. An hour is the CloudWatch console's own
 *  default and small enough that a `SELECT *` typed by mistake is not expensive. */
export const DEFAULT_LOG_WINDOW_MS = 60 * 60 * 1000;

export interface SqlToLogsOptions {
	/** Introspected scopes, so an unknown one is a named error rather than an empty result. */
	schema?: DatabaseSchema | null;
	/** "Now", in ms since the epoch. Injected so `now()` and the default window are testable and so
	 *  one statement's several time references all resolve against a single instant. */
	now?: number;
	/** The window to use when the SQL names none. Supplied by the connection's time-range control. */
	defaultWindowMs?: number;
	/** A window the CALLER has already decided (the time-range toolbar), used when the SQL names
	 *  none. `start`/`end` in ms. Overrides {@link defaultWindowMs}. */
	window?: { start: number; end: number };
}

/** What {@link sqlToLogs} produces: the query, plus the two facts the UI needs to be honest about
 *  what it is about to run. */
export interface CompiledLogsQuery {
	query: LogsQuery;
	/** False when the window came from the caller's default rather than from the statement — the
	 *  signal for "showing the last hour; add a `ts >` bound to widen it". */
	windowFromSql: boolean;
	/** True when answering this needs the provider's aggregating engine, which on CloudWatch is the
	 *  per-GB-billed one. The driver decides for real; this is what lets the UI warn first. */
	needsAggregation: boolean;
}

/** A scope name that is not a plain identifier, unquoted in the FROM.
 *
 *  Every provider names its scopes with characters SQL reserves: `/aws/lambda/checkout`,
 *  `container-logs`, `Microsoft.Web/sites`. Written bare they fail in the PARSER, whose message is a
 *  wall of expected tokens that never mentions the quoting the user actually needs — and, before
 *  this, that unreadable message was what decided to offer an AI translation. Recognised here so the
 *  answer is the one sentence that fixes it rather than the general "unexpected /" the shared
 *  near-miss table would give, and terminal (`CompileError`): no model is needed to put quotes
 *  around a name. */
const UNQUOTED_SCOPE = /\bfrom\s+(?![\s"'`(])([^\s;()]*[/\\][^\s;()]*)/i;

/** Parse, but turn the parser's message into the quoting advice when that is plainly the problem. */
function parseStatement(sql: string): StatementAst {
	try {
		return parseOneStatement(sql);
	} catch (err) {
		const unquoted = UNQUOTED_SCOPE.exec(sql)?.[1];
		if (unquoted && err instanceof SqlSyntaxError) {
			throw new CompileError(`"${unquoted}" has to be quoted, because a log scope name is not a plain SQL name: FROM "${unquoted}".`);
		}
		throw err;
	}
}

/**
 * Compile one SQL SELECT over a log scope into the neutral {@link LogsQuery}.
 *
 * Throws {@link CompileError} when the statement is wrong for this connection (a write, an unknown
 * scope) and {@link UnsupportedQueryError} when it is valid SQL this compiler cannot express, which
 * is the signal the orchestrator reads to offer the AI transcriber.
 */
export function sqlToLogs(sql: string, options: SqlToLogsOptions = {}): CompiledLogsQuery {
	const now = options.now ?? Date.now();
	const statement = parseStatement(sql);
	if (statement.type !== 'select') {
		throw new CompileError(`A log scope is read-only: ${statement.type.toUpperCase()} cannot be run against it.`);
	}
	const select = statement as SelectAst;
	rejectUnsupportedSelectClauses(select);
	if (select.distinct?.type) {
		throw new UnsupportedQueryError('SELECT DISTINCT is not supported over a log scope.');
	}
	if (select.having) {
		throw new UnsupportedQueryError('HAVING is not supported over a log scope.');
	}

	const scope = readScope(select, new SchemaIndex(options.schema));
	const projection = readProjection(select);
	const groupBy = (select.groupby?.columns ?? []).map((column) => canonicalLogField(columnName(column)));
	const { predicates, start, end, bounded } = readWhere(select.where ?? null, now);
	const { limit, skip } = limitAndOffset(select.limit);
	if (skip !== undefined && skip > 0) {
		throw new UnsupportedQueryError('OFFSET is not supported over a log scope — narrow the time range instead.');
	}

	const aggregate = buildAggregate(projection, groupBy);
	const query: LogsQuery = {
		scope,
		...windowFor(start, end, bounded, now, options),
	};
	if (aggregate) {
		query.aggregate = aggregate;
	} else if (projection.fields.length > 0) {
		query.select = projection.fields;
	}
	if (predicates.length > 0) {
		query.where = predicates;
	}
	const orderBy = readOrderBy(select, projection, aggregate);
	if (orderBy.length > 0) {
		query.orderBy = orderBy;
	}
	if (limit !== undefined) {
		query.limit = limit;
	}
	return { query, windowFromSql: bounded.start || bounded.end, needsAggregation: !!aggregate };
}

/** The window, resolved from what the SQL bounded and what the caller supplied for the rest. */
function windowFor(
	start: number | undefined,
	end: number | undefined,
	bounded: { start: boolean; end: boolean },
	now: number,
	options: SqlToLogsOptions,
): { start: number; end: number } {
	const fallbackEnd = options.window?.end ?? now;
	const fallbackStart = options.window?.start ?? fallbackEnd - (options.defaultWindowMs ?? DEFAULT_LOG_WINDOW_MS);
	const resolvedEnd = bounded.end && end !== undefined ? end : fallbackEnd;
	const resolvedStart = bounded.start && start !== undefined ? start : fallbackStart;
	if (resolvedStart >= resolvedEnd) {
		throw new CompileError('That time range is empty: the start is not before the end.');
	}
	return { start: resolvedStart, end: resolvedEnd };
}

/** The single scope a query reads. One FROM entry, no joins, no subquery. */
function readScope(select: SelectAst, schema: SchemaIndex): string {
	const from = select.from ?? [];
	if (from.length === 0) {
		throw new UnsupportedQueryError('a SELECT with no FROM is not supported over a log scope.');
	}
	if (from.length > 1 || from.some((entry) => entry.join)) {
		throw new UnsupportedQueryError('JOINs are not supported: a log query reads one scope.');
	}
	const [base] = from;
	if (base.expr || !base.table) {
		throw new UnsupportedQueryError('a subquery in FROM is not supported over a log scope.');
	}
	if (!schema.has(base.table)) {
		const known = schema.names.slice(0, 8).join(', ');
		throw new CompileError(`There is no log scope called '${base.table}'.${known ? ` Known scopes include: ${known}.` : ''}`);
	}
	return base.table;
}

/** The SELECT list, split into the plain fields and the aggregate calls it asked for. */
interface Projection {
	/** Canonicalised plain column names, in order. Empty for `SELECT *`. */
	fields: string[];
	aggs: LogAgg[];
	star: boolean;
}

function readProjection(select: SelectAst): Projection {
	if (select.columns === '*') {
		return { fields: [], aggs: [], star: true };
	}
	const fields: string[] = [];
	const aggs: LogAgg[] = [];
	let star = false;
	for (const column of select.columns as ColumnAst[]) {
		const expr = column.expr;
		if (isStar(expr)) {
			star = true;
			continue;
		}
		if (expr.type === 'aggr_func' || (expr.type === 'function' && isAggregateName(safeFunctionName(expr)))) {
			aggs.push(readAggregate(expr, column.as));
			continue;
		}
		if (expr.type !== 'column_ref') {
			throw new UnsupportedQueryError('only plain columns and count/sum/avg/min/max are supported in a log SELECT.');
		}
		if (column.as) {
			// A neutral LogsQuery has no per-field rename: the grid labels a scan's columns with the
			// contract's own names. Silently dropping the alias would mislabel the result.
			throw new UnsupportedQueryError('renaming a column with AS is not supported in a log scan.');
		}
		fields.push(canonicalLogField(columnName(expr)));
	}
	return { fields, aggs, star };
}

const AGGREGATE_NAMES = new Set<string>(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

function isAggregateName(name: string | undefined): boolean {
	return !!name && AGGREGATE_NAMES.has(name);
}

/** A function's name, or undefined for a node whose name we cannot read (rather than throwing,
 *  because the caller is only asking "is this an aggregate"). */
function safeFunctionName(expr: ExprAst): string | undefined {
	try {
		return functionName(expr);
	} catch {
		return undefined;
	}
}

function readAggregate(expr: ExprAst, alias: string | null): LogAgg {
	const rawName = expr.type === 'aggr_func' ? (typeof expr.name === 'string' ? expr.name : safeFunctionName(expr)) : safeFunctionName(expr);
	const name = (rawName ?? '').toUpperCase();
	if (!AGGREGATE_NAMES.has(name)) {
		throw new UnsupportedQueryError(`the function ${name || '?'}() is not supported over a log scope.`);
	}
	const fn = name.toLowerCase() as LogAggFn;
	const { argument, distinct } = aggregateArgument(expr);
	if (!argument || isStar(argument)) {
		if (fn !== 'count') {
			throw new UnsupportedQueryError(`${name}(*) is not meaningful — ${name.toLowerCase()} needs a field.`);
		}
		return { fn, as: alias ?? 'count' };
	}
	if (argument.type !== 'column_ref') {
		throw new UnsupportedQueryError(`only a plain field may be passed to ${name}().`);
	}
	const field = canonicalLogField(columnName(argument));
	return { fn, field, ...(distinct ? { distinct: true } : {}), as: alias ?? `${fn}_${field}` };
}

/** The single argument of an aggregate call, in either AST shape (`aggr_func` carries one `expr`
 *  plus a DISTINCT marker; a plain `function` carries an `expr_list`). */
function aggregateArgument(expr: ExprAst): { argument?: ExprAst; distinct: boolean } {
	if (expr.type === 'aggr_func') {
		const args = expr.args as { expr?: ExprAst; distinct?: string | null } | undefined;
		return { argument: args?.expr, distinct: !!args?.distinct };
	}
	const list = functionArgs(expr);
	if (list.length > 1) {
		throw new UnsupportedQueryError('an aggregate over a log scope takes one field.');
	}
	return { argument: list[0], distinct: false };
}

/** Combine the SELECT list and GROUP BY into the query's aggregate half, or nothing for a scan. */
function buildAggregate(projection: Projection, groupBy: string[]): LogAggregate | undefined {
	if (projection.aggs.length === 0) {
		if (groupBy.length > 0) {
			throw new UnsupportedQueryError('GROUP BY without count/sum/avg/min/max has nothing to aggregate.');
		}
		return undefined;
	}
	if (projection.star) {
		throw new UnsupportedQueryError('SELECT * cannot be mixed with an aggregate.');
	}
	// Every plain column in an aggregate SELECT must be grouped on: otherwise the row it belongs to
	// is arbitrary, which is exactly the class of silently-wrong answer this compiler refuses.
	for (const field of projection.fields) {
		if (!groupBy.includes(field)) {
			throw new UnsupportedQueryError(`'${field}' is selected alongside an aggregate but is not in GROUP BY.`);
		}
	}
	for (const field of groupBy) {
		if (!projection.fields.includes(field)) {
			throw new UnsupportedQueryError(`'${field}' is grouped on but not selected — a log result cannot carry a hidden key.`);
		}
	}
	return { by: groupBy, aggs: projection.aggs };
}

/** ORDER BY, restricted to what the result actually carries. */
function readOrderBy(select: SelectAst, projection: Projection, aggregate: LogAggregate | undefined): LogOrder[] {
	const orders: LogOrder[] = [];
	for (const entry of select.orderby ?? []) {
		if (entry.expr.type !== 'column_ref') {
			throw new UnsupportedQueryError('ORDER BY must name a selected field over a log scope.');
		}
		const raw = columnName(entry.expr);
		const available = aggregate
			? [...aggregate.by, ...aggregate.aggs.map((agg) => agg.as)]
			: projection.fields;
		// A scan with no explicit projection carries the whole fixed contract, so any of it is fair
		// game; an aggregate carries only its own outputs, and their names are the ALIASES.
		const field = aggregate && available.includes(raw) ? raw : canonicalLogField(raw);
		if (aggregate && !available.includes(field)) {
			throw new UnsupportedQueryError(`ORDER BY '${raw}' names something the grouped result does not contain.`);
		}
		orders.push({ field, desc: (entry.type ?? '').toUpperCase() === 'DESC' });
	}
	return orders;
}

/** The WHERE clause, split into the time window it bounds and the predicates that remain. */
interface WhereParts {
	predicates: LogPredicate[];
	start?: number;
	end?: number;
	bounded: { start: boolean; end: boolean };
}

function readWhere(where: ExprAst | null, now: number): WhereParts {
	const parts: WhereParts = { predicates: [], bounded: { start: false, end: false } };
	for (const node of flattenAnd(where)) {
		if (applyTimeBound(node, now, parts)) {
			continue;
		}
		parts.predicates.push(readPredicate(node));
	}
	return parts;
}

/** The ANDed conjuncts of a WHERE, or [] for none. OR is rejected by name so the message says what
 *  to do about it rather than "unsupported expression". */
function flattenAnd(node: ExprAst | null | undefined): ExprAst[] {
	if (!node) {
		return [];
	}
	if (node.type === 'binary_expr' && node.operator === 'AND') {
		return [...flattenAnd(node.left), ...flattenAnd(node.right)];
	}
	if (node.type === 'binary_expr' && node.operator === 'OR') {
		throw new UnsupportedQueryError('OR in a WHERE is not supported over a log scope — the conditions are combined with AND.');
	}
	return [node];
}

/**
 * Consume a conjunct that bounds the time window, returning true when it did.
 *
 * A bound is a comparison of the `ts` column against an instant, or a BETWEEN over it. It is
 * REMOVED from the predicate list rather than also pushed down, because on every one of these
 * providers the window is a parameter of the request and repeating it as a filter would make the
 * driver ask for the same restriction twice — harmless on two of them and a parse error on the
 * third.
 */
function applyTimeBound(node: ExprAst, now: number, parts: WhereParts): boolean {
	if (node.type !== 'binary_expr' || !node.left || !node.operator) {
		return false;
	}
	if (node.left.type !== 'column_ref' || canonicalLogField(columnName(node.left)) !== LOG_FIELDS.ts) {
		return false;
	}
	const operator = node.operator.toUpperCase();
	if (operator === 'BETWEEN' && node.right) {
		const [lower, upper] = exprListNodes(node.right);
		setStart(parts, instantOf(lower, now));
		// SQL BETWEEN is inclusive at both ends; the window is exclusive at the end, so the upper
		// bound is nudged by a millisecond rather than silently dropping the last event.
		setEnd(parts, instantOf(upper, now) + 1);
		return true;
	}
	if (!node.right) {
		return false;
	}
	const instant = instantOf(node.right, now);
	switch (operator) {
		case '>':
			// `ts > x` excludes x; the window's start includes it. One millisecond is the finest
			// granularity any of these providers reports, so this is exact rather than approximate.
			setStart(parts, instant + 1);
			return true;
		case '>=':
			setStart(parts, instant);
			return true;
		case '<':
			setEnd(parts, instant);
			return true;
		case '<=':
			setEnd(parts, instant + 1);
			return true;
		case '=':
			setStart(parts, instant);
			setEnd(parts, instant + 1);
			return true;
		default:
			return false;
	}
}

/** Several lower bounds narrow rather than replace: `ts > a AND ts > b` means both. */
function setStart(parts: WhereParts, value: number): void {
	parts.start = parts.bounded.start ? Math.max(parts.start ?? value, value) : value;
	parts.bounded.start = true;
}

function setEnd(parts: WhereParts, value: number): void {
	parts.end = parts.bounded.end ? Math.min(parts.end ?? value, value) : value;
	parts.bounded.end = true;
}

/** Epoch millis a timestamp expression denotes: a literal, `now()`, `ago('15m')`, or `now()` minus
 *  a duration. Anything else is unsupported rather than guessed at. */
function instantOf(node: ExprAst | undefined, now: number): number {
	if (!node) {
		throw new UnsupportedQueryError('a time comparison needs a value.');
	}
	if (node.type === 'function' || node.type === 'aggr_func') {
		return instantOfCall(node, now);
	}
	if (node.type === 'binary_expr' && (node.operator === '-' || node.operator === '+')) {
		const base = instantOf(node.left, now);
		const offset = durationOf(node.right, now);
		return node.operator === '-' ? base - offset : base + offset;
	}
	const value = literalValue(node);
	return instantOfLiteral(value);
}

/** `now()` / `current_timestamp` / `ago('1h')` / `ago(3600000)`. */
function instantOfCall(node: ExprAst, now: number): number {
	const name = (safeFunctionName(node) ?? '').toUpperCase();
	if (name === 'NOW' || name === 'CURRENT_TIMESTAMP') {
		return now;
	}
	if (name === 'AGO') {
		const [argument] = functionArgs(node);
		if (!argument) {
			throw new UnsupportedQueryError("ago() needs a duration, e.g. ago('15m').");
		}
		return now - durationOf(argument, now);
	}
	throw new UnsupportedQueryError(`${name || 'that function'}() is not a time value — use a timestamp literal, now(), or ago('15m').`);
}

/** A literal in a time position: an ISO/parseable date string, or epoch millis. */
function instantOfLiteral(value: unknown): number {
	if (typeof value === 'number') {
		// Epoch SECONDS is the commonest thing to paste that is not millis, and the two are a
		// thousandfold apart, so the ambiguity is safe to resolve: anything below the year 2001 in
		// millis is seconds. Guessing wrong here would be a window off by decades.
		return value < 1e11 ? value * 1000 : value;
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isNaN(parsed)) {
			throw new CompileError(`'${value}' is not a timestamp this can read (try an ISO 8601 date).`);
		}
		return parsed;
	}
	throw new UnsupportedQueryError('a time comparison needs a timestamp literal.');
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i;

const DURATION_MS: Readonly<Record<string, number>> = {
	ms: 1,
	s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
	m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
	h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
	d: 86_400_000, day: 86_400_000, days: 86_400_000,
	w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/** A duration in ms: a bare number (already ms) or a string like `'15m'` / `'2 hours'`. */
function durationOf(node: ExprAst | undefined, now: number): number {
	if (!node) {
		throw new UnsupportedQueryError('a duration is missing.');
	}
	if (node.type === 'function' || node.type === 'aggr_func') {
		// `now() - now()` and friends: an instant where a duration belongs.
		throw new UnsupportedQueryError('expected a duration, not a timestamp.');
	}
	const value = literalValue(node);
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string') {
		const match = DURATION.exec(value.trim());
		if (!match) {
			throw new CompileError(`'${value}' is not a duration (try '15m', '2h', '7d').`);
		}
		return Number(match[1]) * DURATION_MS[match[2].toLowerCase()];
	}
	throw new UnsupportedQueryError('a duration must be a number of milliseconds or a string like \'15m\'.');
}

/** One non-time conjunct → a pushed-down predicate. */
function readPredicate(node: ExprAst): LogPredicate {
	if (node.type !== 'binary_expr' || !node.left || !node.operator) {
		throw new UnsupportedQueryError('only simple comparisons are supported in a log WHERE.');
	}
	if (node.left.type !== 'column_ref') {
		throw new UnsupportedQueryError('the left side of a log condition must be a field.');
	}
	const field = canonicalLogField(columnName(node.left));
	const operator = node.operator.toUpperCase();
	switch (operator) {
		case '=':
		case '!=':
		case '<>':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return { op: operator === '<>' ? '!=' : (operator as '=' | '!=' | '<' | '<=' | '>' | '>='), field, value: scalarOf(node.right) };
		case 'LIKE':
		case 'NOT LIKE':
		case 'ILIKE':
		case 'NOT ILIKE': {
			const pattern = scalarOf(node.right);
			if (typeof pattern !== 'string') {
				throw new UnsupportedQueryError('LIKE needs a string pattern.');
			}
			const negated = operator.startsWith('NOT ');
			const insensitive = operator.endsWith('ILIKE');
			return { op: negated ? 'not like' : 'like', field, pattern, ...(insensitive ? { caseInsensitive: true } : {}) };
		}
		case 'IN':
		case 'NOT IN': {
			if (!node.right) {
				throw new UnsupportedQueryError('IN needs a value list.');
			}
			const values = exprListNodes(node.right).map((item) => scalarOf(item));
			return { op: operator === 'IN' ? 'in' : 'not in', field, values };
		}
		case 'IS':
		case 'IS NOT': {
			if (!node.right || node.right.type !== 'null') {
				throw new UnsupportedQueryError('IS may only be compared against NULL over a log scope.');
			}
			return { op: operator === 'IS' ? 'is null' : 'is not null', field };
		}
		case 'BETWEEN': {
			// Not a time field (that was consumed already), so it is a numeric/textual range: two
			// predicates' worth, which the ANDed list expresses fine.
			throw new UnsupportedQueryError('BETWEEN is supported only on the time column — use >= AND <=.');
		}
		default:
			throw new UnsupportedQueryError(`the operator ${operator} is not supported over a log scope.`);
	}
}

function scalarOf(node: ExprAst | undefined): LogScalar {
	if (!node) {
		throw new UnsupportedQueryError('a condition is missing its value.');
	}
	const value = literalValue(node);
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	throw new UnsupportedQueryError('only string, number, boolean and NULL values are supported in a log condition.');
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The TELEMETRY query form: what a log scope is, as far as SQL is concerned.
 *
 *  A log scope (a CloudWatch log group, an Azure Monitor table, a GCP log) is presented to the app
 *  as a pseudo-TABLE, so the whole IDE - explorer, grid, history, charts, the assistant - works on
 *  it with no telemetry branches. This file is the contract that makes that possible, and four
 *  decisions shape it.
 *
 *  1. ONE STRUCTURED FORM FOR EVERY VENDOR, not one native query language per vendor. The three
 *     log services differ enormously in their query languages (Logs Insights, KQL, a GCP filter
 *     string) and hardly at all in what a SELECT over events actually asks for: a scope, a window,
 *     some predicates, maybe a grouping, a cap. So {@link LogsQuery} is that ask, and RENDERING it
 *     into a vendor's own language is the driver's job. One SQL compiler serves all three, and a
 *     fourth service is a driver rather than a compiler.
 *
 *  2. THE WINDOW IS NOT OPTIONAL. Every field here can be absent except `start`/`end`. An unbounded
 *     log query is not a slow query, it is a bill (CloudWatch Logs Insights charges per GB
 *     SCANNED), and there is no sensible provider default. A query that named no window was given
 *     one before it got here.
 *
 *  3. AGGREGATION IS A SEPARATE FIELD, NOT A SHAPE OF THE PROJECTION, because for at least one
 *     vendor it is a different API with a different price. The driver reads `aggregate` and decides
 *     which of its engines to use; nothing above the seam knows there is a choice.
 *
 *  4. THE COLUMN NAMES ARE OURS. A user writes `ts` and `message`, never `@timestamp` or
 *     `TimeGenerated`, and the driver maps to whatever its provider calls the same thing
 *     ({@link LOG_FIELDS}). Vendor spellings are accepted as ALIASES so pasted queries work, but
 *     the canonical name is the one this app documents.
 *--------------------------------------------------------------------------------------------*/

/**
 * The columns every log scope has, whatever the provider.
 *
 * These mirror `LogEvent` in `src/shared/cloud.ts` field for field, deliberately: that type is what
 * a log driver already produces for a Data Flow, and a scan here returns exactly those events. The
 * two must not drift.
 *
 * `ts` rather than `at` (which `LogEvent` calls it) for one unglamorous reason: `AT` is a reserved
 * word in the SQL grammar the deterministic compilers parse with, so `SELECT at FROM …` does not
 * parse at all. `ts` is what the user types; `LogEvent.at` is what the code carries.
 */
export const LOG_FIELDS = {
	/** Producer clock, ms since the epoch. The scope's natural ordering and its window axis. */
	ts: 'ts',
	/** The event's text. */
	message: 'message',
	/** The sub-division of the scope the event came from, where the provider has one (a CloudWatch
	 *  log stream). Null on a provider with no such concept. */
	stream: 'stream',
	/** The event's identity, as the provider issues it. */
	id: 'id',
	/** Service clock, ms since the epoch, where the provider reports one. */
	ingestedAt: 'ingested_at',
} as const;

/** A canonical column name of the fixed contract. */
export type LogFieldName = (typeof LOG_FIELDS)[keyof typeof LOG_FIELDS];

/** The fixed contract in the order the explorer and a `SELECT *` present it. */
export const LOG_COLUMNS: readonly LogFieldName[] = [
	LOG_FIELDS.ts,
	LOG_FIELDS.message,
	LOG_FIELDS.stream,
	LOG_FIELDS.id,
	LOG_FIELDS.ingestedAt,
];

/**
 * Vendor and convenience spellings that mean one of {@link LOG_COLUMNS}.
 *
 * Here so that a query pasted out of the CloudWatch console (`@timestamp`, `@message`) or written
 * by someone thinking in Azure (`TimeGenerated`) resolves instead of being read as a parsed field
 * that does not exist. Lower-cased on both sides at lookup.
 */
const FIELD_ALIASES: Readonly<Record<string, LogFieldName>> = {
	'@timestamp': LOG_FIELDS.ts,
	timestamp: LOG_FIELDS.ts,
	time: LOG_FIELDS.ts,
	event_time: LOG_FIELDS.ts,
	timegenerated: LOG_FIELDS.ts,
	'@message': LOG_FIELDS.message,
	msg: LOG_FIELDS.message,
	'@logstream': LOG_FIELDS.stream,
	log_stream: LOG_FIELDS.stream,
	logstream: LOG_FIELDS.stream,
	'@ptr': LOG_FIELDS.id,
	event_id: LOG_FIELDS.id,
	insert_id: LOG_FIELDS.id,
	'@ingestiontime': LOG_FIELDS.ingestedAt,
	ingestion_time: LOG_FIELDS.ingestedAt,
	ingested: LOG_FIELDS.ingestedAt,
};

/**
 * The canonical name for a field a user wrote, or the name unchanged when it is not one of ours.
 *
 * An unrecognised name is NOT an error: it is a parsed field out of the event's own JSON, which
 * every one of these providers can address and none of them can enumerate reliably in advance. So
 * this normalises what it knows and passes the rest through for the driver to reference.
 */
export function canonicalLogField(name: string): string {
	const lower = name.toLowerCase();
	if ((LOG_COLUMNS as readonly string[]).includes(lower)) {
		return lower;
	}
	return FIELD_ALIASES[lower] ?? name;
}

/** True when `name` is one of the fixed contract's columns rather than a parsed field. */
export function isBuiltInLogField(name: string): boolean {
	return (LOG_COLUMNS as readonly string[]).includes(canonicalLogField(name));
}

/** A literal a predicate can compare against. */
export type LogScalar = string | number | boolean | null;

/**
 * One ANDed condition of a scan.
 *
 * Deliberately small. Everything here is expressible in all three providers' filter languages;
 * anything that is not is rejected by the compiler as unsupported, which is what routes it to the
 * consent-gated AI transcriber rather than producing a query that quietly means something else.
 */
export type LogPredicate =
	| { op: '=' | '!=' | '<' | '<=' | '>' | '>='; field: string; value: LogScalar }
	/** SQL `LIKE` / `NOT LIKE`. `%` and `_` keep their SQL meaning; the driver translates. */
	| { op: 'like' | 'not like'; field: string; pattern: string; caseInsensitive?: boolean }
	| { op: 'in' | 'not in'; field: string; values: LogScalar[] }
	| { op: 'is null' | 'is not null'; field: string };

/** The aggregate functions a grouped log query may ask for. */
export type LogAggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** One output column of a grouped query. `field` is absent only for `count(*)`. */
export interface LogAgg {
	fn: LogAggFn;
	field?: string;
	distinct?: boolean;
	/** The result column's name, as the grid will label it. */
	as: string;
}

/**
 * The grouping half of a query, when there is one.
 *
 * Present means "this cannot be answered by streaming events" — the driver must use an engine that
 * aggregates at the source, which on CloudWatch is the billable one. `by` may be empty: that is a
 * whole-window aggregate (`SELECT count(*) FROM …`), one row out.
 */
export interface LogAggregate {
	by: string[];
	aggs: LogAgg[];
}

/** How a result is ordered. Only the fields the query already produces may be ordered on. */
export interface LogOrder {
	field: string;
	desc: boolean;
}

/**
 * A read of one log scope: the vendor-neutral form every telemetry driver executes.
 *
 * `start`/`end` are ms since the epoch and the window is HALF-OPEN, `start` inclusive and `end`
 * exclusive, matching `LogReadWindow` in the flow seam and `FilterLogEvents` itself. Keeping one
 * definition across both readers is what lets a cursor resume with no gap and no double count.
 */
export interface LogsQuery {
	/** The scope's name, exactly as introspection spelled it (a log group's full path). */
	scope: string;
	/** Inclusive. */
	start: number;
	/** Exclusive. */
	end: number;
	/** Projected fields in order. Absent means the whole fixed contract. Ignored when
	 *  {@link aggregate} is present, whose outputs are the projection. */
	select?: string[];
	/** ANDed conditions. Absent or empty means every event in the window. */
	where?: LogPredicate[];
	aggregate?: LogAggregate;
	orderBy?: LogOrder[];
	/** Rows the caller wants at most. A driver may overshoot by up to one page; the caller slices. */
	limit?: number;
	/** Narrow to a sub-division of the scope, where the provider has one. Ignored by those that
	 *  do not, exactly as `LogReadOptions.streamPrefix` is. */
	streamPrefix?: string;
}

/** A one-line rendering of a {@link LogsQuery} for the history list and the results footer. Reads
 *  as the SQL it came from rather than as any vendor's language, because at this level it has not
 *  been given to a vendor yet. */
export function describeLogsQuery(query: LogsQuery): string {
	const projection = query.aggregate
		? [...query.aggregate.by, ...query.aggregate.aggs.map(describeAgg)].join(', ')
		: (query.select?.join(', ') || '*');
	const parts = [`SELECT ${projection} FROM ${quoteScope(query.scope)}`];
	parts.push(`BETWEEN ${new Date(query.start).toISOString()} AND ${new Date(query.end).toISOString()}`);
	if (query.where?.length) {
		parts.push(`WHERE ${query.where.map(describePredicate).join(' AND ')}`);
	}
	if (query.aggregate?.by.length) {
		parts.push(`GROUP BY ${query.aggregate.by.join(', ')}`);
	}
	if (query.orderBy?.length) {
		parts.push(`ORDER BY ${query.orderBy.map((o) => `${o.field}${o.desc ? ' DESC' : ''}`).join(', ')}`);
	}
	if (query.limit !== undefined) {
		parts.push(`LIMIT ${query.limit}`);
	}
	return parts.join(' ');
}

/** A scope name is a path (`/aws/lambda/api`), so it is quoted unless it is a bare identifier. */
function quoteScope(scope: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(scope) ? scope : `"${scope.replace(/"/g, '""')}"`;
}

function describeAgg(agg: LogAgg): string {
	const arg = agg.field ? `${agg.distinct ? 'DISTINCT ' : ''}${agg.field}` : '*';
	return `${agg.fn}(${arg}) AS ${agg.as}`;
}

function describePredicate(predicate: LogPredicate): string {
	switch (predicate.op) {
		case 'is null':
		case 'is not null':
			return `${predicate.field} ${predicate.op.toUpperCase()}`;
		case 'like':
		case 'not like':
			return `${predicate.field} ${predicate.op.toUpperCase()} ${literal(predicate.pattern)}`;
		case 'in':
		case 'not in':
			return `${predicate.field} ${predicate.op.toUpperCase()} (${predicate.values.map(literal).join(', ')})`;
		default:
			return `${predicate.field} ${predicate.op} ${literal(predicate.value)}`;
	}
}

function literal(value: LogScalar): string {
	if (value === null) {
		return 'NULL';
	}
	return typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
}

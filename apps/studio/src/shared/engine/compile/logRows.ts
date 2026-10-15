/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Answering a {@link LogsQuery} over log EVENTS: the half of telemetry execution that is the same
 *  for every vendor.
 *
 *  A driver's job is to fetch as little as it can — it pushes whatever of the query its provider's
 *  filter language can express down to the service. What it CANNOT push down still has to be
 *  applied, or the answer is wrong, and each of the three providers can push down a different
 *  subset. So the residue is applied here, once, by code that is pure and tested, rather than three
 *  times by code that talks to a network.
 *
 *  That is also what lets a provider with NO aggregation API (Google Cloud Logging has none: its
 *  Logging API lists entries and nothing else) still answer `GROUP BY`. The rule that keeps that
 *  honest is {@link aggregateLogRows}'s: an aggregate computed here over a scan that was TRUNCATED
 *  is not a slightly-off answer, it is a wrong one, so the caller must refuse rather than round.
 *
 *  Everything here is pure and synchronous. Nothing knows what a provider is.
 *--------------------------------------------------------------------------------------------*/

import {
	canonicalLogField,
	LOG_COLUMNS,
	LOG_FIELDS,
	type LogAgg,
	type LogAggregate,
	type LogPredicate,
	type LogScalar,
	type LogsQuery,
} from './logs';

/** One log event as the drivers hand it over — the shape `LogEvent` in `src/shared/cloud.ts` has,
 *  repeated structurally so the engine does not import an app-shell contract. */
export interface LogEventLike {
	id: string;
	at: number;
	ingestedAt?: number;
	stream?: string;
	message: string;
}

/** A row: the fixed contract's columns plus whatever parsed fields the event carried. */
export type LogRow = Record<string, unknown>;

/**
 * An event → a row.
 *
 * The fixed contract is filled from the event itself; the PARSED fields come from the message when
 * it is a JSON object, which is what makes `WHERE level = 'ERROR'` work on a structured log without
 * anyone declaring a schema. A message that is not JSON contributes no fields and keeps its text,
 * which is the common case and must stay free — hence the cheap first-character check before
 * `JSON.parse` is even attempted.
 *
 * A parsed field never overwrites a contract column: a log line with its own `"message"` key would
 * otherwise replace the event's real text with a fragment of itself. Those land prefixed, so they
 * are addressable and the contract stays trustworthy.
 */
export function logRowOf(event: LogEventLike): LogRow {
	const row: LogRow = {
		[LOG_FIELDS.ts]: event.at,
		[LOG_FIELDS.message]: event.message,
		[LOG_FIELDS.stream]: event.stream ?? null,
		[LOG_FIELDS.id]: event.id,
		[LOG_FIELDS.ingestedAt]: event.ingestedAt ?? null,
	};
	for (const [key, value] of Object.entries(parsedFields(event.message))) {
		row[(LOG_COLUMNS as readonly string[]).includes(key) ? `json_${key}` : key] = value;
	}
	return row;
}

/** The top-level keys of a JSON-object message, flattened one level for nested objects (`a.b`), or
 *  nothing at all. Depth is capped at one because a log line's nesting is unbounded and a column
 *  list that changes shape per row is not a table. */
function parsedFields(message: string): Record<string, unknown> {
	const trimmed = message.trimStart();
	if (!trimmed.startsWith('{')) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {};
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
				out[`${key}.${inner}`] = innerValue;
			}
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** True when a row satisfies every predicate. An empty list matches everything. */
export function matchesLogPredicates(row: LogRow, predicates: readonly LogPredicate[] | undefined): boolean {
	for (const predicate of predicates ?? []) {
		if (!matchesOne(row, predicate)) {
			return false;
		}
	}
	return true;
}

function matchesOne(row: LogRow, predicate: LogPredicate): boolean {
	const value = row[canonicalLogField(predicate.field)];
	switch (predicate.op) {
		case 'is null':
			return value === null || value === undefined;
		case 'is not null':
			return value !== null && value !== undefined;
		case 'like':
		case 'not like': {
			const matched = typeof value === 'string' && likeRegex(predicate.pattern, predicate.caseInsensitive).test(value);
			return predicate.op === 'like' ? matched : !matched;
		}
		case 'in':
		case 'not in': {
			const found = predicate.values.some((candidate) => looseEquals(value, candidate));
			return predicate.op === 'in' ? found : !found;
		}
		case '=':
			return looseEquals(value, predicate.value);
		case '!=':
			return !looseEquals(value, predicate.value);
		default: {
			const order = compareScalars(value, predicate.value);
			if (order === undefined) {
				return false;
			}
			switch (predicate.op) {
				case '<': return order < 0;
				case '<=': return order <= 0;
				case '>': return order > 0;
				case '>=': return order >= 0;
			}
		}
	}
	return false;
}

/**
 * SQL equality, with ONE deliberate liberty: a JSON log field is whatever the producer serialised
 * it as, so `status = 200` must match both `200` and `"200"`. Comparing across those types is not
 * SQL's rule, but a log line is not a typed column, and the alternative is a query that silently
 * returns nothing. NULL never equals anything, exactly as in SQL.
 */
function looseEquals(value: unknown, expected: LogScalar): boolean {
	if (expected === null) {
		return false;
	}
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value === typeof expected) {
		return value === expected;
	}
	return String(value) === String(expected);
}

/** -1/0/1, or undefined when the two are not comparable (so an ordering predicate is false). */
function compareScalars(value: unknown, expected: LogScalar): number | undefined {
	if (value === null || value === undefined || expected === null) {
		return undefined;
	}
	if (typeof value === 'number' && typeof expected === 'number') {
		return value < expected ? -1 : value > expected ? 1 : 0;
	}
	const left = typeof value === 'number' ? value : String(value);
	const right = typeof expected === 'number' ? expected : String(expected);
	if (typeof left === 'number' && typeof right === 'number') {
		return left < right ? -1 : left > right ? 1 : 0;
	}
	const a = String(left);
	const b = String(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

const LIKE_CACHE = new Map<string, RegExp>();

function likeRegex(pattern: string, caseInsensitive?: boolean): RegExp {
	const key = `${caseInsensitive ? 'i' : ''}:${pattern}`;
	const cached = LIKE_CACHE.get(key);
	if (cached) {
		return cached;
	}
	const source = '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$';
	const regex = new RegExp(source, caseInsensitive ? 'is' : 's');
	LIKE_CACHE.set(key, regex);
	return regex;
}

/** Keep only the requested columns, in the requested order. No projection means the whole row. */
export function projectLogRow(row: LogRow, select: readonly string[] | undefined): LogRow {
	if (!select || select.length === 0) {
		return row;
	}
	const out: LogRow = {};
	for (const field of select) {
		const name = canonicalLogField(field);
		out[name] = row[name] ?? null;
	}
	return out;
}

/** Sort rows in place by a query's ORDER BY. Stable, and NULLs sort last in either direction —
 *  a log field that is missing is not "smallest", it is absent. */
export function sortLogRows(rows: LogRow[], orderBy: LogsQuery['orderBy']): LogRow[] {
	if (!orderBy?.length) {
		return rows;
	}
	return rows.sort((left, right) => {
		for (const { field, desc } of orderBy) {
			const a = left[field];
			const b = right[field];
			const aMissing = a === null || a === undefined;
			const bMissing = b === null || b === undefined;
			if (aMissing || bMissing) {
				if (aMissing && bMissing) {
					continue;
				}
				return aMissing ? 1 : -1;
			}
			const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
			if (order !== 0) {
				return desc ? -order : order;
			}
		}
		return 0;
	});
}

/**
 * Group and aggregate rows in the app, for a provider whose API cannot.
 *
 * `complete` is the caller's assertion that the rows it is passing are EVERY row in the window, not
 * the first page of them. It is a parameter rather than an inference because only the driver knows
 * whether its scan ran to the end or stopped at a cap, and an aggregate over a truncated scan is
 * not approximately right — a `count(*)` that says 10,000 because 10,000 is where we stopped
 * reading is a wrong answer wearing a right answer's clothes. So this throws rather than returning
 * one, and the caller turns that into "narrow the time range".
 */
export function aggregateLogRows(rows: readonly LogRow[], aggregate: LogAggregate, complete: boolean): LogRow[] {
	if (!complete) {
		throw new IncompleteAggregateError();
	}
	const groups = new Map<string, { key: LogRow; rows: LogRow[] }>();
	for (const row of rows) {
		const key: LogRow = {};
		for (const field of aggregate.by) {
			key[field] = row[field] ?? null;
		}
		const id = JSON.stringify(aggregate.by.map((field) => key[field]));
		const existing = groups.get(id);
		if (existing) {
			existing.rows.push(row);
		} else {
			groups.set(id, { key, rows: [row] });
		}
	}
	// An ungrouped aggregate over no rows is still one row (`count(*)` = 0), which is what SQL says
	// and what a dashboard reading "no errors" depends on.
	if (aggregate.by.length === 0 && groups.size === 0) {
		groups.set('[]', { key: {}, rows: [] });
	}
	return [...groups.values()].map(({ key, rows: members }) => {
		const out: LogRow = { ...key };
		for (const agg of aggregate.aggs) {
			out[agg.as] = applyAgg(agg, members);
		}
		return out;
	});
}

/** Thrown by {@link aggregateLogRows} when asked to aggregate a scan that did not finish. */
export class IncompleteAggregateError extends Error {
	constructor() {
		super('The scan hit its row cap before the window ended, so this total would be wrong. Narrow the time range or add a filter.');
		this.name = 'IncompleteAggregateError';
	}
}

function applyAgg(agg: LogAgg, rows: readonly LogRow[]): unknown {
	if (agg.fn === 'count' && !agg.field) {
		return rows.length;
	}
	const field = agg.field ? canonicalLogField(agg.field) : undefined;
	const values = rows.map((row) => (field ? row[field] : undefined)).filter((value) => value !== null && value !== undefined);
	if (agg.fn === 'count') {
		return agg.distinct ? new Set(values.map((value) => String(value))).size : values.length;
	}
	const numbers = values.map(Number).filter((value) => Number.isFinite(value));
	if (numbers.length === 0) {
		// SQL's answer for an aggregate over no non-null values, and the honest one: not zero, which
		// would be indistinguishable from a real total of zero.
		return null;
	}
	switch (agg.fn) {
		case 'sum': return numbers.reduce((total, value) => total + value, 0);
		case 'avg': return numbers.reduce((total, value) => total + value, 0) / numbers.length;
		case 'min': return Math.min(...numbers);
		case 'max': return Math.max(...numbers);
	}
}

/** The column names a query's result carries, in order — what the grid labels its columns with. */
export function logResultColumns(query: LogsQuery): string[] {
	if (query.aggregate) {
		return [...query.aggregate.by, ...query.aggregate.aggs.map((agg) => agg.as)];
	}
	return query.select?.length ? query.select.map(canonicalLogField) : [...LOG_COLUMNS];
}

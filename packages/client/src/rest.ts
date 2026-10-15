/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The data API: a query builder over PostgREST at `/v1/data` (`/rest/v1` in the old vocabulary).
 *
 * A builder is a description of one request, and awaiting it sends it. Nothing is sent by
 * `read()` or `eq()`; they only add to the URL, which is why a builder can be passed
 * around, extended and awaited later. Every result is `{ data, error, count, status }`, and
 * a refusal is an `error` rather than a throw, unless `throwOnError()` asks for a throw.
 */

import { checkSegment, joinUrl, messageOf, readBody, type Transport } from './http.js';

/**
 * A row when the client was made without a `Database` type: `any`, so untyped code reads its
 * rows without a cast. It was `Record<string, unknown>` in 0.1.0-0.2.0, and moving our own four apps
 * across found ~100 places that stopped compiling on that alone. With a `Database` type
 * (`snoutdata gen types typescript`), rows are exact, which is where the safety belongs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

export interface QueryError {
	message: string;
	details: string | null;
	hint: string | null;
	code: string;
}

interface Base {
	count: number | null;
	status: number;
	statusText: string;
}

export type QueryResult<T> = (Base & { data: T; error: null }) | (Base & { data: null; error: QueryError });

export type CountMethod = 'exact' | 'planned' | 'estimated';

type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE';

interface State {
	transport: Transport;
	method: Method;
	url: URL;
	schema: string | undefined;
	body: unknown;
	prefer: Map<string, string>;
	accept: string | undefined;
	cardinality: 'many' | 'one' | 'maybe-one';
	signal: AbortSignal | undefined;
	throws: boolean;
}

/**
 * A PostgREST filter value. Lists go in parentheses and each member is quoted when it holds
 * a character PostgREST would read as syntax.
 */
function quote(value: unknown): string {
	const text = value === null ? 'null' : String(value);
	return /[,()"\\:]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

function list(values: readonly unknown[]): string {
	return `(${values.map(quote).join(',')})`;
}

/** `{a,b}` for an array column, JSON for a jsonb one, the text as given for a range. */
function containment(value: unknown): string {
	if (Array.isArray(value)) {
		return `{${value.map(quote).join(',')}}`;
	}
	if (value !== null && typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

export type FilterOperator =
	| 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in'
	| 'cs' | 'cd' | 'ov' | 'sl' | 'sr' | 'nxl' | 'nxr' | 'adj' | 'match' | 'imatch'
	| 'fts' | 'plfts' | 'phfts' | 'wfts' | 'isdistinct';

/**
 * One request, being described. Filters and modifiers return `this` with a narrower result
 * type where they change the shape (`single()`, `maybeSingle()`), so the awaited value is
 * typed by what was asked for.
 */
/**
 * `W` is the row a `read()` after a write returns: the table's row for `add`, `change`, `put`
 * and `remove`, whose own result is `null` until `read()` asks for the rows.
 */
export class QueryBuilder<T, W = T extends readonly (infer E)[] ? E : T> implements PromiseLike<QueryResult<T>> {
	protected readonly state: State;

	constructor(state: State) {
		this.state = state;
	}

	/** @deprecated Since 0.4.0: use `read()`, the same function. Removed in 0.5.0. */
	declare select: QueryBuilder<T, W>['read'];

	// ---- filters ----

	eq(column: string, value: unknown): this {
		return this.filter(column, 'eq', value);
	}

	neq(column: string, value: unknown): this {
		return this.filter(column, 'neq', value);
	}

	gt(column: string, value: unknown): this {
		return this.filter(column, 'gt', value);
	}

	gte(column: string, value: unknown): this {
		return this.filter(column, 'gte', value);
	}

	lt(column: string, value: unknown): this {
		return this.filter(column, 'lt', value);
	}

	lte(column: string, value: unknown): this {
		return this.filter(column, 'lte', value);
	}

	like(column: string, pattern: string): this {
		return this.filter(column, 'like', pattern);
	}

	ilike(column: string, pattern: string): this {
		return this.filter(column, 'ilike', pattern);
	}

	likeAnyOf(column: string, patterns: readonly string[]): this {
		return this.raw(column, `like(any).{${patterns.map(quote).join(',')}}`);
	}

	ilikeAnyOf(column: string, patterns: readonly string[]): this {
		return this.raw(column, `ilike(any).{${patterns.map(quote).join(',')}}`);
	}

	/** `null`, `true`, `false` or `unknown`, compared with IS. */
	is(column: string, value: boolean | null | 'unknown'): this {
		return this.raw(column, `is.${value === null ? 'null' : String(value)}`);
	}

	isDistinct(column: string, value: unknown): this {
		return this.filter(column, 'isdistinct', value);
	}

	in(column: string, values: readonly unknown[]): this {
		return this.raw(column, `in.${list(values)}`);
	}

	contains(column: string, value: unknown): this {
		return this.raw(column, `cs.${containment(value)}`);
	}

	containedBy(column: string, value: unknown): this {
		return this.raw(column, `cd.${containment(value)}`);
	}

	overlaps(column: string, value: unknown): this {
		return this.raw(column, `ov.${containment(value)}`);
	}

	rangeGt(column: string, range: string): this {
		return this.raw(column, `sr.${range}`);
	}

	rangeGte(column: string, range: string): this {
		return this.raw(column, `nxl.${range}`);
	}

	rangeLt(column: string, range: string): this {
		return this.raw(column, `sl.${range}`);
	}

	rangeLte(column: string, range: string): this {
		return this.raw(column, `nxr.${range}`);
	}

	rangeAdjacent(column: string, range: string): this {
		return this.raw(column, `adj.${range}`);
	}

	/** Full-text search. `type` picks the tsquery parser; plain `to_tsquery` when omitted. */
	textSearch(column: string, query: string, options: { config?: string; type?: 'plain' | 'phrase' | 'websearch' } = {}): this {
		const operator = { plain: 'plfts', phrase: 'phfts', websearch: 'wfts' }[options.type ?? 'plain'] ?? 'fts';
		const parser = options.type === undefined ? 'fts' : operator;
		const config = options.config ? `(${options.config})` : '';
		return this.raw(column, `${parser}${config}.${query}`);
	}

	/** Equality on every key of `query`. */
	match(query: Record<string, unknown>): this {
		for (const [column, value] of Object.entries(query)) {
			this.eq(column, value);
		}
		return this;
	}

	not(column: string, operator: FilterOperator, value: unknown): this {
		return this.raw(column, `not.${operator}.${this.operand(operator, value)}`);
	}

	/**
	 * Any of the conditions, in PostgREST's own syntax: `'status.eq.open,priority.gt.3'`.
	 * `referencedTable` applies it to an embedded resource instead of the top level.
	 */
	or(conditions: string, options: { referencedTable?: string } = {}): this {
		const key = options.referencedTable ? `${options.referencedTable}.or` : 'or';
		this.state.url.searchParams.append(key, `(${conditions})`);
		return this;
	}

	/** Any operator by name, for the ones without a method of their own. */
	filter(column: string, operator: FilterOperator | `not.${FilterOperator}`, value: unknown): this {
		const bare = operator.replace(/^not\./, '') as FilterOperator;
		return this.raw(column, `${operator}.${this.operand(bare, value)}`);
	}

	private operand(operator: FilterOperator, value: unknown): string {
		if (operator === 'in' && Array.isArray(value)) {
			return list(value);
		}
		if ((operator === 'cs' || operator === 'cd' || operator === 'ov') && typeof value !== 'string') {
			return containment(value);
		}
		return value === null ? 'null' : String(value);
	}

	private raw(column: string, expression: string): this {
		this.state.url.searchParams.append(column, expression);
		return this;
	}

	// ---- modifiers ----

	/**
	 * After `add`/`change`/`put`/`remove`, return the affected rows (and only these columns).
	 * Without it a write returns no rows, which is cheaper.
	 */
	read<R = W>(columns = '*'): QueryBuilder<R[]> {
		this.state.url.searchParams.set('select', cleanColumns(columns));
		this.state.prefer.set('return', 'representation');
		return this as unknown as QueryBuilder<R[]>;
	}

	order(column: string, options: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string } = {}): this {
		const key = options.referencedTable ? `${options.referencedTable}.order` : 'order';
		const term = [
			column,
			options.ascending === false ? 'desc' : 'asc',
			...(options.nullsFirst === undefined ? [] : [options.nullsFirst ? 'nullsfirst' : 'nullslast'])
		].join('.');
		const existing = this.state.url.searchParams.get(key);
		this.state.url.searchParams.set(key, existing ? `${existing},${term}` : term);
		return this;
	}

	limit(count: number, options: { referencedTable?: string } = {}): this {
		const key = options.referencedTable ? `${options.referencedTable}.limit` : 'limit';
		this.state.url.searchParams.set(key, String(count));
		return this;
	}

	/** Rows `from` to `to`, both inclusive and zero-based, as `range(0, 9)` is the first ten. */
	range(from: number, to: number, options: { referencedTable?: string } = {}): this {
		const prefix = options.referencedTable ? `${options.referencedTable}.` : '';
		this.state.url.searchParams.set(`${prefix}offset`, String(from));
		this.state.url.searchParams.set(`${prefix}limit`, String(to - from + 1));
		return this;
	}

	/** Exactly one row, or an error. */
	single(): QueryBuilder<T extends readonly (infer E)[] ? E : T> {
		this.state.cardinality = 'one';
		this.state.accept = 'application/vnd.pgrst.object+json';
		return this as unknown as QueryBuilder<T extends readonly (infer E)[] ? E : T>;
	}

	/** One row or `null`; more than one is an error. */
	maybeSingle(): QueryBuilder<(T extends readonly (infer E)[] ? E : T) | null> {
		this.state.cardinality = 'maybe-one';
		return this as unknown as QueryBuilder<(T extends readonly (infer E)[] ? E : T) | null>;
	}

	/** The result as CSV text instead of rows. */
	csv(): QueryBuilder<string> {
		this.state.accept = 'text/csv';
		return this as unknown as QueryBuilder<string>;
	}

	/** The query plan PostgREST would run, instead of the rows. */
	explain(options: { analyze?: boolean; verbose?: boolean; format?: 'text' | 'json' } = {}): QueryBuilder<unknown> {
		const flags = [options.analyze && 'analyze', options.verbose && 'verbose'].filter(Boolean).join('|');
		const format = options.format ?? 'text';
		this.state.accept = `application/vnd.pgrst.plan+${format}; for="${this.state.accept ?? 'application/json'}"${flags ? `; options=${flags}` : ''}`;
		return this as unknown as QueryBuilder<unknown>;
	}

	abortSignal(signal: AbortSignal): this {
		this.state.signal = signal;
		return this;
	}

	/** Throw the error instead of returning it. */
	throwOnError(): this {
		this.state.throws = true;
		return this;
	}

	/** The request this builder would send, for logging and tests. Sends nothing. */
	toUrl(): string {
		return this.state.url.toString();
	}

	// ---- sending ----

	then<A = QueryResult<T>, B = never>(
		onfulfilled?: ((value: QueryResult<T>) => A | PromiseLike<A>) | null,
		onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
	): PromiseLike<A | B> {
		return this.execute().then(onfulfilled, onrejected);
	}

	private async execute(): Promise<QueryResult<T>> {
		const s = this.state;
		const headers: Record<string, string> = { ...(await s.transport.headers()) };
		if (s.schema) {
			headers[s.method === 'GET' || s.method === 'HEAD' ? 'Accept-Profile' : 'Content-Profile'] = s.schema;
		}
		if (s.accept) {
			headers['Accept'] = s.accept;
		}
		if (s.prefer.size > 0) {
			headers['Prefer'] = [...s.prefer].map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(',');
		}
		let body: string | undefined;
		if (s.body !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(s.body);
		}

		let response: Response;
		try {
			response = await s.transport.fetch(s.url.toString(), { method: s.method, headers, body, signal: s.signal });
		} catch (cause) {
			return this.fail(0, '', {
				message: cause instanceof Error ? cause.message : String(cause),
				details: null,
				hint: null,
				code: ''
			});
		}

		const count = countOf(response.headers.get('content-range'));
		const payload = s.method === 'HEAD' ? null : s.accept === 'text/csv' ? await response.text() : await readBody(response);

		if (!response.ok) {
			const record = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
			return this.fail(response.status, response.statusText, {
				message: messageOf(payload, `${response.status} ${response.statusText}`),
				details: typeof record.details === 'string' ? record.details : null,
				hint: typeof record.hint === 'string' ? record.hint : null,
				code: typeof record.code === 'string' ? record.code : String(response.status)
			}, count);
		}

		let data: unknown = payload;
		if (s.cardinality === 'maybe-one' && Array.isArray(payload)) {
			if (payload.length > 1) {
				return this.fail(406, 'Not Acceptable', {
					message: 'JSON object requested, multiple (or no) rows returned',
					details: `The result contains ${payload.length} rows`,
					hint: null,
					code: 'PGRST116'
				}, count);
			}
			data = payload[0] ?? null;
		}
		return { data: data as T, error: null, count, status: response.status, statusText: response.statusText };
	}

	private fail(status: number, statusText: string, error: QueryError, count: number | null = null): QueryResult<T> {
		if (this.state.throws) {
			throw Object.assign(new Error(error.message), error);
		}
		return { data: null, error, count, status, statusText };
	}
}

/** `0-24/3573` → 3573; `*` or no header → null. */
function countOf(contentRange: string | null): number | null {
	const total = contentRange?.split('/')[1];
	return total === undefined || total === '*' ? null : Number(total);
}

/** Whitespace in a select list is noise to PostgREST except inside a quoted identifier. */
function cleanColumns(columns: string): string {
	let quoted = false;
	let out = '';
	for (const char of columns) {
		if (char === '"') {
			quoted = !quoted;
		}
		if (!quoted && /\s/.test(char)) {
			continue;
		}
		out += char;
	}
	return out;
}

export interface WriteOptions {
	count?: CountMethod;
}

/** What `table(name)` returns: the choice of verb. */
export class TableBuilder<R> {
	constructor(
		private readonly transport: Transport,
		private readonly url: string,
		private readonly schema: string | undefined
	) {}

	/** @deprecated Since 0.4.0: use `read()`, the same function. Removed in 0.5.0. */
	declare select: TableBuilder<R>['read'];
	/** @deprecated Since 0.4.0: use `add()`, the same function. Removed in 0.5.0. */
	declare insert: TableBuilder<R>['add'];
	/** @deprecated Since 0.4.0: use `put()`, the same function. Removed in 0.5.0. */
	declare upsert: TableBuilder<R>['put'];
	/** @deprecated Since 0.4.0: use `change()`, the same function. Removed in 0.5.0. */
	declare update: TableBuilder<R>['change'];
	/** @deprecated Since 0.4.0: use `remove()`, the same function. Removed in 0.5.0. */
	declare delete: TableBuilder<R>['remove'];

	private start<T>(method: Method, body?: unknown): QueryBuilder<T, R> {
		return new QueryBuilder<T, R>({
			transport: this.transport,
			method,
			url: new URL(this.url),
			schema: this.schema,
			body,
			prefer: new Map(),
			accept: undefined,
			cardinality: 'many',
			signal: undefined,
			throws: false
		});
	}

	/** Read. `head: true` sends no rows back, which with `count` is how to count cheaply. */
	read<T = R>(columns = '*', options: { count?: CountMethod; head?: boolean } = {}): QueryBuilder<T[]> {
		const builder = this.start<T[]>(options.head ? 'HEAD' : 'GET');
		builder['state'].url.searchParams.set('select', cleanColumns(columns));
		if (options.count) {
			builder['state'].prefer.set('count', options.count);
		}
		return builder;
	}

	/** Add one row or many. Returns nothing unless followed by `.read()`. */
	add(values: Partial<R> | readonly Partial<R>[], options: WriteOptions & { defaultToNull?: boolean } = {}): QueryBuilder<null, R> {
		const builder = this.start<null>('POST', values);
		withCount(builder, options.count);
		if (Array.isArray(values)) {
			setColumns(builder, values);
			if (options.defaultToNull === false) {
				builder['state'].prefer.set('missing', 'default');
			}
		}
		return builder;
	}

	/**
	 * Add, or change on a conflict (an upsert). `onConflict` names the unique columns to match on
	 * (the primary key when omitted); `ignoreDuplicates` keeps the existing row instead.
	 */
	put(
		values: Partial<R> | readonly Partial<R>[],
		options: WriteOptions & { onConflict?: string; ignoreDuplicates?: boolean; defaultToNull?: boolean } = {}
	): QueryBuilder<null, R> {
		const builder = this.start<null>('POST', values);
		builder['state'].prefer.set('resolution', options.ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates');
		if (options.onConflict) {
			builder['state'].url.searchParams.set('on_conflict', options.onConflict);
		}
		withCount(builder, options.count);
		if (Array.isArray(values)) {
			setColumns(builder, values);
			if (options.defaultToNull === false) {
				builder['state'].prefer.set('missing', 'default');
			}
		}
		return builder;
	}

	/** Change the rows the filters that follow select. Without a filter, PostgREST refuses. */
	change(values: Partial<R>, options: WriteOptions = {}): QueryBuilder<null, R> {
		const builder = this.start<null>('PATCH', values);
		withCount(builder, options.count);
		return builder;
	}

	/** Remove the rows the filters that follow select. */
	remove(options: WriteOptions = {}): QueryBuilder<null, R> {
		const builder = this.start<null>('DELETE');
		withCount(builder, options.count);
		return builder;
	}
}

function withCount(builder: QueryBuilder<unknown>, count: CountMethod | undefined): void {
	if (count) {
		builder['state'].prefer.set('count', count);
	}
}

/**
 * A bulk write names its columns so a row that leaves one out gets NULL (or the default)
 * rather than PostgREST refusing the batch for having unequal keys.
 */
function setColumns(builder: QueryBuilder<unknown>, rows: readonly object[]): void {
	const columns = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			columns.add(key);
		}
	}
	if (columns.size > 0) {
		builder['state'].url.searchParams.set('columns', [...columns].map((c) => `"${c}"`).join(','));
	}
}

/** Calls a Postgres function. `get: true` sends it as a GET with the arguments in the URL. */
export function procedure<T>(
	transport: Transport,
	restUrl: string,
	schema: string | undefined,
	fn: string,
	args: Record<string, unknown> = {},
	options: { head?: boolean; get?: boolean; count?: CountMethod } = {}
): QueryBuilder<T> {
	const url = new URL(joinUrl(restUrl, `rpc/${encodeURIComponent(checkSegment(fn))}`));
	let method: Method = 'POST';
	let body: unknown = args;
	if (options.head || options.get) {
		method = options.head ? 'HEAD' : 'GET';
		body = undefined;
		for (const [name, value] of Object.entries(args)) {
			url.searchParams.append(name, Array.isArray(value) ? `{${value.join(',')}}` : String(value));
		}
	}
	const builder = new QueryBuilder<T>({
		transport,
		method,
		url,
		schema,
		body,
		prefer: new Map(),
		accept: undefined,
		cardinality: 'many',
		signal: undefined,
		throws: false
	});
	withCount(builder, options.count);
	return builder;
}

// The 0.3.x names, each the same function as its new one, kept for 0.4.x.

QueryBuilder.prototype.select = QueryBuilder.prototype.read;

TableBuilder.prototype.select = TableBuilder.prototype.read;
TableBuilder.prototype.insert = TableBuilder.prototype.add;
TableBuilder.prototype.upsert = TableBuilder.prototype.put;
TableBuilder.prototype.update = TableBuilder.prototype.change;
TableBuilder.prototype.delete = TableBuilder.prototype.remove;

/** @deprecated Since 0.4.0: `procedure`, the same function. Removed in 0.5.0. */
export const rpc = procedure;

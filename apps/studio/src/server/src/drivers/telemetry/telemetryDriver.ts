/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The TELEMETRY DatabaseDriver: one driver class, three cloud log services behind it.
 *
 *  This is what makes a log group a table — it implements the same
 *  `DatabaseDriver` contract every SQL vendor does, so the explorer, the live schema index, the
 *  results grid, query history, charts and the assistant work on a CloudWatch connection with no
 *  telemetry branches anywhere above it.
 *
 *  IT IS ONE CLASS FOR ALL THREE VENDORS, unlike the relational drivers, because the variance
 *  between CloudWatch, Azure Monitor and Cloud Logging is entirely inside `TelemetrySession` (their
 *  APIs and their query languages) and not at all in what a connection does with one. Splitting it
 *  three ways would be three copies of the executor below, which is the part with the rules in it.
 *
 *  THE EXECUTOR'S RULES, in the order they matter:
 *
 *  1. **A grouping goes to the source if the source can group it**, because that is the only way to
 *     answer `count(*)` over a week without streaming a week to a laptop. On CloudWatch that path
 *     is billed per GB, so it runs only when the query genuinely needs it — never for a scan.
 *  2. **A grouping the source cannot do is computed here, over a COMPLETE scan or not at all.**
 *     Cloud Logging has no aggregation API; a `count(*)` that says 10,000 because 10,000 is where
 *     the scan stopped is a wrong answer wearing a right one's clothes, so
 *     {@link aggregateLogRows} refuses and the user is told to narrow the range.
 *  3. **Every predicate is applied here regardless of what the driver pushed down.** Pushdown is a
 *     transfer-size optimisation and each provider can express a different subset; re-checking is
 *     free and it is what lets a driver push down nothing and still be correct.
 *  4. **A scan is capped and says so.** {@link MAX_SCAN_ROWS} bounds an unbounded `SELECT *` the
 *     way a `LIMIT` would, and the result's `cost.truncated` is what the footer reads to say the
 *     window held more.
 *--------------------------------------------------------------------------------------------*/

import {
	aggregateLogRows,
	IncompleteAggregateError,
	logResultColumns,
	logRowOf,
	matchesLogPredicates,
	projectLogRow,
	sortLogRows,
	type LogRow,
	type LogsQuery,
	type NativeQuery,
} from '../../../../shared/engine';
import { LOG_COLUMNS, LOG_FIELDS } from '../../../../shared/engine';
import type { CloudAccount } from '../../../../shared/cloud';
import type { ConnectionConfig } from '../../../../shared/connection';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../../shared/schema';
import { QueryCancelledError, type DatabaseDriver, type IntrospectOptions, type QueryResult } from '../databaseDriver';
import { telemetryPlugin, type TelemetryDriverPlugin, type TelemetrySession } from './telemetrySource';
import type { LogScope } from '../../../../shared/cloud';

/** Rows a scan will materialise before it stops. Deliberately the same 10,000 CloudWatch Logs
 *  Insights caps its own results at: past that a grid is not the right tool and a GROUP BY is. */
export const MAX_SCAN_ROWS = 10_000;
/** Events a scan will EXAMINE before it stops, however few of them match. A `WHERE` that matches
 *  one line in ten million must not read the ten million; a narrower window is the answer. */
export const MAX_SCAN_EVENTS = 500_000;
/** Scopes whose parsed fields introspection will discover. Beyond this a scope still gets the fixed
 *  contract and is fully queryable — what it loses is column completion — because on an account
 *  with thousands of log groups, discovery is thousands of throttled calls for a tree nobody has
 *  expanded. */
const MAX_DISCOVER_SCOPES = 100;
/** Discovery calls in flight at once. Enough to make introspection quick, low enough not to be the
 *  thing that trips a provider's rate limiter. */
const DISCOVER_CONCURRENCY = 6;
/** How far back field discovery looks. Fields are discovered from recent events, and a day is long
 *  enough to see a quiet service's shape without asking for an expensive read. */
const DISCOVER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How often a heartbeat ping is allowed to become a real API call. The app's own heartbeat is
 *  every 30 seconds, which against a metered, throttled cloud API is the wrong question asked
 *  ninety-six times too often — see {@link TelemetryDriver.ping}. */
const PING_INTERVAL_MS = 5 * 60 * 1000;

export function createTelemetryDriver(service: string): DatabaseDriver {
	return new TelemetryDriver(service);
}

class TelemetryDriver implements DatabaseDriver {
	readonly kind = 'telemetry' as const;
	private plugin?: TelemetryDriverPlugin;
	private session?: TelemetrySession;
	private account?: CloudAccount;
	private container = '';
	/** The scopes this connection was TOLD to expose, when the credential cannot enumerate them.
	 *  Empty means "ask the provider", which is the normal case. See `ConnectionConfig.cloudScopes`. */
	private named: string[] = [];
	/** Aborts whatever `execute` has in flight; `cancel` also asks the provider to stop, where it
	 *  has a way to (an abandoned Insights query keeps scanning, and keeps charging). */
	private running?: AbortController;
	/** When the credentials were last actually checked against the service. See {@link ping}. */
	private lastVerified = 0;

	constructor(readonly id: string) {}

	get displayName(): string {
		return this.plugin?.info.label ?? telemetryPlugin(this.id)?.info.label ?? this.id;
	}

	async connect(config: ConnectionConfig): Promise<void> {
		const plugin = telemetryPlugin(config.driver);
		if (!plugin) {
			throw new Error(`'${config.driver}' is not a telemetry service this build has a driver for.`);
		}
		const account = config.cloudAccount;
		if (!account) {
			throw new Error('This connection has no cloud account. Pick one on the connection, or add one in Settings.');
		}
		if (account.vendor !== plugin.info.vendor) {
			// A connection pointed at a service its account's vendor does not offer. Caught here
			// rather than at the API, where it surfaces as an authentication failure nobody can read.
			throw new Error(`"${account.name}" is a ${account.vendor.toUpperCase()} account and cannot serve ${plugin.info.label}.`);
		}
		const container = (config.cloudScope ?? '').trim();
		if (!container) {
			throw new Error(`This connection needs a ${plugin.info.containerNoun} (for example ${plugin.info.containerExample}).`);
		}
		const named = (config.cloudScopes ?? []).map((scope) => scope.trim()).filter(Boolean);
		const session = plugin.open(account, config.cloudSecret, container);
		try {
			await verifySession(session, named);
		} catch (err) {
			session.close();
			throw new Error(plugin.explain(err, account, named[0]));
		}
		this.plugin = plugin;
		this.account = account;
		this.container = container;
		this.named = named;
		this.session = session;
		this.lastVerified = Date.now();
	}

	async disconnect(): Promise<void> {
		this.running?.abort();
		this.running = undefined;
		this.session?.close();
		this.session = undefined;
	}

	isConnected(): boolean {
		return !!this.session;
	}

	/**
	 * There is no socket to keep alive — every call is an HTTPS request — so a ping here can only be
	 * "are the credentials still good", which for an SSO or `az login` session is a real question.
	 *
	 * But the app pings every live connection every 30 seconds, and against a cloud API that is
	 * 2,880 throttleable (and, on some services, billable) calls a day per connection to answer a
	 * question whose answer changes about once a workday. So the real call is RATE-LIMITED to
	 * {@link PING_INTERVAL_MS} and the rest are free: an expired credential is noticed within a few
	 * minutes instead of within thirty seconds, and the user's next query would have surfaced it
	 * anyway with a message that names the fix.
	 */
	async ping(): Promise<void> {
		const now = Date.now();
		if (now - this.lastVerified < PING_INTERVAL_MS) {
			return;
		}
		await verifySession(this.require(), this.named);
		this.lastVerified = now;
	}

	/**
	 * Scopes → pseudo-tables.
	 *
	 * Every scope gets the same fixed columns (the contract in `engine/compile/logs.ts`) plus
	 * whatever parsed fields the provider will cheaply admit to having seen. No primary key and no
	 * foreign keys: a log event has an id but nothing references it, and claiming a key would make
	 * the grid offer row editing on something that cannot be edited.
	 */
	async introspectSchema(_options?: IntrospectOptions): Promise<DatabaseSchema> {
		const session = this.require();
		const plugin = this.plugin!;
		let scopes: LogScope[];
		if (this.named.length > 0) {
			// The user named them, so there is nothing to ask: a scope's size and retention are what
			// the listing would have added, and neither is worth a permission the credential lacks.
			scopes = this.named.map((name) => ({ name }));
		} else {
			try {
				scopes = await session.listScopes();
			} catch (err) {
				throw new Error(plugin.explain(err, this.account!));
			}
		}
		const window = { start: Date.now() - DISCOVER_WINDOW_MS, end: Date.now() };
		const discoverable = scopes.slice(0, MAX_DISCOVER_SCOPES);
		const fields = new Map<string, string[]>();
		for (let index = 0; index < discoverable.length; index += DISCOVER_CONCURRENCY) {
			const batch = discoverable.slice(index, index + DISCOVER_CONCURRENCY);
			const discovered = await Promise.all(batch.map(async (scope) => {
				// A discovery failure is not an introspection failure: the scope stays queryable
				// through the fixed contract, which is what the seam's contract promises.
				try {
					return await session.discoverFields(scope.name, window);
				} catch {
					return [];
				}
			}));
			batch.forEach((scope, position) => fields.set(scope.name, discovered[position]));
		}
		return {
			database: this.container,
			tables: scopes.map((scope) => scopeTable(scope.name, fields.get(scope.name) ?? [], scope.storedBytes, scope.retentionDays)),
			fetchedAt: Date.now(),
		};
	}

	/**
	 * The scope NAMES only, deliberately.
	 *
	 * The live schema index polls this to notice structural drift. Parsed fields are discovered from
	 * recent events, so they come and go as traffic does — folding them in would make a quiet
	 * service's log group look like a DDL change every few minutes and re-introspect the whole
	 * account for nothing. The same rule the Mongo driver follows for sampled document shape.
	 */
	async structuralDigest(): Promise<string> {
		if (this.named.length > 0) {
			// A named set cannot drift: it changes when the user edits the connection, and that
			// reconnects. Polling the provider for it would be a call that can only ever agree.
			return [...this.named].sort().join('\n');
		}
		const scopes = await this.require().listScopes();
		return scopes.map((scope) => scope.name).sort().join('\n');
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const session = this.require();
		const started = Date.now();
		this.running = new AbortController();
		const signal = this.running.signal;
		try {
			if (query.lang === 'logs-native') {
				return stampWindow(await this.executeNative(session, query, signal, started), query.start, query.end, true, false, query.scope);
			}
			if (query.lang !== 'logs') {
				throw new Error(`A ${this.plugin!.info.label} connection cannot execute a '${query.lang}' query.`);
			}
			const result = await this.executeLogs(session, query.query, signal, started);
			// Stamped HERE rather than in each branch of the executor: the window is a property of
			// the query, identical whichever of the three paths answered it, and a reader who gets
			// no rows needs it every time.
			return stampWindow(result, query.query.start, query.query.end, query.windowFromSql === true, query.query.aggregate !== undefined, query.query.scope);
		} catch (err) {
			if (signal.aborted) {
				throw new QueryCancelledError();
			}
			throw new Error(this.plugin!.explain(err, this.account!, scopeOf(query)));
		} finally {
			this.running = undefined;
		}
	}

	private async executeNative(session: TelemetrySession, query: Extract<NativeQuery, { lang: 'logs-native' }>, signal: AbortSignal, started: number): Promise<QueryResult> {
		if (!session.runNative) {
			throw new Error(`${this.plugin!.info.label} has no query language of its own here — write the query in SQL.`);
		}
		const result = await session.runNative(query.text, { start: query.start, end: query.end }, query.scope, { signal });
		return {
			fields: result.columns.map((name) => ({ name })),
			rows: result.rows,
			rowCount: result.rows.length,
			durationMs: Date.now() - started,
			...(result.cost ? { cost: result.cost } : {}),
		};
	}

	private async executeLogs(session: TelemetrySession, query: LogsQuery, signal: AbortSignal, started: number): Promise<QueryResult> {
		// Rule 1: a grouping goes to the source when the source can group it.
		if (query.aggregate && session.aggregate) {
			const result = await session.aggregate(query, { signal });
			return {
				fields: result.columns.map((name) => ({ name })),
				rows: result.rows,
				rowCount: result.rows.length,
				durationMs: Date.now() - started,
				...(result.cost ? { cost: result.cost } : {}),
			};
		}

		const { rows, complete, examined } = await this.scanRows(session, query, signal);
		const columns = logResultColumns(query);

		if (query.aggregate) {
			// Rule 2: computed here, over a complete scan or not at all.
			let grouped: LogRow[];
			try {
				grouped = aggregateLogRows(rows, query.aggregate, complete);
			} catch (err) {
				if (err instanceof IncompleteAggregateError) {
					throw new Error(`${err.message} (${examined.toLocaleString()} events were read before the cap.)`);
				}
				throw err;
			}
			sortLogRows(grouped, query.orderBy);
			const capped = query.limit !== undefined ? grouped.slice(0, query.limit) : grouped;
			return {
				fields: columns.map((name) => ({ name })),
				rows: capped.map((row) => columns.map((column) => row[column] ?? null)),
				rowCount: capped.length,
				durationMs: Date.now() - started,
				cost: { engine: `${this.plugin!.info.label} (grouped in the app)`, recordsScanned: examined, recordsMatched: rows.length },
			};
		}

		sortLogRows(rows, query.orderBy);
		const capped = query.limit !== undefined ? rows.slice(0, query.limit) : rows;
		return {
			fields: columns.map((name) => ({ name, dataType: columnType(name) })),
			rows: capped.map((row) => {
				const projected = projectLogRow(row, columns);
				return columns.map((column) => projected[column] ?? null);
			}),
			rowCount: capped.length,
			durationMs: Date.now() - started,
			cost: { engine: `${this.plugin!.info.label} (scan)`, recordsScanned: examined, recordsMatched: rows.length, truncated: !complete },
		};
	}

	/**
	 * Stream the scope, turn events into rows, and apply every predicate (rule 3).
	 *
	 * `complete` is the answer to "were these all of them" — false when either cap stopped the read
	 * — and it is what rule 2 hangs on. An ORDER BY is deliberately NOT allowed to end the scan
	 * early even when it looks like it could: a `LIMIT 10` after `ORDER BY duration DESC` needs
	 * every row considered, not the first ten seen.
	 */
	private async scanRows(session: TelemetrySession, query: LogsQuery, signal: AbortSignal): Promise<{ rows: LogRow[]; complete: boolean; examined: number }> {
		const rows: LogRow[] = [];
		let examined = 0;
		let complete = true;
		// A capped, unordered, ungrouped scan is the one case where "the first N that match" IS the
		// answer, so it may stop as soon as it has them.
		const earlyStop = query.limit !== undefined && !query.aggregate && !query.orderBy?.length ? query.limit : undefined;
		for await (const event of session.scan(query, { signal })) {
			examined += 1;
			const row = logRowOf(event);
			if (matchesLogPredicates(row, query.where)) {
				rows.push(row);
			}
			if (earlyStop !== undefined && rows.length >= earlyStop) {
				// Stopped because the user's own LIMIT was met, which is not truncation: they asked
				// for exactly this many. Anything further in the window is simply not requested.
				return { rows, complete: true, examined };
			}
			if (rows.length >= MAX_SCAN_ROWS || examined >= MAX_SCAN_EVENTS) {
				complete = false;
				break;
			}
		}
		return { rows, complete, examined };
	}

	async cancel(): Promise<void> {
		this.running?.abort();
		await this.session?.cancel?.();
	}

	private require(): TelemetrySession {
		if (!this.session) {
			throw new Error(`${this.id}: not connected`);
		}
		return this.session;
	}
}

/** The scope a query names, for an error message that can say which one failed. */
function scopeOf(query: NativeQuery): string | undefined {
	if (query.lang === 'logs') {
		return query.query.scope;
	}
	return query.lang === 'logs-native' ? query.scope : undefined;
}

/**
 * Prove a session works, by the cheapest call the credential is actually allowed to make.
 *
 * `verify()` lists one scope, which proves the credentials, the container AND the enumerate
 * permission in one call. That last one is the problem: enumerating is its own permission, and a
 * credential scoped to particular log groups is denied it while being perfectly able to read every
 * event the user wants. So a connection that NAMES its scopes is verified by reading one of them
 * instead, over a one-minute window with a limit of one: the same call every query makes, and the
 * only permission such a connection needs.
 */
async function verifySession(session: TelemetrySession, named: string[], signal?: AbortSignal): Promise<void> {
	if (named.length === 0) {
		await session.verify(signal);
		return;
	}
	const end = Date.now();
	const probe: LogsQuery = { scope: named[0], start: end - 60_000, end, limit: 1 };
	for await (const _event of session.scan(probe, { signal })) {
		break;
	}
}

/**
 * Record on the result WHEN was searched, whether the statement chose it, and whether a row is one
 * event or a group of them.
 *
 * Every telemetry query is bounded, so an empty result is only half an answer without the window:
 * "no rows" and "no rows in the last hour, which you did not ask for" are different facts, and the
 * second one is the true one nearly every time somebody thinks the feature is broken.
 *
 * `grouped` is what lets the results pane choose its instrument without guessing from column names:
 * the log READER is a stream of events, and a `GROUP BY` produces rows that are not events. Only the
 * thing that ran the query knows which it was. A NATIVE query is reported ungrouped because its
 * columns come back from the service and we did not compile it — a native `stats … by` therefore
 * relies on its own columns not looking like a log stream, which they do not.
 */
function stampWindow(result: QueryResult, start: number, end: number, windowFromSql: boolean, grouped: boolean, scope: string | undefined): QueryResult {
	return { ...result, cost: { ...(result.cost ?? {}), window: { start, end }, windowFromSql, grouped, ...(scope ? { scope } : {}) } };
}

/** The declared type of a fixed-contract column, so the grid formats a timestamp as one. */
function columnType(name: string): string {
	return name === LOG_FIELDS.ts || name === LOG_FIELDS.ingestedAt ? 'timestamp' : 'string';
}

/** One scope as a pseudo-table. */
function scopeTable(name: string, fields: string[], storedBytes?: number, retentionDays?: number): TableInfo {
	const columns: ColumnInfo[] = LOG_COLUMNS.map((column) => ({
		name: column,
		dataType: columnType(column),
		// Only the producer clock and the text are guaranteed: a provider with no streams reports no
		// stream, and one with no ingestion clock reports no ingestion time.
		nullable: column !== LOG_FIELDS.ts && column !== LOG_FIELDS.message,
		isPrimaryKey: false,
	}));
	for (const field of fields) {
		if (!columns.some((column) => column.name === field)) {
			// A parsed field is whatever the producer wrote it as and may be absent from any given
			// event, so it is always nullable and never typed beyond "something".
			columns.push({ name: field, dataType: 'json', nullable: true, isPrimaryKey: false });
		}
	}
	return {
		name,
		kind: 'logGroup',
		columns,
		// A log event has an id, but nothing references it and no two rows are addressed by it: a
		// declared key here would make the grid offer editing on something that cannot be edited.
		primaryKey: [],
		foreignKeys: [],
		...(storedBytes !== undefined || retentionDays !== undefined
			? { stats: { ...(storedBytes !== undefined ? { totalBytes: storedBytes } : {}) } }
			: {}),
		...(retentionDays !== undefined ? { comment: `Retained for ${retentionDays} days` } : {}),
	};
}

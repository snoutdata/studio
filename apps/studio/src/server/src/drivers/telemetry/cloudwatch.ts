/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Amazon CloudWatch Logs, as a CONNECTION: log groups are tables and SQL runs against them.
 *
 *  One of three plugins behind `telemetrySource.ts`. Nothing outside this
 *  file names AWS, a log group, an event id or Logs Insights.
 *
 *  THE TWO ENGINES, AND WHY THIS DRIVER HAS BOTH. The flow-side driver
 *  uses `FilterLogEvents` and never Insights: Insights is billed per GB SCANNED and a flow only moves events, so paying to aggregate
 *  at the source buys nothing. A connection is the other case. `SELECT ... LIMIT 100` is still a
 *  scan and still free, but `SELECT level, count(*) ... GROUP BY level` over a week cannot be
 *  answered by streaming a week of events to a laptop — that is what Insights is for, and it is
 *  worth its charge. So the ENGINE follows the QUERY: a scan goes to `FilterLogEvents`, a grouping
 *  goes to Insights, and the results footer says which ran and what it scanned so the bill is never
 *  a surprise.
 *
 *  INSIGHTS TAKES SECONDS, `FilterLogEvents` TAKES MILLISECONDS. Both windows are the same instant;
 *  only the unit differs. Getting that wrong is a query over 1970, which is why the conversion
 *  happens once, at the call, and never on the way in.
 *--------------------------------------------------------------------------------------------*/

import type {
	CloudWatchLogsClient,
	FilterLogEventsCommandOutput,
	GetQueryResultsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';

import { awsCredentialsFor } from './awsAuth';
import type {
	TelemetryAggregateResult,
	TelemetryDriverPlugin,
	TelemetryEvent,
	TelemetryScanOptions,
	TelemetrySession,
	TelemetryWindow,
} from './telemetrySource';
import { LOG_FIELDS, type LogAgg, type LogPredicate, type LogsQuery } from '../../../../shared/engine';
import { TELEMETRY_SERVICES } from '../../../../shared/cloud';
import type { CloudAccount, LogScope } from '../../../../shared/cloud';

/** The SDK, required the first time somebody actually queries CloudWatch — the server child must
 *  not pay for it at load time. Same rule as the Azure/GCS flow drivers state at length. */
function sdk(): typeof import('@aws-sdk/client-cloudwatch-logs') {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('@aws-sdk/client-cloudwatch-logs') as typeof import('@aws-sdk/client-cloudwatch-logs');
}

/** Events one `FilterLogEvents` page asks for. The API's own ceiling is 10,000 (and 1 MB a page). */
const PAGE_SIZE = 10_000;
/** Log groups one `DescribeLogGroups` page asks for. The API's ceiling is 50. */
const GROUP_PAGE = 50;
/** Groups the explorer will enumerate before it stops — an account with more than this has a naming
 *  problem the explorer cannot solve, and enumerating forever is worse than saying "the first 1,000". */
const MAX_GROUPS = 1000;
/** How often a running Insights query is asked whether it has finished. A second is what the
 *  console itself uses; anything tighter is throttle pressure for no benefit. */
const POLL_MS = 1000;
/** How long an Insights query is waited on before it is stopped and reported as timed out. */
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;


const INFO = TELEMETRY_SERVICES.cloudwatch;

export function createCloudWatchTelemetryPlugin(): TelemetryDriverPlugin {
	return {
		info: INFO,
		open: (account, secret, container) => new CloudWatchTelemetrySession(account, secret, container),
		explain: explainCloudWatch,
	};
}

class CloudWatchTelemetrySession implements TelemetrySession {
	private client?: CloudWatchLogsClient;
	/** The Insights query in flight, so `cancel` can StopQuery it rather than only abort the socket
	 *  — an abandoned Insights query keeps scanning, and keeps charging, until it finishes. */
	private runningQueryId?: string;

	constructor(
		private readonly account: CloudAccount,
		private readonly secret: string | undefined,
		private readonly region: string,
	) {}

	private get logs(): CloudWatchLogsClient {
		if (!this.client) {
			const { CloudWatchLogsClient } = sdk();
			this.client = new CloudWatchLogsClient({
				region: this.region || this.account.region || 'us-east-1',
				...awsCredentialsFor(this.account, this.secret),
				...(this.account.endpoint ? { endpoint: this.account.endpoint } : {}),
			});
		}
		return this.client;
	}

	async verify(signal?: AbortSignal): Promise<void> {
		// One page of one group: the cheapest call that proves the credentials, the region and the
		// `logs:DescribeLogGroups` permission all at once. An EMPTY account is a valid answer.
		const { DescribeLogGroupsCommand } = sdk();
		await this.logs.send(new DescribeLogGroupsCommand({ limit: 1 }), { abortSignal: signal });
	}

	async verifyAccount(signal?: AbortSignal): Promise<void> {
		// The same call: a region is only a default here (the account's, else us-east-1), and listing
		// log groups is the one thing these credentials are for in a build without the flow drivers.
		await this.verify(signal);
	}

	async listScopes(signal?: AbortSignal): Promise<LogScope[]> {
		const { DescribeLogGroupsCommand } = sdk();
		const scopes: LogScope[] = [];
		let token: string | undefined;
		do {
			const page = await this.logs.send(
				new DescribeLogGroupsCommand({ limit: GROUP_PAGE, nextToken: token }),
				{ abortSignal: signal },
			);
			for (const group of page.logGroups ?? []) {
				if (group.logGroupName) {
					scopes.push({ name: group.logGroupName, storedBytes: group.storedBytes, retentionDays: group.retentionInDays });
				}
			}
			token = page.nextToken;
		} while (token && scopes.length < MAX_GROUPS);
		return scopes.slice(0, MAX_GROUPS);
	}

	/**
	 * The parsed fields CloudWatch has seen in this group recently.
	 *
	 * `GetLogGroupFields` is the cheap, un-billed discovery call — it reads an index rather than
	 * scanning, which is exactly why introspection uses it and not a sampling Insights query. It is
	 * also allowed to fail (a group with no structured events has nothing to report), and a failure
	 * here must not fail introspection: a scope with no discovered columns is still queryable
	 * through the fixed contract.
	 */
	async discoverFields(scope: string, window: TelemetryWindow, signal?: AbortSignal): Promise<string[]> {
		try {
			const { GetLogGroupFieldsCommand } = sdk();
			const result = await this.logs.send(
				new GetLogGroupFieldsCommand({ logGroupName: scope, time: Math.floor(window.start / 1000) }),
				{ abortSignal: signal },
			);
			return (result.logGroupFields ?? [])
				.map((field) => field.name ?? '')
				// The `@`-prefixed names are CloudWatch's own built-ins, which the fixed contract
				// already exposes under our names. Listing both would show every scope twice.
				.filter((name) => name && !name.startsWith('@'));
		} catch {
			return [];
		}
	}

	async *scan(query: LogsQuery, options: TelemetryScanOptions = {}): AsyncIterable<TelemetryEvent> {
		const { FilterLogEventsCommand } = sdk();
		const pattern = filterPatternFor(query.where);
		let token: string | undefined;
		let produced = 0;
		for (;;) {
			const page: FilterLogEventsCommandOutput = await this.logs.send(
				new FilterLogEventsCommand({
					logGroupName: query.scope,
					// Inclusive start, exclusive end — the API's own semantics, which is why
					// `LogsQuery`'s window is defined the same way rather than the other way round.
					startTime: query.start,
					endTime: query.end,
					logStreamNamePrefix: query.streamPrefix || undefined,
					filterPattern: pattern,
					limit: PAGE_SIZE,
					nextToken: token,
				}),
				{ abortSignal: options.signal },
			);
			for (const event of page.events ?? []) {
				if (typeof event.timestamp !== 'number' || typeof event.message !== 'string') {
					// An event with no timestamp cannot be placed in the window. Dropping it is the
					// only answer that does not corrupt the ordering the seam promises.
					continue;
				}
				yield {
					id: event.eventId ?? `${event.logStreamName ?? ''}:${event.timestamp}:${produced}`,
					at: event.timestamp,
					ingestedAt: event.ingestionTime,
					stream: event.logStreamName,
					message: event.message,
				};
				produced += 1;
			}
			options.onProgress?.(produced);
			token = page.nextToken;
			if (!token) {
				return;
			}
		}
	}

	/**
	 * Group at the source with Logs Insights: StartQuery, poll, read the results.
	 *
	 * This is the BILLED path (per GB scanned), which is why it runs only for a query that needs it
	 * and why the statistics come back on the result for the footer to show.
	 */
	async aggregate(query: LogsQuery, options: TelemetryScanOptions = {}): Promise<TelemetryAggregateResult> {
		return await this.runInsights(insightsQuery(query), query.scope, query, query.limit, options, aliasNames(query.aggregate ?? { by: [], aggs: [] }));
	}

	/**
	 * StartQuery, poll, read the results — the BILLED path (per GB scanned).
	 *
	 * Shared by `aggregate` and `runNative` so a compiled grouping and a hand-written Insights query
	 * are run, polled, timed out and cancelled by exactly one piece of code.
	 */
	private async runInsights(
		queryString: string,
		scope: string,
		window: TelemetryWindow,
		limit: number | undefined,
		options: TelemetryScanOptions,
		columns?: string[],
	): Promise<TelemetryAggregateResult> {
		const { StartQueryCommand, GetQueryResultsCommand } = sdk();
		const started = await this.logs.send(
			new StartQueryCommand({
				logGroupNames: [scope],
				// SECONDS here, milliseconds on FilterLogEvents. One conversion, at the call.
				startTime: Math.floor(window.start / 1000),
				endTime: Math.ceil(window.end / 1000),
				queryString,
				limit: limit ?? 1000,
			}),
			{ abortSignal: options.signal },
		);
		const queryId = started.queryId;
		if (!queryId) {
			throw new Error('CloudWatch did not return a query id.');
		}
		this.runningQueryId = queryId;
		try {
			const deadline = Date.now() + QUERY_TIMEOUT_MS;
			for (;;) {
				await delay(POLL_MS, options.signal);
				const result: GetQueryResultsCommandOutput = await this.logs.send(
					new GetQueryResultsCommand({ queryId }),
					{ abortSignal: options.signal },
				);
				const status = result.status ?? 'Running';
				if (status === 'Complete') {
					return readInsightsResult(result, columns);
				}
				if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
					throw new Error(`The CloudWatch Logs Insights query ${status.toLowerCase()}.`);
				}
				if (Date.now() > deadline) {
					await this.cancel();
					throw new Error('The CloudWatch Logs Insights query did not finish in five minutes. Narrow the time range.');
				}
			}
		} finally {
			this.runningQueryId = undefined;
		}
	}

	/** A Logs Insights query the user wrote, run untouched over the window. The same billed engine
	 *  `aggregate` uses, so the same statistics come back for the footer. */
	async runNative(text: string, window: TelemetryWindow, scope: string | undefined, options: TelemetryScanOptions = {}): Promise<TelemetryAggregateResult> {
		if (!scope) {
			throw new Error('A CloudWatch Logs Insights query needs a log group. Pick one in the explorer, or use SQL with a FROM clause.');
		}
		return await this.runInsights(text, scope, window, undefined, options);
	}

	/** Stop the Insights query rather than merely abandoning it: an abandoned query keeps scanning,
	 *  and keeps billing, until it finishes on its own. */
	async cancel(): Promise<void> {
		const queryId = this.runningQueryId;
		if (!queryId) {
			return;
		}
		this.runningQueryId = undefined;
		try {
			const { StopQueryCommand } = sdk();
			await this.logs.send(new StopQueryCommand({ queryId }));
		} catch {
			// A query that already finished cannot be stopped, and saying so helps nobody.
		}
	}

	close(): void {
		this.client?.destroy();
		this.client = undefined;
	}
}

/** Await `ms`, rejecting early if the caller aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('Query cancelled.'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			reject(new Error('Query cancelled.'));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * What of a WHERE can be pushed into a `FilterLogEvents` pattern.
 *
 * Deliberately almost nothing, and that is a correctness decision rather than a lazy one. A
 * CloudWatch filter pattern has two mutually exclusive grammars (a text-term pattern and a JSON
 * `{ $.a = "b" }` pattern), neither is regex, and getting one subtly wrong silently returns FEWER
 * events rather than erroring. The executor re-applies every predicate over the rows anyway, so a
 * pattern is a pure transfer-size optimisation — worth taking when it is unambiguous, never worth
 * guessing at.
 *
 * So: one predicate, a `LIKE '%literal%'` on the message with no other wildcard, becomes the quoted
 * term that means "contains this". Everything else is filtered locally.
 */
export function filterPatternFor(predicates: readonly LogPredicate[] | undefined): string | undefined {
	if (!predicates || predicates.length !== 1) {
		return undefined;
	}
	const [only] = predicates;
	if (only.op !== 'like' || only.caseInsensitive) {
		return undefined;
	}
	if (only.field !== LOG_FIELDS.message) {
		return undefined;
	}
	const match = /^%([^%_]+)%$/.exec(only.pattern);
	if (!match) {
		return undefined;
	}
	// A term containing a quote or a backslash would need escaping rules this does not model.
	if (/["\\]/.test(match[1])) {
		return undefined;
	}
	return `"${match[1]}"`;
}

/** The canonical contract's columns, in Logs Insights' own spelling. */
const INSIGHTS_FIELDS: Readonly<Record<string, string>> = {
	[LOG_FIELDS.ts]: '@timestamp',
	[LOG_FIELDS.message]: '@message',
	[LOG_FIELDS.stream]: '@logStream',
	[LOG_FIELDS.id]: '@ptr',
	[LOG_FIELDS.ingestedAt]: '@ingestionTime',
};

/** A field reference in Insights. A parsed field with a dot in it must be backticked, or the dot is
 *  read as a path separator into something that is not there. */
function insightsField(field: string): string {
	const builtIn = INSIGHTS_FIELDS[field];
	if (builtIn) {
		return builtIn;
	}
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : `\`${field}\``;
}

/** Build the Logs Insights query text for a grouped {@link LogsQuery}. Exported for its unit test:
 *  this string is the whole of what AWS is asked to do, and it is worth pinning exactly. */
export function insightsQuery(query: LogsQuery): string {
	const lines: string[] = [];
	const filters = (query.where ?? []).map(insightsPredicate).filter((text): text is string => !!text);
	for (const filter of filters) {
		lines.push(`filter ${filter}`);
	}
	if (query.aggregate) {
		const aggs = query.aggregate.aggs.map(insightsAgg).join(', ');
		const by = query.aggregate.by.length ? ` by ${query.aggregate.by.map(insightsField).join(', ')}` : '';
		lines.push(`stats ${aggs}${by}`);
	} else {
		lines.push(`fields ${(query.select?.length ? query.select : Object.keys(INSIGHTS_FIELDS)).map(insightsField).join(', ')}`);
	}
	for (const order of query.orderBy ?? []) {
		// After a `stats`, the sortable names are the aggregate ALIASES, which are already plain
		// identifiers — so only a pre-stats sort needs the field spelling.
		const name = query.aggregate && aliasNames(query.aggregate).includes(order.field) ? order.field : insightsField(order.field);
		lines.push(`sort ${name} ${order.desc ? 'desc' : 'asc'}`);
	}
	if (query.limit !== undefined) {
		lines.push(`limit ${query.limit}`);
	}
	return lines.join(' | ');
}

function aliasNames(aggregate: NonNullable<LogsQuery['aggregate']>): string[] {
	return [...aggregate.by, ...aggregate.aggs.map((agg) => agg.as)];
}

function insightsAgg(agg: LogAgg): string {
	if (agg.fn === 'count' && !agg.field) {
		return `count(*) as ${agg.as}`;
	}
	const field = insightsField(agg.field ?? '');
	// Insights spells "how many distinct" as its own function rather than as a modifier.
	const call = agg.fn === 'count' && agg.distinct ? `count_distinct(${field})` : `${agg.fn}(${field})`;
	return `${call} as ${agg.as}`;
}

/** One predicate in Insights' filter syntax, or undefined when it has no faithful form (in which
 *  case the aggregate would be computed over more rows than asked for — so a predicate that cannot
 *  be expressed makes the whole query ineligible, see {@link insightsSupports}). */
function insightsPredicate(predicate: LogPredicate): string | undefined {
	const field = insightsField(predicate.field);
	switch (predicate.op) {
		case 'is null':
			return `not ispresent(${field})`;
		case 'is not null':
			return `ispresent(${field})`;
		case 'like':
		case 'not like': {
			const regex = likeToInsightsRegex(predicate.pattern);
			const test = `${field} like /${regex}/`;
			return predicate.op === 'like' ? test : `not (${test})`;
		}
		case 'in':
		case 'not in': {
			const list = predicate.values.map(insightsLiteral).join(', ');
			return predicate.op === 'in' ? `${field} in [${list}]` : `not (${field} in [${list}])`;
		}
		default:
			return `${field} ${predicate.op} ${insightsLiteral(predicate.value)}`;
	}
}

/** True when every predicate of a query has a faithful Insights form — the gate on using the
 *  source-side engine at all, since an aggregate over a filter we could not express would be a
 *  confidently wrong number. */
export function insightsSupports(query: LogsQuery): boolean {
	return (query.where ?? []).every((predicate) => insightsPredicate(predicate) !== undefined);
}

/** A SQL LIKE pattern as an UNANCHORED Insights regex. Insights' `like /re/` searches rather than
 *  matches, so the SQL anchors are added explicitly and `%` at either end removes them. */
function likeToInsightsRegex(pattern: string): string {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	const body = escaped.replace(/%/g, '.*').replace(/_/g, '.');
	return `^${body}$`;
}

function insightsLiteral(value: unknown): string {
	if (value === null || value === undefined) {
		return '""';
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * An Insights result (a list of field/value pairs per row) → the columns and rows the grid wants.
 *
 * `columns` is the order the query ASKED for, which is the order the grid must show; a hand-written
 * native query has no such list, so the field names of the first row stand in — that is the only
 * ordering AWS itself offers, and inventing one would reorder the user's own `fields` clause.
 */
function readInsightsResult(result: GetQueryResultsCommandOutput, columns?: string[]): TelemetryAggregateResult {
	const rowsIn = result.results ?? [];
	const resolved = columns?.length
		? columns
		: [...new Set(rowsIn.flatMap((entry) => entry.map((cell) => cell.field ?? '').filter(Boolean)))]
			// `@ptr` is Insights' internal row pointer, present on every `fields` query and meaningless
			// in a grid. It is dropped unless the user named it.
			.filter((name) => name !== '@ptr');
	const rows = rowsIn.map((entry) => {
		const byName = new Map<string, string>();
		for (const cell of entry) {
			if (cell.field) {
				byName.set(cell.field, cell.value ?? '');
			}
		}
		return resolved.map((column) => coerceInsightsValue(byName.get(column) ?? byName.get(insightsField(column))));
	});
	return {
		columns: resolved,
		rows,
		cost: {
			engine: 'CloudWatch Logs Insights',
			bytesScanned: result.statistics?.bytesScanned,
			recordsScanned: result.statistics?.recordsScanned,
			recordsMatched: result.statistics?.recordsMatched,
		},
	};
}

/** Insights answers in strings. A numeric-looking one becomes a number so the grid right-aligns it
 *  and a chart can plot it; anything else stays text. */
function coerceInsightsValue(value: string | undefined): unknown {
	if (value === undefined) {
		return null;
	}
	if (value !== '' && !Number.isNaN(Number(value))) {
		return Number(value);
	}
	return value;
}

/**
 * A CloudWatch failure as a sentence that names the fix.
 *
 * The connection-side twin of `explainCloudWatchLogs` in the flow driver. Separate on purpose: the
 * permissions a connection needs are not the ones a flow needs (`StartQuery` and
 * `GetLogGroupFields` appear here and nowhere there), and sending somebody to check the wrong
 * permission is worse than saying nothing.
 */
export function explainCloudWatch(err: unknown, account: CloudAccount, scope?: string): string {
	const name = (err as { name?: string })?.name ?? '';
	const message = err instanceof Error ? err.message : String(err);
	const named = scope ? `"${scope}"` : 'that log group';

	if (/ResourceNotFound/i.test(name)) {
		return `There is no log group called ${named} in this region. Log groups are per region, so check the region as well as the name.`;
	}
	if (/MalformedQueryException|InvalidParameter/i.test(name)) {
		return `CloudWatch rejected this query: ${message}`;
	}
	if (/LimitExceeded/i.test(name)) {
		return 'This account already has as many Logs Insights queries running as CloudWatch allows. Wait for one to finish, or narrow the time range so this one is cheaper.';
	}
	if (/Throttling|TooManyRequests/i.test(name)) {
		return 'CloudWatch is rate-limiting these requests. A narrower time range, or fewer queries at once, will settle it.';
	}
	if (/InvalidAccessKeyId|SignatureDoesNotMatch|UnrecognizedClientException/i.test(name)) {
		return 'AWS did not accept those credentials. Check the access key and its secret on the cloud account this connection uses.';
	}
	if (/ExpiredToken/i.test(name)) {
		return account.auth.mode === 'named'
			? `The credentials for "${account.auth.name}" have expired. Run "aws sso login --profile ${account.auth.name}" and reconnect.`
			: 'Those credentials have expired. Sign in again, or refresh the profile they came from, and reconnect.';
	}
	if (/CredentialsProviderError|CredentialsError/i.test(name)) {
		return account.auth.mode === 'named'
			? `No credentials were found for the profile "${account.auth.name}". Check it still exists in your AWS config, and that any SSO session it needs is signed in.`
			: 'No AWS credentials were found. Add an access key to the cloud account, import a profile, or sign in so the default chain can find one.';
	}
	if (/AccessDenied|Forbidden/i.test(name)) {
		return scope
			? `Those credentials cannot read ${named}. A scan needs logs:FilterLogEvents; a GROUP BY also needs logs:StartQuery and logs:GetQueryResults.`
			: 'Those credentials cannot list log groups. They need logs:DescribeLogGroups.';
	}
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
		return 'CloudWatch could not be reached. Check your network.';
	}
	if (/ETIMEDOUT|TimeoutError|aborted due to timeout/i.test(message)) {
		return 'CloudWatch did not answer in time. Check your network, and any proxy or firewall in front of it.';
	}
	return message;
}

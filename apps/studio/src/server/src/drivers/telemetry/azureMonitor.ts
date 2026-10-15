/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Azure Monitor Logs (Log Analytics), as a CONNECTION: a workspace's tables are tables and SQL
 *  runs against them.
 *
 *  One of three plugins behind `telemetrySource.ts`. Nothing outside this
 *  file names Azure, a workspace, KQL or `TimeGenerated`.
 *
 *  THREE THINGS DIFFER FROM CLOUDWATCH, AND EACH IS REAL RATHER THAN COSMETIC.
 *
 *  1. **There is one engine, not two.** Log Analytics answers everything in KQL through one
 *     endpoint, and it is not billed per query — the charge is on ingestion and retention. So
 *     `aggregate` is implemented, a `GROUP BY` costs no more than a scan, and there is no cheap
 *     path to prefer. `insightsSupports`'s whole class of worry does not exist here.
 *  2. **The columns are REAL.** A workspace publishes each table's schema, so `discoverFields` is a
 *     metadata read rather than a sampling heuristic, and it is exact. That is the one place this
 *     provider is richer than the other two.
 *  3. **There is no `message` column.** A CloudWatch event is a line of text; a Log Analytics row is
 *     a record with named, typed columns and no canonical text field. So a row's OTHER columns are
 *     serialised into the contract's `message` as JSON, which `logRowOf` parses straight back out
 *     into fields — the row survives intact, `SELECT message` shows the record, and
 *     `WHERE severity = 'Error'` addresses a real column. Inventing a "primary text column" per
 *     table would have been a guess that is wrong on every custom table.
 *
 *  AUTHENTICATION IS AAD, WHICH IS WHY `key` NEEDS A TENANT. Azure has no shared credentials file,
 *  so the reference mode is `@azure/identity`'s own `AzureCliCredential` — the SDK invoking
 *  `az account get-access-token` itself, which is the one sanctioned exception
 *  to "never shell out to a cloud CLI". A service principal (`key` mode: client id + secret) also
 *  needs the tenant it belongs to, and an account without one is told so rather than failing inside
 *  the SDK with a message about a discovery endpoint.
 *--------------------------------------------------------------------------------------------*/

import type { AccessToken, TokenCredential } from '@azure/identity';

import type {
	TelemetryAggregateResult,
	TelemetryDriverPlugin,
	TelemetryEvent,
	TelemetryScanOptions,
	TelemetrySession,
	TelemetryWindow,
} from './telemetrySource';
import { canonicalLogField, LOG_FIELDS, type LogAgg, type LogPredicate, type LogsQuery } from '../../../../shared/engine';
import { TELEMETRY_SERVICES } from '../../../../shared/cloud';
import type { CloudAccount, LogScope } from '../../../../shared/cloud';

/** The SDK, required lazily — the server child must not pay for it at load time. */
function identity(): typeof import('@azure/identity') {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('@azure/identity') as typeof import('@azure/identity');
}

/** The Log Analytics query API. Reached with `fetch` rather than `@azure/monitor-query`: two calls
 *  (query and metadata) do not justify another SDK in the bundle, and the REST contract is stable
 *  and documented. */
const API = 'https://api.loganalytics.io/v1';
/** The AAD scope a Log Analytics token is minted for. */
const TOKEN_SCOPE = 'https://api.loganalytics.io/.default';
/** Rows one query asks for when the caller named no cap. The service's own ceiling is 500,000. */
const DEFAULT_TAKE = 10_000;

/** Azure's own bookkeeping columns, which are noise in a log row: they are dropped from the
 *  serialised record so a `SELECT *` shows the event and not the plumbing. */
const INTERNAL_COLUMNS = new Set(['TenantId', 'SourceSystem', 'MG', 'ManagementGroupName', 'Type', '_ResourceId', '_SubscriptionId']);

const INFO = TELEMETRY_SERVICES.azureMonitor;

export function createAzureMonitorPlugin(): TelemetryDriverPlugin {
	return {
		info: INFO,
		open: (account, secret, container) => new AzureMonitorSession(account, secret, container),
		explain: explainAzureMonitor,
	};
}

class AzureMonitorSession implements TelemetrySession {
	private credential?: TokenCredential;
	private token?: AccessToken;
	/** The workspace's table list, fetched once per session: introspection asks for every scope's
	 *  columns in turn, and each of those would otherwise be the same whole-workspace metadata read. */
	private metadata?: Promise<AzureMetadata>;

	constructor(
		private readonly account: CloudAccount,
		private readonly secret: string | undefined,
		private readonly workspace: string,
	) {}

	/**
	 * The credential, chosen from the account's auth mode.
	 *
	 * `named` maps to `AzureCliCredential` rather than to a stored profile because Azure has no
	 * shared credentials file to name — what "the credential this computer already has" means on
	 * Azure is the `az` session, and the SDK reaches it itself.
	 */
	private get identityCredential(): TokenCredential {
		if (this.credential) {
			return this.credential;
		}
		const { ClientSecretCredential, AzureCliCredential, DefaultAzureCredential } = identity();
		switch (this.account.auth.mode) {
			case 'key': {
				const tenantId = this.account.tenantId;
				if (!tenantId) {
					throw new Error('This Azure account signs in with a client id and secret, which also needs the directory (tenant) ID. Add it to the cloud account in Settings.');
				}
				if (!this.secret) {
					throw new Error('This Azure account has no client secret stored. Re-enter it on the cloud account in Settings.');
				}
				this.credential = new ClientSecretCredential(tenantId, this.account.auth.keyId, this.secret);
				break;
			}
			case 'named':
				this.credential = new AzureCliCredential(this.account.tenantId ? { tenantId: this.account.tenantId } : undefined);
				break;
			case 'document':
				throw new Error('A credential file is not a way to sign in to Azure Monitor. Use a client id and secret, or sign in with the Azure CLI.');
			default:
				this.credential = new DefaultAzureCredential();
		}
		return this.credential;
	}

	async verifyAccount(signal?: AbortSignal): Promise<void> {
		// A token is the whole of signing in; the workspace is chosen later, on the connection.
		await this.bearer(signal);
	}

	/** A bearer token, reused until a minute before it expires — minting one per request is a
	 *  round-trip per query for no benefit, and the SDK caches nothing across credential instances. */
	private async bearer(signal?: AbortSignal): Promise<string> {
		const now = Date.now();
		if (this.token && this.token.expiresOnTimestamp - 60_000 > now) {
			return this.token.token;
		}
		const token = await this.identityCredential.getToken(TOKEN_SCOPE, { abortSignal: signal });
		if (!token) {
			throw new Error('Azure did not issue a token for Log Analytics.');
		}
		this.token = token;
		return token.token;
	}

	private async call<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${API}/workspaces/${encodeURIComponent(this.workspace)}${path}`, {
			...init,
			headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await this.bearer(signal)}`, 'Content-Type': 'application/json' },
			signal,
		});
		if (!response.ok) {
			// The service reports its own reason in a JSON envelope; surfacing that beats "HTTP 400".
			const body = await response.text().catch(() => '');
			throw new AzureApiError(response.status, azureReason(body) || body || response.statusText);
		}
		return (await response.json()) as T;
	}

	/** The workspace's published schema, fetched at most once per session. A failure is not cached:
	 *  an expired token or a blip must not make every later call fail for the session's lifetime. */
	private workspaceMetadata(signal?: AbortSignal): Promise<AzureMetadata> {
		if (!this.metadata) {
			this.metadata = this.call<AzureMetadata>('/metadata', { method: 'GET' }, signal).catch((err) => {
				this.metadata = undefined;
				throw err;
			});
		}
		return this.metadata;
	}

	async verify(signal?: AbortSignal): Promise<void> {
		// The cheapest call that proves the token, the workspace id and the read permission at once.
		await this.workspaceMetadata(signal);
	}

	async listScopes(signal?: AbortSignal): Promise<LogScope[]> {
		const metadata = await this.workspaceMetadata(signal);
		return (metadata.tables ?? [])
			.filter((table) => !!table.name)
			.map((table) => ({ name: table.name }));
	}

	/** The table's declared columns — exact, because the workspace publishes them. Azure's own
	 *  bookkeeping columns are left out for the reason {@link INTERNAL_COLUMNS} states. */
	async discoverFields(scope: string, _window: TelemetryWindow, signal?: AbortSignal): Promise<string[]> {
		try {
			const metadata = await this.workspaceMetadata(signal);
			const table = (metadata.tables ?? []).find((entry) => entry.name === scope);
			return (table?.columns ?? [])
				.map((column) => column.name)
				.filter((name) => !!name && name !== 'TimeGenerated' && !INTERNAL_COLUMNS.has(name));
		} catch {
			return [];
		}
	}

	async *scan(query: LogsQuery, options: TelemetryScanOptions = {}): AsyncIterable<TelemetryEvent> {
		const kql = [
			kqlSource(query),
			// Oldest first, which the seam requires: the executor's cap and any cursor depend on it.
			'| order by TimeGenerated asc',
			`| take ${query.limit ?? DEFAULT_TAKE}`,
		].join(' ');
		const table = await this.runKql(kql, options.signal);
		let produced = 0;
		for (const row of table.rows ?? []) {
			const record = zip(table.columns ?? [], row);
			const at = Date.parse(String(record.TimeGenerated ?? ''));
			if (Number.isNaN(at)) {
				// A row that cannot be placed in the window would break the ordering contract.
				continue;
			}
			yield {
				// `_ItemId` is present on most tables and stable; where it is not, the timestamp and
				// the position within this read are the best stable-enough identity available.
				id: String(record._ItemId ?? `${at}:${produced}`),
				at,
				stream: typeof record.Computer === 'string' ? record.Computer : undefined,
				message: serialiseRecord(record),
			};
			produced += 1;
		}
		options.onProgress?.(produced);
	}

	async aggregate(query: LogsQuery, options: TelemetryScanOptions = {}): Promise<TelemetryAggregateResult> {
		const aggregate = query.aggregate;
		if (!aggregate) {
			throw new Error('aggregate() was called without a GROUP BY.');
		}
		const summarize = `| summarize ${aggregate.aggs.map(kqlAgg).join(', ')}${aggregate.by.length ? ` by ${aggregate.by.map(kqlColumn).join(', ')}` : ''}`;
		const order = (query.orderBy ?? []).map((entry) => `${kqlColumn(entry.field)} ${entry.desc ? 'desc' : 'asc'}`);
		const kql = [
			kqlSource(query),
			summarize,
			order.length ? `| order by ${order.join(', ')}` : '',
			query.limit !== undefined ? `| take ${query.limit}` : '',
		].filter(Boolean).join(' ');
		const table = await this.runKql(kql, options.signal);
		const columns = (table.columns ?? []).map((column) => column.name);
		return {
			columns,
			rows: (table.rows ?? []).map((row) => [...row]),
			cost: { engine: 'Azure Monitor (KQL)' },
		};
	}

	/** A KQL query the user wrote, run untouched. The window is applied as a leading `where` rather
	 *  than as the API's `timespan`, so a query that already narrows further still works and one
	 *  that does not is still bounded. */
	async runNative(text: string, window: TelemetryWindow, _scope: string | undefined, options: TelemetryScanOptions = {}): Promise<TelemetryAggregateResult> {
		const bounded = [
			text.trim(),
			`| where TimeGenerated >= datetime(${new Date(window.start).toISOString()}) and TimeGenerated < datetime(${new Date(window.end).toISOString()})`,
		].join(' ');
		const table = await this.runKql(bounded, options.signal);
		return {
			columns: (table.columns ?? []).map((column) => column.name),
			rows: (table.rows ?? []).map((row) => [...row]),
			cost: { engine: 'Azure Monitor (KQL)' },
		};
	}

	private async runKql(query: string, signal?: AbortSignal): Promise<AzureTable> {
		const result = await this.call<AzureQueryResponse>('/query', { method: 'POST', body: JSON.stringify({ query }) }, signal);
		const [table] = result.tables ?? [];
		if (!table) {
			throw new Error('Azure Monitor returned no table.');
		}
		return table;
	}

	close(): void {
		this.credential = undefined;
		this.token = undefined;
	}
}

interface AzureColumn { name: string; type?: string }
interface AzureTable { name?: string; columns?: AzureColumn[]; rows?: unknown[][] }
interface AzureQueryResponse { tables?: AzureTable[] }
interface AzureMetadata { tables?: { name: string; columns?: AzureColumn[] }[] }

class AzureApiError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = 'AzureApiError';
	}
}

/** The `error.message` out of Azure's error envelope, when the body is one. */
function azureReason(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; innererror?: { message?: string } } };
		return parsed.error?.innererror?.message ?? parsed.error?.message;
	} catch {
		return undefined;
	}
}

/** Columns and a row → a record. */
function zip(columns: AzureColumn[], row: unknown[]): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	columns.forEach((column, index) => {
		record[column.name] = row[index];
	});
	return record;
}

/** A row minus its timestamp and Azure's bookkeeping, as the JSON that becomes the event's
 *  `message` — and, through `logRowOf`, its parsed fields. */
function serialiseRecord(record: Record<string, unknown>): string {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === 'TimeGenerated' || INTERNAL_COLUMNS.has(key) || value === null || value === undefined) {
			continue;
		}
		out[key] = value;
	}
	return JSON.stringify(out);
}

/** The table, the window and the WHERE, as the head of a KQL pipeline. Shared by both engines so a
 *  scan and an aggregate can never disagree about what they are reading. */
export function kqlSource(query: LogsQuery): string {
	const parts = [
		kqlTable(query.scope),
		// Half-open, matching `LogsQuery` — `>=` and `<`, never `between`, which is inclusive at both.
		`| where TimeGenerated >= datetime(${new Date(query.start).toISOString()}) and TimeGenerated < datetime(${new Date(query.end).toISOString()})`,
	];
	for (const predicate of query.where ?? []) {
		parts.push(`| where ${kqlPredicate(predicate)}`);
	}
	return parts.join(' ');
}

/** A table name. Bracket-quoted unless it is a plain identifier, so a custom table with an odd
 *  name (`My-Table_CL`) does not become a parse error. */
function kqlTable(name: string): string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : kqlBracket(name);
}

/** `['name']`, KQL's quoted identifier. Its body is a single-quoted string literal, where `\` is the
 *  escape character, so a backslash is escaped as well as a quote (and first): a name ending in `\`
 *  must not escape the closing quote and let the rest of the name run on as KQL. */
export function kqlBracket(name: string): string {
	return `['${name.replace(/[\\']/g, '\\$&')}']`;
}

/** The contract's columns in Log Analytics' spelling. Everything else is a real column of the
 *  table and passes through under its own name. */
const KQL_COLUMNS: Readonly<Record<string, string>> = {
	[LOG_FIELDS.ts]: 'TimeGenerated',
	[LOG_FIELDS.stream]: 'Computer',
	[LOG_FIELDS.id]: '_ItemId',
};

function kqlColumn(field: string): string {
	const canonical = canonicalLogField(field);
	const mapped = KQL_COLUMNS[canonical];
	if (mapped) {
		return mapped;
	}
	// `message` has no Log Analytics equivalent — the whole record IS the message here — so a
	// predicate on it searches every column, which is what a user typing `message like '%x%'`
	// means on a provider with no message column.
	if (canonical === LOG_FIELDS.message) {
		return '*';
	}
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : kqlBracket(field);
}

function kqlPredicate(predicate: LogPredicate): string {
	const column = kqlColumn(predicate.field);
	const wholeRow = column === '*';
	switch (predicate.op) {
		case 'is null':
			return wholeRow ? 'false' : `isnull(${column})`;
		case 'is not null':
			return wholeRow ? 'true' : `isnotnull(${column})`;
		case 'like':
		case 'not like': {
			// KQL has no LIKE. A `%term%` pattern is a `contains`, which is what almost every log
			// filter is; anything else becomes a regex so the SQL semantics survive intact.
			const inner = /^%([^%_]*)%$/.exec(predicate.pattern);
			const test = inner
				? `${wholeRow ? '*' : column} ${predicate.caseInsensitive ? 'contains' : 'contains_cs'} ${kqlLiteral(inner[1])}`
				: `${wholeRow ? 'tostring(pack_all())' : column} matches regex ${kqlLiteral(likeToKqlRegex(predicate.pattern, predicate.caseInsensitive))}`;
			return predicate.op === 'like' ? test : `not (${test})`;
		}
		case 'in':
		case 'not in': {
			const list = predicate.values.map(kqlLiteral).join(', ');
			const test = `${wholeRow ? 'tostring(pack_all())' : column} in (${list})`;
			return predicate.op === 'in' ? test : `not (${test})`;
		}
		default: {
			const target = wholeRow ? 'tostring(pack_all())' : column;
			return `${target} ${predicate.op === '!=' ? '!=' : predicate.op} ${kqlLiteral(predicate.value)}`;
		}
	}
}

function likeToKqlRegex(pattern: string, caseInsensitive?: boolean): string {
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return `${caseInsensitive ? '(?i)' : ''}^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`;
}

function kqlLiteral(value: unknown): string {
	if (value === null || value === undefined) {
		return '""';
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

function kqlAgg(agg: LogAgg): string {
	if (agg.fn === 'count' && !agg.field) {
		return `${agg.as} = count()`;
	}
	const column = kqlColumn(agg.field ?? '');
	const call = agg.fn === 'count'
		? (agg.distinct ? `dcount(${column})` : `count(${column})`)
		: `${agg.fn}(${column})`;
	return `${agg.as} = ${call}`;
}

/** An Azure Monitor failure as a sentence that names the fix. */
export function explainAzureMonitor(err: unknown, account: CloudAccount, scope?: string): string {
	const message = err instanceof Error ? err.message : String(err);
	const status = err instanceof AzureApiError ? err.status : undefined;
	const named = scope ? `"${scope}"` : 'that table';

	if (status === 401) {
		return account.auth.mode === 'named'
			? 'The Azure CLI session has expired. Run "az login" and reconnect.'
			: 'Azure did not accept those credentials for Log Analytics. Check the client id, its secret, and the directory (tenant) ID on the cloud account.';
	}
	if (status === 403) {
		return `Those credentials cannot read this workspace. They need the "Log Analytics Reader" role on it.`;
	}
	if (status === 404) {
		return 'There is no Log Analytics workspace with that ID. The connection wants the workspace ID (a GUID), not the workspace name.';
	}
	if (status === 400 && /SemanticError|SyntaxError|BadArgument/i.test(message)) {
		return `Azure Monitor rejected this query: ${message}`;
	}
	if (status === 429) {
		return 'Azure Monitor is rate-limiting these queries. A narrower time range, or fewer queries at once, will settle it.';
	}
	if (/Failed to.*az account|AzureCliCredential/i.test(message)) {
		return 'The Azure CLI could not provide a token. Run "az login", or give the cloud account a client id and secret instead.';
	}
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
		return 'Azure Monitor could not be reached. Check your network.';
	}
	if (scope && /could not be resolved|Failed to resolve table/i.test(message)) {
		return `There is no table called ${named} in this workspace.`;
	}
	return message;
}

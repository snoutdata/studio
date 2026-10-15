/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Google Cloud Logging, as a CONNECTION: a project's logs are tables and SQL runs against them.
 *
 *  One of three plugins behind `telemetrySource.ts`. Nothing outside this
 *  file names GCP, a log name, an insert id or a Logging filter.
 *
 *  **THIS IS THE DRIVER `aggregate` IS OPTIONAL FOR.** The Cloud Logging API lists entries and does
 *  nothing else: there is no `GROUP BY`, no `count()`, no server-side summarisation at any price.
 *  (Log Analytics, the BigQuery-backed surface, is a separate opt-in product on separate buckets,
 *  and pretending a connection had it when the project has not enabled it would fail at query time
 *  rather than at design time.) So this session implements `scan` and NOT `aggregate`, and the
 *  executor computes a grouping over a completed scan instead — refusing outright, rather than
 *  reporting a plausible wrong number, when the scan hit its cap first. That refusal is the whole
 *  reason `aggregateLogRows` takes a `complete` flag.
 *
 *  A SERVICE ACCOUNT IS A DOCUMENT, WHICH IS WHY `CloudAuth` HAS A FOURTH MODE. The GCS flow driver
 *  records the reasoning at length: the JSON file is issued and rotated as one artifact, so it is
 *  kept whole in the keychain and handed to the auth library unchanged rather than split into a key
 *  and a secret. `named` and `chain` both mean application default credentials — what
 *  `gcloud auth application-default login` writes — because gcloud configurations are not
 *  credentials a library can be pointed at by name, and saying so beats silently using a different
 *  one than the user picked.
 *--------------------------------------------------------------------------------------------*/

import type { GoogleAuth } from 'google-auth-library';

import type {
	TelemetryAggregateResult,
	TelemetryDriverPlugin,
	TelemetryEvent,
	TelemetryScanOptions,
	TelemetrySession,
	TelemetryWindow,
} from './telemetrySource';
import { canonicalLogField, LOG_FIELDS, type LogPredicate, type LogsQuery } from '../../../../shared/engine';
import { TELEMETRY_SERVICES } from '../../../../shared/cloud';
import type { CloudAccount, LogScope } from '../../../../shared/cloud';

/** The auth library, required lazily — the server child must not pay for it at load time. */
function authLibrary(): typeof import('google-auth-library') {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('google-auth-library') as typeof import('google-auth-library');
}

const API = 'https://logging.googleapis.com/v2';
/** Read-only, deliberately: nothing this driver does writes, and a token that cannot write is one
 *  fewer thing to get wrong. */
const SCOPES = ['https://www.googleapis.com/auth/logging.read'];
/** Entries one `entries:list` page asks for. The API's own ceiling is 1,000. */
const PAGE_SIZE = 1000;
/** Log names the explorer will enumerate before it stops. */
const MAX_LOGS = 1000;

const INFO = TELEMETRY_SERVICES.gcpLogging;

export function createGcpLoggingPlugin(): TelemetryDriverPlugin {
	return {
		info: INFO,
		open: (account, secret, container) => new GcpLoggingSession(account, secret, container),
		explain: explainGcpLogging,
	};
}

class GcpLoggingSession implements TelemetrySession {
	private auth?: GoogleAuth;

	constructor(
		private readonly account: CloudAccount,
		private readonly secret: string | undefined,
		private readonly project: string,
	) {}

	private get google(): GoogleAuth {
		if (this.auth) {
			return this.auth;
		}
		const { GoogleAuth } = authLibrary();
		if (this.account.auth.mode === 'document') {
			if (!this.secret) {
				throw new Error('This Google account has no service-account key stored. Re-add the JSON key file to the cloud account in Settings.');
			}
			let credentials: object;
			try {
				credentials = JSON.parse(this.secret) as object;
			} catch {
				throw new Error('The stored Google service-account key is not valid JSON. Re-add the key file to the cloud account in Settings.');
			}
			this.auth = new GoogleAuth({ credentials, scopes: SCOPES, projectId: this.project });
		} else if (this.account.auth.mode === 'key') {
			// An HMAC key is a storage interoperability credential; it cannot mint an OAuth token,
			// so saying so beats a 401 the user cannot act on.
			throw new Error('An HMAC key can only be used for Cloud Storage. Cloud Logging needs a service-account JSON key, or application default credentials.');
		} else {
			this.auth = new GoogleAuth({ scopes: SCOPES, projectId: this.project });
		}
		return this.auth;
	}

	private async call<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
		const token = await this.google.getAccessToken();
		if (!token) {
			throw new Error('Google did not issue an access token for Cloud Logging.');
		}
		const response = await fetch(`${API}${path}`, {
			...init,
			headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new GcpApiError(response.status, gcpReason(body) || body || response.statusText);
		}
		return (await response.json()) as T;
	}

	async verify(signal?: AbortSignal): Promise<void> {
		// One page of log names: proves the credentials, the project and `logging.logEntries.list`
		// in one call. A project with no logs is a valid answer.
		await this.call<LogNameList>(`/projects/${encodeURIComponent(this.project)}/logs?pageSize=1`, { method: 'GET' }, signal);
	}

	async verifyAccount(): Promise<void> {
		// A token is the whole of signing in; the project is chosen later, on the connection.
		if (!await this.google.getAccessToken()) {
			throw new Error('Google did not issue an access token for Cloud Logging.');
		}
	}

	async listScopes(signal?: AbortSignal): Promise<LogScope[]> {
		const scopes: LogScope[] = [];
		let token: string | undefined;
		do {
			const page = await this.call<LogNameList>(
				`/projects/${encodeURIComponent(this.project)}/logs?pageSize=${PAGE_SIZE}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
				{ method: 'GET' },
				signal,
			);
			for (const full of page.logNames ?? []) {
				// The API answers with `projects/p/logs/<url-encoded name>`; the short name is what a
				// user writes in `FROM`, and it is decoded because a log name may contain a slash.
				const short = full.split('/logs/')[1];
				if (short) {
					scopes.push({ name: decodeURIComponent(short) });
				}
			}
			token = page.nextPageToken;
		} while (token && scopes.length < MAX_LOGS);
		return scopes.slice(0, MAX_LOGS);
	}

	/**
	 * Cloud Logging publishes no per-log schema.
	 *
	 * An entry's `jsonPayload` is whatever the producer wrote, and the API has no call that reports
	 * what keys a log has held. Sampling entries to guess would cost a read on every introspection
	 * and still be a guess, so this reports nothing and the scope is queryable through the fixed
	 * contract — the seam allows exactly that, and says so.
	 */
	async discoverFields(_scope: string, _window: TelemetryWindow): Promise<string[]> {
		return [];
	}

	async *scan(query: LogsQuery, options: TelemetryScanOptions = {}): AsyncIterable<TelemetryEvent> {
		let token: string | undefined;
		let produced = 0;
		for (;;) {
			const page = await this.call<EntryList>(
				'/entries:list',
				{
					method: 'POST',
					body: JSON.stringify({
						resourceNames: [`projects/${this.project}`],
						filter: loggingFilter(query, this.project),
						// Oldest first, which the seam requires of every driver.
						orderBy: 'timestamp asc',
						pageSize: PAGE_SIZE,
						...(token ? { pageToken: token } : {}),
					}),
				},
				options.signal,
			);
			for (const entry of page.entries ?? []) {
				const at = Date.parse(entry.timestamp ?? '');
				if (Number.isNaN(at)) {
					continue;
				}
				yield {
					id: entry.insertId ?? `${at}:${produced}`,
					at,
					ingestedAt: entry.receiveTimestamp ? Date.parse(entry.receiveTimestamp) : undefined,
					// The nearest thing GCP has to a stream: which resource produced the entry.
					stream: entry.resource?.type,
					message: messageOf(entry),
				};
				produced += 1;
			}
			options.onProgress?.(produced);
			token = page.nextPageToken;
			if (!token) {
				return;
			}
		}
	}

	/**
	 * A Cloud Logging FILTER the user wrote, run untouched over the window.
	 *
	 * Not a query language with a projection — the filter selects entries and nothing else — so the
	 * result is the fixed contract's columns over the entries it selected, which is exactly what a
	 * filter means. The window is ANDed on rather than trusted to the text.
	 */
	async runNative(text: string, window: TelemetryWindow, scope: string | undefined, options: TelemetryScanOptions = {}): Promise<TelemetryAggregateResult> {
		const clauses = [
			...(scope ? [`logName="projects/${this.project}/logs/${encodeURIComponent(scope)}"`] : []),
			`timestamp>="${new Date(window.start).toISOString()}"`,
			`timestamp<"${new Date(window.end).toISOString()}"`,
			...(text.trim() ? [`(${text.trim()})`] : []),
		];
		const rows: unknown[][] = [];
		let token: string | undefined;
		do {
			const page = await this.call<EntryList>(
				'/entries:list',
				{
					method: 'POST',
					body: JSON.stringify({
						resourceNames: [`projects/${this.project}`],
						filter: clauses.join(' AND '),
						orderBy: 'timestamp asc',
						pageSize: PAGE_SIZE,
						...(token ? { pageToken: token } : {}),
					}),
				},
				options.signal,
			);
			for (const entry of page.entries ?? []) {
				const at = Date.parse(entry.timestamp ?? '');
				if (Number.isNaN(at)) {
					continue;
				}
				rows.push([at, messageOf(entry), entry.resource?.type ?? null, entry.insertId ?? null, entry.receiveTimestamp ? Date.parse(entry.receiveTimestamp) : null]);
			}
			options.onProgress?.(rows.length);
			token = page.nextPageToken;
		} while (token && rows.length < PAGE_SIZE);
		return {
			columns: [LOG_FIELDS.ts, LOG_FIELDS.message, LOG_FIELDS.stream, LOG_FIELDS.id, LOG_FIELDS.ingestedAt],
			rows,
			cost: { engine: 'Cloud Logging (filter)' },
		};
	}

	close(): void {
		this.auth = undefined;
	}
}

interface LogNameList { logNames?: string[]; nextPageToken?: string }
interface LogEntry {
	insertId?: string;
	timestamp?: string;
	receiveTimestamp?: string;
	severity?: string;
	logName?: string;
	resource?: { type?: string; labels?: Record<string, string> };
	textPayload?: string;
	jsonPayload?: Record<string, unknown>;
	protoPayload?: Record<string, unknown>;
	labels?: Record<string, string>;
}
interface EntryList { entries?: LogEntry[]; nextPageToken?: string }

class GcpApiError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = 'GcpApiError';
	}
}

function gcpReason(body: string): string | undefined {
	try {
		return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
	} catch {
		return undefined;
	}
}

/**
 * An entry's text.
 *
 * A Cloud Logging entry carries exactly one of three payloads. A `textPayload` is already the line.
 * The other two are records, and they are serialised as JSON with the entry's own `severity` folded
 * in — so `WHERE severity = 'ERROR'` addresses a field on every entry, structured or not, which is
 * the single most common thing anyone filters GCP logs by.
 */
function messageOf(entry: LogEntry): string {
	const payload = entry.jsonPayload ?? entry.protoPayload;
	if (payload) {
		return JSON.stringify({ ...(entry.severity ? { severity: entry.severity } : {}), ...payload, ...(entry.labels ?? {}) });
	}
	if (entry.severity || entry.labels) {
		// Even a plain text line gets its severity addressable, without losing the text itself.
		return JSON.stringify({ ...(entry.severity ? { severity: entry.severity } : {}), ...(entry.labels ?? {}), textPayload: entry.textPayload ?? '' });
	}
	return entry.textPayload ?? '';
}

/**
 * The Cloud Logging filter for a query: the log, the window, and whatever of the WHERE its filter
 * language can express.
 *
 * Pushdown is best-effort by design — the executor re-applies every predicate over the rows — so
 * anything the language cannot say faithfully is simply left out rather than approximated.
 */
export function loggingFilter(query: LogsQuery, project: string): string {
	const clauses = [
		`logName="projects/${project}/logs/${encodeURIComponent(query.scope)}"`,
		// Half-open, matching `LogsQuery`.
		`timestamp>="${new Date(query.start).toISOString()}"`,
		`timestamp<"${new Date(query.end).toISOString()}"`,
	];
	for (const predicate of query.where ?? []) {
		const clause = loggingPredicate(predicate);
		if (clause) {
			clauses.push(clause);
		}
	}
	return clauses.join(' AND ');
}

/** One predicate in Cloud Logging's filter syntax, or undefined when it has no faithful form. */
function loggingPredicate(predicate: LogPredicate): string | undefined {
	const field = loggingField(predicate.field);
	if (!field) {
		return undefined;
	}
	switch (predicate.op) {
		case '=':
		case '!=':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return `${field}${predicate.op}${loggingLiteral(predicate.value)}`;
		case 'like': {
			// Only the plain "contains" form: the filter language's `:` is a substring/has test, and
			// nothing in it corresponds to a wildcard in the middle of a pattern.
			const inner = /^%([^%_]+)%$/.exec(predicate.pattern);
			return inner ? `${field}:${loggingLiteral(inner[1])}` : undefined;
		}
		case 'in':
			return `(${predicate.values.map((value) => `${field}=${loggingLiteral(value)}`).join(' OR ')})`;
		default:
			return undefined;
	}
}

/** A field path in the filter language, or undefined for one with no addressable form. */
function loggingField(field: string): string | undefined {
	const canonical = canonicalLogField(field);
	if (canonical === LOG_FIELDS.ts || canonical === LOG_FIELDS.id || canonical === LOG_FIELDS.ingestedAt) {
		// The window is already a filter clause, and the other two are identity, not selection.
		return undefined;
	}
	if (canonical === LOG_FIELDS.message) {
		return 'textPayload';
	}
	if (canonical === LOG_FIELDS.stream) {
		return 'resource.type';
	}
	if (canonical === 'severity') {
		return 'severity';
	}
	// Anything else is a key inside the entry's own record payload.
	return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(field) ? `jsonPayload.${field}` : undefined;
}

function loggingLiteral(value: unknown): string {
	if (value === null || value === undefined) {
		return '""';
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

/** A Cloud Logging failure as a sentence that names the fix. */
export function explainGcpLogging(err: unknown, account: CloudAccount, scope?: string): string {
	const message = err instanceof Error ? err.message : String(err);
	const status = err instanceof GcpApiError ? err.status : undefined;

	if (status === 401) {
		return account.auth.mode === 'document'
			? 'Google did not accept that service-account key. Check it has not been revoked, and that the project on this connection is the one it belongs to.'
			: 'No usable Google credentials were found. Run "gcloud auth application-default login", or add a service-account key to the cloud account.';
	}
	if (status === 403) {
		return `Those credentials cannot read logs in "${account.name}". They need the "Logs Viewer" role (roles/logging.viewer) on the project.`;
	}
	if (status === 404) {
		return 'That project does not exist, or the Cloud Logging API is not enabled on it.';
	}
	if (status === 400) {
		return scope ? `Cloud Logging rejected this query: ${message}` : `Cloud Logging rejected the request: ${message}`;
	}
	if (status === 429) {
		return 'Cloud Logging is rate-limiting these requests. A narrower time range will settle it.';
	}
	if (/Could not load the default credentials/i.test(message)) {
		return 'No application default credentials were found. Run "gcloud auth application-default login", or add a service-account key to the cloud account in Settings.';
	}
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
		return 'Cloud Logging could not be reached. Check your network.';
	}
	return message;
}

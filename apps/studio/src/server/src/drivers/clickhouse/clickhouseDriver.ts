/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';

import type { ConnectionConfig } from '../../../../shared/connection';
import type { DialectCatalog } from '../../../../shared/catalog';
import type { DatabaseSchema } from '../../../../shared/schema';
import { CLICKHOUSE_APP_MARKER, CLICKHOUSE_REPLICA_CLUSTER, clickhouseScopeSettings, clickhouseSystemTable, dialectFor, quoteClickHouseIdent, type BulkExportRequest, type BulkExportResult, type BulkLoadRequest, type BulkLoadResult, type NativeQuery, type ReplicaScope } from '../../../../shared/engine';
import type { QueryProgress } from '../../../../shared/query';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { expectSql, QueryCancelledError } from '../databaseDriver';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { introspectClickHouseCatalog } from './catalog';
import { clickhouseStructuralDigest, introspectClickHouse, type ClickHouseRowRunner } from './introspection';

/** What the HTTP interface answers a statement with, when it answers with rows. */
interface JsonCompactBody {
	meta?: { name: string; type: string }[];
	data?: unknown[][];
	rows?: number;
	statistics?: { elapsed?: number; rows_read?: number | string; bytes_read?: number | string };
}

interface JsonBody {
	data?: Record<string, unknown>[];
}

interface HttpAnswer {
	status: number;
	body: string;
	summary?: string;
	/** The format the server actually answered in (`X-ClickHouse-Format`): ours, unless the
	 *  statement named its own with a FORMAT clause. */
	format?: string;
}

/**
 * ClickHouse over its HTTP interface (port 8123, or 8443 with TLS on ClickHouse Cloud). No client
 * package: one POST per statement with Node's own `http`/`https`, which is also how the TLS
 * options and an SSH tunnel stay the same as every other driver's.
 *
 * Each statement carries its own `query_id`, so Stop is a `KILL QUERY` for exactly that id from a
 * side request, followed by dropping the connection. On ClickHouse Cloud (or any server behind a
 * balancer with several replicas) that side request can land on a replica the query is NOT running
 * on, so the KILL is also sent `ON CLUSTER` to all of them once the connection has found replicas.
 *
 * The HTTP interface is STATELESS: every request is a fresh session. So a `SET` or a `USE` the user
 * runs would otherwise vanish before the next statement. The driver remembers them and sends them
 * with every later request, which is what they would have done on a native connection.
 *
 * Nothing is sent as a URL setting that a `readonly = 1` user would be refused: that is the usual
 * production analyst account, and it cannot change any setting at all.
 */
/** What one HTTP request carries besides the statement (see {@link ClickHouseDriver.run}). */
interface RunOptions {
	format?: string;
	queryId?: string;
	track?: { request?: ClientRequest };
	session?: boolean;
	statement?: string;
	body?: () => Readable;
	contentEncoding?: string;
	toFile?: string;
	/** Send `readonly = 2`, so the server refuses any write or DDL in this request. */
	readOnly?: boolean;
}

/** The server's refusal to change `readonly` for an account that is already `readonly = 1`. */
export function isAccountReadOnlyRefusal(message: string): boolean {
	return /Cannot modify 'readonly' setting in readonly mode/i.test(message);
}

class ClickHouseDriver implements DatabaseDriver {
	readonly id = 'clickhouse';
	readonly displayName = 'ClickHouse';
	readonly kind = 'relational' as const;

	private config?: ConnectionConfig;
	private tunnel?: SshTunnel;
	private endpoint?: { host: string; port: number };
	private active?: { queryId: string; request?: ClientRequest; cancelled: boolean };
	/** Settings from the user's own `SET` statements, replayed on every request. */
	private sessionSettings = new Map<string, string>();
	/** The database from the user's own `USE`, overriding the connection's. */
	private currentDatabase?: string;
	/** The account is itself `readonly = 1` (it refused the read-only setting), so the server already
	 *  refuses its writes and a read-only run sends nothing extra. Reset on connect. */
	private accountReadOnly = false;
	/** The replicas behind this endpoint, found in the background after connecting: a KILL must
	 *  reach all of them, and a query's progress is on whichever one runs it. */
	private replicas?: ReplicaScope;

	async connect(config: ConnectionConfig): Promise<void> {
		this.config = config;
		this.sessionSettings.clear();
		this.currentDatabase = undefined;
		this.accountReadOnly = false;
		this.replicas = undefined;
		let host = config.host;
		let port = config.port || (config.ssl ? 8443 : 8123);
		if (config.sshTunnel) {
			this.tunnel = await openSshTunnel(config.sshTunnel, host, port);
			host = this.tunnel.host;
			port = this.tunnel.port;
		}
		this.endpoint = { host, port };
		await this.ping();
		// Off the connect path: one small read, and only Stop and progress need the answer.
		void this.findReplicas();
	}

	private async findReplicas(): Promise<void> {
		this.replicas = await dialectFor('clickhouse').replicaScope?.(this.rowRunner()).catch(() => undefined);
	}

	private get killCluster(): string | undefined {
		return this.replicas && this.replicas.replicas > 1 ? this.replicas.cluster ?? CLICKHOUSE_REPLICA_CLUSTER : undefined;
	}

	/** Rows and bytes read so far, and memory, from the server's own list of running queries. */
	async progress(): Promise<QueryProgress | null> {
		const entry = this.active;
		if (!entry) {
			return null;
		}
		const rows = await this.rowRunner()(progressSql(entry.queryId, this.replicas));
		return rows.length > 0 ? readProgress(rows[0]) : null;
	}

	async disconnect(): Promise<void> {
		this.endpoint = undefined;
		const tunnel = this.tunnel;
		this.tunnel = undefined;
		await tunnel?.close().catch(() => undefined);
	}

	isConnected(): boolean {
		return this.endpoint !== undefined;
	}

	async ping(): Promise<void> {
		await this.run('SELECT 1', { format: 'JSONCompact' });
	}

	async introspectSchema(options?: IntrospectOptions): Promise<DatabaseSchema> {
		return introspectClickHouse(this.rowRunner(), this.config?.database, options?.includeViews ?? true);
	}

	async structuralDigest(): Promise<string> {
		return clickhouseStructuralDigest(this.rowRunner());
	}

	/** What this server knows about itself: functions, combinators, engines, types, formats,
	 *  settings. Read once per connection; each list degrades on its own. */
	async introspectCatalog(): Promise<DialectCatalog> {
		return introspectClickHouseCatalog(this.rowRunner());
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		const { sql, params, readOnly } = expectSql(query);
		if (params && params.length > 0) {
			throw new Error('ClickHouse: positional parameters are not supported over HTTP. Inline the values.');
		}
		const started = Date.now();
		if (onlyBindsParameters(sql)) {
			this.remember(sql);
			return { fields: [], rows: [], rowCount: 0, durationMs: 0 };
		}
		const entry: { queryId: string; request?: ClientRequest; cancelled: boolean } = { queryId: randomUUID(), cancelled: false };
		this.active = entry;
		try {
			const answer = await this.runMaybeReadOnly(sql, { format: 'JSONCompact', queryId: entry.queryId, track: entry, session: true }, readOnly);
			this.remember(sql);
			const durationMs = Date.now() - started;
			if (answer.format && answer.format !== 'JSONCompact' && answer.body.trim()) {
				// The statement chose its own FORMAT (CSV, TSV, Pretty, JSONEachRow, ...). Its output is
				// the answer, shown as it came, one line per row, rather than failing to parse as ours.
				return textResult(answer.format, answer.body, Date.now() - started);
			}
			if (!answer.body.trim()) {
				// DDL and INSERT answer with no body; the summary header says how much was written.
				return { fields: [], rows: [], rowCount: writtenRows(answer.summary), durationMs };
			}
			const parsed = parseBody<JsonCompactBody>(answer.body);
			const rows = parsed.data ?? [];
			const result: QueryResult = {
				fields: (parsed.meta ?? []).map((m) => ({ name: m.name, dataType: m.type })),
				rows,
				rowCount: rows.length,
				durationMs,
			};
			const read = readCost(parsed.statistics);
			if (read) {
				result.cost = read;
			}
			return result;
		} catch (err) {
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.active === entry) {
				this.active = undefined;
			}
		}
	}

	/**
	 * A file INTO a table: the statement goes in the URL and the file's bytes are the body, which
	 * is ClickHouse's own fast path in and the reason this exists (`INSERT ... VALUES` makes the
	 * server parse SQL for every row).
	 *
	 * The file is piped, never read: these are the files too big to sit in a statement. A
	 * compressed one is sent AS IT IS with its `Content-Encoding`, so a `.csv.gz` crosses the wire
	 * at its compressed size and the server expands it. That is a request header rather than a
	 * setting, so it works for any account allowed to insert.
	 *
	 * It shares `active` with `execute`, so Stop kills it and the progress poll reads its rows as
	 * they go in, exactly as for a running query.
	 */
	async bulkLoad(request: BulkLoadRequest): Promise<BulkLoadResult> {
		const started = Date.now();
		const stat = await statFile(request.filePath);
		const entry: { queryId: string; request?: ClientRequest; cancelled: boolean } = { queryId: randomUUID(), cancelled: false };
		this.active = entry;
		try {
			const answer = await this.run('', {
				statement: request.sql,
				body: () => createReadStream(request.filePath),
				contentEncoding: request.encoding,
				queryId: entry.queryId,
				track: entry,
				session: true,
			});
			return { rowsWritten: writtenRows(answer.summary), bytesSent: stat, durationMs: Date.now() - started };
		} catch (err) {
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.active === entry) {
				this.active = undefined;
			}
		}
	}

	/**
	 * A whole result STRAIGHT to a file: the statement is the body as usual and the answer is piped
	 * to disk, so nothing the export holds is ever in this process. That is the point of it; the
	 * app's own export serializes rows it is holding, which a fifty-million-row result cannot be.
	 *
	 * It writes `<file>.part` and renames on success, so a failure does not leave a truncated file
	 * standing where a good one was. The honest limit: ClickHouse answers 200 and starts streaming
	 * before it knows the query will finish, so an error thrown PART WAY arrives as text at the end
	 * of the body. `wait_end_of_query=1` is what would fix that and it is a setting, which a
	 * `readonly = 1` account is refused, so it is not sent. A short answer that is nothing but an
	 * exception is caught below; a truncated big one is not.
	 *
	 * It is sent with `readonly = 2`, as a read-only run is, since an export only reads; an account
	 * that is already `readonly = 1` is sent it once, refused, and not again (`runMaybeReadOnly`).
	 */
	async bulkExport(request: BulkExportRequest): Promise<BulkExportResult> {
		const started = Date.now();
		const part = `${request.filePath}.part`;
		const entry: { queryId: string; request?: ClientRequest; cancelled: boolean } = { queryId: randomUUID(), cancelled: false };
		this.active = entry;
		try {
			// An export only reads, so the server is asked to refuse a write as well (main already
			// refused any statement that reads as one).
			const written = await this.runMaybeReadOnly('', { statement: request.sql, toFile: part, queryId: entry.queryId, track: entry, session: true }, true);
			await rename(part, request.filePath);
			return { bytesWritten: Number(written.body), durationMs: Date.now() - started };
		} catch (err) {
			await unlink(part).catch(() => undefined);
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.active === entry) {
				this.active = undefined;
			}
		}
	}

	async cancel(): Promise<void> {
		const entry = this.active;
		if (!entry) {
			return;
		}
		entry.cancelled = true;
		const [local, ...others] = killStatements(entry.queryId, this.killCluster);
		// ON CLUSTER waits for every host to take the entry, which is minutes when one is down: it is
		// sent, not waited for.
		for (const sql of others) {
			void this.run(sql, {}).catch(() => undefined);
		}
		await this.run(local, {}).catch(() => undefined);
		entry.request?.destroy();
	}

	/**
	 * A read-only run asks the server to refuse writes with `readonly = 2` on the request
	 * (`readOnly.ts`, CLICKHOUSE_READ_ONLY): 2, not 1, so the settings replayed for the session are
	 * still accepted. An account that is ALREADY `readonly = 1` may not send it (the server refuses
	 * to change `readonly` at all), and needs it least, since the server already refuses its writes;
	 * that refusal is recognised once, remembered, and the statement sent without the setting.
	 */
	private async runMaybeReadOnly(sql: string, options: RunOptions, readOnly: boolean): Promise<HttpAnswer> {
		if (!readOnly || this.accountReadOnly) {
			return this.run(sql, options);
		}
		try {
			return await this.run(sql, { ...options, readOnly: true });
		} catch (err) {
			if (!isAccountReadOnlyRefusal(err instanceof Error ? err.message : String(err))) {
				throw err;
			}
			this.accountReadOnly = true;
			return this.run(sql, options);
		}
	}

	/** Keep what a `SET` or `USE` that just SUCCEEDED changed, for the requests after it. */
	private remember(sql: string): void {
		const use = parseUse(sql);
		if (use) {
			this.currentDatabase = use;
			return;
		}
		for (const [name, value] of parseSet(sql)) {
			this.sessionSettings.set(name, value);
		}
	}

	/**
	 * The app's own reads: introspection, the catalog, the digest, replicas and progress. They run
	 * with no click and some are built from names the catalog holds, so each asks the server to
	 * refuse a write (`readonly = 2`), as a read-only run does.
	 */
	private rowRunner(): ClickHouseRowRunner {
		return async (sql) => parseBody<JsonBody>((await this.runMaybeReadOnly(sql, { format: 'JSON' }, true)).body).data ?? [];
	}

	/**
	 * POST one statement. A non-2xx answer carries ClickHouse's own message, which is thrown.
	 *
	 * Two shapes: normally the statement IS the body, and for a file load the statement goes in
	 * the `query` URL parameter (`statement`) so the body can be the file (`body`). `query` is not
	 * a setting, so nothing here is refused to a `readonly = 1` account that was not already.
	 */
	private run(sql: string, options: RunOptions): Promise<HttpAnswer> {
		const config = this.config;
		const endpoint = this.endpoint;
		if (!config || !endpoint) {
			return Promise.reject(new Error('ClickHouse: not connected.'));
		}
		const search = new URLSearchParams();
		if (options.format) {
			// The one setting a readonly = 1 user may still send.
			search.set('default_format', options.format);
		}
		if (options.queryId) {
			search.set('query_id', options.queryId);
		}
		if (options.statement) {
			search.set('query', options.statement);
		}
		if (options.session) {
			for (const [name, value] of this.sessionSettings) {
				search.set(name, value);
			}
		}
		if (options.readOnly) {
			// After the session's own settings, so a remembered `SET readonly = 0` cannot undo it.
			search.set('readonly', '2');
		}
		const headers: Record<string, string> = {
			'Content-Type': options.body ? 'application/octet-stream' : 'text/plain; charset=utf-8',
			'X-ClickHouse-User': config.username || 'default',
		};
		if (options.contentEncoding) {
			headers['Content-Encoding'] = options.contentEncoding;
		}
		if (config.password) {
			headers['X-ClickHouse-Key'] = config.password;
		}
		const database = this.currentDatabase ?? config.database;
		if (database) {
			headers['X-ClickHouse-Database'] = database;
		}
		const tls = Boolean(config.ssl);
		const sslObject = typeof config.ssl === 'object' ? config.ssl : undefined;
		const requestOptions: RequestOptions & { servername?: string; ca?: string; rejectUnauthorized?: boolean } = {
			host: endpoint.host,
			port: endpoint.port,
			method: 'POST',
			path: `/?${search.toString()}`,
			headers,
		};
		if (tls) {
			// Through a tunnel the socket is on loopback, so name the real host for SNI and the
			// certificate check.
			requestOptions.servername = config.host;
			requestOptions.ca = sslObject?.ca;
			requestOptions.rejectUnauthorized = sslObject?.rejectUnauthorized !== false;
		}
		return new Promise<HttpAnswer>((resolve, reject) => {
			const request = (tls ? httpsRequest : httpRequest)(requestOptions, (response: IncomingMessage) => {
				const status = response.statusCode ?? 0;
				const summary = response.headers['x-clickhouse-summary'];
				if (options.toFile && status >= 200 && status < 300) {
					// The answer goes to disk as it arrives. `body` carries the byte count, since there
					// is no body left to hand back.
					const file = createWriteStream(options.toFile);
					let bytes = 0;
					response.on('data', (chunk: Buffer) => { bytes += chunk.length; });
					response.on('error', reject);
					file.on('error', reject);
					file.on('finish', () => resolve({ status, body: String(bytes), summary: Array.isArray(summary) ? summary[0] : summary }));
					response.pipe(file);
					return;
				}
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('error', reject);
				response.on('end', () => {
					const body = Buffer.concat(chunks).toString('utf8');
					const status = response.statusCode ?? 0;
					if (status < 200 || status >= 300) {
						const code = response.headers['x-clickhouse-exception-code'];
						reject(new Error(withExceptionCode(clickhouseMessage(body) || `ClickHouse answered HTTP ${status}.`, Array.isArray(code) ? code[0] : code)));
						return;
					}
					const summary = response.headers['x-clickhouse-summary'];
					const format = response.headers['x-clickhouse-format'];
					resolve({ status, body, summary: Array.isArray(summary) ? summary[0] : summary, format: Array.isArray(format) ? format[0] : format });
				});
			});
			if (options.track) {
				options.track.request = request;
			}
			request.on('error', reject);
			if (options.body) {
				// A read error (the file vanished, a permission) must end the request too, or it hangs
				// with a half-sent body until the server times out.
				const file = options.body();
				file.on('error', (err: Error) => {
					request.destroy();
					reject(err);
				});
				file.pipe(request);
			} else {
				request.end(sql);
			}
		});
	}
}

/** The file's size, for the reading under the result. A file we cannot stat is not a failure here:
 *  the load itself is about to say so if it is really gone. */
async function statFile(path: string): Promise<number> {
	return stat(path).then((entry) => entry.size).catch(() => 0);
}

/**
 * What Stop sends: a KILL on whichever node answers, plus, when the server has several replicas, the
 * same KILL `ON CLUSTER` (which needs Keeper; where there is none it fails and the first one stands).
 */
export function killStatements(queryId: string, cluster: string | undefined): string[] {
	const where = `WHERE query_id = '${queryId.replace(/[\\']/g, '')}'`;
	return cluster ? [`KILL QUERY ${where}`, `KILL QUERY ON CLUSTER ${quoteClickHouseIdent(cluster)} ${where}`] : [`KILL QUERY ${where}`];
}

/** The read `progress` sends: marked as the app's own, so the operations views leave it out. */
export function progressSql(queryId: string, scope: ReplicaScope | undefined): string {
	return `${CLICKHOUSE_APP_MARKER} SELECT read_rows, read_bytes, total_rows_approx, memory_usage, peak_memory_usage
FROM ${clickhouseSystemTable('processes', scope)} WHERE query_id = '${queryId.replace(/[\\']/g, '')}'${clickhouseScopeSettings(scope)}`;
}

export function readProgress(row: Record<string, unknown>): QueryProgress {
	const n = (value: unknown): number | undefined => {
		const x = Number(value);
		return value === null || value === undefined || value === '' || !Number.isFinite(x) ? undefined : x;
	};
	const total = n(row.total_rows_approx);
	return {
		rowsRead: n(row.read_rows),
		bytesRead: n(row.read_bytes),
		totalRowsEstimate: total && total > 0 ? total : undefined,
		memoryBytes: n(row.memory_usage),
		peakMemoryBytes: n(row.peak_memory_usage),
	};
}

/** `Code: 60. DB::Exception: Unknown table ... (UNKNOWN_TABLE) (version 26.8.6.5 (official build))`
 *  → without the version tail, which is noise to someone reading why their statement failed. */
export function clickhouseMessage(body: string): string {
	return body.trim().replace(/\s*\(version [^()]*(\([^()]*\))?\)\s*$/, '');
}

/**
 * The error with ClickHouse's numeric code at its head, from the `X-ClickHouse-Exception-Code`
 * header when the body does not already carry it (a proxy's page, an empty or cut-off body), so the
 * failure memory and the fix-with-AI prompt classify it by code rather than by its wording.
 */
export function withExceptionCode(message: string, code: string | undefined): string {
	if (!code || !/^\d+$/.test(code) || /\bCode: \d+\./.test(message)) {
		return message;
	}
	return `Code: ${code}. DB::Exception: ${message}`;
}

/** Output in a format the statement chose itself, one line per row under the format's name. */
export function textResult(format: string, body: string, durationMs: number): QueryResult {
	const lines = body.replace(/\r?\n$/, '').split(/\r?\n/);
	return { fields: [{ name: format, dataType: 'String' }], rows: lines.map((line) => [line]), rowCount: lines.length, durationMs };
}

/** The rows an INSERT wrote, from the `X-ClickHouse-Summary` header. */
export function writtenRows(summary: string | undefined): number {
	if (!summary) {
		return 0;
	}
	try {
		const parsed = JSON.parse(summary) as { written_rows?: string | number };
		const n = Number(parsed.written_rows ?? 0);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

/** What the statement READ, which on a columnar engine is the honest measure of what it cost:
 *  a query that returns four rows can still have read a billion. */
export function readCost(statistics: JsonCompactBody['statistics']): QueryResult['cost'] | undefined {
	if (!statistics) {
		return undefined;
	}
	const rows = Number(statistics.rows_read);
	const bytes = Number(statistics.bytes_read);
	if (!Number.isFinite(rows) && !Number.isFinite(bytes)) {
		return undefined;
	}
	return {
		engine: 'ClickHouse',
		recordsScanned: Number.isFinite(rows) ? rows : undefined,
		bytesScanned: Number.isFinite(bytes) ? bytes : undefined,
	};
}

/** `USE analytics` → `analytics`. */
export function parseUse(sql: string): string | undefined {
	const match = /^\s*USE\s+(`[^`]+`|"[^"]+"|[A-Za-z_][\w.]*)\s*;?\s*$/i.exec(sql);
	return match ? match[1].replace(/^[`"]|[`"]$/g, '') : undefined;
}

/**
 * `SET max_threads = 4, join_use_nulls = 1` → [['max_threads', '4'], ['join_use_nulls', '1']].
 * `SET ROLE` and `SET DEFAULT ROLE` change access, not a setting, and are not remembered.
 */
export function parseSet(sql: string): [string, string][] {
	const match = /^\s*SET\s+(?!(?:DEFAULT\s+)?ROLE\b)([\s\S]+?)\s*;?\s*$/i.exec(sql);
	if (!match) {
		return [];
	}
	const out: [string, string][] = [];
	for (const part of splitTopLevel(match[1])) {
		const pair = /^\s*([A-Za-z_][\w]*)\s*=\s*([\s\S]+?)\s*$/.exec(part);
		if (!pair) {
			continue;
		}
		let value = pair[2];
		if (/^'.*'$/s.test(value)) {
			value = unquote(value.slice(1, -1));
		}
		out.push([pair[1], value]);
	}
	return out;
}

/** A SQL string literal's content: `\\` → `\`, `\'` and `''` → `'`. */
function unquote(body: string): string {
	return body.replace(/''|\\([\s\S])/g, (_all, escaped: string | undefined) => (escaped === undefined ? "'" : escaped));
}

/** A `SET` that only binds query parameters (`SET param_id = 42`): nothing for the server to do,
 *  since over HTTP a parameter travels with each request, so it is kept here and never sent. */
export function onlyBindsParameters(sql: string): boolean {
	const pairs = parseSet(sql);
	return pairs.length > 0 && pairs.every(([name]) => name.startsWith('param_'));
}

/** Split on commas that are not inside a quoted string or brackets (`param_ids = [1, 2]`). */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quoted = false;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted && ch === '\\') {
			current += ch + (text[i + 1] ?? '');
			i++;
			continue;
		}
		if (ch === "'") {
			quoted = !quoted;
		} else if (!quoted && (ch === '(' || ch === '[' || ch === '{')) {
			depth++;
		} else if (!quoted && (ch === ')' || ch === ']' || ch === '}')) {
			depth = Math.max(0, depth - 1);
		}
		if (ch === ',' && !quoted && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	parts.push(current);
	return parts;
}

type SourceReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * An integer past 2^53 cannot survive as a JavaScript number, and newer servers no longer quote
 * 64-bit integers in JSON. Asking them to is a SETTING, which a readonly = 1 user may not change, so
 * the digits are kept here instead: such a number is returned as the exact text of its source.
 */
const keepBigIntegers: SourceReviver = (_key, value, context) => {
	if (typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
		return context.source;
	}
	return value;
};

/** A 200 whose body is not JSON is an exception ClickHouse raised mid-stream; say so in its words. */
export function parseBody<T>(body: string): T {
	try {
		return JSON.parse(body, keepBigIntegers as (this: unknown, key: string, value: unknown) => unknown) as T;
	} catch {
		throw new Error(clickhouseMessage(body) || 'ClickHouse returned a response that is not JSON.');
	}
}

export function createClickHouseDriver(): DatabaseDriver {
	return new ClickHouseDriver();
}

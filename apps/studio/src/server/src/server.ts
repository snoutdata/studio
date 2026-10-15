/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
	type CompletionItem,
	type CompletionList,
	type Hover,
	type InitializeResult,
	type TextDocumentPositionParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import {
	SnoutProtocol,
	type BulkExportOutcome,
	type BulkExportParams,
	type BulkLoadOutcome,
	type BulkLoadParams,
	type ConnectParams,
	type ConnectResult,
	type ExecuteQueryParams,
	type ExecuteQueryResult,
	type GetSchemaDigestParams,
	type GetSchemaDigestResult,
	type GetSchemaParams,
	type GetSchemaResult,
	type PingConnectionResult,
	type SchemaUpdatedParams,
	type SshHostKeyLearnedParams,
	type TestConnectionParams,
	type TestConnectionResult,
	type VerifyCloudAccountParams,
	type VerifyCloudAccountResult,
} from '../../shared/protocol';
import { registerBuiltInDrivers, createDriver } from './drivers/driverRegistry';
import { testConnection } from './testConnection';
import { telemetryPlugin } from './drivers/telemetry/telemetrySource';
import { onHostKeyLearned } from './drivers/sshHostKey';
import { QueryCancelledError, type DatabaseDriver } from './drivers/databaseDriver';
import { SchemaCache } from './schema/schemaCache';
import type { DatabaseSchema } from '../../shared/schema';
import type { DialectCatalog } from '../../shared/catalog';
import { analyzeCompletionContext } from './completion/sqlAnalyzer';
import { buildCompletions, resolveCompletion } from './completion/completionProvider';
import { buildHover } from './hover/hoverProvider';
import type { QueryProgress } from '../../shared/query';

/**
 * Last-resort guard: never let one stray async error take the whole child down.
 *
 * This process holds every live database connection for the app, so its death is not a
 * local failure — it drops every connection, empties the schema cache, and forces main to
 * spawn a replacement. Yet an 'error' event with no listener (an idle-reaped pool socket, an
 * SSH tunnel a bastion hung up on) is thrown as an uncaughtException, and Node's default is
 * to exit. One broken connection is a far better outcome than that, and every request path
 * validates its own connection anyway, so we log and stay up.
 *
 * Written straight to stderr, not console.error: in --stdio mode vscode-languageserver
 * patches console to route through the LSP logger, which needs a working connection — the
 * one thing we can't assume here. Main mirrors this stream into the crash report.
 */
function logFatal(label: string, err: unknown): void {
	const detail = err instanceof Error ? err.stack ?? err.message : String(err);
	process.stderr.write(`[snout] ${label} (staying alive): ${detail}\n`);
}
process.on('uncaughtException', (err) => logFatal('uncaught exception', err));
process.on('unhandledRejection', (reason) => logFatal('unhandled rejection', reason));

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const schemaCache = new SchemaCache();
const activeDrivers = new Map<string, DatabaseDriver>();
/**
 * What each connected engine says it KNOWS (its functions, combinators, table functions, engines,
 * types, formats and settings), beside what its database HOLDS. Read once per connection, never on
 * the connect path, and absent for a driver that cannot answer — completion and hover are then
 * exactly what they were before.
 */
const catalogCache = new Map<string, DialectCatalog>();

registerBuiltInDrivers();

// A tunnel that trusted a new SSH host key tells main, which remembers it (sshKnownHosts.ts).
onHostKeyLearned((host, port, fingerprint) => {
	const params: SshHostKeyLearnedParams = { host, port, fingerprint };
	connection.sendNotification(SnoutProtocol.SshHostKeyLearned, params);
});

connection.onInitialize((): InitializeResult => ({
	capabilities: {
		textDocumentSync: TextDocumentSyncKind.Incremental,
		completionProvider: { resolveProvider: true, triggerCharacters: ['.', ' '] },
		hoverProvider: true,
	},
}));

/** Introspect the driver, cache the result and notify the client. */
async function introspectInto(connectionId: string, driver: DatabaseDriver): Promise<number> {
	const schema = await driver.introspectSchema();
	schemaCache.set(connectionId, schema);
	const params: SchemaUpdatedParams = { connectionId, tableCount: schema.tables.length };
	connection.sendNotification(SnoutProtocol.SchemaUpdated, params);
	return schema.tables.length;
}

// --- Live schema index ------------------------------------------------------------
// Poll a cheap structural digest per connection; when it changes (DDL — added/dropped/
// renamed/retyped column or table), re-introspect so the cache, schema explorer and
// completion stay current without a manual refresh.
const POLL_INTERVAL_MS = 15000;
const schemaDigests = new Map<string, string>();
const pollTimers = new Map<string, NodeJS.Timeout>();

/** Read the engine's catalog in the background. Never awaited by connect: a slow or refused read
 *  must not delay a connection, and its only effect is that completion knows more once it lands. */
function loadCatalog(connectionId: string, driver: DatabaseDriver): void {
	if (!driver.introspectCatalog) {
		return;
	}
	void driver.introspectCatalog().then(
		(catalog) => {
			// The connection may have gone (or been replaced) while the read was in flight.
			if (activeDrivers.get(connectionId) === driver) {
				catalogCache.set(connectionId, catalog);
				connection.console.log(`[snout] catalog for '${connectionId}': ${catalog.functions.length} functions, ${catalog.settings.length} settings`);
			}
		},
		(err: unknown) => connection.console.log(`[snout] catalog read failed for '${connectionId}': ${err instanceof Error ? err.message : String(err)}`),
	);
}

async function captureDigest(connectionId: string, driver: DatabaseDriver): Promise<void> {
	schemaDigests.set(connectionId, await driver.structuralDigest().catch(() => ''));
}

async function pollSchema(connectionId: string, driver: DatabaseDriver): Promise<void> {
	try {
		const digest = await driver.structuralDigest();
		if (digest !== schemaDigests.get(connectionId)) {
			schemaDigests.set(connectionId, digest);
			const tableCount = await introspectInto(connectionId, driver);
			connection.console.log(`[snout] schema change on '${connectionId}'; recached ${tableCount} tables`);
		}
	} catch (err) {
		connection.console.log(`[snout] schema poll failed for '${connectionId}': ${err instanceof Error ? err.message : String(err)}`);
	}
}

function startSchemaPolling(connectionId: string, driver: DatabaseDriver): void {
	stopSchemaPolling(connectionId);
	const timer = setInterval(() => { void pollSchema(connectionId, driver); }, POLL_INTERVAL_MS);
	timer.unref();
	pollTimers.set(connectionId, timer);
}

function stopSchemaPolling(connectionId: string): void {
	const timer = pollTimers.get(connectionId);
	if (timer) {
		clearInterval(timer);
		pollTimers.delete(connectionId);
	}
}

// editor → LSP → driver → schema cache
// Tear down any state held for a connection id: stop polling, drop the digest, disconnect
// the driver (best-effort — a dead driver still needs its tunnel/listener freed) and clear
// the cache. Shared by Disconnect and by Connect, which must reclaim a prior (possibly
// silently-dead) driver before standing up a new one, or the old pool + SSH tunnel + local
// listener leak and a fixed local port collides on the reconnect.
async function teardown(connectionId: string): Promise<void> {
	stopSchemaPolling(connectionId);
	schemaDigests.delete(connectionId);
	await activeDrivers.get(connectionId)?.disconnect().catch(() => undefined);
	activeDrivers.delete(connectionId);
	schemaCache.delete(connectionId);
	catalogCache.delete(connectionId);
}

// Serialize the lifecycle requests (connect/disconnect/refresh) per connection id so they
// run strictly one-at-a-time. Without this, a disconnect (e.g. the client heartbeat firing
// the instant it sees a dead socket) could interleave with an in-flight reconnect and call
// pool.end() on the brand-new pool the connect just stood up — the next pool op then throws
// "Pool is closed." and the connect fails (a transient that "works on retry"). Ops on
// different ids stay concurrent; only same-id ops queue.
const connLocks = new Map<string, Promise<unknown>>();
function withConnLock<T>(connectionId: string, op: () => Promise<T>): Promise<T> {
	const prev = connLocks.get(connectionId) ?? Promise.resolve();
	// Run `op` once `prev` settles, whether it resolved or rejected.
	const run = prev.then(op, op);
	// The next op waits for this one's settling; swallow here so one failure can't poison the chain.
	connLocks.set(connectionId, run.then(() => undefined, () => undefined));
	return run;
}

connection.onRequest(SnoutProtocol.Connect, (params: ConnectParams): Promise<ConnectResult> =>
	withConnLock(params.config.id, async (): Promise<ConnectResult> => {
		const { config } = params;
		await teardown(config.id);
		const driver = createDriver(config.driver); // pluggable: resolves 'mysql-aurora', etc.
		await driver.connect(config);
		activeDrivers.set(config.id, driver);
		const tableCount = await introspectInto(config.id, driver);
		await captureDigest(config.id, driver);
		startSchemaPolling(config.id, driver);
		loadCatalog(config.id, driver);
		connection.console.log(`[snout] connected '${config.label}'; cached ${tableCount} tables`);
		return { connectionId: config.id, tableCount };
	}),
);

connection.onRequest(SnoutProtocol.Disconnect, (connectionId: string): Promise<void> =>
	withConnLock(connectionId, () => teardown(connectionId)),
);

connection.onRequest(SnoutProtocol.RefreshSchema, (connectionId: string): Promise<ConnectResult> =>
	withConnLock(connectionId, async (): Promise<ConnectResult> => {
		const driver = activeDrivers.get(connectionId);
		if (!driver) {
			throw new Error(`snout/refreshSchema: '${connectionId}' is not connected`);
		}
		const tableCount = await introspectInto(connectionId, driver);
		await captureDigest(connectionId, driver);
		return { connectionId, tableCount };
	}),
);

connection.onRequest(SnoutProtocol.GetSchema, (params: GetSchemaParams): GetSchemaResult =>
	schemaCache.get(params.connectionId) ?? null,
);

// The failure-memory write path keys records on the schema's structural fingerprint. Serve the
// digest the live schema index already keeps in memory (captured on connect/refresh, refreshed by
// the poll) rather than recomputing it — an empty string means we have none yet for this id.
connection.onRequest(SnoutProtocol.GetSchemaDigest, (params: GetSchemaDigestParams): GetSchemaDigestResult =>
	schemaDigests.get(params.connectionId) ?? '',
);

// Transient connect → ping → disconnect, without touching the cache or active set.
// A file database (SQLite, DuckDB) is opened read-only so a Test never creates one (testConnection.ts).
connection.onRequest(SnoutProtocol.TestConnection, (params: TestConnectionParams): Promise<TestConnectionResult> =>
	testConnection(params.config, createDriver),
);

// Do these cloud credentials sign in to a log service, before any region, workspace or project is
// chosen (Settings → Cloud accounts → Test, when main has no storage or log-source driver to try).
connection.onRequest(SnoutProtocol.VerifyCloudAccount, async (params: VerifyCloudAccountParams): Promise<VerifyCloudAccountResult> => {
	const plugin = telemetryPlugin(params.service);
	if (!plugin) {
		return { ok: false, message: `${params.service} is not in this build.` };
	}
	const session = plugin.open(params.account, params.secret, params.account.region ?? '');
	try {
		await session.verifyAccount();
		return { ok: true };
	} catch (err) {
		return { ok: false, message: plugin.explain(err, params.account) };
	} finally {
		session.close();
	}
});

// editor → LSP → driver → rows. A SQL error returns { ok:false } so the results
// grid can render it in place rather than surfacing a raw request rejection.
connection.onRequest(SnoutProtocol.ExecuteQuery, async (params: ExecuteQueryParams): Promise<ExecuteQueryResult> => {
	const driver = activeDrivers.get(params.connectionId);
	if (!driver) {
		return { ok: false, error: `'${params.connectionId}' is not connected` };
	}
	try {
		const result = await driver.execute(params.query);
		return { ok: true, result };
	} catch (err) {
		if (err instanceof QueryCancelledError) {
			return { ok: false, error: err.message, cancelled: true };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});

// Stream a file into a table. The driver owns the socket and the file handle; everything about
// WHAT runs (the format, the statement) was decided by the engine before the call got here.
connection.onRequest(SnoutProtocol.BulkLoad, async (params: BulkLoadParams): Promise<BulkLoadOutcome> => {
	const driver = activeDrivers.get(params.connectionId);
	if (!driver) {
		return { ok: false, error: `'${params.connectionId}' is not connected` };
	}
	if (!driver.bulkLoad) {
		return { ok: false, error: `${driver.displayName} cannot be handed a file; its rows go in as INSERT statements.` };
	}
	try {
		return { ok: true, result: await driver.bulkLoad(params.request) };
	} catch (err) {
		if (err instanceof QueryCancelledError) {
			return { ok: false, error: err.message, cancelled: true };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});

// The same, outward: the result goes to a file the driver writes, never through this process.
connection.onRequest(SnoutProtocol.BulkExport, async (params: BulkExportParams): Promise<BulkExportOutcome> => {
	const driver = activeDrivers.get(params.connectionId);
	if (!driver) {
		return { ok: false, error: `'${params.connectionId}' is not connected` };
	}
	if (!driver.bulkExport) {
		return { ok: false, error: `${driver.displayName} cannot write a result to a file itself.` };
	}
	try {
		return { ok: true, result: await driver.bulkExport(params.request) };
	} catch (err) {
		if (err instanceof QueryCancelledError) {
			return { ok: false, error: err.message, cancelled: true };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});

// Cancel the query in flight on a connection (best-effort; no-op if none or unknown).
connection.onRequest(SnoutProtocol.CancelQuery, async (connectionId: string): Promise<void> => {
	await activeDrivers.get(connectionId)?.cancel().catch(() => undefined);
});

// How far the query in flight has got (polled by the renderer while a run is in flight). Never
// throws: progress is a nicety, and a failed read is just "no progress to show".
connection.onRequest(SnoutProtocol.QueryProgress, async (connectionId: string): Promise<QueryProgress | null> => {
	return (await activeDrivers.get(connectionId)?.progress?.().catch(() => null)) ?? null;
});

// Liveness probe — main's heartbeat (and resume/focus re-checks) call this to tell a
// still-live connection from one whose pooled socket died silently. Returning an envelope
// rather than throwing keeps the call out of the JSON-RPC error path so a routine "dead"
// answer doesn't pollute the IPC error surface.
connection.onRequest(SnoutProtocol.PingConnection, async (connectionId: string): Promise<PingConnectionResult> => {
	const driver = activeDrivers.get(connectionId);
	if (!driver) {
		return { ok: false, error: 'not connected' };
	}
	try {
		await driver.ping();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
});

// schema cache + cursor context → completion. The analyzer resolves the statement's
// FROM clause so columns are scoped to in-scope tables and `alias.` resolves to that
// table's columns; resolve enriches the previewed item with markdown docs.
// Scope schema to the editor's active connection when the renderer supplies one;
// otherwise fall back to every cached schema. Without this, having more than one
// connection open shows each table duplicated (once per connection's schema).
function schemasFor(connectionId: string | undefined): DatabaseSchema[] {
	if (connectionId) {
		const schema = schemaCache.get(connectionId);
		return schema ? [schema] : [];
	}
	return schemaCache.all();
}

connection.onCompletion((params: TextDocumentPositionParams & { connectionId?: string }): CompletionList => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return { items: [], isIncomplete: false };
	}
	const context = analyzeCompletionContext(document.getText(), document.offsetAt(params.position));
	// The connection's driver id decides how a name that needs quoting is spelled when it is
	// inserted (`"…"`, `` `…` ``, `[…]`). A log scope is the case that made this necessary: its name
	// contains slashes, so an unquoted insertion does not parse. The catalog is what the engine
	// itself says it knows: its functions, settings, formats, engines and types.
	const driverId = params.connectionId ? activeDrivers.get(params.connectionId)?.id : undefined;
	const catalog = params.connectionId ? catalogCache.get(params.connectionId) : undefined;
	return buildCompletions(context, schemasFor(params.connectionId), { driverId, catalog });
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => resolveCompletion(item, schemaCache.all(), [...catalogCache.values()]));

// identifier under the cursor → table/column detail from the cached schema.
connection.onHover((params: TextDocumentPositionParams & { connectionId?: string }): Hover | null => {
	const document = documents.get(params.textDocument.uri);
	if (!document) {
		return null;
	}
	const catalog = params.connectionId ? catalogCache.get(params.connectionId) : undefined;
	return buildHover(document.getText(), document.offsetAt(params.position), schemasFor(params.connectionId), catalog);
});

documents.listen(connection);
connection.listen();

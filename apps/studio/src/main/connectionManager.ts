/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';

import type { ConnectionConfig, SshTunnelConfig } from '../shared/connection';
import { clampPoolMax } from '../shared/connection';
import { backendKindForDriver, buildPlan, DATA_ACCESS_LEVELS, canonicalizeQuery, describeNative, destructiveStatement, dialectFor, isNotConnected, looksLikeConnectionLoss, profileFor, readOnlyEscape, redactSqlSecrets, serverExportRefusal, retrieveMemory, type ApplyMigrationResult, type ApplyStatement, type BackendKind, type BulkExportRequest, type BulkLoadRequest, type FailureQuery, type MongoDdl, type MongoWrite, type NativeQuery, type SchemaDiffResult } from '../shared/engine';
import type { ConnectionFormValues, ConnectionsState } from '../shared/forms';
import type { BulkExportOutcome, BulkLoadOutcome, ConnectResult, ExecuteQueryResult, GetSchemaResult, TestConnectionResult, TranscribeResult } from '../shared/protocol';
import type { DatabaseSchema } from '../shared/schema';
import { compileSqlDeterministic, transcribeFailureMessage } from './transcribe';
import { BackgroundGate } from './backgroundGate';
import { componentRequiredError } from '../shared/components';
import type { ComponentStore } from './componentStore';
import { applyAwsSecret } from './awsSecrets';
import { resolveSsl } from './sslCerts';
import { readConnections, removeConnection, writeConnection } from './configStore';
import { getTunnel, readTunnels, tunnelSecretId, writeTunnel } from './tunnelStore';
import { connectionMoves, dropMovedSecrets, moveUriPasswords, secretsToDrop, type ConnectionSecret } from './connectionSecrets';
import { liftUriPassword } from '../shared/connectionUri';
import { tunnelEndpoint, type TunnelEndpoint } from '../shared/connectionDestination';
import { forgetHostKey, knownHostKey, rememberHostKey } from './sshKnownHosts';
import type { SecretStore } from './secretStore';
import type { CloudAccount } from '../shared/cloud';
import type { SqlServer } from './sqlServer';
import type { QueryStore } from './queryStore';
import type { FailureMemory } from './failureMemory';
import type { QueryProgress } from '../shared/query';

/**
 * Connection lifecycle on top of {@link SqlServer}: persists non-secret config
 * (configStore) and secrets (secretStore) separately, resolves secrets before
 * connecting, tracks which connections are live, and fires `onChange` so the sidebar
 * refreshes. Ported from the original VSCode extension's ConnectionManager, with the VSCode client
 * swapped for our stdio server bridge and SecretStorage swapped for safeStorage.
 */
/**
 * Priority of an execute. `interactive` (the default) is a user-facing query and is never
 * throttled. `background` is app-driven polling (monitors) that must not be able to occupy the
 * whole connection pool — it's gated so at least one pool slot always stays reachable by an
 * interactive query. A main-only concept: it never crosses the wire to the server.
 */
export type QueryPriority = 'interactive' | 'background';


/** Drivers whose npm client a development build may not have, by the module it would otherwise
 *  load (see `componentEnforced`). SAP's HANA client is no dependency at all. `ibm_db` is an optional
 *  one that the open-source tree does not install, since its install script downloads IBM's driver
 *  without showing IBM's licence; without it a development build takes the Db2 component, licence
 *  first, as a user does. */
const COMPONENT_ONLY_DEV_MODULES: Record<string, string> = { hana: '@sap/hana-client', db2: 'ibm_db' };

/**
 * Why `sql` may not run on a connection flagged read-only, or undefined. A write is blocked, and so
 * is what steps out of the read-only run every statement there is sent in (`readOnlyEscape`):
 * ending its transaction, or turning read-only off, would let the next statement write.
 */
function readOnlyBlock(sql: string, config: ConnectionConfig): string | undefined {
	const verb = destructiveStatement(sql, config.driver)?.verb ?? readOnlyEscape(sql, config.driver);
	return verb ? `Connection "${config.label}" is read-only; ${verb} is blocked.` : undefined;
}

/** What {@link ConnectionManager} is handed instead of importing it. */
export interface ConnectionManagerHooks {
	readConfigs?: () => ConnectionConfig[];
	/** Upsert one saved connection (configStore's writeConnection; a test records it instead). */
	writeConnection?: (config: ConnectionConfig) => void;
	/** A person used the app today (installHeartbeat's markActive). */
	markActive?: () => void;
}

/** Options for {@link ConnectionManager.save}. */
export interface SaveOptions {
	/** The values came from an import (another tool's saved connections), not from the user's form. */
	imported?: boolean;
	/**
	 * A person saved this from the connection form. Only this save confirms an imported connection
	 * that was held until someone looked at it; a save by the assistant or an agent (edit_connection)
	 * goes through the plain IPC, which never sets it.
	 */
	confirmedByPerson?: boolean;
}

/**
 * Why an imported connection whose credentials come from AWS Secrets Manager does not connect yet.
 * Its host, port and secret were written by whatever file it was imported from, and connecting
 * fetches the secret with the user's own AWS credentials, so a person looks at it once first.
 */
export function unconfirmedAwsSecretMessage(config: Pick<ConnectionConfig, 'label' | 'host' | 'port' | 'awsSecret'>): string {
	const where = config.host ? ` and sends them to ${config.host}${config.port ? `:${config.port}` : ''}` : '';
	return `"${config.label}" was imported and fetches its credentials from AWS Secrets Manager (secret "${config.awsSecret?.secretId ?? ''}")${where}. Open it with Edit, check where it connects, and Save it before connecting.`;
}

/** Why an imported connection that goes through an SSH tunnel does not connect yet: the tunnel's
 *  server and key came from another tool's file, so a person looks at it once first. */
export function unconfirmedSshTunnelMessage(config: Pick<ConnectionConfig, 'label' | 'sshTunnel'>, tunnel: { host: string; port: number } | undefined): string {
	const where = tunnel ? ` to ${tunnel.host}:${tunnel.port}` : '';
	return `"${config.label}" was imported and connects through an SSH tunnel${where}, signing in with your own SSH key. Open it with Edit, check where it connects, and Save it before connecting.`;
}

export class ConnectionManager {
	private readonly readConfigs: () => ConnectionConfig[];
	private readonly writeConnection: (config: ConnectionConfig) => void;
	private readonly markActive: () => void;
	private readonly connected = new Set<string>();
	// Per-connection idle timers; a connection auto-disconnects when its timer fires.
	private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// How long a connection may sit without a query before it's dropped (0 disables). The
	// renderer pushes the user's configured value at startup; 4h is the default until then.
	private idleTimeoutMs = 4 * 60 * 60 * 1000;
	// Heartbeat: ping every live connection on this interval; on failure, mark the
	// connection dropped and broadcast. Catches silent socket deaths (wait_timeout, NLB
	// idle, OS sleep) so the UI's "connected" dot stops lying. 30s sits comfortably under
	// typical NLB idle (60–350s) and well below MySQL's default wait_timeout.
	private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	// Set true while a recheck is mid-flight per connection, so overlapping triggers
	// (heartbeat tick + focus + resume firing together) collapse into a single probe.
	private readonly probeInFlight = new Set<string>();
	// Connections with a connect() in flight. The heartbeat probe skips these so a tick
	// that fires mid-reconnect can't ping (and then tear down) a driver that's still being
	// stood up — the probe would see the old/absent driver and disconnect the new one.
	private readonly connecting = new Set<string>();
	// The in-flight connect() promise per connection, so overlapping connect calls (a slow-tunnel
	// auto-connect the renderer already kicked off + a query's reconnect-and-replay) share ONE
	// handshake instead of racing. dispatch() awaits this so a run that lands mid-connect waits for
	// the connection to come up rather than failing with a premature "not connected".
	private readonly connectInFlight = new Map<string, Promise<ConnectResult>>();
	// The AI half of the hybrid SQL→native transcriber, late-bound by main after AiService is
	// constructed (it depends on this manager, so the wiring can't be a ctor arg).
	// Used as the fallback when the deterministic `sqlToMongo` compiler can't represent a query.
	private aiTranscriber?: (sql: string, connectionId: string) => Promise<NativeQuery>;
	// Text → embedding vector, late-bound by main from AiService. Only a vector query built from an
	// explicit `similar_to('…')` predicate uses it: the user asking for a similarity search IS the
	// consent, the same way the "Get pipeline translation" click is.
	private embedder?: (text: string) => Promise<number[]>;
	/** The CURRENT password of a SnoutData Cloud project, from the control plane. Late-bound by main. */
	private cloudPassword?: (ref: string) => Promise<string | null>;
	// A saved cloud account + its keychain secret, by id — late-bound by main from CloudService.
	// Late-bound rather than a ctor arg for the same reason the two above are: it keeps the wiring
	// order in main free, and a build with no telemetry connection never calls it. This is the ONE
	// place a telemetry connection's credential is looked up, and what it produces goes to the
	// server child resolved, exactly as a DB password does.
	private cloudAccounts?: (id: string) => { account: CloudAccount; secret: string | undefined } | undefined;
	// The failure-memory write sink, late-bound by main.
	// Every executor's failure verdict funnels through here — this manager is the single choke point.
	private failureMemory?: FailureMemory;
	// The failure-memory READ seam (the store, as a query interface), late-bound by main. Used to
	// surface a caution when the assistant is grounding on a query whose shape has failed before.
	private failureQuery?: FailureQuery;
	// Background-execute reservation: caps concurrent background queries per connection so
	// app-driven polling (monitors) can't consume every pool connection and stall an interactive
	// query. Interactive runs never touch it.
	private readonly bgGate = new BackgroundGate();
	private queriesRunning = 0;

	constructor(
		private readonly server: SqlServer,
		private readonly secrets: SecretStore,
		private readonly queries: QueryStore,
		private readonly onChange: () => void,
		// Fired when the manager creates a tunnel profile (auto-promoting an inline tunnel), so
		// the renderer's tunnel pickers refresh. Defaults to a no-op for callers that don't care.
		private readonly onTunnelsChange: () => void = () => {},
		// Resolves on-demand native-driver components (Db2's ibm_db sidecar runtime). Omitted in
		// tests. When a required component is missing, connect throws a component-required sentinel
		// the renderer turns into a download prompt — but only when `enforceComponents` is set
		// (packaged builds); in dev the sidecar's env-based fallback handles a locally-installed
		// client, so the gate is skipped.
		private readonly components?: ComponentStore,
		private readonly enforceComponents = false,
		// What the manager is handed rather than imports: the saved connections (read from userData
		// on every call; a test hands its own), and the daily activity mark (installHeartbeat's
		// markActive), which reaches Electron and the crash reporter and so stays out of a test.
		hooks: ConnectionManagerHooks = {},
	) {
		this.readConfigs = hooks.readConfigs ?? readConnections;
		this.writeConnection = hooks.writeConnection ?? writeConnection;
		this.markActive = hooks.markActive ?? (() => {});
		this.startHeartbeat();
		// A tunnel that trusted an SSH host key for the first time: remember it, so every later
		// connect through that host and port is held to it.
		this.server.onSshHostKeyLearned(({ host, port, fingerprint }) => {
			try {
				rememberHostKey(host, port, fingerprint);
			} catch (err) {
				console.error('[ssh] could not remember the host key:', err);
			}
		});
	}

	/**
	 * Hand the tunnel the SSH host key remembered for its host and port, so a different key is
	 * refused. With none remembered the tunnel trusts the key it sees and reports it back.
	 */
	private attachHostKey(config: ConnectionConfig): ConnectionConfig {
		if (config.sshTunnel) {
			config.sshTunnel = { ...config.sshTunnel, hostKeyFingerprint: knownHostKey(config.sshTunnel.host, config.sshTunnel.port) };
		}
		return config;
	}

	/** The SSH host and port a connection form tunnels through, inline or by saved profile. */
	private formTunnelHost(form: ConnectionFormValues): { host: string; port?: number } | undefined {
		if (form.ssh?.host) {
			return { host: form.ssh.host, port: form.ssh.port };
		}
		if (form.sshTunnelRef) {
			const profile = getTunnel(form.sshTunnelRef);
			return profile ? { host: profile.host, port: profile.port } : undefined;
		}
		return undefined;
	}

	/** The form asked to forget the saved host key ("the server was rebuilt"): drop it, so the
	 *  next connect trusts the new key. */
	private applyForgetHostKey(form: ConnectionFormValues): void {
		if (!form.forgetSshHostKey) {
			return;
		}
		const target = this.formTunnelHost(form);
		if (target) {
			forgetHostKey(target.host, target.port);
		}
	}

	/**
	 * For a native-driver connection, attach the resolved {@link NativeRuntime} (stock-Node binary
	 * + native module path) from its installed components so the server's sidecar can spawn. Throws
	 * the component-required sentinel when a packaged build is missing the download. A no-op for
	 * ordinary (pure-JS) drivers and in dev (env fallback covers a locally-installed client).
	 */
	private attachRuntime(config: ConnectionConfig): ConnectionConfig {
		if (!this.components) {
			return config;
		}
		const runtime = this.components.runtimeFor(config.driver);
		if (runtime) {
			config.nativeRuntime = runtime;
			return config;
		}
		if (this.components.requiredFor(config.driver) && this.componentEnforced(config.driver)) {
			throw componentRequiredError(config.driver);
		}
		return config;
	}

	/**
	 * Whether a native driver must come from its downloaded component here. Always in a packaged
	 * build. In development a driver's npm client is used instead, EXCEPT one this checkout does not
	 * have: SAP's HANA client is not open source, so it is no dependency of the open tree, and the
	 * open tree does not install `ibm_db`; a development build without one gets it the way a user does.
	 */
	private componentEnforced(driver: string): boolean {
		if (this.enforceComponents) {
			return true;
		}
		const devModule = COMPONENT_ONLY_DEV_MODULES[driver];
		if (!devModule) {
			return false;
		}
		try {
			require.resolve(devModule);
			return false;
		} catch {
			return true;
		}
	}

	state(): ConnectionsState {
		return { connections: this.readConfigs(), connectedIds: [...this.connected] };
	}

	/**
	 * The connection's structural schema fingerprint (the digest the live schema index keeps),
	 * or '' when unknown/not connected. Cheap and non-blocking (served from the server's in-memory
	 * cache, no database round-trip), so the failure-memory write path can read it fire-and-forget.
	 */
	async schemaDigest(connectionId: string): Promise<string> {
		try {
			return await this.server.getSchemaDigest(connectionId);
		} catch {
			return '';
		}
	}

	/** Probe every live connection now (heartbeat tick, OS resume, window focus). */
	async recheckAll(): Promise<void> {
		await Promise.all([...this.connected].map((id) => this.probe(id)));
	}

	/** Ping one connection; if the probe fails, mark it disconnected and notify. */
	private async probe(id: string): Promise<void> {
		if (this.probeInFlight.has(id) || this.connecting.has(id) || !this.connected.has(id)) {
			return;
		}
		this.probeInFlight.add(id);
		try {
			const result = await this.server.ping(id);
			// If a (re)connect started while this probe was in flight, it now owns the driver —
			// don't tear down the connection it's standing up (the stale-disconnect-vs-reconnect race).
			if (!result.ok && this.connected.has(id) && !this.connecting.has(id)) {
				// The driver reported dead. Drop our live flag and tell the server too so
				// its activeDrivers map and schema cache don't carry a phantom entry.
				this.connected.delete(id);
				this.clearIdle(id);
				await this.server.disconnect(id).catch(() => undefined);
				this.onChange();
			}
		} catch {
			// LSP transport hiccup: skip this tick; the next probe will retry.
		} finally {
			this.probeInFlight.delete(id);
		}
	}

	private startHeartbeat(): void {
		if (this.heartbeat) {
			return;
		}
		this.heartbeat = setInterval(() => { void this.recheckAll(); }, ConnectionManager.HEARTBEAT_INTERVAL_MS);
		// The heartbeat shouldn't, by itself, keep the process alive.
		this.heartbeat.unref?.();
	}

	async connect(id: string): Promise<ConnectResult> {
		// Coalesce concurrent connects onto one handshake: a slow tunnel means the renderer's
		// auto-connect can still be in flight when a query triggers reconnect-and-replay, and
		// both should await the SAME connect rather than opening two drivers (or the second
		// bailing early). Any caller gets the in-flight result.
		const inFlight = this.connectInFlight.get(id);
		if (inFlight) {
			return inFlight;
		}
		const promise = this.doConnect(id);
		this.connectInFlight.set(id, promise);
		try {
			return await promise;
		} finally {
			this.connectInFlight.delete(id);
		}
	}

	private async doConnect(id: string): Promise<ConnectResult> {
		// Mark the connect in flight so a concurrent heartbeat probe doesn't tear down the
		// driver mid-handshake (see {@link probe}).
		this.connecting.add(id);
		try {
			const result = await this.connectOnce(id).catch(async (error: unknown) => {
				const config = this.require(id);
				const refused = /password authentication failed/i.test(error instanceof Error ? error.message : String(error));
				const fresh = refused && config.cloudProjectRef && this.cloudPassword
					? await this.cloudPassword(config.cloudProjectRef).catch(() => null)
					: null;
				if (!fresh || fresh === this.secrets.get(id, 'password')) {
					throw error;
				}
				this.secrets.store(id, 'password', fresh);
				return this.connectOnce(id);
			});
			this.connected.add(id);
			this.armIdle(id);
			this.onChange();
			return result;
		} finally {
			this.connecting.delete(id);
		}
	}

	private async connectOnce(id: string): Promise<ConnectResult> {
		return this.server.connect(this.attachHostKey(this.attachRuntime(await this.resolveSecrets(this.require(id)))));
	}

	/**
	 * Cancel a slow connect the user gave up on. Just a plain disconnect: the underlying driver
	 * handshake can't be interrupted mid-flight (it's serialized on the server behind the connect
	 * lock), so this queues behind an in-flight connect and tears the driver down the moment it
	 * lands — keeping `connected` and the server's driver map in lock-step either way, so a
	 * cancel can never leave a phantom "connected" connection with no driver behind it.
	 */
	async cancelConnect(id: string): Promise<void> {
		await this.disconnect(id).catch(() => undefined);
	}

	async disconnect(id: string): Promise<void> {
		await this.server.disconnect(id);
		this.connected.delete(id);
		this.clearIdle(id);
		this.onChange();
	}

	/** Set the idle auto-disconnect window (ms; 0 disables) and re-arm live connections. */
	setIdleTimeout(ms: number): void {
		this.idleTimeoutMs = Math.max(0, ms);
		for (const id of this.connected) {
			this.armIdle(id);
		}
	}

	/** (Re)start a connection's idle timer, replacing any prior one. No-op when disabled. */
	private armIdle(id: string): void {
		this.clearIdle(id);
		if (this.idleTimeoutMs <= 0 || !this.connected.has(id)) {
			return;
		}
		const timer = setTimeout(() => {
			this.idleTimers.delete(id);
			void this.disconnect(id).catch(() => undefined);
		}, this.idleTimeoutMs);
		// An idle-disconnect timer shouldn't, by itself, keep the process from exiting.
		timer.unref?.();
		this.idleTimers.set(id, timer);
	}

	private clearIdle(id: string): void {
		const timer = this.idleTimers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.idleTimers.delete(id);
		}
	}

	refresh(id: string): Promise<ConnectResult> {
		return this.server.refresh(id);
	}

	getSchema(id: string): Promise<GetSchemaResult> {
		return this.server.getSchema(id);
	}

	/** Wire the AI transcription fallback, late-bound by main once AiService
	 *  exists. Called only when the deterministic `sqlToMongo` compiler rejects a query. */
	/** Late-bind how a `cloudAccountId` on a connection becomes a real account plus its secret.
	 *  Wired by main from `CloudService`; without it a telemetry connection reports that its
	 *  account could not be found, which is also what happens when the account was deleted. */
	setCloudAccounts(resolve: (id: string) => { account: CloudAccount; secret: string | undefined } | undefined): void {
		this.cloudAccounts = resolve;
	}

	/**
	 * Where a cloud connection's password is read again when the database refuses the stored one.
	 *
	 * A reset made anywhere but this app (the dashboard, the CLI, an agent's `reset_password`)
	 * left the keychain copy stale, and the connection failed with "password authentication
	 * failed" until the person re-imported it. The control plane holds the current one for the
	 * signed-in owner, so a refusal reads it, stores it, and connects again once.
	 */
	setCloudPassword(fn: ((ref: string) => Promise<string | null>) | undefined): void {
		this.cloudPassword = fn;
	}

	setAiTranscriber(fn: ((sql: string, connectionId: string) => Promise<NativeQuery>) | undefined): void {
		this.aiTranscriber = fn;
	}

	/** Wire the text→vector embedder, late-bound by main like the transcriber.
	 *  Without one, a `similar_to('…')` query fails with a message naming the missing model. */
	setEmbedder(fn: ((text: string) => Promise<number[]>) | undefined): void {
		this.embedder = fn;
	}

	/** The connection's introspected schema for the compilers, or null. Served from the server
	 *  child's in-memory cache (no database round-trip) and best-effort: a miss just means the
	 *  compiler works schema-blind, never that the query fails. */
	private async compileSchema(id: string): Promise<DatabaseSchema | null> {
		try {
			return (await this.server.getSchema(id)) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Turn a `similar_to('…')` predicate into a real query vector. Runs after compilation and before
	 * dispatch, because only main can reach the embeddings model. A query without one is returned
	 * untouched, so this costs nothing on every other path.
	 */
	private async resolveEmbedding(native: NativeQuery): Promise<NativeQuery> {
		if (native.lang !== 'pinecone' || native.query.embedText === undefined) {
			return native;
		}
		if (!this.embedder) {
			throw new Error('Similarity search needs an embeddings model, which this build has no access to yet.');
		}
		const { embedText, ...rest } = native.query;
		const vector = await this.embedder(embedText);
		return { ...native, query: { ...rest, vector } };
	}

	/** Wire the failure-memory sink, late-bound by main (it resolves the schema fingerprint via
	 *  this manager, so it can't be a ctor arg). Optional: with none wired, the emit is a no-op. */
	setFailureMemory(memory: FailureMemory): void {
		this.failureMemory = memory;
	}

	/** Wire the failure-memory read seam (the store), late-bound by main. Optional: with none wired,
	 *  {@link retrieveFailureNote} always returns null. */
	setFailureQuery(query: FailureQuery): void {
		this.failureQuery = query;
	}

	/**
	 * A caution from failure memory for a query the user is about to run on this connection, or null.
	 * Gates on the connection's schema fingerprint + backend and ranks by canonical query shape (see
	 * shared/engine/memory/failureRetrieval). Non-blocking and best-effort: any failure degrades to null so the
	 * assistant path is never disturbed by memory.
	 */
	async retrieveFailureNote(connectionId: string, query: string): Promise<string | null> {
		if (!this.failureQuery || !query.trim()) {
			return null;
		}
		try {
			const config = this.readConfigs().find((entry) => entry.id === connectionId);
			const backend = backendKindForDriver(config?.driver);
			const fingerprint = await this.schemaDigest(connectionId);
			const hit = retrieveMemory(this.failureQuery, fingerprint, backend, canonicalizeQuery(query));
			return hit ? hit.note : null;
		} catch {
			return null;
		}
	}

	/**
	 * Emit one failure verdict to the memory sink. Fire-and-forget: the sink never throws or blocks,
	 * so a memory write can never disturb the query flow. A no-op until a sink is wired.
	 */
	/** Remember a failed statement so the assistant can learn from it. Redacted first, for the
	 *  same reason history is: failure memory is persisted, and a statement fails just as often
	 *  WITH a password in it as without. */
	private rememberFailure(connectionId: string, query: string, backend: BackendKind, error: string, origin: 'execution' | 'translation'): void {
		this.failureMemory?.record({ connectionId, query: redactSqlSecrets(query), backend, ok: false, error, origin });
	}

	/**
	 * Translate a SQL string to the connection's native query form WITHOUT running it (the editor's
	 * "Get pipeline translation" action). Deterministic-first; the AI step is gated the same way as
	 * {@link execute} — `allowAiTranscribe` must be true to spend budget, else an AI-recoverable miss
	 * returns `needsAiTranscribe` so the caller can ask. Relational connections have no translation.
	 */
	async transcribeOnly(id: string, sql: string, allowAiTranscribe = false): Promise<TranscribeResult> {
		const config = this.readConfigs().find((entry) => entry.id === id);
		const kind = backendKindForDriver(config?.driver);
		if (kind === 'relational') {
			return { ok: false, error: 'This connection runs SQL directly, so there is no pipeline translation.' };
		}
		const det = compileSqlDeterministic(kind, sql, await this.compileSchema(id));
		if (det.ok) {
			return { ok: true, native: det.native };
		}
		if (det.aiRecoverable && this.aiTranscriber && allowAiTranscribe) {
			try {
				return { ok: true, native: await this.aiTranscriber(sql, id) };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		if (det.aiRecoverable && this.aiTranscriber) {
			return { ok: false, needsAiTranscribe: true, error: det.message };
		}
		return { ok: false, error: transcribeFailureMessage(kind, det) };
	}

	/** Wrap a SQL string as a `NativeQuery` and dispatch it to the server. The single place the
	 *  relational SQL-as-NativeQuery wrapping happens; non-SQL backends transcribe before here. */
	private runSql(id: string, sql: string, readOnly = false): Promise<ExecuteQueryResult> {
		return this.server.execute({ connectionId: id, query: readOnly ? { lang: 'sql', sql, readOnly } : { lang: 'sql', sql } });
	}

	/** Run one statement. `recordHistory` is false for the MCP path: an agent's queries go to
	 *  the separate MCP log (mcpLogStore), never the user's own query history. */
	async execute(id: string, sql: string, recordHistory = true, allowAiTranscribe = false, priority: QueryPriority = 'interactive', window?: { start: number; end: number }): Promise<ExecuteQueryResult> {
		return this.executeAs(id, sql, recordHistory, allowAiTranscribe, priority, window, false);
	}

	/**
	 * Run one statement the app has promised is a READ: the agent broker's read tools and the
	 * assistant's run_query, after the lexical guard (`readOnlyError`) has passed it. The statement
	 * is also sent with `readOnly`, so the database itself refuses a write where the engine can
	 * (`readOnlyEnforcement`): a SELECT that calls a writing function fails at the database instead
	 * of running. A connection flagged read-only gets the same for every statement (dispatchInner).
	 */
	async executeRead(id: string, sql: string, recordHistory = true, priority: QueryPriority = 'interactive'): Promise<ExecuteQueryResult> {
		return this.executeAs(id, sql, recordHistory, false, priority, undefined, true);
	}

	private async executeAs(id: string, sql: string, recordHistory: boolean, allowAiTranscribe: boolean, priority: QueryPriority, window: { start: number; end: number } | undefined, readOnlyRun: boolean): Promise<ExecuteQueryResult> {
		// Read-only connections: hard-block writes/DDL in main as a defense-in-depth gate
		// (the UI also disables editing affordances). Pure SELECTs pass through.
		const config = this.readConfigs().find((entry) => entry.id === id);
		if (config?.readOnly) {
			const blocked = readOnlyBlock(sql, config);
			if (blocked) {
				return { ok: false, error: blocked };
			}
		}
		// Document/vector backends don't run SQL natively: transcribe the authored SQL to the
		// connection's native query form (Mongo aggregation pipeline) before dispatch. Relational
		// connections pass through unchanged.
		const kind = backendKindForDriver(config?.driver);
		let native: NativeQuery;
		let aiTranslated = false;
		if (kind === 'relational') {
			native = readOnlyRun ? { lang: 'sql', sql, readOnly: true } : { lang: 'sql', sql };
		} else {
			// Deterministic first (free, offline). The AI fallback is a SEPARATE, consent-gated step:
			// every model round-trip spends the user's budget, so we never call it implicitly. When the
			// compiler can't represent the query and an AI translator is available, we signal the
			// renderer (`needsAiTranscribe`) to ask; only a caller that already has consent passes
			// `allowAiTranscribe`: AI transcription is consent-gated.
			const det = compileSqlDeterministic(kind, sql, await this.compileSchema(id), window);
			if (det.ok) {
				native = det.native;
			} else if (det.aiRecoverable && this.aiTranscriber && !allowAiTranscribe) {
				return { ok: false, needsAiTranscribe: true, error: det.message };
			} else if (det.aiRecoverable && this.aiTranscriber && allowAiTranscribe) {
				try {
					native = await this.aiTranscriber(sql, id);
					aiTranslated = true;
				} catch (err) {
					// AI translation was the last resort and it failed too, so the query never ran: a
					// terminal translation failure. The write trigger is still a deterministic verdict
					// (nothing executed), independent of the model's involvement in the attempt. Remember
					// the deterministic compiler's structural reason (the stable signal), not the AI error.
					if (recordHistory) {
						this.rememberFailure(id, sql, kind, det.message, 'translation');
					}
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			} else {
				// No translator wired, or a backend the AI can't recover (e.g. vector). Also terminal:
				// the query couldn't be translated and never ran. Store the raw compiler reason, not the
				// UI-hint suffix. (The consent-ask branch above is NOT recorded — it isn't terminal; the
				// user hasn't decided yet, and approving it re-enters execute with consent.)
				if (recordHistory) {
					this.rememberFailure(id, sql, kind, det.message, 'translation');
				}
				return { ok: false, error: transcribeFailureMessage(kind, det) };
			}
		}
		const result = await this.dispatch(id, native, recordHistory, sql, config, priority);
		// Tag a successful run that went through the model, so the UI can say so (transparency for
		// the always-translate setting, where there's no per-run consent dialog).
		return aiTranslated && result.ok ? { ...result, aiTranslated: true } : result;
	}

	/**
	 * Run an already-built {@link NativeQuery} authored on the native surface (the Mongo pipeline
	 * JSON editor). The destructive/read-only guard goes through the backend's
	 * {@link QueryLanguageProfile} rather than the SQL-only `destructiveStatement`.
	 */
	async executeNative(id: string, native: NativeQuery, recordHistory = true, priority: QueryPriority = 'interactive'): Promise<ExecuteQueryResult> {
		const config = this.readConfigs().find((entry) => entry.id === id);
		if (config?.readOnly && profileFor(backendKindForDriver(config?.driver)).isDestructive(native, config?.driver)) {
			return { ok: false, error: `Connection "${config.label}" is read-only; this query writes data and is blocked.` };
		}
		return this.dispatch(id, native, recordHistory, describeNative(native), config, priority);
	}

	/**
	 * Run a batch of document writes from the editable grid — the document-backend
	 * analog of {@link executeScript}. Wraps the ops as a single `mongo-write` {@link NativeQuery} and
	 * routes through {@link executeNative}, so the read-only guard (writes are always destructive) and
	 * history recording are shared. An empty batch is a no-op success.
	 */
	async executeWrites(id: string, writes: MongoWrite[], recordHistory = true): Promise<ExecuteQueryResult> {
		if (writes.length === 0) {
			return { ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } };
		}
		return this.executeNative(id, { lang: 'mongo-write', writes }, recordHistory);
	}

	/**
	 * Run a batch of document structure ops — the document-backend analog of
	 * {@link executeScript}'s DDL: create/drop a collection, create/drop an index. Wraps them as a
	 * single `mongo-ddl` {@link NativeQuery} through {@link executeNative} (so the read-only/prod
	 * guard and history recording are shared). A structure change, so the caller re-introspects after
	 * it lands. An empty batch is a no-op success.
	 */
	async executeMongoDdl(id: string, ops: MongoDdl[], recordHistory = true): Promise<ExecuteQueryResult> {
		if (ops.length === 0) {
			return { ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } };
		}
		return this.executeNative(id, { lang: 'mongo-ddl', ops }, recordHistory);
	}

	/** Per-connection cap on concurrent background queries: one below the interactive pool size, so
	 *  at least one pooled connection is always left for an interactive query. Never below 1. */
	private bgLimit(config: ConnectionConfig | undefined): number {
		return Math.max(1, clampPoolMax(config?.poolMax) - 1);
	}

	/**
	 * Shared tail of {@link execute}/{@link executeNative}: gate on the background reservation (so
	 * app-driven polling can't starve interactive queries), then run the resolved native query, drop
	 * the live flag on a dead socket, re-arm the idle timer on success, and record history.
	 * `displaySql` is what shows in the history list + results footer (the SQL text, or a shell-style
	 * rendering of a native query via `describeNative`).
	 */
	private async dispatch(id: string, nativeQuery: NativeQuery, recordHistory: boolean, displaySql: string, config: ConnectionConfig | undefined, priority: QueryPriority = 'interactive'): Promise<ExecuteQueryResult> {
		// A similarity search arrives with its query TEXT, not a vector: only main can reach the
		// embeddings model, and the driver would otherwise silently browse instead of searching.
		let native: NativeQuery;
		try {
			native = await this.resolveEmbedding(nativeQuery);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		// An INTERACTIVE query is a person running something; a background one is the monitors
		// poller or a schedule, i.e. the app working by itself, which must never count as usage.
		// That distinction is the whole reason this hook sits here rather than in dispatchInner.
		if (priority === 'interactive') {
			this.markActive();
		}
		this.queriesRunning++;
		try {
			if (priority === 'background') {
				await this.bgGate.acquire(id, this.bgLimit(config));
			}
			try {
				return await this.dispatchInner(id, native, recordHistory, displaySql, config);
			} finally {
				if (priority === 'background') {
					this.bgGate.release(id);
				}
			}
		} finally {
			this.queriesRunning--;
		}
	}

	/** Queries executing (or parked on the background gate) right now, of any priority. The tray's
	 *  background update install waits for this to be zero (trayInstall.ts). */
	queriesInFlight(): number {
		return this.queriesRunning;
	}

	private async dispatchInner(id: string, query: NativeQuery, recordHistory: boolean, displaySql: string, config: ConnectionConfig | undefined): Promise<ExecuteQueryResult> {
		// A connection flagged read-only: the database is asked to refuse writes on EVERY statement,
		// behind the lexical block in execute()/executeScript() (`readOnlyEnforcement`).
		const native: NativeQuery = config?.readOnly && query.lang === 'sql' && !query.readOnly ? { ...query, readOnly: true } : query;
		let result = await this.server.execute({ connectionId: id, query: native });
		// The connection isn't live (the user disconnected, an idle cull dropped it, or a dead socket
		// the pool couldn't rebuild). Because the pool was absent nothing ran, so it's safe to stand the
		// connection back up once and replay — a run after a disconnect just reconnects, instead of
		// surfacing a raw "not connected". connect() coalesces onto any in-flight handshake, so if a
		// slow-tunnel connect is already underway we WAIT for it here (then replay) instead of failing
		// with a premature "not connected" the moment the query lands mid-connect.
		if (!result.ok && isNotConnected(result.error)) {
			try {
				await this.connect(id);
				result = await this.server.execute({ connectionId: id, query: native });
			} catch {
				// Reconnect failed — fall through with the not-connected result; the UI offers reconnect.
			}
		}
		if (!result.ok && looksLikeConnectionLoss(result.error)) {
			// The socket died (and the driver's in-place retry couldn't recover it). Drop
			// our live flag now and notify, so the sidebar dot and the connected-state
			// gating flip immediately instead of lying until the next heartbeat probe.
			if (this.connected.delete(id)) {
				this.clearIdle(id);
				await this.server.disconnect(id).catch(() => undefined);
				this.onChange();
			}
		} else {
			// A successful query is activity — push the idle auto-disconnect back.
			this.armIdle(id);
		}
		if (recordHistory) {
			this.queries.record({
				sql: displaySql,
				connectionId: id,
				connectionLabel: config?.label ?? id,
				environment: config?.environment,
				timestamp: Date.now(),
				outcome: result.ok
					? { ok: true, rowCount: result.result.rowCount, durationMs: result.result.durationMs }
					: { ok: false, error: result.error },
			});
			// Feed the failure sink alongside history (same MCP exclusion: an agent's failures go to
			// the MCP log, not the user's assistant memory). A user cancellation is not a failure to
			// remember, so skip it.
			if (!result.ok && !result.cancelled) {
				this.rememberFailure(id, displaySql, backendKindForDriver(config?.driver), result.error, 'execution');
			}
		}
		return result;
	}

	/**
	 * Run a batch of statements as one logical save (the editable grid's DELETE/UPDATE/INSERT
	 * set). Sending them as a single multi-statement query breaks on MySQL (mysql2 disallows it)
	 * and wouldn't be atomic across the pool anyway, so we run them one at a time on the same
	 * per-driver basis as a migration: Postgres inside a transaction (all-or-nothing), MySQL/SQL
	 * Server statement-by-statement, stopping at the first error. Honors the read-only guard.
	 *
	 * `options` exists for automated writers (Data Flows): `recordHistory: false` keeps a run's
	 * hundreds of INSERT batches out of the user's own query history, and `priority: 'background'`
	 * routes the whole script through the background reservation so it can never starve the
	 * interactive query someone is waiting on. Both default to the interactive, recorded behaviour
	 * every existing caller expects.
	 */
	/**
	 * Load a FILE into a table, as one statement whose body is the file (`engine/dialect/bulkLoad`).
	 *
	 * It does not go through `dispatch`, because there is no `NativeQuery` here and nothing to
	 * transcribe: the engine built the statement, the driver streams the bytes. What it DOES share
	 * with every other write is the read-only gate, counting as activity, and landing in the user's
	 * own query history, because a load is the user's statement and belongs on the same trail.
	 */
	async bulkLoad(id: string, request: BulkLoadRequest): Promise<BulkLoadOutcome> {
		const config = this.readConfigs().find((entry) => entry.id === id);
		if (config?.readOnly) {
			// Not via destructiveStatement: an INSERT is not destructive, and a read-only connection
			// still may not be written to at all.
			return { ok: false, error: `Connection "${config.label}" is read-only; loading a file into it is blocked.` };
		}
		this.markActive();
		this.queriesRunning++;
		let outcome: BulkLoadOutcome;
		try {
			outcome = await this.server.bulkLoad({ connectionId: id, request });
		} finally {
			this.queriesRunning--;
		}
		// The statement, plus the file it was handed, since the statement alone does not say which
		// file went in and history is where someone looks to find out.
		const displaySql = `${request.sql}\n-- from ${request.filePath}`;
		this.queries.record({
			sql: displaySql,
			connectionId: id,
			connectionLabel: config?.label ?? id,
			environment: config?.environment,
			timestamp: Date.now(),
			outcome: outcome.ok
				? { ok: true, rowCount: outcome.result.rowsWritten, durationMs: outcome.result.durationMs }
				: { ok: false, error: outcome.error },
		});
		if (!outcome.ok && !outcome.cancelled) {
			this.rememberFailure(id, request.sql, backendKindForDriver(config?.driver), outcome.error, 'execution');
		}
		if (outcome.ok) {
			this.armIdle(id);
		}
		return outcome;
	}

	/**
	 * A whole result STRAIGHT to a file, written by the server (`engine/dialect/bulkLoad`). The
	 * mirror of {@link bulkLoad}, and history's entry says which file it went to, because the
	 * statement alone does not.
	 *
	 * An export only READS, on every connection: the statement is the editor's, so one that writes is
	 * refused here before the server sees it (`serverExportRefusal`), and the driver also asks the
	 * server to refuse a write where it can. A read-only connection may export a read.
	 */
	async bulkExport(id: string, request: BulkExportRequest): Promise<BulkExportOutcome> {
		const config = this.readConfigs().find((entry) => entry.id === id);
		const refusal = serverExportRefusal(request.sql, config?.driver, config?.flavor);
		if (refusal) {
			return { ok: false, error: refusal };
		}
		this.markActive();
		this.queriesRunning++;
		let outcome: BulkExportOutcome;
		try {
			outcome = await this.server.bulkExport({ connectionId: id, request });
		} finally {
			this.queriesRunning--;
		}
		this.queries.record({
			sql: `${request.sql}\n-- to ${request.filePath}`,
			connectionId: id,
			connectionLabel: config?.label ?? id,
			environment: config?.environment,
			timestamp: Date.now(),
			outcome: outcome.ok
				? { ok: true, rowCount: 0, durationMs: outcome.result.durationMs }
				: { ok: false, error: outcome.error },
		});
		if (outcome.ok) {
			this.armIdle(id);
		}
		return outcome;
	}

	/**
	 * Run a statement whose TEXT must not be recorded as it was sent.
	 *
	 * A table function takes its credentials as ARGUMENTS (`remote(addr, db, t, user, password)`),
	 * so the statement that runs holds a password in the middle of it. `dispatch` already keeps the
	 * query it RUNS apart from the text it RECORDS, which is what this uses: the real statement goes
	 * to the driver and the redacted twin goes to query history, the failure sink and the screen.
	 *
	 * The redaction is done by the caller, by VALUE, because only the caller knows which argument
	 * was the secret. Nothing here guesses at SQL.
	 */
	async executeRedacted(id: string, sql: string, displaySql: string): Promise<ExecuteQueryResult> {
		const config = this.readConfigs().find((entry) => entry.id === id);
		return this.dispatch(id, { lang: 'sql', sql }, true, displaySql, config);
	}

	async executeScript(id: string, statements: string[], options: { recordHistory?: boolean; priority?: QueryPriority } = {}): Promise<ExecuteQueryResult> {
		const recordHistory = options.recordHistory ?? true;
		const priority = options.priority ?? 'interactive';
		const config = this.readConfigs().find((entry) => entry.id === id);
		if (config?.readOnly) {
			for (const sql of statements) {
				const blocked = readOnlyBlock(sql, config);
				if (blocked) {
					return { ok: false, error: blocked };
				}
			}
		}
		if (statements.length === 0) {
			return { ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } };
		}
		const label = config?.label ?? id;
		const kind = backendKindForDriver(config?.driver);
		const transactional = dialectFor(config?.driver).isTransactionalDdl;
		const start = Date.now();

		// A read-only connection: each statement asks the database to refuse writes too, and the
		// script is not wrapped in one transaction (there is nothing to group, and each statement
		// already runs in its own read-only one).
		const readOnly = config?.readOnly === true;
		const run = async (sql: string): Promise<ExecuteQueryResult> => {
			const result = await this.runSql(id, sql, readOnly);
			if (recordHistory) {
				this.queries.record({
					sql,
					connectionId: id,
					connectionLabel: label,
					environment: config?.environment,
					timestamp: Date.now(),
					outcome: result.ok
						? { ok: true, rowCount: result.result.rowCount, durationMs: result.result.durationMs }
						: { ok: false, error: result.error },
				});
				if (!result.ok && !result.cancelled) {
					this.rememberFailure(id, sql, kind, result.error, 'execution');
				}
			}
			return result;
		};

		// The whole script takes ONE background reservation, not one per statement: a batched
		// insert would otherwise re-queue between every batch and interleave with itself.
		if (priority === 'background') {
			await this.bgGate.acquire(id, this.bgLimit(config));
		}
		try {
			return await this.runScriptStatements(id, statements, run, transactional && !readOnly, start);
		} finally {
			if (priority === 'background') {
				this.bgGate.release(id);
			}
		}
	}

	/** The body of {@link executeScript}: all-or-nothing where the dialect allows it, otherwise
	 *  statement-by-statement, stopping at the first error. */
	private async runScriptStatements(id: string, statements: string[], run: (sql: string) => Promise<ExecuteQueryResult>, transactional: boolean, start: number): Promise<ExecuteQueryResult> {
		let affected = 0;
		if (transactional) {
			const begin = await this.runSql(id, 'BEGIN');
			if (!begin.ok) {
				return begin;
			}
			for (const sql of statements) {
				const result = await run(sql);
				if (!result.ok) {
					await this.runSql(id, 'ROLLBACK').catch(() => undefined);
					return result;
				}
				affected += result.result.rowCount;
			}
			const commit = await this.runSql(id, 'COMMIT');
			if (!commit.ok) {
				await this.runSql(id, 'ROLLBACK').catch(() => undefined);
				return commit;
			}
		} else {
			for (const sql of statements) {
				const result = await run(sql);
				if (!result.ok) {
					// Mirror execute(): a dropped socket flips the live flag immediately.
					if (looksLikeConnectionLoss(result.error) && this.connected.delete(id)) {
						this.clearIdle(id);
						await this.server.disconnect(id).catch(() => undefined);
						this.onChange();
					}
					return result;
				}
				affected += result.result.rowCount;
			}
		}
		this.armIdle(id);
		return { ok: true, result: { fields: [], rows: [], rowCount: affected, durationMs: Date.now() - start } };
	}

	/** Cancel the query currently running on a connection (best-effort). */
	/** How far the query running on a connection has got, or null. */
	queryProgress(id: string): Promise<QueryProgress | null> {
		return this.server.queryProgress(id);
	}

	cancel(id: string): Promise<void> {
		return this.server.cancel(id);
	}

	/**
	 * Compute the migration that would morph the TARGET connection's schema into the SOURCE
	 * connection's. Both must be connected and share a driver (no cross-dialect sync).
	 */
	async buildSchemaPlan(sourceId: string, targetId: string): Promise<SchemaDiffResult> {
		const sourceConfig = this.readConfigs().find((entry) => entry.id === sourceId);
		const targetConfig = this.readConfigs().find((entry) => entry.id === targetId);
		if (!sourceConfig || !targetConfig) {
			return { ok: false, error: 'Source or target connection no longer exists.' };
		}
		if (sourceConfig.driver !== targetConfig.driver) {
			return { ok: false, error: `Cannot sync across database types ("${sourceConfig.driver}" → "${targetConfig.driver}"). Source and target must use the same driver.` };
		}
		const [source, target] = await Promise.all([this.server.getSchema(sourceId), this.server.getSchema(targetId)]);
		if (!source) {
			return { ok: false, error: `Source "${sourceConfig.label}" is not connected.` };
		}
		if (!target) {
			return { ok: false, error: `Target "${targetConfig.label}" is not connected.` };
		}
		try {
			return { ok: true, plan: buildPlan(source, target, targetConfig.driver) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Apply an ordered list of migration statements against the target. Postgres runs inside a
	 * transaction (all-or-nothing); MySQL/SQL Server run statement-by-statement and report the
	 * failed index so the UI can fix it and resume from there.
	 *
	 * A migration is nothing but DDL, so a target marked read-only is refused outright, before a
	 * single statement is sent, rather than judged statement by statement. The production
	 * confirmation is the renderer's, as it is for every other write: Schema Sync asks before
	 * every Apply, and names a production target in the question.
	 */
	async applyMigration(id: string, statements: ApplyStatement[]): Promise<ApplyMigrationResult> {
		const config = this.readConfigs().find((entry) => entry.id === id);
		if (config?.readOnly) {
			return { ok: false, error: `Connection "${config.label}" is read-only; Schema Sync cannot change its schema.`, failedIndex: -1, failedId: '', applied: 0, rolledBack: false };
		}
		const label = config?.label ?? id;
		const kind = backendKindForDriver(config?.driver);
		const transactional = dialectFor(config?.driver).isTransactionalDdl;

		const run = async (sql: string): Promise<ExecuteQueryResult> => {
			const result = await this.runSql(id, sql);
			this.queries.record({
				sql,
				connectionId: id,
				connectionLabel: label,
				environment: config?.environment,
				timestamp: Date.now(),
				outcome: result.ok
					? { ok: true, rowCount: result.result.rowCount, durationMs: result.result.durationMs }
					: { ok: false, error: result.error },
			});
			if (!result.ok && !result.cancelled) {
				this.rememberFailure(id, sql, kind, result.error, 'execution');
			}
			return result;
		};

		if (transactional) {
			const begin = await this.runSql(id, 'BEGIN');
			if (!begin.ok) {
				return { ok: false, error: begin.error, failedIndex: -1, failedId: '', applied: 0, rolledBack: false };
			}
			for (let i = 0; i < statements.length; i++) {
				const result = await run(statements[i].sql);
				if (!result.ok) {
					await this.runSql(id, 'ROLLBACK').catch(() => undefined);
					return { ok: false, error: result.error, failedIndex: i, failedId: statements[i].id, applied: 0, rolledBack: true };
				}
			}
			const commit = await this.runSql(id, 'COMMIT');
			if (!commit.ok) {
				await this.runSql(id, 'ROLLBACK').catch(() => undefined);
				return { ok: false, error: commit.error, failedIndex: statements.length - 1, failedId: statements[statements.length - 1]?.id ?? '', applied: 0, rolledBack: true };
			}
			this.armIdle(id);
			return { ok: true, applied: statements.length };
		}

		for (let i = 0; i < statements.length; i++) {
			const result = await run(statements[i].sql);
			if (!result.ok) {
				return { ok: false, error: result.error, failedIndex: i, failedId: statements[i].id, applied: i, rolledBack: false };
			}
		}
		this.armIdle(id);
		return { ok: true, applied: statements.length };
	}

	/**
	 * Test a connection without saving. Secrets the user typed are used inline; any the user
	 * left blank while editing an existing connection fall back to the stored secret (so a
	 * blank password in edit mode tests with the saved one, not no password). Typed values
	 * always win, so testing a freshly entered password works.
	 */
	/**
	 * Test a SAVED connection exactly as it is saved, with its stored secrets resolved here. This is
	 * the only test the assistant and an agent may run without asking: it can reach nothing the user
	 * has not already pointed a connection at, so it cannot be used to send anything (a hostname, a
	 * "password") to an address a model chose.
	 */
	async testSaved(id: string): Promise<TestConnectionResult> {
		const saved = this.readConfigs().find((entry) => entry.id === id);
		if (!saved) {
			return { ok: false, error: `No connection with id "${id}".` };
		}
		let config: ConnectionConfig;
		try {
			config = await this.resolveSecrets(saved);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		const required = this.components?.requiredFor(config.driver);
		if (required && this.componentEnforced(config.driver) && !this.components?.runtimeFor(config.driver)) {
			return {
				ok: false,
				error: required.supported
					? `This database needs a one-time component download (${required.totalLabel}). Click Connect to install it.`
					: `This database isn't supported on your operating system yet.`,
			};
		}
		return this.server.test(this.attachHostKey(this.attachRuntime(config)));
	}

	async test(given: ConnectionFormValues): Promise<TestConnectionResult> {
		// A password in a connection string is the password typed for this test (connectionUri.ts).
		const form = liftUriPassword(given);
		const id = form.id ?? randomUUID();
		this.applyForgetHostKey(form);
		let config = this.toConfig(form, id, true);
		// A stored secret is a fallback only while the connection still goes where it went: a Test
		// of an edit that moved it (a new host, port, driver, TLS or tunnel) with the password left
		// blank must not send the saved password to the new destination.
		const saved = form.id ? this.readConfigs().find((entry) => entry.id === form.id) : undefined;
		const withheld = new Set<ConnectionSecret>(saved ? secretsToDrop(connectionMoves(saved, config, (ref) => this.profileEndpoint(ref)), {}) : []);
		const stored = (kind: ConnectionSecret): string | undefined => (form.id && !withheld.has(kind) ? this.secrets.get(id, kind) : undefined);
		if (form.id) {
			config.password = config.password ?? stored('password');
			if (config.sshTunnel) {
				config.sshTunnel.password = config.sshTunnel.password ?? stored('sshPassword');
				config.sshTunnel.passphrase = config.sshTunnel.passphrase ?? stored('sshPassphrase');
			}
		}
		// Testing a connection with a freshly typed tunnel saves it as a shared profile too, so
		// the tunnel isn't lost if the user tests before saving. The test itself still runs
		// against the inline tunnel already resolved above.
		if (form.saveTunnelAsProfile && form.ssh && config.sshTunnel) {
			this.persistTunnelProfile(form.ssh, form.id);
		}
		if (!config.sshTunnel && config.sshTunnelRef) {
			try {
				config.sshTunnel = this.resolveTunnelRef(config.sshTunnelRef);
				config.sshTunnelRef = undefined;
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		if (config.awsSecret) {
			const secretAccessKey = form.aws?.secretAccessKey || stored('awsSecretAccessKey');
			try {
				config = await applyAwsSecret(config, config.awsSecret, secretAccessKey);
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		try {
			config = resolveSsl(config);
			this.attachCloudAccount(config);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		// A native-driver connection whose component isn't installed (packaged builds): guide the
		// user to Connect (which prompts the download) rather than failing with a raw sidecar error.
		const required = this.components?.requiredFor(config.driver);
		if (required && this.componentEnforced(config.driver) && !this.components?.runtimeFor(config.driver)) {
			return {
				ok: false,
				error: required.supported
					? `This database needs a one-time component download (${required.totalLabel}). Save the connection and click Connect to install it.`
					: `This database isn't supported on your operating system yet.`,
			};
		}
		return this.server.test(this.attachHostKey(this.attachRuntime(config)));
	}

	/**
	 * Persist non-secret config; (re)store only the secrets the user actually entered. An edit that
	 * moves the connection (driver, host, port, TLS, tunnel endpoint, user name, or a database field
	 * that says where it goes) drops the stored secrets it did
	 * not re-type, so a saved password is never carried to a new destination (connectionSecrets.ts).
	 */
	save(given: ConnectionFormValues, options: SaveOptions = {}): ConnectionConfig {
		// A password in a connection string goes to the keychain like a typed one, and the URI is
		// saved without it (connectionUri.ts).
		const form = liftUriPassword(given);
		const id = form.id ?? randomUUID();
		this.applyForgetHostKey(form);
		const saved = form.id ? this.readConfigs().find((entry) => entry.id === form.id) : undefined;
		const config = this.toConfig(form, id, false);
		// Promote an inline tunnel to a shared profile and reference it instead.
		if (form.saveTunnelAsProfile && form.ssh && config.sshTunnel) {
			const ref = this.persistTunnelProfile(form.ssh, form.id);
			if (ref) {
				config.sshTunnelRef = ref;
				delete config.sshTunnel;
			}
		}
		// An import that fetches its credentials from AWS Secrets Manager, or that goes through an
		// SSH tunnel, waits for a person to open and save it from the form. Only that save clears the
		// hold: a save by the assistant or an agent carries it over, whatever else it changes.
		const holds = !options.confirmedByPerson && saved !== undefined;
		if (config.awsSecret && (options.imported || (holds && saved.awsSecretUnconfirmed))) {
			config.awsSecretUnconfirmed = true;
		}
		if ((config.sshTunnel || config.sshTunnelRef) && (options.imported || (holds && saved.sshTunnelUnconfirmed))) {
			config.sshTunnelUnconfirmed = true;
		}
		this.writeConnection(config);
		dropMovedSecrets(this.secrets, saved, config, {
			password: Boolean(form.password),
			sshPassword: Boolean(config.sshTunnel && form.ssh?.password),
			sshPassphrase: Boolean(config.sshTunnel && form.ssh?.passphrase),
			awsSecretAccessKey: Boolean(form.aws?.secretAccessKey),
		}, (ref) => this.profileEndpoint(ref));
		if (form.password) {
			this.secrets.store(id, 'password', form.password);
		}
		// Inline-tunnel secrets stay on the connection only when it kept an inline tunnel; a
		// promoted tunnel's secrets were stored against the profile in persistTunnelProfile.
		if (config.sshTunnel && form.ssh?.password) {
			this.secrets.store(id, 'sshPassword', form.ssh.password);
		}
		if (config.sshTunnel && form.ssh?.passphrase) {
			this.secrets.store(id, 'sshPassphrase', form.ssh.passphrase);
		}
		if (form.aws?.secretAccessKey) {
			this.secrets.store(id, 'awsSecretAccessKey', form.aws.secretAccessKey);
		}
		this.onChange();
		return config;
	}

	/**
	 * Connections saved before a connection string's password was lifted out still carry it in
	 * connections.json. Move each to the keychain (it replaces a stored password, since the URI's
	 * own credentials are the ones the driver used) and rewrite the saved URI without it. Run once
	 * per launch, off the boot path; a no-op when no saved host holds a password. Returns the ids
	 * it moved.
	 */
	moveUriPasswordsToKeychain(): string[] {
		return moveUriPasswords(this.readConfigs(), this.secrets, writeConnection);
	}

	async remove(id: string): Promise<void> {
		if (this.connected.has(id)) {
			await this.disconnect(id).catch(() => undefined);
		}
		removeConnection(id);
		this.secrets.deleteAll(id);
		this.onChange();
	}

	/**
	 * A saved connection with its secrets resolved, for main-side code that hands them to a tool it
	 * spawns (a move's pg_dump). Never sent to the renderer.
	 */
	async resolvedConfig(id: string): Promise<ConnectionConfig> {
		return this.resolveSecrets(this.require(id));
	}

	/**
	 * Save a copy of a connection pointed at another database on the same server, with the same
	 * secrets: the connection a move saves to the database it just created.
	 */
	copyForDatabase(id: string, database: string): ConnectionConfig {
		const source = this.require(id);
		const copy: ConnectionConfig = { ...source, id: randomUUID(), label: database, database };
		delete copy.cloudProjectRef;
		delete copy.localProjectId;
		this.writeConnection(copy);
		for (const key of ['password', 'sshPassword', 'sshPassphrase', 'awsSecretAccessKey'] as const) {
			const value = this.secrets.get(id, key);
			if (value) {
				this.secrets.store(copy.id, key, value);
			}
		}
		this.onChange();
		return copy;
	}

	private require(id: string): ConnectionConfig {
		const config = this.readConfigs().find((entry) => entry.id === id);
		if (!config) {
			throw new Error(`Connection '${id}' not found`);
		}
		return config;
	}

	/** A telemetry connection authenticates as a saved cloud account. Resolved HERE so the server
	 *  child is handed the account and its secret already looked up, never an id it would have to
	 *  reach a main-process store for. Both the connect path and the test path go through this:
	 *  a Test that skipped it handed the driver an id it cannot resolve, and the driver reported
	 *  the connection had no account at all.
	 *  Mutates `config` in place and throws when the account is gone. */
	private attachCloudAccount(config: ConnectionConfig): void {
		if (!config.cloudAccountId) {
			return;
		}
		const found = this.cloudAccounts?.(config.cloudAccountId);
		if (!found) {
			throw new Error('The cloud account this connection uses no longer exists. Edit the connection and pick one, or add it again in Settings.');
		}
		config.cloudAccount = found.account;
		config.cloudSecret = found.secret;
	}

	/** Merge stored secrets onto the non-secret config; inline password is a fallback. When
	 *  the connection draws its credentials from AWS Secrets Manager, fetch them now (this
	 *  may throw — connect() surfaces the failure to the caller). */
	private async resolveSecrets(config: ConnectionConfig): Promise<ConnectionConfig> {
		if (config.awsSecret && config.awsSecretUnconfirmed) {
			throw new Error(unconfirmedAwsSecretMessage(config));
		}
		if ((config.sshTunnel || config.sshTunnelRef) && config.sshTunnelUnconfirmed) {
			const tunnel = config.sshTunnel ? { host: config.sshTunnel.host, port: config.sshTunnel.port ?? 22 } : config.sshTunnelRef ? this.profileEndpoint(config.sshTunnelRef) : undefined;
			throw new Error(unconfirmedSshTunnelMessage(config, tunnel));
		}
		const resolved: ConnectionConfig = { ...config, password: this.secrets.get(config.id, 'password') ?? config.password };
		if (config.sshTunnel) {
			resolved.sshTunnel = {
				...config.sshTunnel,
				password: this.secrets.get(config.id, 'sshPassword') ?? config.sshTunnel.password,
				passphrase: this.secrets.get(config.id, 'sshPassphrase') ?? config.sshTunnel.passphrase,
			};
		} else if (config.sshTunnelRef) {
			// Reusable profile: expand it (with its own keychain secrets) into a concrete
			// inline tunnel so the server only ever sees a plain sshTunnel.
			resolved.sshTunnel = this.resolveTunnelRef(config.sshTunnelRef);
			resolved.sshTunnelRef = undefined;
		}
		this.attachCloudAccount(resolved);
		if (config.awsSecret) {
			return resolveSsl(await applyAwsSecret(resolved, config.awsSecret, this.secrets.get(config.id, 'awsSecretAccessKey')));
		}
		return resolveSsl(resolved);
	}

	/** Non-secret signature used to spot an already-saved tunnel with the same settings. */
	private static tunnelSignature(t: { host?: string; port?: number; username?: string; privateKeyPath?: string }): string {
		return [t.host ?? '', t.port ?? '', t.username ?? '', t.privateKeyPath ?? ''].join('|');
	}

	/** A compact default name for an auto-saved tunnel: the host's first DNS label (so a long
	 *  RDS/EC2 endpoint doesn't blow out the picker). IPs and short names are kept whole. */
	private static defaultTunnelName(username: string, host: string): string {
		const isIp = /^[0-9.]+$/.test(host);
		const shortHost = !isIp && host.includes('.') ? host.slice(0, host.indexOf('.')) : host;
		return `${username}@${shortHost}`;
	}

	/**
	 * Save a connection's inline tunnel as a reusable profile (request: a tunnel typed while
	 * creating/editing a connection should become shareable). Reuses an existing profile whose
	 * settings match, so repeated tests/saves don't pile up duplicates. Secrets come from the
	 * form, falling back to the connection's stored SSH secrets when the user left them blank on
	 * edit. Returns the profile id (or undefined when there's nothing usable to save).
	 */
	private persistTunnelProfile(ssh: NonNullable<ConnectionFormValues['ssh']>, connId: string | undefined): string | undefined {
		const host = ssh.host?.trim();
		const username = ssh.username?.trim();
		if (!host || !username) {
			return undefined;
		}
		const privateKeyPath = ssh.privateKeyPath?.trim() || undefined;
		const signature = ConnectionManager.tunnelSignature({ host, port: ssh.port, username, privateKeyPath });
		const existing = readTunnels().find((p) => ConnectionManager.tunnelSignature(p) === signature);
		if (existing) {
			return existing.id;
		}
		const id = randomUUID();
		writeTunnel({ id, name: ConnectionManager.defaultTunnelName(username, host), host, port: ssh.port, username, privateKeyPath, keepAlive: ssh.keepAlive });
		const secretId = tunnelSecretId(id);
		// The connection's stored SSH secrets carry over to the new profile only when it is the SAME
		// endpoint the connection already used (an inline tunnel being promoted). A tunnel pointed at a
		// different host, port or user gets only what was typed for it.
		const inherit = connId !== undefined && this.sameSavedTunnel(connId, tunnelEndpoint({ host, port: ssh.port, username }));
		const passphrase = ssh.passphrase || (inherit && connId ? this.secrets.get(connId, 'sshPassphrase') : undefined);
		const password = ssh.password || (inherit && connId ? this.secrets.get(connId, 'sshPassword') : undefined);
		if (passphrase) {
			this.secrets.store(secretId, 'sshPassphrase', passphrase);
		}
		if (password) {
			this.secrets.store(secretId, 'sshPassword', password);
		}
		this.onTunnelsChange();
		return id;
	}

	/** A saved tunnel profile's endpoint (no secrets), for deciding whether an edit moved a tunnel. */
	private profileEndpoint(ref: string): TunnelEndpoint | undefined {
		return tunnelEndpoint(getTunnel(ref));
	}

	/** Whether `endpoint` is the inline tunnel the saved connection `connId` already uses. */
	private sameSavedTunnel(connId: string, endpoint: TunnelEndpoint | undefined): boolean {
		const saved = this.readConfigs().find((entry) => entry.id === connId)?.sshTunnel;
		const was = tunnelEndpoint(saved);
		return Boolean(was && endpoint && was.host === endpoint.host && was.port === endpoint.port && was.username === endpoint.username);
	}

	/** Expand a saved tunnel profile (by id) into a concrete inline tunnel, pulling its key
	 *  passphrase / SSH password from the keychain. Throws if the profile no longer exists. */
	private resolveTunnelRef(refId: string): SshTunnelConfig {
		const profile = getTunnel(refId);
		if (!profile) {
			throw new Error(`SSH tunnel profile not found (it may have been deleted). Edit the connection and pick a tunnel again.`);
		}
		const secretId = tunnelSecretId(refId);
		return {
			host: profile.host,
			port: profile.port,
			username: profile.username,
			privateKeyPath: profile.privateKeyPath,
			passphrase: this.secrets.get(secretId, 'sshPassphrase'),
			password: this.secrets.get(secretId, 'sshPassword'),
			// Local bind port is auto-allocated per connection so two connections sharing a
			// profile don't fight over the same local port.
			keepAlive: profile.keepAlive,
		};
	}

	private toConfig(form: ConnectionFormValues, id: string, includeSecrets: boolean): ConnectionConfig {
		const config: ConnectionConfig = {
			id,
			label: form.label,
			driver: form.driver,
			host: form.host,
			port: form.port,
			username: form.username,
		};
		if (form.database) {
			config.database = form.database;
		}
		if (form.environment) {
			config.environment = form.environment;
		}
		if (form.ssl) {
			const mode = form.sslMode ?? 'rds';
			if (mode === 'insecure') {
				config.ssl = { rejectUnauthorized: false };
			} else if (mode === 'rds') {
				config.ssl = { rejectUnauthorized: true, caBundle: 'rds' };
			} else if (mode === 'custom') {
				config.ssl = { rejectUnauthorized: true, caPath: form.sslCaPath?.trim() || undefined };
			} else {
				config.ssl = { rejectUnauthorized: true };
			}
		}
		if (form.readOnly) {
			config.readOnly = true;
		}
		if (form.flavor) {
			config.flavor = form.flavor;
		}
		if (form.warehouse) {
			config.warehouse = form.warehouse.trim();
		}
		if (form.role) {
			config.role = form.role.trim();
		}
		// The SnoutData Cloud project this was imported from. A tag and nothing else: no
		// code below reads it to behave differently, and the import is what puts it there
		// so a second import updates this connection instead of adding one beside it.
		if (form.cloudProjectRef) {
			config.cloudProjectRef = form.cloudProjectRef;
		}
		if (form.localProjectId) {
			config.localProjectId = form.localProjectId;
		}
		// Telemetry: the account is a REFERENCE (its credential stays on the account, in the
		// keychain) and the scope is the container within it — a region, a workspace, a project.
		if (form.cloudAccountId) {
			config.cloudAccountId = form.cloudAccountId;
		}
		if (form.cloudScope) {
			config.cloudScope = form.cloudScope.trim();
		}
		if (form.cloudScopes?.length) {
			config.cloudScopes = form.cloudScopes.map((scope) => scope.trim()).filter(Boolean);
		}
		// Persist the clamped value so a stored connection never carries an out-of-range pool size;
		// leave it unset when the form gives no value so the driver default stays implicit.
		if (form.poolMax !== undefined) {
			config.poolMax = clampPoolMax(form.poolMax);
		}
		if (form.aiDataAccess && DATA_ACCESS_LEVELS.includes(form.aiDataAccess)) {
			config.aiDataAccess = form.aiDataAccess;
		}
		if (includeSecrets && form.password) {
			config.password = form.password;
		}
		if (form.aws) {
			config.awsSecret = {
				region: form.aws.region.trim(),
				secretId: form.aws.secretId.trim(),
				profile: form.aws.profile?.trim() || undefined,
				accessKeyId: form.aws.accessKeyId?.trim() || undefined,
			};
		}
		// A connection uses either a saved tunnel profile (by ref) or an inline tunnel, never
		// both. The ref wins if present so toggling to a profile drops any stale inline tunnel.
		if (form.sshTunnelRef) {
			config.sshTunnelRef = form.sshTunnelRef;
		} else if (form.ssh) {
			config.sshTunnel = {
				host: form.ssh.host,
				port: form.ssh.port,
				username: form.ssh.username,
				privateKeyPath: form.ssh.privateKeyPath || undefined,
				localPort: form.ssh.localPort,
				keepAlive: form.ssh.keepAlive,
			};
			if (includeSecrets) {
				config.sshTunnel.passphrase = form.ssh.passphrase || undefined;
				config.sshTunnel.password = form.ssh.password || undefined;
			}
		}
		return config;
	}
}

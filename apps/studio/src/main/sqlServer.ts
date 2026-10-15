/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from 'vscode-jsonrpc/node';

import type { CompletionItem, CompletionList, Hover, Position } from 'vscode-languageserver-protocol';

import {
	SnoutProtocol,
	type ConnectParams,
	type ConnectResult,
	type BulkExportOutcome,
	type BulkExportParams,
	type BulkLoadOutcome,
	type BulkLoadParams,
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
} from '../shared/protocol';
import type { ConnectionConfig } from '../shared/connection';
import type { QueryProgress } from '../shared/query';

/**
 * Owns the ported SQL language server: spawns it as a child process and speaks the
 * same LSP/JSON-RPC protocol over its stdio that the original VSCode extension spoke from the VSCode
 * extension host. The custom `snout/*` requests (connect, executeQuery, …) are
 * forwarded verbatim; only the transport endpoint moved from the extension host to
 * the Electron main process.
 */
/** Why the server child went away, for the crash hook. */
export interface SqlServerDied {
	reason: string;
	/** How long this child lived past its handshake, in ms. */
	uptimeMs: number;
	/** True once we've stopped respawning because the child keeps dying on us. */
	givingUp: boolean;
	/** The tail of the child's stderr. An uncaught exception in the child prints its stack
	 *  here and then the process is gone, so this is the only place the cause survives. */
	stderr: string;
}

export class SqlServer {
	private child: ChildProcessWithoutNullStreams | undefined;
	private connection: MessageConnection | undefined;
	// Resolves with the live connection once the child has spawned and the LSP `initialize`
	// handshake is done. Every request awaits this, so callers never need to await start():
	// the window is created while the child boots, and requests that race the boot just wait.
	// Cleared when the child dies, which is what lets the next request boot a fresh one.
	private ready: Promise<MessageConnection> | undefined;
	// Kept so we can respawn without the caller handing us the path again.
	private serverPath: string | undefined;
	// True between stop() and the next start(): a child exiting then is expected, so we
	// neither respawn it nor report it.
	private stopping = false;
	// Boot generation. A child that dies only tears down state if it's still the current
	// one — a late 'exit' from a previous generation must not bury its replacement.
	private generation = 0;
	// Consecutive deaths that happened before the child proved itself healthy. Bounds the
	// respawn: a child that dies on every boot (corrupt install, missing driver binary) is
	// a permanent failure, and spawn-looping on it would just burn CPU behind an app that
	// looks alive.
	private crashes = 0;
	private static readonly MAX_CRASHES = 3;
	private static readonly HEALTHY_UPTIME_MS = 30_000;
	// How long a bare "connection closed" waits for the child's 'exit' to land. The transport
	// notices the pipe is gone before the process handle reports why, so reporting the first
	// signal we get threw away the exit code on every real crash (every Sentry event we have
	// says "server connection closed", which names no cause at all).
	private static readonly EXIT_GRACE_MS = 500;
	// Lines of the child's stderr kept for the crash report. Enough for a stack plus the
	// driver noise around it, small enough to stay inside an event's payload.
	private static readonly STDERR_TAIL_LINES = 40;
	private diedHandler: ((info: SqlServerDied) => void) | undefined;
	private schemaUpdatedHandler: ((params: SchemaUpdatedParams) => void) | undefined;
	private sshHostKeyHandler: ((params: SshHostKeyLearnedParams) => void) | undefined;

	/** Begin booting the bundled server (spawn + LSP initialize). Returns a promise that
	 *  resolves when the handshake is done, but callers need NOT await it before using the
	 *  app — every request method awaits readiness itself (see {@link conn}), so the window
	 *  can paint while the child's heavy require()s (mysql2/pg/mssql/ssh2) run in parallel. */
	start(serverPath: string): Promise<void> {
		this.serverPath = serverPath;
		this.stopping = false;
		this.crashes = 0;
		this.ready = this.boot(serverPath);
		return this.ready.then(() => undefined);
	}

	/** Called whenever the child dies unexpectedly (not via stop()). Main wires this to
	 *  logging/telemetry so one honest event replaces the flood of downstream
	 *  "Connection is closed" errors the dead child used to produce. */
	onDied(handler: (info: SqlServerDied) => void): void {
		this.diedHandler = handler;
	}

	private async boot(serverPath: string): Promise<MessageConnection> {
		// ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, so we
		// run the server without depending on a system Node install (works packaged).
		// `--stdio` tells the ported server's createConnection(ProposedFeatures.all)
		// to use stdin/stdout as its LSP transport (it auto-detects from argv).
		const generation = ++this.generation;
		const child = spawn(process.execPath, [serverPath, '--stdio'], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		// Registered NOW, not after the handshake: stop() can only kill what it can see, and a
		// child still booting when the app quits would otherwise outlive it. A stray child holds
		// file handles under the install dir, which is enough to make a Windows update install
		// fail to replace files. Nothing here treats a set `child` as "ready" (readiness is the
		// `ready` promise), so publishing it early is safe.
		this.child = child;
		// Kept as well as logged: when the child dies the report below is the only thing that
		// leaves the machine, and an uncaught exception's stack lands here and nowhere else.
		// (The child cannot use console.error for this — vscode-languageserver patches console in
		// stdio mode to route through the LSP logger, so it writes to process.stderr directly.)
		const stderrTail: string[] = [];
		child.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString().trimEnd();
			console.error('[sql-server]', text);
			stderrTail.push(text);
			while (stderrTail.length > SqlServer.STDERR_TAIL_LINES) {
				stderrTail.shift();
			}
		});

		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout),
			new StreamMessageWriter(child.stdin),
		);

		// A dead child takes its JSON-RPC connection with it, and a disposed connection rejects
		// every future request with "Connection is closed". Cached, that turned one child death
		// into a permanently zombied app: the editor, the schema fetch, and disconnect all threw
		// forever while the UI still claimed to be connected. Dropping the cached generation here
		// is what lets conn() boot a replacement on the next request.
		let bootedAt = 0;
		let torn = false;
		let reported = false;
		let exitGrace: NodeJS.Timeout | undefined;
		let reason = '';
		let named = false;
		let uptimeMs = 0;
		let givingUp = false;

		// Drop the cached generation the moment the transport goes away, and charge the death
		// to the crash budget there and then. Both belong on the FIRST signal: the first is what
		// lets conn() boot a replacement on the next request, and the second is what keeps a
		// child that dies on every boot from spawn-looping while we wait for a tidy reason.
		const tearDown = (): void => {
			// A late signal from a superseded generation must not tear down its replacement.
			if (torn || this.generation !== generation) {
				return;
			}
			torn = true;
			this.child = undefined;
			this.connection = undefined;
			this.ready = undefined;
			connection.dispose();
			if (this.stopping) {
				return;
			}
			// Uptime is measured from the handshake: a child that never got there (bootedAt 0)
			// counts as a crash, which is exactly the case the budget exists to bound.
			uptimeMs = bootedAt ? Date.now() - bootedAt : 0;
			this.crashes = uptimeMs >= SqlServer.HEALTHY_UPTIME_MS ? 0 : this.crashes + 1;
			givingUp = this.crashes >= SqlServer.MAX_CRASHES;
		};

		// Report the death once, EXIT_GRACE_MS after the first signal rather than on it. The
		// signals arrive in the wrong order for a useful report: the transport's "connection
		// closed" (which names no cause) beats the exit code, and a child that died on an
		// uncaught exception is still flushing that stack to stderr as it goes. Waiting one
		// short beat collects both. Nothing else waits for this — the teardown above already
		// freed the state and charged the budget.
		const flush = (): void => {
			reported = true;
			exitGrace = undefined;
			child.removeAllListeners();
			// !torn means this child was already superseded (or stopped) when it died, so its
			// death is nobody's news.
			if (this.stopping || !torn) {
				return;
			}
			console.error(`[sql-server] ${reason} (up ${uptimeMs}ms)${givingUp ? ' — giving up on respawn' : ''}`);
			this.diedHandler?.({ reason, uptimeMs, givingUp, stderr: stderrTail.join('\n') });
		};

		// `isNamed` marks a reason that actually says why (an exit code, a spawn error). The
		// first one of those wins; a bare "connection closed" is only used if nothing better
		// arrives before the grace period is up.
		const bury = (why: string, isNamed: boolean): void => {
			tearDown();
			if (reported) {
				return;
			}
			if ((isNamed && !named) || !reason) {
				reason = why;
				named = isNamed;
			}
			if (!exitGrace) {
				exitGrace = setTimeout(flush, SqlServer.EXIT_GRACE_MS);
				exitGrace.unref();
			}
		};
		child.on('exit', (code, signal) => bury(`server exited (code ${code}, signal ${signal})`, true));
		child.on('error', (err) => bury(`server process error: ${err.message}`, true));
		connection.onClose(() => bury('server connection closed', false));

		// Subscribe UNCONDITIONALLY, and dispatch through the field rather than binding whatever is
		// in it right now. `boot` runs synchronously as far as the first await below, so `start()`
		// got this far before the very next line of main's wiring called onSchemaUpdated — the
		// handler was always still undefined here, the `if` never passed, and the live schema index
		// never reached the UI at all. The server polled and recached (so completion stayed current,
		// which is why nothing looked broken), while the explorer showed the schema it had at
		// connect time until the user pressed Refresh.
		connection.onNotification(SnoutProtocol.SchemaUpdated, (params: SchemaUpdatedParams) => {
			this.schemaUpdatedHandler?.(params);
		});
		connection.onNotification(SnoutProtocol.SshHostKeyLearned, (params: SshHostKeyLearnedParams) => {
			this.sshHostKeyHandler?.(params);
		});
		connection.listen();
		await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
		connection.sendNotification('initialized', {});

		bootedAt = Date.now();
		this.connection = connection;
		return connection;
	}

	/** Subscribe to the server's schema-changed notifications (live schema index). Safe to call at
	 *  any point relative to start(): the child's connection dispatches through this field, so it
	 *  does not matter whether the handler arrived before or after the boot, and a respawned child
	 *  gets it too — otherwise the live schema index would go quiet after a crash with nothing to
	 *  show for it. */
	onSchemaUpdated(handler: (params: SchemaUpdatedParams) => void): void {
		this.schemaUpdatedHandler = handler;
		void this.conn().catch(() => undefined);
	}

	/** Subscribe to SSH host keys a tunnel trusted on first use, so they can be remembered. Same
	 *  dispatch-through-a-field shape as {@link onSchemaUpdated}, for the same reason. */
	onSshHostKeyLearned(handler: (params: SshHostKeyLearnedParams) => void): void {
		this.sshHostKeyHandler = handler;
	}

	/** The live connection, booting one if the last child died. Awaiting this is how requests
	 *  that race the child's boot wait it out instead of throwing. Rejects if start() was never
	 *  called, if we're shutting down, or if the child has burned its respawn budget. */
	private conn(): Promise<MessageConnection> {
		if (!this.ready) {
			if (!this.serverPath || this.stopping) {
				return Promise.reject(new Error('SQL server is not started'));
			}
			if (this.crashes >= SqlServer.MAX_CRASHES) {
				return Promise.reject(new Error('SQL server keeps crashing on startup; restart the app to try again'));
			}
			this.ready = this.boot(this.serverPath);
		}
		return this.ready;
	}

	async connect(config: ConnectionConfig): Promise<ConnectResult> {
		const params: ConnectParams = { config };
		return (await this.conn()).sendRequest(SnoutProtocol.Connect, params);
	}

	async disconnect(connectionId: string): Promise<void> {
		return (await this.conn()).sendRequest(SnoutProtocol.Disconnect, connectionId);
	}

	async execute(params: ExecuteQueryParams): Promise<ExecuteQueryResult> {
		return (await this.conn()).sendRequest(SnoutProtocol.ExecuteQuery, params);
	}

	/** Stream a file into a table (the engine's bulk path). The server child reads the file, so
	 *  what crosses this seam is a path and a statement. */
	async bulkLoad(params: BulkLoadParams): Promise<BulkLoadOutcome> {
		return (await this.conn()).sendRequest(SnoutProtocol.BulkLoad, params);
	}

	/** Write a whole result to a file, from the server child. */
	async bulkExport(params: BulkExportParams): Promise<BulkExportOutcome> {
		return (await this.conn()).sendRequest(SnoutProtocol.BulkExport, params);
	}

	async cancel(connectionId: string): Promise<void> {
		return (await this.conn()).sendRequest(SnoutProtocol.CancelQuery, connectionId);
	}

	async queryProgress(connectionId: string): Promise<QueryProgress | null> {
		return (await this.conn()).sendRequest(SnoutProtocol.QueryProgress, connectionId);
	}

	/** Cheap liveness probe — the heartbeat (ConnectionManager) and the focus/resume re-checks
	 *  call this to tell a live connection from a silently-dead one. */
	async ping(connectionId: string): Promise<PingConnectionResult> {
		return (await this.conn()).sendRequest(SnoutProtocol.PingConnection, connectionId);
	}

	async getSchema(connectionId: string): Promise<GetSchemaResult> {
		const params: GetSchemaParams = { connectionId };
		return (await this.conn()).sendRequest(SnoutProtocol.GetSchema, params);
	}

	/** The connection's last-polled structural digest (schema fingerprint), or '' if none yet.
	 *  Served from the server's in-memory cache, so it never touches the database. */
	async getSchemaDigest(connectionId: string): Promise<GetSchemaDigestResult> {
		const params: GetSchemaDigestParams = { connectionId };
		return (await this.conn()).sendRequest(SnoutProtocol.GetSchemaDigest, params);
	}

	async refresh(connectionId: string): Promise<ConnectResult> {
		return (await this.conn()).sendRequest(SnoutProtocol.RefreshSchema, connectionId);
	}

	async test(config: ConnectionConfig): Promise<TestConnectionResult> {
		const params: TestConnectionParams = { config };
		return (await this.conn()).sendRequest(SnoutProtocol.TestConnection, params);
	}

	/** Do these cloud credentials sign in to a log service (a cloud account's Test with no storage
	 *  or log-source driver in the build; see CloudService.test). */
	async verifyCloudAccount(params: VerifyCloudAccountParams): Promise<VerifyCloudAccountResult> {
		return (await this.conn()).sendRequest(SnoutProtocol.VerifyCloudAccount, params);
	}

	// --- Editor language features (standard LSP) -----------------------------------
	// The ported server's TextDocuments manager needs the buffer synced before it can
	// answer completion/hover, so the renderer opens the doc once and pushes the
	// current text (a full-content change) right before each request.

	async didOpen(uri: string, text: string, version: number): Promise<void> {
		return (await this.conn()).sendNotification('textDocument/didOpen', {
			textDocument: { uri, languageId: 'sql', version, text },
		});
	}

	async didChange(uri: string, version: number, text: string): Promise<void> {
		return (await this.conn()).sendNotification('textDocument/didChange', {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	/** The answer is a LIST, not an array: `isIncomplete` is how the server says the suggestions
	 *  were narrowed to what has been typed (the engine catalog runs to thousands of names), so the
	 *  editor must ask again on the next keystroke rather than filter this list itself. */
	async completion(uri: string, position: Position, connectionId?: string): Promise<CompletionList> {
		return (await this.conn()).sendRequest('textDocument/completion', { textDocument: { uri }, position, connectionId });
	}

	async completionResolve(item: CompletionItem): Promise<CompletionItem> {
		return (await this.conn()).sendRequest('completionItem/resolve', item);
	}

	async hover(uri: string, position: Position, connectionId?: string): Promise<Hover | null> {
		return (await this.conn()).sendRequest('textDocument/hover', { textDocument: { uri }, position, connectionId });
	}

	stop(): void {
		// Set first: the kill below fires 'exit', and bury() must read this as a deliberate
		// shutdown so it neither respawns the child nor reports the exit as a crash.
		this.stopping = true;
		this.generation++;
		this.connection?.dispose();
		this.child?.kill();
		this.connection = undefined;
		this.child = undefined;
		this.ready = undefined;
	}
}

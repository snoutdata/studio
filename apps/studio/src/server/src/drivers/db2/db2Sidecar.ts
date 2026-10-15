/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NativeRuntime } from '../../../../shared/components';

/**
 * Spawns and talks to the Db2 sidecar (see {@link db2SidecarEntry}). The sidecar exists because
 * `ibm_db` cannot run under Electron's ABI — its prebuilt `.node` is keyed to stock Node and its
 * source will not recompile against Electron 42's V8. So we run `ibm_db` in a **stock-Node** child
 * and proxy every catalog/DML statement to it over a newline-delimited JSON pipe.
 *
 * One sidecar instance == one Db2 connection (pool). The driver owns the SSH tunnel, the DSN, the
 * retry/cancel logic; this class is only the transport: spawn, `open` a pool, `query`, `close`.
 */
export class Db2Sidecar {
	private proc?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, { resolve: (rows: Db2Row[]) => void; reject: (err: Error) => void }>();
	private nextId = 1;
	private stdoutBuf = '';
	private starting?: Promise<void>;

	/**
	 * @param runtime Resolved by main from the downloaded `node22` + `db2` components (stock-Node
	 *   binary, the ibm_db entry path, IBM_DB_HOME env). When absent we fall back to env-based
	 *   resolution (SNOUTDATA_DB2_NODE + require.resolve), which is how dev runs against a locally
	 *   `npm install`ed ibm_db before the component is built.
	 */
	constructor(private readonly runtime?: NativeRuntime) {}

	/** Open (or re-open) the pool for a DSN. Spawns the sidecar on first call; idempotent thereafter
	 *  so the driver's dead-connection reset can reuse it to rebuild the pool. */
	async open(connStr: string): Promise<void> {
		if (!this.proc) {
			await this.start();
		}
		await this.send<void>('open', { connStr, maxPoolSize: 4 });
	}

	/** Run one statement and resolve to named-column rows (the shape introspection + execute want). */
	query(sql: string, params?: readonly unknown[]): Promise<Db2Row[]> {
		return this.send<Db2Row[]>('query', { sql, params: params ? [...params] : undefined });
	}

	/** Drain the pool and stop the sidecar. Best-effort: a dead child is treated as already closed. */
	async close(): Promise<void> {
		if (!this.proc) {
			return;
		}
		try {
			await this.send<void>('close', {});
		} catch {
			// the child may have already exited; fall through to hard teardown
		}
		this.teardown(new Error('db2 sidecar closed'));
	}

	/** Spawn the stock-Node child and wire its stdout/stderr/exit. Resolves once the process is up. */
	private start(): Promise<void> {
		if (this.starting) {
			return this.starting;
		}
		this.starting = new Promise<void>((resolve, reject) => {
			let nodeBin: string;
			let ibmDbPath: string;
			let scriptPath: string;
			try {
				nodeBin = this.runtime?.nodeBin ?? resolveNodeBinary();
				ibmDbPath = this.runtime?.modulePath ?? resolveIbmDbPath();
				scriptPath = materializeSidecarScript();
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}

			const child = spawn(nodeBin, [scriptPath], {
				// A plain Node ABI is required, so DO NOT inherit ELECTRON_RUN_AS_NODE from the server child.
				// The component's env (e.g. Db2's IBM_DB_HOME → the clidriver dir) is merged in last.
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: undefined,
					SNOUTDATA_IBM_DB_PATH: ibmDbPath,
					...(this.runtime?.env ?? {}),
				} as NodeJS.ProcessEnv,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			this.proc = child;

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
			child.stderr.setEncoding('utf8');
			// ibm_db / clidriver chatter and sidecar diagnostics land here; keep them out of the channel.
			child.stderr.on('data', (chunk: string) => process.stderr.write(`[db2 sidecar] ${chunk}`));

			child.on('error', (err) => {
				reject(new Error(`Could not start the Db2 sidecar via "${nodeBin}". A stock Node 22 runtime is required for ibm_db. ${err.message}`));
				this.teardown(err);
			});
			child.on('exit', (code) => {
				this.teardown(new Error(`db2 sidecar exited (code ${code ?? 'null'})`));
			});

			// The child is usable as soon as spawn succeeds; the first `open` validates it for real.
			resolve();
		});
		return this.starting;
	}

	/** Parse newline-delimited reply frames and settle the matching pending request. */
	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl = this.stdoutBuf.indexOf('\n');
		while (nl !== -1) {
			const line = this.stdoutBuf.slice(0, nl).trim();
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (line) {
				this.onFrame(line);
			}
			nl = this.stdoutBuf.indexOf('\n');
		}
	}

	private onFrame(line: string): void {
		let frame: Reply;
		try {
			frame = JSON.parse(line) as Reply;
		} catch {
			process.stderr.write(`[db2 sidecar] unparseable reply: ${line}\n`);
			return;
		}
		const waiter = this.pending.get(frame.id);
		if (!waiter) {
			return;
		}
		this.pending.delete(frame.id);
		if (frame.ok) {
			waiter.resolve(frame.rows ?? []);
		} else {
			// Re-tag with the sidecar's sqlcode/state so isPreflightDeadConnectionError can read it.
			const err = new Error(frame.error ?? 'db2 sidecar error') as Error & { state?: string };
			if (frame.code !== undefined) {
				err.state = frame.code;
			}
			waiter.reject(err);
		}
	}

	/** Send a request frame and await its reply. */
	private send<T>(method: string, body: Record<string, unknown>): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const child = this.proc;
			if (!child || child.stdin.destroyed) {
				reject(new Error('db2 sidecar: not running'));
				return;
			}
			this.pending.set(id, {
				resolve: resolve as (rows: Db2Row[]) => void,
				reject,
			});
			child.stdin.write(JSON.stringify({ id, method, ...body }) + '\n', (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	/** Reject every in-flight request and drop the child. Safe to call more than once. */
	private teardown(reason: Error): void {
		for (const waiter of this.pending.values()) {
			waiter.reject(reason);
		}
		this.pending.clear();
		const child = this.proc;
		this.proc = undefined;
		this.starting = undefined;
		if (child && !child.killed) {
			child.kill();
		}
	}
}

export type Db2Row = Record<string, unknown>;

interface Reply {
	id: number;
	ok: boolean;
	rows?: Db2Row[];
	error?: string;
	code?: string;
}

/**
 * Locate a stock-Node binary to host `ibm_db`. The Electron server child runs with
 * ELECTRON_RUN_AS_NODE (Electron's ABI), which cannot load the native module, so we need a separate
 * Node. Resolution order: an explicit override, a node bundled beside the app's resources, then the
 * `node` on PATH. (Bundling a pinned Node 22 next to the app is the ship-time answer; until then the
 * override / PATH node covers dev.)
 */
function resolveNodeBinary(): string {
	const override = process.env.SNOUTDATA_DB2_NODE;
	if (override && existsSync(override)) {
		return override;
	}
	const resources = process.env.SNOUTDATA_RESOURCES_PATH;
	if (resources) {
		const bundled = join(resources, process.platform === 'win32' ? 'node.exe' : 'node');
		if (existsSync(bundled)) {
			return bundled;
		}
	}
	return process.platform === 'win32' ? 'node.exe' : 'node';
}

/** Absolute path to the `ibm_db` entry, resolved from the server bundle's location so the stock-Node
 *  sidecar can require it without depending on its own cwd/node_modules. */
function resolveIbmDbPath(): string {
	// `require` in the esbuild CJS bundle resolves against out/server; in a packaged app ibm_db is
	// asarUnpack'd, and Electron's resolver returns its unpacked real-FS path (what the child needs).
	const req = createRequire(join(__dirname, 'server.js'));
	return req.resolve('ibm_db');
}

let cachedScriptPath: string | undefined;

/**
 * The sidecar must run from a real-filesystem path: in a packaged app the bundle lives inside the
 * asar, which a stock-Node child cannot read. We read the sidecar bundle (Electron's fs can read
 * inside the asar) and copy it once to a temp file the child runs from.
 */
function materializeSidecarScript(): string {
	if (cachedScriptPath && existsSync(cachedScriptPath)) {
		return cachedScriptPath;
	}
	const bundled = join(__dirname, 'db2-sidecar.cjs');
	const source = readFileSync(bundled, 'utf8');
	const dir = mkdtempSync(join(tmpdir(), 'snoutdata-db2-'));
	const out = join(dir, 'db2-sidecar.cjs');
	writeFileSync(out, source);
	cachedScriptPath = out;
	return out;
}

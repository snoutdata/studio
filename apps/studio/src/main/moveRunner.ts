/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Starting, watching and stopping a move from the app.
 *
 * The runner is `@snout/move-runner`'s, the same one `snoutdata move` will run. This is its
 * host in the desktop: credentials resolved from the keychain into the tools' environment,
 * statements through the connection manager at background priority, a hosted project woken, created,
 * exported and paused or deleted through the control plane with the user's own session.
 *
 * Starting re-checks the spec against both databases HERE, in main, and re-checks the typed names:
 * a sheet read a minute ago is not a licence to write to a database that has changed since.
 * No model and no MCP call reaches `start`; the review sheet's button is its only caller.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { createDatabaseSql, preflight, readyToRun, type MoveProgress, type MoveRunResult, type MoveSpec } from '@snout/move';
import { runMove, type MoveRunHost, type PgAccess, type Side } from '@snout/move-runner';
import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionFormValues } from '../shared/forms';
import type { MoveConfirmations, MoveRunRecord, MoveRunState, MoveStartOutcome } from '../shared/move';
import type { CloudApi } from './cloudApi';
import { resolveSnoutdataCloudImport } from './cloudImport';
import { readThroughBlips } from './cloudProjects';
import { connectionFor, gatherFacts, type MoveHost } from './moveService';

export interface MoveRunDeps extends MoveHost {
	/** The connection with its secrets, for the tools' environment only. */
	resolved(id: string): Promise<ConnectionConfig>;
	copyForDatabase(serverId: string, database: string): ConnectionConfig;
	saveConnection(values: ConnectionFormValues): ConnectionConfig;
	cloud: CloudApi;
	toolsDir(): string | null;
	record(run: MoveRunRecord): void;
	recoverInterrupted(): void;
	onProgress(progress: MoveProgress): void;
	onFinished(result: MoveRunResult): void;
	sleep?(ms: number): Promise<void>;
}

/** A cold wake grows with the size in the bucket (21.9 s for 918 MB, measured); a create is quicker. */
const READY_TIMEOUT_MS = 20 * 60_000;
const EXPORT_TIMEOUT_MS = 60 * 60_000;

function sleepFor(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How a spawned tool reaches a saved connection, as the app's own driver would (`postgresDriver.ts`).
 * TLS that the driver verifies is verified here too, against the same roots Node trusts, because
 * libpq does not read the system store on every platform.
 */
export function pgAccessFor(config: ConnectionConfig, roots: readonly string[]): PgAccess {
	if (config.sshTunnel || config.sshTunnelRef) {
		throw new Error(`"${config.label}" connects through an SSH tunnel, and a move cannot use one yet.`);
	}
	const base = {
		host: config.host,
		port: config.port,
		user: config.username,
		password: config.password ?? null,
		// libpq and node-postgres both default the database to the user's name.
		database: config.database || config.username
	};
	const ssl = config.ssl;
	if (!ssl) {
		return { ...base, sslmode: 'prefer', caPem: null };
	}
	if (ssl !== true && ssl.rejectUnauthorized === false) {
		return { ...base, sslmode: 'require', caPem: null };
	}
	const ca = ssl !== true && ssl.ca ? ssl.ca : roots.join('\n');
	return { ...base, sslmode: 'verify-full', caPem: ca };
}

/** Wait for a hosted project to be `ready`, saying what it is doing meanwhile. */
export async function waitForReady(cloud: CloudApi, ref: string, label: string, report: (message: string) => void, sleep: (ms: number) => Promise<void>, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		// A poll that lands in a control-plane deploy (the front door restarts for a few seconds) is
		// asked again, rather than failing a move that was only waiting (seen live, 2026-10-15: 521).
		const project = (await readThroughBlips(() => cloud.list(), sleep)).find((candidate) => candidate.ref === ref);
		if (!project) {
			throw new Error(`SnoutData Cloud does not list "${label}" any more.`);
		}
		if (project.state === 'ready') {
			return;
		}
		if (project.state === 'error' || project.state === 'deleted' || project.state === 'deleting') {
			throw new Error(`"${label}" is ${project.state}${project.stateDetail ? `: ${project.stateDetail}` : ''}.`);
		}
		if (Date.now() > deadline) {
			throw new Error(`"${label}" was still ${project.state} after ${Math.round(timeoutMs / 60_000)} minutes.`);
		}
		report(`Waiting for "${label}": ${project.state}${project.stateDetail ? `, ${project.stateDetail}` : ''}`);
		await sleep(2000);
	}
}

/**
 * Wake a hosted project explicitly, and start nothing until it is `ready` (measured: a multi-GB cold
 * wake outruns the front door's 60 s hold, so the tools must not be the thing that wakes it).
 */
export async function wakeProject(cloud: CloudApi, ref: string, label: string, report: (message: string) => void, sleep: (ms: number) => Promise<void>): Promise<void> {
	const project = (await readThroughBlips(() => cloud.list(), sleep)).find((candidate) => candidate.ref === ref);
	if (!project) {
		throw new Error(`SnoutData Cloud does not list "${label}" any more.`);
	}
	if (project.state === 'ready') {
		return;
	}
	if (project.state === 'paused' || project.state === 'pausing' || project.desiredState === 'paused') {
		report(`Waking "${label}"`);
		await cloud.resume(ref);
	}
	await waitForReady(cloud, ref, label, report, sleep);
}

interface ActiveRun {
	readonly runId: string;
	readonly controller: AbortController;
	progress: MoveProgress | null;
}

export class MoveRuns {
	private readonly active = new Map<string, ActiveRun>();
	private readonly finished = new Map<string, MoveRunResult>();
	private readonly waiters = new Map<string, ((result: MoveRunResult) => void)[]>();
	private recovered = false;

	constructor(private readonly deps: MoveRunDeps) {}

	/** Whether any move is running, for the tray's background update install. */
	anyRunning(): boolean {
		return this.active.size > 0;
	}

	state(moveId: string): MoveRunState {
		const active = this.active.get(moveId);
		return { running: active !== undefined, progress: active?.progress ?? null, result: this.finished.get(moveId) ?? null };
	}

	async start(spec: MoveSpec, typed: MoveConfirmations): Promise<MoveStartOutcome> {
		if (this.active.has(spec.id)) {
			return { ok: false, error: "This move is already running." };
		}
		let facts;
		try {
			facts = await gatherFacts(spec, this.deps);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const findings = preflight(spec, facts);
		if (!readyToRun(findings)) {
			return { ok: false, error: "Something changed since the check. Check both databases again." };
		}
		const tools = this.deps.toolsDir();
		if (!tools) {
			return { ok: false, error: "The Postgres tools this move runs are not installed yet." };
		}
		const all = this.deps.connections();
		const source = connectionFor(spec.source, all);
		const target = connectionFor(spec.target, all);
		if (facts.target.production && (!target || typed.target !== target.label)) {
			return { ok: false, error: `The target is a production database. Type "${target?.label ?? ''}" to start the move.` };
		}
		if (spec.sourceAfter === 'delete' && (!source || typed.source !== source.label)) {
			return { ok: false, error: `The source is deleted afterwards. Type "${source?.label ?? ''}" to start the move.` };
		}
		if (!this.recovered) {
			this.recovered = true;
			this.deps.recoverInterrupted();
		}

		const runId = randomUUID();
		const run: ActiveRun = { runId, controller: new AbortController(), progress: null };
		this.active.set(spec.id, run);
		this.finished.delete(spec.id);
		const startedAt = new Date().toISOString();
		this.deps.record({ id: runId, moveId: spec.id, startedAt, finishedAt: null, status: 'running', spec, findings, result: null });

		void runMove({ runId, spec, facts: { source: facts.source, target: facts.target }, signal: run.controller.signal }, this.host(spec, tools, run))
			.catch((thrown: unknown): MoveRunResult => ({
				// runMove reports its own failures; this is the one it could not, kept rather than lost.
				runId,
				moveId: spec.id,
				status: 'failed',
				startedAt,
				finishedAt: new Date().toISOString(),
				error: thrown instanceof Error ? thrown.message : String(thrown),
				failures: [],
				harmlessErrors: 0,
				tables: [],
				sequences: [],
				created: null,
				backup: null,
				sourceAfter: null,
				bytes: 0,
				durationMs: 0
			}))
			.then((result) => {
				this.active.delete(spec.id);
				this.finished.set(spec.id, result);
				this.deps.record({ id: runId, moveId: spec.id, startedAt, finishedAt: result.finishedAt, status: result.status, spec, findings, result });
				this.deps.onFinished(result);
				for (const resolve of this.waiters.get(spec.id) ?? []) {
					resolve(result);
				}
				this.waiters.delete(spec.id);
			});
		return { ok: true, runId };
	}

	/** The result of the move's current run, once it finishes (a project copy waits for its database part). */
	wait(moveId: string): Promise<MoveRunResult> {
		const done = this.finished.get(moveId);
		if (!this.active.has(moveId) && done) {
			return Promise.resolve(done);
		}
		return new Promise((resolve) => {
			this.waiters.set(moveId, [...(this.waiters.get(moveId) ?? []), resolve]);
		});
	}

	cancel(runId: string): boolean {
		for (const run of this.active.values()) {
			if (run.runId === runId) {
				run.controller.abort();
				return true;
			}
		}
		return false;
	}

	/** On quit: a spawned tool outlives the app on Windows unless it is killed. */
	cancelAll(): void {
		for (const run of this.active.values()) {
			run.controller.abort();
		}
	}

	private host(spec: MoveSpec, tools: string, run: ActiveRun): MoveRunHost {
		const { deps } = this;
		const sleep = deps.sleep ?? sleepFor;
		let createdId: string | null = null;

		function connectionOf(side: Side): ConnectionConfig {
			const all = deps.connections();
			const found = side === 'target' && createdId !== null ? all.find((connection) => connection.id === createdId) : connectionFor(side === 'source' ? spec.source : spec.target, all);
			if (!found) {
				throw new Error(`The ${side} is not a saved connection any more.`);
			}
			return found;
		}

		async function query(id: string, sql: string): Promise<unknown> {
			await deps.ensureConnected(id);
			const answer = await deps.execute(id, sql);
			if (!answer.ok) {
				throw new Error(String(answer.error));
			}
			return answer.result.rows[0]?.[0] ?? null;
		}

		return {
			tool: (name) => ({ file: join(tools, process.platform === 'win32' ? `${name}.exe` : name), args: [] }),
			access: async (side) => pgAccessFor(await deps.resolved(connectionOf(side).id), rootCertificates),
			query: (side, sql) => query(connectionOf(side).id, sql),
			wake: async (side, report) => {
				const connection = connectionOf(side);
				if (connection.cloudProjectRef) {
					await wakeProject(deps.cloud, connection.cloudProjectRef, connection.label, report, sleep);
				}
			},
			createTarget: async (report) => {
				const target = spec.target;
				if (target.kind === 'newDatabase') {
					const server = deps.connections().find((connection) => connection.id === target.serverConnectionId);
					if (!server) {
						throw new Error("The server for the new database is not a saved connection any more.");
					}
					report(`Creating the database "${target.database}"`);
					try {
						await query(server.id, createDatabaseSql(target.database));
					} catch (error) {
						throw new Error(`Could not create the database "${target.database}": ${error instanceof Error ? error.message : String(error)}`);
					}
					const saved = deps.copyForDatabase(server.id, target.database);
					createdId = saved.id;
					return { label: saved.label, connectionId: saved.id };
				}
				if (target.kind === 'newCloudProject') {
					report(`Creating the SnoutData Cloud project "${target.name}"`);
					const { project } = await deps.cloud.create(target.name, target.region);
					await waitForReady(deps.cloud, project.ref, target.name, report, sleep);
					const [values] = await resolveSnoutdataCloudImport(deps.cloud, [{ file: 'snoutdata-cloud', connId: project.ref }], deps.connections());
					const saved = deps.saveConnection(values);
					createdId = saved.id;
					return { label: saved.label, connectionId: saved.id };
				}
				throw new Error("The target already exists, so there is nothing to create.");
			},
			backupTarget: async (report) => {
				const connection = connectionOf('target');
				const ref = connection.cloudProjectRef;
				if (!ref) {
					return null;
				}
				report(`Saving a copy of "${connection.label}" before replacing it`);
				let status = await deps.cloud.requestExport(ref);
				const deadline = Date.now() + EXPORT_TIMEOUT_MS;
				while (status.pending) {
					if (run.controller.signal.aborted) {
						return null;
					}
					if (Date.now() > deadline) {
						throw new Error("The copy of the target was still being saved after an hour, so nothing was replaced.");
					}
					await sleep(3000);
					status = await readThroughBlips(() => deps.cloud.exportStatus(ref), sleep);
				}
				if (status.error) {
					throw new Error(`The copy of the target could not be saved, so nothing was replaced: ${status.error}`);
				}
				return { url: status.url };
			},
			afterSource: async (action) => {
				const connection = connectionOf('source');
				const ref = connection.cloudProjectRef;
				if (!ref) {
					throw new Error("only a SnoutData Cloud project can be paused or deleted");
				}
				if (action === 'pause') {
					await deps.cloud.pause(ref);
					return `"${connection.label}" was paused.`;
				}
				await deps.cloud.remove(ref);
				return `"${connection.label}" was deleted, and can be recovered for your plan's grace period.`;
			},
			onProgress: (progress) => {
				run.progress = progress;
				deps.onProgress(progress);
			}
		};
	}
}

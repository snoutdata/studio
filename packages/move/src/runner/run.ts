/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Running a move: the order of the steps and what each one reports.
 *
 * Everything that needs the app or the CLI is a host service: how to reach each end, how to
 * run a statement, how to wake a hosted project, create a target, save a copy and pause or delete
 * the source. What is here is the part both of them must do identically:
 *
 *   wake the source → create or wake the target → (replace: save a copy, then empty it) →
 *   `pg_dump | pg_restore`, with the target's COPY progress polled → count every table on both
 *   sides → only after a `success`, pause or delete the source.
 *
 * A failure after the target was created leaves it and says so. Cancelling kills both tools
 * and leaves what was copied. Nothing here decides whether the move MAY run: the host re-checks the
 * spec against both databases, in main, just before calling this.
 */

import type { EndpointFacts } from '../facts.js';
import { nativePgArgs } from '../pgArgs.js';
import { selectedSchemas } from '../preflight.js';
import type { MovePhase, MoveProgress, MoveTableProgress } from '../progress.js';
import { replacePlan } from '../replace.js';
import { runStatus, verifySequences, verifyTables, type MoveRunResult, type SequenceVerification, type TableVerification } from '../report.js';
import {
	chunks,
	copyProgressFromPg,
	PG_COPY_PROGRESS_SQL,
	pgRowCountsSql,
	pgSequencesSql,
	pgTableSizesSql,
	sequencesFromPg,
	tableCountsFromPg,
	tableEstimatesFromPg,
	type CopyProgress,
	type TableCount,
	type TableEstimate,
	type TableRef
} from '../runSql.js';
import { isNewEndpoint, type MoveSpec } from '../spec.js';
import { ToolLog, type RestoreFailure, type ToolLogEvent } from '../toolLog.js';
import { toolEnv, type PgAccess } from './env.js';
import { runPipeline } from './pipeline.js';

export type Side = 'source' | 'target';

export interface ToolCommand {
	readonly file: string;
	/** Arguments that go before the move's own, for a tool run through another program. */
	readonly args: readonly string[];
}

export interface MoveRunHost {
	tool(name: 'pg_dump' | 'pg_restore'): ToolCommand;
	/** How to reach one end, password included. For a created target, asked only after `createTarget`. */
	access(side: Side): Promise<PgAccess>;
	/** Run one statement and return its first cell. Throws an Error whose message is a sentence. */
	query(side: Side, sql: string): Promise<unknown>;
	/**
	 * Make a hosted end ready before a tool connects, reporting its state as it goes. Never the
	 * front door's 60 s hold, which a multi-GB cold wake outruns (measured). A no-op otherwise.
	 */
	wake(side: Side, report: (message: string) => void): Promise<void>;
	/** Create the target the spec names. Called only for a new endpoint. */
	createTarget(report: (message: string) => void): Promise<{ label: string; connectionId: string | null }>;
	/** Save a copy of a hosted target before replacing it. Null when it is not hosted. Throws when the copy fails. */
	backupTarget(report: (message: string) => void): Promise<{ url: string | null } | null>;
	/** Pause or delete the source, after a `success` only. Returns what was done, in a sentence. */
	afterSource(action: 'pause' | 'delete'): Promise<string>;
	onProgress(progress: MoveProgress): void;
}

export interface MoveRunInput {
	readonly runId: string;
	readonly spec: MoveSpec;
	/** What the check that allowed this run read, moments ago. */
	readonly facts: { readonly source: EndpointFacts; readonly target: EndpointFacts };
	readonly signal: AbortSignal;
	readonly now?: () => number;
	/** How often the target is asked how its COPY is going. */
	readonly pollMs?: number;
}

class Cancelled extends Error {}

/** Minimum gap between progress reports that are not a change of phase. */
const EMIT_MS = 250;
/** How many tables one count statement names. */
const COUNT_CHUNK = 100;
/** Post-data objects: once these start, the rows are in. */
const POST_DATA = /^(INDEX|CONSTRAINT|FK CONSTRAINT|TRIGGER|POLICY|RULE|MATERIALIZED VIEW DATA|EVENT TRIGGER)$/;

interface TableRow {
	schema: string;
	table: string;
	state: MoveTableProgress['state'];
	bytesDone: number;
	bytesTotal: number | null;
	rowsDone: number;
	rowsEstimate: number | null;
}

function keyOf(table: TableRef): string {
	return `${table.schema}.${table.table}`;
}

class ProgressState {
	private phase: MovePhase = 'starting';
	private message: string | null = null;
	private readonly rows = new Map<string, TableRow>();
	private copying: string | null = null;
	private seenData = false;
	private rate: number | null = null;
	private sample: { at: number; bytes: number } | null = null;
	private lastEmit = 0;

	constructor(
		private readonly runId: string,
		private readonly moveId: string,
		private readonly emitTo: (progress: MoveProgress) => void,
		private readonly now: () => number,
		private readonly failed: () => number
	) {}

	set(phase: MovePhase, message: string | null): void {
		const phaseChanged = phase !== this.phase;
		const messageChanged = message !== this.message;
		this.phase = phase;
		this.message = message;
		// A new phase always reaches the screen; a new object inside one ("Creating table x", once per
		// object in a schema of thousands) is throttled like any other tick.
		if (phaseChanged || messageChanged) {
			this.emit(phaseChanged);
		}
	}

	get current(): MovePhase {
		return this.phase;
	}

	tables(estimates: readonly TableEstimate[]): void {
		for (const estimate of estimates) {
			this.rows.set(keyOf(estimate), {
				schema: estimate.schema,
				table: estimate.table,
				state: 'waiting',
				bytesDone: 0,
				bytesTotal: estimate.bytes,
				rowsDone: 0,
				rowsEstimate: estimate.rows
			});
		}
		this.emit(true);
	}

	event(event: ToolLogEvent): void {
		if (event.kind === 'data') {
			this.seenData = true;
			this.doneCopying();
			const key = keyOf(event);
			const row = this.rows.get(key);
			if (row) {
				row.state = 'copying';
				this.copying = key;
			}
			this.set('data', `Copying ${key}`);
			return;
		}
		if (event.kind === 'creating') {
			if (this.seenData && POST_DATA.test(event.desc)) {
				this.doneCopying();
				this.set('indexes', `Creating ${event.desc.toLowerCase()} ${event.object}`);
			} else if (!this.seenData) {
				this.set('schema', `Creating ${event.desc.toLowerCase()} ${event.object}`);
			}
			return;
		}
		this.emit(event.kind === 'error');
	}

	copies(copies: readonly CopyProgress[]): void {
		for (const copy of copies) {
			const row = this.rows.get(keyOf(copy));
			if (!row || row.state === 'done' || row.state === 'failed') {
				continue;
			}
			row.state = 'copying';
			row.bytesDone = Math.max(row.bytesDone, copy.bytes);
			row.rowsDone = Math.max(row.rowsDone, copy.rows);
		}
		this.emit(false);
	}

	/** The restore finished: nothing is still copying. */
	restored(): void {
		this.doneCopying();
		this.emit(true);
	}

	/** The exact counts on the target replace every estimate. */
	counted(counts: readonly TableCount[]): void {
		for (const count of counts) {
			const row = this.rows.get(keyOf(count));
			if (row) {
				row.state = count.rows === null ? 'failed' : 'done';
				row.rowsDone = count.rows ?? 0;
			}
		}
		this.emit(true);
	}

	private doneCopying(): void {
		if (this.copying === null) {
			return;
		}
		const row = this.rows.get(this.copying);
		if (row && row.state === 'copying') {
			row.state = 'done';
			row.bytesDone = Math.max(row.bytesDone, row.bytesTotal ?? 0);
			row.rowsDone = Math.max(row.rowsDone, row.rowsEstimate ?? 0);
		}
		this.copying = null;
	}

	snapshot(): MoveProgress {
		const tables = [...this.rows.values()].map((row) => ({ ...row }));
		const bytesDone = tables.reduce((sum, row) => sum + row.bytesDone, 0);
		const totals = tables.map((row) => row.bytesTotal);
		const bytesTotal = totals.length > 0 && totals.every((total) => total !== null) ? totals.reduce<number>((sum, total) => sum + (total ?? 0), 0) : null;
		return {
			runId: this.runId,
			moveId: this.moveId,
			phase: this.phase,
			message: this.message,
			tables,
			bytesDone,
			bytesTotal,
			bytesPerSecond: this.phase === 'data' || this.phase === 'indexes' ? this.rate : null,
			objectsFailed: this.failed()
		};
	}

	emit(force: boolean): void {
		const at = this.now();
		if (!force && at - this.lastEmit < EMIT_MS) {
			return;
		}
		this.lastEmit = at;
		const progress = this.snapshot();
		// A rate over at least a second, smoothed, so one slow poll does not swing the ETA.
		if (this.sample === null) {
			this.sample = { at, bytes: progress.bytesDone };
		} else if (at - this.sample.at >= 1000) {
			const instant = ((progress.bytesDone - this.sample.bytes) * 1000) / (at - this.sample.at);
			this.rate = this.rate === null ? instant : this.rate * 0.7 + instant * 0.3;
			this.sample = { at, bytes: progress.bytesDone };
		}
		this.emitTo(progress);
	}
}

function pollTarget(host: MoveRunHost, state: ProgressState, ms: number): { stop(): void } {
	let stopped = false;
	let inFlight = false;
	const timer = setInterval(() => {
		if (stopped || inFlight) {
			return;
		}
		inFlight = true;
		host
			.query('target', PG_COPY_PROGRESS_SQL)
			.then(
				(answer) => {
					if (!stopped) {
						state.copies(copyProgressFromPg(answer).filter((copy) => copy.command === 'COPY FROM'));
					}
				},
				// A missed sample costs one tick of the bar, never the move.
				() => undefined
			)
			.finally(() => {
				inFlight = false;
			});
	}, ms);
	return {
		stop(): void {
			stopped = true;
			clearInterval(timer);
		}
	};
}

async function countRows(host: MoveRunHost, side: Side, tables: readonly TableRef[]): Promise<TableCount[]> {
	const counts: TableCount[] = [];
	for (const chunk of chunks(tables, COUNT_CHUNK)) {
		counts.push(...tableCountsFromPg(await host.query(side, pgRowCountsSql(chunk))));
	}
	return counts;
}

function messageOf(thrown: unknown): string {
	return thrown instanceof Error ? thrown.message : String(thrown);
}

export async function runMove(input: MoveRunInput, host: MoveRunHost): Promise<MoveRunResult> {
	const now = input.now ?? Date.now;
	const started = now();
	const { spec, signal } = input;
	const restoreLog = new ToolLog();
	const dumpLog = new ToolLog();
	const state = new ProgressState(input.runId, spec.id, (progress) => host.onProgress(progress), now, () =>
		restoreLog.failures().filter((failure) => !failure.harmless).length
	);

	let created: MoveRunResult['created'] = null;
	let backup: MoveRunResult['backup'] = null;
	let tables: TableVerification[] = [];
	let sequences: SequenceVerification[] = [];
	let sourceAfter: string | null = null;
	let error: string | null = null;
	let cancelled = false;
	let bytes = 0;

	function stillWanted(): void {
		if (signal.aborted) {
			throw new Cancelled();
		}
	}

	try {
		// Something on the screen at once, before a wake or a create that can take a minute.
		state.emit(true);
		await host.wake('source', (message) => state.set('waking', message));
		stillWanted();
		if (isNewEndpoint(spec.target)) {
			state.set('creating', "Creating the target");
			created = await host.createTarget((message) => state.set('creating', message));
		} else {
			await host.wake('target', (message) => state.set('waking', message));
		}
		stillWanted();

		const schemas = selectedSchemas(spec, input.facts.source);
		if (spec.targetMode === 'replace') {
			backup = await host.backupTarget((message) => state.set('saving', message));
			stillWanted();
			const plan = replacePlan(spec, input.facts);
			if (plan.statements.length > 0) {
				state.set('replacing', `Dropping ${plan.drops.length} object${plan.drops.length === 1 ? '' : 's'} from the target`);
				// One statement text: a host that pools connections still runs it as one transaction.
				await host.query('target', `begin;\n${plan.statements.join(';\n')};\ncommit;`);
			}
		}
		stillWanted();

		const estimates = spec.content === 'schema' ? [] : tableEstimatesFromPg(await host.query('source', pgTableSizesSql(schemas, spec.selection.excludeTables)));
		state.tables(estimates);
		stillWanted();

		const [sourceAccess, targetAccess] = await Promise.all([host.access('source'), host.access('target')]);
		const args = nativePgArgs(spec, { database: targetAccess.database });
		const dumpTool = host.tool('pg_dump');
		const restoreTool = host.tool('pg_restore');
		// Each env owns a private directory; the second failing must not strand the first's.
		const dumpEnv = toolEnv(sourceAccess);
		let restoreEnv: ReturnType<typeof toolEnv>;
		try {
			restoreEnv = toolEnv(targetAccess);
		} catch (err) {
			dumpEnv.dispose();
			throw err;
		}
		state.set('schema', null);
		const poller = spec.content === 'schema' ? null : pollTarget(host, state, input.pollMs ?? 1000);
		let pipeline;
		try {
			pipeline = await runPipeline({
				dump: { file: dumpTool.file, args: [...dumpTool.args, ...args.dump], env: dumpEnv.env },
				restore: { file: restoreTool.file, args: [...restoreTool.args, ...args.restore], env: restoreEnv.env },
				signal,
				onDumpLine: (line) => {
					dumpLog.push(line);
				},
				onRestoreLine: (line) => {
					const event = restoreLog.push(line);
					if (event) {
						state.event(event);
					}
				},
				onBytes: (total) => {
					bytes = total;
				}
			});
		} finally {
			poller?.stop();
			dumpEnv.dispose();
			restoreEnv.dispose();
		}
		if (pipeline.cancelled) {
			throw new Cancelled();
		}
		if (pipeline.spawnError) {
			throw new Error(pipeline.spawnError);
		}
		if (pipeline.dumpExit !== 0) {
			const said = dumpLog.failures()[0]?.message;
			throw new Error(`pg_dump could not read the source${said ? `: ${said}` : ` (it exited with code ${pipeline.dumpExit})`}.`);
		}
		// 1 is "finished, with errors ignored", and those errors are the report. Anything else stopped it.
		if (pipeline.restoreExit !== 0 && !(pipeline.restoreExit === 1 && restoreLog.failures().length > 0)) {
			const said = restoreLog.failures()[0]?.message;
			throw new Error(`pg_restore stopped${said ? `: ${said}` : ` (it exited with code ${pipeline.restoreExit})`}.`);
		}
		state.restored();
		stillWanted();

		if (spec.content !== 'schema') {
			state.set('verifying', "Counting the rows on both sides");
			const refs = estimates.map((estimate) => ({ schema: estimate.schema, table: estimate.table }));
			const [sourceCounts, targetCounts] = await Promise.all([countRows(host, 'source', refs), countRows(host, 'target', refs)]);
			tables = verifyTables(sourceCounts, targetCounts);
			state.counted(targetCounts);
			const [sourceSequences, targetSequences] = await Promise.all([host.query('source', pgSequencesSql(schemas)), host.query('target', pgSequencesSql(schemas))]);
			sequences = verifySequences(sequencesFromPg(sourceSequences), sequencesFromPg(targetSequences));
		}

		const failures = restoreLog.failures();
		if (runStatus({ cancelled: false, failed: false, failures, tables, sequences }) === 'success' && spec.sourceAfter !== 'keep') {
			const action = spec.sourceAfter;
			state.set('finishing', action === 'pause' ? "Pausing the source" : "Deleting the source");
			try {
				sourceAfter = await host.afterSource(action);
			} catch (thrown) {
				// The move itself succeeded; what did not happen to the source is said, not hidden.
				sourceAfter = `The source was not ${action === 'pause' ? 'paused' : 'deleted'}: ${messageOf(thrown)}`;
			}
		}
	} catch (thrown) {
		if (thrown instanceof Cancelled || signal.aborted) {
			cancelled = true;
		} else {
			error = messageOf(thrown);
		}
	}

	const failures: RestoreFailure[] = restoreLog.failures();
	const status = runStatus({ cancelled, failed: error !== null, failures, tables, sequences });
	state.set(status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'done', status === 'failed' ? error : null);
	const finished = now();
	return {
		runId: input.runId,
		moveId: spec.id,
		status,
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(finished).toISOString(),
		error,
		failures: failures.filter((failure) => !failure.harmless),
		harmlessErrors: failures.filter((failure) => failure.harmless).length,
		tables,
		sequences,
		created,
		backup,
		sourceAfter,
		bytes,
		durationMs: finished - started
	};
}

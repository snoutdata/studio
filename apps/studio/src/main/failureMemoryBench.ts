/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionConfig } from '../shared/connection';
import type { AiProviderId } from '../shared/ai';
import { BENCH_SCENARIOS, type BenchScenario, type ErrorClass, type MongoDdl, type MongoWrite } from '../shared/engine';
import type { ConnectionManager } from './connectionManager';
import type { AiService } from './aiService';
import type { FailureMemory } from './failureMemory';
import type { FailureMemoryStore } from './failureMemoryStore';
import { removeConnection, writeConnection } from './configStore';
import { dropPgDatabase, openContention, pgDatabaseName, pgParams, preparePgDatabase, type Contention } from './failureMemoryBenchPg';

/**
 * The live, model-in-the-loop replay benchmark.
 *
 * The deterministic half (does retrieval surface the right prior?) runs in CI as a `node --test`
 * (`failureReplayBenchmark.test.ts`). THIS is the other half — the one the essay's headline number
 * comes from: does injecting the memory make the model stop REPEATING a failure? It needs a real model
 * round-trip (non-deterministic, spends tokens), so it lives behind `SNOUT_MEMORY_BENCH=1` and drives
 * the REAL wiring headlessly, exactly like the self-test: a throwaway SQLite connection, the real
 * `ConnectionManager.execute()` (which routes failures into the sink), the real store, and the real
 * `retrieveFailureNote()`. It reuses the live prompt builder via `AiService.debugChat` so what the
 * model sees is byte-identical to a live chat turn — the only lever is whether the memory note is in
 * the ambient block.
 *
 * Protocol per scenario, per run (the plan's "count how often the second attempt still fails"):
 *   1. Attempt 1: send the task through the assistant, execute the proposed SQL. A failure seeds memory.
 *   2. Attempt 2, memory-OFF: re-run the task with the failing query back on screen but NO memory note
 *      and NO transient error (a fresh re-ask; memory's value is that it outlives that error).
 *   3. Attempt 2, memory-ON: same, PLUS the retrieved memory note.
 * Because the model is non-deterministic, each scenario is run k times (SNOUT_MEMORY_BENCH_RUNS, default
 * 5) and the report aggregates over runs — so the number carries a denominator and a spread, not a single
 * fraction. Segmented by `error_class` and `inferable` (memory should help non-inferable runtime failures
 * far more than inferable ones, where capability/the schema already suffice).
 *
 * Run against the local bench model for a cheap contrast tier; point it at the served model with
 * SNOUT_MEMORY_BENCH_MODEL=<model id> for the production-relevant number.
 *
 * @returns true if the harness completed (a measurement, not a pass/fail gate).
 */
export async function runFailureMemoryBench(deps: {
	connections: ConnectionManager;
	store: FailureMemoryStore;
	failureMemory: FailureMemory;
	aiService: AiService;
}): Promise<boolean> {
	const { connections, store, failureMemory, aiService } = deps;
	const log = (message: string): void => console.log(`[memory-bench] ${message}`);

	const [first] = aiService.benchmarkModels();
	const provider = (process.env.SNOUT_MEMORY_BENCH_PROVIDER as AiProviderId | undefined) ?? first.provider;
	const model = process.env.SNOUT_MEMORY_BENCH_MODEL ?? first.model;
	const runs = Math.max(1, Math.trunc(Number(process.env.SNOUT_MEMORY_BENCH_RUNS) || 5));
	log(`model = ${provider}/${model}  runs/scenario = ${runs}  (override: SNOUT_MEMORY_BENCH_MODEL / _PROVIDER / _RUNS)`);

	const dir = mkdtempSync(join(tmpdir(), 'snout-membench-'));
	const results: ScenarioResult[] = [];

	// The document scenarios measure the `unsupported-translation` class, whose failure is the
	// deterministic SQL→Mongo compiler REFUSING a query (a JOIN). With the AI transcriber wired, that
	// refusal would be rescued (the model translates it) and no failure would seed — so for the whole
	// bench we turn the transcriber OFF, modelling a user who hasn't enabled AI translation. The refusal
	// then becomes a terminal, recorded translation failure (the clean, model-independent seed). Relational
	// scenarios never invoke the transcriber, so this is inert for them. Restored in the finally.
	connections.setAiTranscriber(undefined);

	// Iterating on one class shouldn't cost a full-corpus run: SNOUT_MEMORY_BENCH_ONLY takes a
	// comma-separated list of name prefixes (e.g. `pg-`). Unset runs everything, which is what any
	// number worth reporting is measured on.
	const only = (process.env.SNOUT_MEMORY_BENCH_ONLY ?? '')
		.split(',')
		.map((prefix) => prefix.trim())
		.filter(Boolean);
	const selected = only.length > 0 ? BENCH_SCENARIOS.filter((s) => only.some((prefix) => s.name.startsWith(prefix))) : BENCH_SCENARIOS;
	if (only.length > 0) {
		log(`SUBSET — running ${selected.length}/${BENCH_SCENARIOS.length} scenarios matching ${only.join(', ')} (this is NOT a corpus number)`);
	}

	try {
		for (const scenario of selected) {
			results.push(await runScenario(scenario, { connections, store, failureMemory, aiService, provider, model, runs, dir, log }));
		}
		report(results, runs, log);
	} catch (err) {
		log(`FATAL — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		return false;
	} finally {
		connections.setAiTranscriber((sql, connectionId) => aiService.transcribeToNative(sql, connectionId));
		rmSync(dir, { recursive: true, force: true });
	}
	return true;
}

/** The live Mongo the document scenarios run against. A local `mongo` container with no auth is the
 *  default (`docker run -d -p 27017:27017 mongo`); point elsewhere with SNOUT_MEMORY_BENCH_MONGO_URI
 *  (a full `mongodb://…` string) or the host/port pair. Each scenario gets its own throwaway database
 *  so runs never collide. `directConnection=true` is baked into the default URI: a container mongod's
 *  `hello` advertises its INTERNAL Docker IP, and a driver in topology-discovery mode then dials that
 *  unreachable address (ETIMEDOUT) — directConnection pins the driver to the seed host. */
function mongoConfig(id: string, label: string, scenarioName: string): ConnectionConfig {
	const database = `membench_${scenarioName.replace(/[^a-z0-9]+/gi, '_')}`;
	const host = process.env.SNOUT_MEMORY_BENCH_MONGO_HOST ?? '127.0.0.1';
	const port = Number(process.env.SNOUT_MEMORY_BENCH_MONGO_PORT) || 27017;
	const uri = process.env.SNOUT_MEMORY_BENCH_MONGO_URI ?? `mongodb://${host}:${port}/?directConnection=true`;
	return { id, label, driver: 'mongodb', host: uri, port: 0, database, username: '' };
}

/** The live Postgres the `pg-*` scenarios run against — the `timeout` and `deadlock` classes, which
 *  need a statement timeout and a second session holding locks (see failureMemoryBenchPg.ts). Each
 *  scenario gets its own throwaway database, created and dropped by the rig. */
function pgConfig(id: string, label: string, scenarioName: string): ConnectionConfig {
	const params = pgParams();
	return { id, label, driver: 'postgres', host: params.host, port: params.port, database: pgDatabaseName(scenarioName), username: params.user, password: params.password };
}

/** The aggregate over a scenario's k runs. Counts are over RUNS unless noted; `measured` is the subset
 *  of runs where attempt 1 actually failed (only those have a repeat to measure — a control, or a run the
 *  model got right first try, is not measured). Rates in the report are always `fail / measured`. */
interface ScenarioResult {
	name: string;
	inducedClass: ErrorClass;
	/** whether the failure was derivable from the prompt (the plan's key segmentation axis). */
	inferable: boolean;
	/** the boundary law's axis: did a runnable query that still answers the ask exist for the note to
	 *  steer toward? Undefined where the scenario deliberately doesn't take a position. */
	hasSatisfyingAlternative?: boolean;
	/** the cause was removed before the retry, so the identical query would now succeed. These are not
	 *  scored for repeat-reduction — they measure the opposite risk (memory over-steering). */
	transient: boolean;
	/** the assistant/model couldn't be reached, or setup failed — reported, not scored. */
	skipped?: string;
	/** measurement iterations that ran (== RUNS unless the scenario aborted early). */
	runs: number;
	/** iterations where attempt 1 produced a real failure (the measured subset). */
	measured: number;
	/** of the measured iterations, how many retrieved a note (harness-health signal). */
	noteRetrieved: number;
	/** of the measured iterations, how many still failed with memory OFF. */
	failOff: number;
	/** of the measured iterations, how many still failed with memory ON. */
	failOn: number;
}

async function runScenario(
	scenario: BenchScenario,
	ctx: {
		connections: ConnectionManager;
		store: FailureMemoryStore;
		failureMemory: FailureMemory;
		aiService: AiService;
		provider: AiProviderId;
		model: string;
		runs: number;
		dir: string;
		log: (m: string) => void;
	},
): Promise<ScenarioResult> {
	const { connections, store, failureMemory, aiService, provider, model, runs, dir, log } = ctx;
	const id = `membench-${scenario.name}`;
	const label = `Mem Bench: ${scenario.name}`;
	// Relational scenarios run against a throwaway SQLite file; document scenarios against a live Mongo
	// (skipped cleanly below when none is reachable). Vector isn't wired end to end, so it's refused.
	if (scenario.backend === 'vector') {
		const agg = emptyAgg(scenario);
		log(`SKIP ${scenario.name} — vector backend not runnable yet`);
		return { ...agg, skipped: 'vector backend' };
	}
	const isPostgres = scenario.backend === 'relational' && scenario.driver === 'postgres';
	const config: ConnectionConfig =
		scenario.backend === 'document'
			? mongoConfig(id, label, scenario.name)
			: isPostgres
				? pgConfig(id, label, scenario.name)
				: { id, label, driver: 'sqlite', host: '', port: 0, database: join(dir, `${scenario.name}.db`), username: '' };

	const agg = emptyAgg(scenario);
	// Document scenarios measure `unsupported-translation`, which only exists on the SQL-editor surface
	// (a JOIN the SQL→Mongo compiler refuses). Live chat would give a Mongo connection the native-pipeline
	// prompt, so the assistant would propose a runnable Mongo pipeline and never emit SQL — the class would
	// be unreachable. Forcing SQL mode drives that surface (the model stands in for a developer typing SQL).
	const sqlMode = scenario.backend === 'document';

	try {
		// Postgres scenarios seed and set their statement timeout OUT OF BAND, before the app connects:
		// a 5M-row seed must not run under the very timeout the scenario is about, and a session that is
		// already open would keep whatever timeout it started with.
		if (isPostgres) {
			const prepError = await preparePgDatabase(scenario);
			if (prepError) {
				log(`SKIP ${scenario.name} — postgres ${prepError}`);
				return { ...agg, skipped: `postgres ${prepError}` };
			}
		}
		writeConnection(config);
		try {
			await connections.connect(id);
		} catch (err) {
			// A document backend with no reachable service (no live Mongo): skip, don't mis-measure. The
			// SQLite tier still runs, so CI/dev without Mongo gets the relational numbers.
			const reason = err instanceof Error ? err.message : String(err);
			log(`SKIP ${scenario.name} — ${scenario.backend} backend unreachable: ${reason}`);
			return { ...agg, skipped: `unreachable: ${reason}` };
		}
		const setupError = isPostgres ? null : await applySetup(connections, id, scenario);
		if (setupError) {
			log(`SKIP ${scenario.name} — setup failed: ${setupError}`);
			return { ...agg, skipped: `setup: ${setupError}` };
		}
		await connections.refresh(id); // so the schema fingerprint is meaningful and stable across attempts

		for (let run = 0; run < runs; run++) {
			store.deleteAll(); // each run starts from an empty memory so the seed is exactly this run's failure

			// A contending session, when the scenario needs one, is opened fresh per run and always
			// released in the finally — a leaked holder would poison every later run with a lock nobody
			// asked for.
			let contention: Contention | null = null;
			let cycle: Promise<void> | undefined;
			try {
				contention = await openContention(scenario);
			} catch (err) {
				log(`SKIP ${scenario.name} — contention rig failed: ${err instanceof Error ? err.message : String(err)}`);
				return { ...agg, skipped: 'contention rig' };
			}
			try {
				// --- Attempt 1: the model proposes SQL for the task; executing it may seed a failure memory. ---
				const a1 = await aiService.debugChat({ question: scenario.task, connectionId: id, provider, model, sqlMode });
				if (!a1.ok) {
					// The model is unreachable — abort the whole scenario (every run would fail the same way).
					log(`SKIP ${scenario.name} — model unreachable: ${a1.error}`);
					return { ...agg, skipped: `model: ${a1.error ?? 'unknown'}` };
				}
				agg.runs++;
				const sql1 = extractSql(a1.reply);
				if (!sql1) {
					log(`  ${scenario.name} run ${run + 1}/${runs}: attempt 1 proposed no runnable SQL (not measured)`);
					continue;
				}
				// Start the measured statement, THEN watch for it to block: the cycle-closing statement can
				// only be fired once there is a waiter to deadlock against, so it runs alongside the execute
				// rather than before it.
				const exec1Promise = connections.execute(id, sql1); // recordHistory defaults true → routes through the sink
				cycle = contention?.closeCycleWhenBlocked().catch(() => undefined);
				const exec1 = await exec1Promise;
				await failureMemory.settled(); // the capture is fire-and-forget; wait for it

				if (exec1.ok) {
					// The model got it right this run (or this is the control): nothing to repeat.
					continue;
				}
				agg.measured++;

				const note = await connections.retrieveFailureNote(id, sql1);
				if (note !== null) {
					agg.noteRetrieved++;
				}
				// A TRANSIENT cause is released here, before the retry: the collision is over, so the very
				// same query would now succeed. That inverts what the run measures — not "does memory stop
				// the repeat" but "does memory talk the model out of something that is fine again", the
				// stale-suppression risk the research doc calls a correctness bug rather than a nicety.
				if (scenario.contention?.release === 'after-attempt-1') {
					await contention?.release();
				}
				// Both second attempts model a FRESH re-ask: the failing query is back on screen (that's what
				// triggers retrieval in the live app), but the transient run error is GONE. We deliberately do
				// NOT feed the previous error back in — the whole value proposition of durable failure memory is
				// that it outlives that error. Feeding lastError to both conditions was found to floor the
				// measurement, so the ONLY difference between the two attempts is the memory note.
				const ambientBase = { editorBuffer: sql1 };

				const a2off = await aiService.debugChat({ question: scenario.task, connectionId: id, provider, model, sqlMode, ambient: ambientBase });
				const failOff = await stillFails(connections, id, a2off.reply, a2off.ok);
				if (failOff) {
					agg.failOff++;
				}

				const a2on = await aiService.debugChat({ question: scenario.task, connectionId: id, provider, model, sqlMode, ambient: note ? { ...ambientBase, memoryNote: note } : ambientBase });
				const failOn = await stillFails(connections, id, a2on.reply, a2on.ok);
				if (failOn) {
					agg.failOn++;
				}
			} finally {
				// Release first (that also stops the watcher's poll), then wait for the watcher to actually
				// be gone: a poll loop still holding a session would be dropped out from under it when the
				// scenario's database goes away.
				await contention?.release();
				await cycle;
			}
		}

		log(
			`SCEN ${scenario.name} [${scenario.inferable ? 'inferable' : 'NON-inferable'}] — measured ${agg.measured}/${agg.runs} runs  ` +
				`off=${agg.failOff}/${agg.measured} on=${agg.failOn}/${agg.measured}  note=${agg.noteRetrieved}/${agg.measured}`,
		);
		return agg;
	} catch (err) {
		log(`ERROR ${scenario.name} — ${err instanceof Error ? err.message : String(err)}`);
		return { ...agg, skipped: `error: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		// Bounded: teardown is housekeeping, and a cleanup that hangs must not take the measurement with
		// it — the whole report is printed after the last scenario returns.
		await bounded(connections.disconnect(id).catch(() => undefined), 15_000);
		if (isPostgres) {
			await bounded(dropPgDatabase(scenario.name), 15_000);
		}
		try {
			removeConnection(id);
		} catch {
			// best-effort cleanup
		}
	}
}

/** Wait for `work`, but give up after `ms`. Used only for teardown, where hanging is worse than
 *  leaking: a stuck disconnect or DROP would otherwise strand the run before it prints anything. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** A zeroed aggregate for a scenario — the starting point every result path builds on. */
function emptyAgg(scenario: BenchScenario): ScenarioResult {
	return {
		name: scenario.name,
		inducedClass: scenario.inducedClass,
		inferable: scenario.inferable,
		hasSatisfyingAlternative: scenario.hasSatisfyingAlternative,
		transient: scenario.contention?.release === 'after-attempt-1',
		runs: 0,
		measured: 0,
		noteRetrieved: 0,
		failOff: 0,
		failOn: 0,
	};
}

/** Build the scenario's schema before the task. Relational scenarios run their SQL DDL; document
 *  scenarios create + seed their collections through the connection's native ops (so introspection
 *  infers real fields and the schema fingerprint is meaningful). Returns an error string on the first
 *  failure, or null on success. */
async function applySetup(connections: ConnectionManager, id: string, scenario: BenchScenario): Promise<string | null> {
	if (scenario.backend === 'document') {
		for (const { collection, docs } of scenario.mongoSetup ?? []) {
			// Each scenario reuses a named database, so drop first for a clean seed across bench runs
			// (ignore the result — the collection may not exist yet on the first run).
			await connections.executeMongoDdl(id, [{ op: 'dropCollection', collection }], false).catch(() => undefined);
			const ddl: MongoDdl[] = [{ op: 'createCollection', collection }];
			const created = await connections.executeMongoDdl(id, ddl, false);
			if (!created.ok) {
				return created.error ?? 'createCollection failed';
			}
			if (docs.length > 0) {
				const writes: MongoWrite[] = docs.map((document) => ({ op: 'insertOne', collection, document }));
				const inserted = await connections.executeWrites(id, writes, false);
				if (!inserted.ok) {
					return inserted.error ?? 'insert failed';
				}
			}
		}
		return null;
	}
	for (const statement of scenario.setup) {
		const setupResult = await connections.execute(id, statement, false);
		if (!setupResult.ok) {
			return setupResult.error ?? 'unknown';
		}
	}
	return null;
}

/** Run a second-attempt reply's SQL and decide whether it still fails. No runnable SQL counts as a
 *  failure to help (the model didn't produce something that could run). The execute is recordHistory=false
 *  so scoring the retry never pollutes the memory we're measuring against. */
async function stillFails(connections: ConnectionManager, id: string, reply: string, modelOk: boolean): Promise<boolean> {
	if (!modelOk) {
		return true; // the model call itself failed → the attempt did not succeed
	}
	const sql = extractSql(reply);
	if (!sql) {
		return true;
	}
	const result = await connections.execute(id, sql, false);
	return !result.ok;
}

/** Extract the SQL the assistant proposed from its markdown reply: the first ```sql fenced block,
 *  then any fenced block that looks like SQL, then a bare reply that starts like a statement. */
function extractSql(reply: string): string | null {
	const sqlFence = /```sql\s*\n?([\s\S]*?)```/i.exec(reply);
	if (sqlFence && sqlFence[1].trim()) {
		return sqlFence[1].trim();
	}
	const anyFence = /```[a-z]*\s*\n?([\s\S]*?)```/i.exec(reply);
	if (anyFence && /\b(select|insert|update|delete|with|create|drop|alter)\b/i.test(anyFence[1])) {
		return anyFence[1].trim();
	}
	const trimmed = reply.trim();
	if (/^\s*(select|insert|update|delete|with|create|drop|alter)\b/i.test(trimmed)) {
		return trimmed;
	}
	return null;
}

/** Sum the measured/failOff/failOn counts over a set of scenarios (each already aggregated over its runs). */
function totals(rs: ScenarioResult[]): { measured: number; failOff: number; failOn: number; note: number } {
	return rs.reduce(
		(a, r) => ({ measured: a.measured + r.measured, failOff: a.failOff + r.failOff, failOn: a.failOn + r.failOn, note: a.note + r.noteRetrieved }),
		{ measured: 0, failOff: 0, failOn: 0, note: 0 },
	);
}

function pct(n: number, d: number): string {
	return d ? `${n}/${d} (${((n / d) * 100).toFixed(0)}%)` : 'n/a (0 measured)';
}

/** Print the headline table over ALL measured runs (denominator = measured runs, not scenarios), then the
 *  per-`inferable` and per-`error_class` segmentation, then a per-scenario spread so a stable 0-vs-noisy
 *  result is visible, then harness health. */
function report(results: ScenarioResult[], runs: number, log: (m: string) => void): void {
	// Transient scenarios are excluded from every repeat-failure number: their cause is gone by the
	// retry, so a "repeat" there isn't one. They get their own over-steer line at the bottom.
	const scored = results.filter((r) => !r.skipped && !r.transient);
	const transient = results.filter((r) => !r.skipped && r.transient);
	const skipped = results.filter((r) => r.skipped);
	const all = totals(scored);

	log('──────── RESULTS ────────');
	log(`scenarios=${results.length} runs/scenario=${runs} total-measured-runs=${all.measured} skipped=${skipped.length}`);
	if (skipped.length > 0) {
		log(`skipped: ${skipped.map((r) => `${r.name} (${r.skipped})`).join(', ')}`);
	}
	log(`note-retrieval rate (health): ${pct(all.note, all.measured)}`);
	log(`repeat-failure  memory-OFF: ${pct(all.failOff, all.measured)}`);
	log(`repeat-failure  memory-ON : ${pct(all.failOn, all.measured)}`);

	// The plan's key axis: memory should help far more on non-inferable failures.
	for (const inferable of [false, true]) {
		const t = totals(scored.filter((r) => r.inferable === inferable));
		log(`  ${inferable ? 'inferable    ' : 'non-inferable'}  off=${pct(t.failOff, t.measured)}  on=${pct(t.failOn, t.measured)}`);
	}

	for (const cls of [...new Set(scored.map((r) => r.inducedClass))]) {
		const t = totals(scored.filter((r) => r.inducedClass === cls));
		if (t.measured > 0) {
			log(`  by class [${cls}]  off=${pct(t.failOff, t.measured)}  on=${pct(t.failOn, t.measured)}`);
		}
	}

	// The boundary law as a measured axis, not an essay observation: memory should reduce a repeat only
	// where a runnable query that still answers the ask exists for the note to steer toward.
	for (const [label, has] of [
		['alternative EXISTS  ', true],
		['NO alternative      ', false],
		['unlabelled          ', undefined],
	] as const) {
		const t = totals(scored.filter((r) => r.hasSatisfyingAlternative === has));
		if (t.measured > 0) {
			log(`  boundary [${label}]  off=${pct(t.failOff, t.measured)}  on=${pct(t.failOn, t.measured)}`);
		}
	}

	log('  per-scenario spread (measured/runs · off · on):');
	for (const r of scored) {
		if (r.measured > 0) {
			log(`    ${r.name} [${r.inferable ? 'inf' : 'non'}]  ${r.measured}/${r.runs}  off=${r.failOff}/${r.measured}  on=${r.failOn}/${r.measured}`);
		}
	}

	// The dual of repeat-failure: on a TRANSIENT cause the retry would succeed on its own, so memory-ON
	// failing where memory-OFF didn't is memory making things WORSE — the stale-suppression bug. `off`
	// is the control (it should be ~0); anything `on` costs above it is over-steer.
	if (transient.some((r) => r.measured > 0)) {
		const t = totals(transient);
		log(`  OVER-STEER (transient cause, retry would succeed): off=${pct(t.failOff, t.measured)}  on=${pct(t.failOn, t.measured)}`);
		for (const r of transient) {
			if (r.measured > 0) {
				log(`    ${r.name}  ${r.measured}/${r.runs}  off=${r.failOff}/${r.measured}  on=${r.failOn}/${r.measured}`);
			}
		}
	}
	log('─────────────────────────');
}

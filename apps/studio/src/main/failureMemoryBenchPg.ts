/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Client as PgClient } from 'pg';

import type { BenchScenario } from '../shared/engine';

/**
 * The Postgres side of the live failure-memory benchmark: the throwaway database each `pg-*` scenario
 * runs against, and the contending session that makes a lock wait or a real deadlock happen.
 *
 * Why this is out-of-band (a raw `pg` client, not the app's own connection): it is test INFRASTRUCTURE,
 * not part of what is measured. The measured statement always goes through the real `ConnectionManager`
 * path, exactly like every other scenario — but the collision it runs into has to be arranged by a
 * second session that holds an open transaction, which the app's pooled, autocommit execute path
 * cannot express (there is no session affinity to pin a transaction to).
 *
 * Two properties this buys, both required by the discipline the essay committed to:
 *  - The failure is GROUND TRUTH by construction. A database-level `statement_timeout` (applied AFTER
 *    seeding, so it governs only the measured statement) turns an unbounded scan into a deterministic
 *    timeout; a held row lock turns any update of that row into one too. No model, no judge.
 *  - The deadlock is not timing luck. The rig POLLS `pg_stat_activity` for a backend actually waiting
 *    on a lock and only then fires the statement that closes the cycle, so Postgres raises a genuine
 *    40P01 rather than the waiter simply blocking until its timeout.
 *
 * `pg` is imported dynamically so a normal dev launch never loads it (startup is sacred); nothing here
 * runs unless SNOUT_MEMORY_BENCH=1 selects a `pg-*` scenario.
 */

interface PgConnectionParams {
	host: string;
	port: number;
	user: string;
	password: string;
}

/** Where the bench's Postgres lives. A throwaway trust-auth container is the default:
 *  `docker run -d --name snout-membench-pg -p 5434:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17`.
 *  Override with SNOUT_MEMORY_BENCH_PG_HOST / _PORT / _USER / _PASSWORD. */
export function pgParams(): PgConnectionParams {
	return {
		host: process.env.SNOUT_MEMORY_BENCH_PG_HOST ?? '127.0.0.1',
		port: Number(process.env.SNOUT_MEMORY_BENCH_PG_PORT) || 5434,
		user: process.env.SNOUT_MEMORY_BENCH_PG_USER ?? 'postgres',
		password: process.env.SNOUT_MEMORY_BENCH_PG_PASSWORD ?? 'postgres',
	};
}

/** The database name a scenario gets. One per scenario, dropped and recreated each bench run so a
 *  seed is never inherited from a previous run. */
export function pgDatabaseName(scenarioName: string): string {
	return `membench_${scenarioName.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

async function newClient(database: string): Promise<PgClient> {
	// Dynamic so a normal dev launch never pays for loading `pg` in main (startup is sacred). CJS
	// interop puts the exports on `default` under some bundlers and on the namespace under others.
	const mod = await import('pg');
	const { Client } = mod.default ?? mod;
	const client = new Client({ ...pgParams(), database });
	await client.connect();
	return client;
}

/**
 * Create the scenario's database, run its setup with NO statement timeout (a 5M-row seed must not trip
 * the very limit the scenario is about), then apply the scenario's `statementTimeout` at the DATABASE
 * level so every session the app opens afterwards inherits it. Returns an error string on failure, or
 * null when the database is ready. Must run BEFORE the app connects — a session that is already open
 * keeps whatever timeout it started with.
 */
export async function preparePgDatabase(scenario: BenchScenario): Promise<string | null> {
	const database = pgDatabaseName(scenario.name);
	let admin: PgClient;
	try {
		admin = await newClient('postgres');
	} catch (err) {
		return `unreachable: ${err instanceof Error ? err.message : String(err)}`;
	}
	try {
		await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
		await admin.query(`CREATE DATABASE ${database}`);
	} catch (err) {
		return `create database: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		await admin.end().catch(() => undefined);
	}

	let setup: PgClient;
	try {
		setup = await newClient(database);
	} catch (err) {
		return `connect: ${err instanceof Error ? err.message : String(err)}`;
	}
	try {
		await setup.query('SET statement_timeout = 0');
		for (const statement of scenario.setup) {
			await setup.query(statement);
		}
		if (scenario.statementTimeout) {
			await setup.query(`ALTER DATABASE ${database} SET statement_timeout = '${scenario.statementTimeout}'`);
		}
	} catch (err) {
		return `setup: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		await setup.end().catch(() => undefined);
	}
	return null;
}

/** Drop the scenario's database once the scenario is done. Best-effort — a leftover `membench_*`
 *  database is harmless and the next run drops it anyway. */
export async function dropPgDatabase(scenarioName: string): Promise<void> {
	try {
		const admin = await newClient('postgres');
		await admin.query(`DROP DATABASE IF EXISTS ${pgDatabaseName(scenarioName)} WITH (FORCE)`).catch(() => undefined);
		await admin.end().catch(() => undefined);
	} catch {
		// best-effort cleanup
	}
}

/**
 * A contending transaction, open on its own session, holding whatever locks its statements took.
 * {@link release} rolls it back — call it before the retry for a TRANSIENT cause (the failure is gone,
 * so the same query would now succeed: the over-steer check) or after the run to keep the collision
 * live across both attempts.
 */
export interface Contention {
	/** Watch for a backend waiting on a lock and then fire the scenario's `onWait` statement, which
	 *  requests a lock the waiter already holds and so closes the cycle into a real deadlock. Resolves
	 *  when the statement has been fired (or when nothing ever waited). Safe to call and ignore. */
	closeCycleWhenBlocked(): Promise<void>;
	release(): Promise<void>;
}

/** Open the scenario's contending transaction. Returns null when the scenario has no contention, or
 *  when the holder can't be opened (reported by the caller as a skip rather than mis-measured). */
export async function openContention(scenario: BenchScenario): Promise<Contention | null> {
	const spec = scenario.contention;
	if (!spec) {
		return null;
	}
	const database = pgDatabaseName(scenario.name);
	const holder = await newClient(database);
	await holder.query('SET statement_timeout = 0');
	await holder.query('BEGIN');
	for (const statement of spec.hold) {
		await holder.query(statement);
	}

	let released = false;
	return {
		async closeCycleWhenBlocked(): Promise<void> {
			if (!spec.onWait) {
				return;
			}
			// Poll (never sleep-and-hope) until the measured statement is genuinely blocked, so the
			// deadlock is a property of the lock graph rather than of how fast the model replied.
			//
			// "Blocked" is not enough on its own, and getting this wrong is what turns an intended
			// deadlock into a plain lock-wait timeout: if the holder asks for its second row BEFORE the
			// waiter has taken any row of its own, the holder simply gets the row, the waiter then blocks
			// on both, and there is no cycle to detect. So the predicate also requires the waiter to hold
			// its own transaction id — Postgres assigns one only once a backend has actually written a
			// row, which is exactly "it is holding a row lock somebody could deadlock against".
			const watcher = await newClient(database);
			try {
				await watcher.query('SET statement_timeout = 0');
				for (let waited = 0; waited < 20_000 && !released; waited += 100) {
					const seen = await watcher.query(
						`SELECT count(*)::int AS n
						 FROM pg_stat_activity a
						 WHERE a.datname = $1
						   AND a.wait_event_type = 'Lock'
						   AND EXISTS (
						       SELECT 1 FROM pg_locks l
						       WHERE l.pid = a.pid AND l.granted AND l.locktype = 'transactionid'
						   )`,
						[database],
					);
					if (Number(seen.rows[0]?.n ?? 0) > 0) {
						// The holder now asks for a lock the waiter holds: Postgres detects the cycle and
						// aborts one of them (the measured statement, in this shape).
						await holder.query(spec.onWait).catch(() => undefined);
						return;
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			} catch {
				// The watcher losing its session (e.g. the database being dropped underneath it) just means
				// there is no cycle left to close.
			} finally {
				await watcher.end().catch(() => undefined);
			}
		},
		async release(): Promise<void> {
			if (released) {
				return;
			}
			released = true; // also stops the watcher's poll loop, so no session outlives the run
			await holder.query('ROLLBACK').catch(() => undefined);
			await holder.end().catch(() => undefined);
		},
	};
}

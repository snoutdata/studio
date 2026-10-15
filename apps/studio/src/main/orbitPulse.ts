/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExecuteQueryResult } from '../shared/protocol';
import {
	clampPulseInterval,
	maskedRowsMessage,
	pulseSourceFor,
	pulseUnavailableReason,
	readPulse,
	type PulseSample,
	type PulseStart,
	type PulseSupport,
} from '../shared/orbitPulse';

// Orbit's Pulse 3b sampler: the main-process half that reads a database's OWN activity view on an
// interval and broadcasts what it finds, so the Orbit tab can light the tables real traffic is
// touching rather than only the ones this app touched.
//
// Shaped after `monitorPoller.ts`, and for the same reasons: an interval per target, a narrow
// runner interface so it is testable without the whole ConnectionManager, no overlapping polls for
// one target, and a last-error per target so a view that opens mid-stream can say why it is empty
// instead of hanging on "waiting".
//
// Three things it does NOT do, each deliberate:
//
//   - It never starts itself. Nothing here runs until the renderer asks, and closing the Orbit tab
//     stops it. "Startup is sacred" plus the plainer point that this is a query against a database
//     the user may pay for by the read, so it is opt-in per session.
//   - It never connects on demand. The monitor poller does, because a trend series must keep
//     accumulating whether or not anyone is looking. Pulse is the opposite: it is a live view of a
//     database the user is already looking at, and silently dialling out to a paused or expensive
//     database because a 3D tab is open is not a thing to do on someone's behalf.
//   - It never records history. An automated poll must not pollute the user's query history, and
//     one every two seconds would bury it.

/** The slice of the connection manager the sampler needs. `priority` is the whole point of the
 *  signature: 'background' takes the reservation in `backgroundGate` so a two-second sampler can
 *  never consume the pool an interactive query needs. */
export interface PulseRunner {
	execute(id: string, sql: string, recordHistory?: boolean, allowAiTranscribe?: boolean, priority?: 'interactive' | 'background'): Promise<ExecuteQueryResult>;
	/** The driver id of a saved connection, or undefined when there is no such connection. */
	driverFor(connectionId: string): string | undefined;
}

interface PulseTarget {
	connectionId: string;
	timer: NodeJS.Timeout;
	/** The query in force. Swapped for the fallback once the primary view is refused (MySQL's
	 *  performance_schema is the case that needs it). */
	sql: string;
	source: string;
	/** The fallback, once. Cleared as soon as it is taken, so a failure cannot ping-pong forever. */
	fallbackSql?: string;
	fallbackSource?: string;
	/** The one-shot precondition, if this engine has one. Cleared as soon as it has been asked, so
	 *  it costs one query per Pulse session and not one per tick. */
	requiresSql?: string;
	requiresReason?: string;
	/**
	 * A standing note about this target, which survives a SUCCESSFUL poll. Only the fallback sets
	 * one, and it has to survive: the rail shows the note in place of "Reading <view>", and the view
	 * it names is the one Pulse is no longer reading. Driven against a `--performance-schema=OFF`
	 * MySQL 8: without this the sampler announced the fallback and the very next poll, which
	 * succeeded, replaced the announcement with the old sentence. Pulse was reading the processlist
	 * and telling the user it was reading performance_schema.
	 */
	note?: string;
}

/** Whether a precondition query answered yes. One row, one cell, and MySQL hands back its CASE
 *  result as a number while another engine might hand back '1', so this reads both. */
function firstCellIsTruthy(rows: unknown[][]): boolean {
	const cell = rows[0]?.[0];
	if (cell === null || cell === undefined || cell === '' || cell === false) {
		return false;
	}
	const n = Number(cell);
	return Number.isFinite(n) ? n !== 0 : true;
}

export class OrbitPulseSampler {
	private readonly targets = new Map<string, PulseTarget>();
	private readonly inFlight = new Set<string>();
	// Last poll status per connection: an error string, or null once a poll succeeds.
	private readonly lastStatus = new Map<string, string | null>();

	constructor(
		private readonly runner: PulseRunner,
		private readonly broadcastSamples: (connectionId: string, samples: PulseSample[]) => void,
		private readonly broadcastStatus: (connectionId: string, error: string | null) => void,
	) {}

	/** Whether this connection's engine exposes an activity view, and what it would read. The
	 *  refusal is a sentence, not a flag, because the UI shows it verbatim. */
	support(connectionId: string): PulseSupport {
		const driver = this.runner.driverFor(connectionId) ?? '';
		const source = pulseSourceFor(driver);
		if (!source) {
			return { supported: false, driver, reason: pulseUnavailableReason(driver) };
		}
		return { supported: true, driver, source: source.sourceName };
	}

	/** Whether a sampler is running for this connection. */
	isSampling(connectionId: string): boolean {
		return this.targets.has(connectionId);
	}

	/** The last known poll status (an error string, or null when the last poll was ok). */
	status(connectionId: string): string | null {
		return this.lastStatus.get(connectionId) ?? null;
	}

	/**
	 * Begin sampling a connection. Restarting an already-running target simply re-arms it at the new
	 * interval, so the renderer can move the rail's slider without stopping first.
	 */
	start(connectionId: string, intervalMs?: number): PulseStart {
		const effective = clampPulseInterval(intervalMs);
		const driver = this.runner.driverFor(connectionId) ?? '';
		const source = pulseSourceFor(driver);
		if (!source) {
			return { started: false, intervalMs: effective, reason: pulseUnavailableReason(driver) };
		}
		this.stop(connectionId);
		const target: PulseTarget = {
			connectionId,
			timer: setInterval(() => void this.tick(connectionId), effective),
			sql: source.sql,
			source: source.sourceName,
			fallbackSql: source.fallbackSql,
			fallbackSource: source.fallbackSourceName,
			requiresSql: source.requiresSql,
			requiresReason: source.requiresReason,
		};
		// An interval that keeps the process alive would turn an open Orbit tab into a reason the app
		// cannot quit. Same as the monitor poller.
		target.timer.unref();
		this.targets.set(connectionId, target);
		// Fire once immediately so the world is not dark for a whole interval after the switch flips.
		void this.tick(connectionId);
		return { started: true, intervalMs: effective };
	}

	/** Stop sampling one connection. Safe on a connection that was never started. */
	stop(connectionId: string): void {
		const target = this.targets.get(connectionId);
		if (!target) {
			return;
		}
		clearInterval(target.timer);
		this.targets.delete(connectionId);
		// The status is kept: a view that reopens should still see why the last poll failed. The
		// in-flight marker is NOT cleared, so a poll already on the wire finishes and is discarded by
		// tick()'s own check rather than being able to broadcast into a stopped sampler.
	}

	/** Stop everything (the app is quitting, or the last Orbit tab closed). */
	stopAll(): void {
		for (const connectionId of [...this.targets.keys()]) {
			this.stop(connectionId);
		}
	}

	private setStatus(connectionId: string, error: string | null): void {
		this.lastStatus.set(connectionId, error);
		this.broadcastStatus(connectionId, error);
	}

	private async tick(connectionId: string): Promise<void> {
		const target = this.targets.get(connectionId);
		if (!target) {
			return;
		}
		// Skip if the previous tick is still out. A busy server's activity view can take longer than
		// the interval, and stacking reads on a database the user is paying for is the opposite of
		// what background priority is for.
		if (this.inFlight.has(connectionId)) {
			return;
		}
		this.inFlight.add(connectionId);
		try {
			await this.checkPrecondition(target);
			if (this.targets.get(connectionId) !== target) {
				return;
			}
			// recordHistory=false, allowAiTranscribe=false, priority='background'. All three matter:
			// no history pollution, no model spend behind the user's back, no starving an interactive
			// query.
			const res = await this.runner.execute(connectionId, target.sql, false, false, 'background');
			// The sampler may have been stopped (or restarted) while this was on the wire. Nothing a
			// dead target says should reach the renderer.
			if (this.targets.get(connectionId) !== target) {
				return;
			}
			if (!res.ok) {
				this.failed(target, res.error);
				return;
			}
			const reading = readPulse(res.result, Date.now(), connectionId);
			// A poll that returned only rows the database refused to describe is not a healthy poll,
			// and reporting it as one is how a permissions problem looks exactly like a quiet database.
			// The live run found precisely that on Postgres: a role without pg_read_all_stats saw every
			// session and could read none of them. Masking is the more urgent of the two, so it wins
			// over a standing note; either way a successful poll never silently reports "all well".
			this.setStatus(connectionId, reading.maskedRows > 0 ? maskedRowsMessage(reading.maskedRows) : target.note ?? null);
			this.broadcastSamples(connectionId, reading.samples);
		} catch (err) {
			if (this.targets.get(connectionId) === target) {
				this.failed(target, err instanceof Error ? err.message : String(err));
			}
		} finally {
			this.inFlight.delete(connectionId);
		}
	}

	/**
	 * Ask the engine, ONCE per Pulse session, whether its richer view will actually report. This
	 * exists because of a defect a live MariaDB found: a switched-off `performance_schema` does not
	 * refuse the activity query, it answers it with no rows, for ever, and a fallback that fires on
	 * failure therefore never fires. An empty answer and a broken one are indistinguishable from
	 * here, so the engine is asked outright rather than guessed at from row counts, which would
	 * demote a healthy server every time its database went quiet.
	 */
	private async checkPrecondition(target: PulseTarget): Promise<void> {
		const sql = target.requiresSql;
		if (!sql) {
			return;
		}
		// Cleared before the await, so a slow answer cannot let a second tick ask again.
		target.requiresSql = undefined;
		const reason = target.requiresReason;
		target.requiresReason = undefined;
		let ready = true;
		try {
			const res = await this.runner.execute(target.connectionId, sql, false, false, 'background');
			// A precondition that cannot be RUN says nothing about the view, so it is not treated as a
			// no. If the view is genuinely unreadable the poll itself will fail and take the fallback.
			ready = !res.ok || firstCellIsTruthy(res.result.rows);
		} catch {
			ready = true;
		}
		if (!ready && this.targets.get(target.connectionId) === target) {
			this.switchToFallback(target, reason ?? `${target.source} is not reporting on this server.`);
		}
	}

	/**
	 * A failed poll. Where the engine has a second, humbler view (MySQL, whose performance_schema can
	 * be compiled out or unreadable while the processlist never is) the first failure takes it, ONCE,
	 * and says so. Everything else is reported and retried on the next tick, because a transient
	 * disconnect should heal itself rather than switch the feature off.
	 */
	private failed(target: PulseTarget, error: string): void {
		if (target.fallbackSql) {
			this.switchToFallback(target, `Could not read ${target.source}, falling back to ${target.fallbackSource ?? 'a simpler activity view'}. (${error})`);
			return;
		}
		this.setStatus(target.connectionId, error);
	}

	/** Take the humbler view, once, and say so in the words the caller chose. Cleared as it is taken,
	 *  so a failure cannot ping-pong forever. */
	private switchToFallback(target: PulseTarget, message: string): void {
		if (!target.fallbackSql) {
			this.setStatus(target.connectionId, message);
			return;
		}
		target.sql = target.fallbackSql;
		target.source = target.fallbackSource ?? 'a simpler activity view';
		target.fallbackSql = undefined;
		target.fallbackSource = undefined;
		// Standing, not one-shot: the next successful poll must not erase it (see PulseTarget.note).
		target.note = message;
		this.setStatus(target.connectionId, message);
	}
}

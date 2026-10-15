/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The pluggable contract every TELEMETRY (cloud logs) backend implements.
 *
 *  The sibling of `main/cloud/logSource.ts`, which serves Data Flows, and deliberately NOT the same
 *  interface: a flow moves events into a sink and wants a cursor and a stream; a connection answers
 *  a query and wants a scope list, a column list and rows. Two jobs, two seams, one vocabulary
 *  (`src/shared/cloud.ts`) so nothing above either of them names a vendor.
 *
 *  THE ONE STRUCTURAL DECISION HERE IS `aggregate` BEING OPTIONAL, and it is what makes the same
 *  SQL work on all three services:
 *
 *      | | scan | aggregate at the source |
 *      |---|---|---|
 *      | CloudWatch Logs   | FilterLogEvents (no per-GB charge) | Logs Insights (billed per GB scanned) |
 *      | Azure Monitor     | KQL `take`                        | KQL `summarize` (same API, same price) |
 *      | Cloud Logging     | entries.list                      | NONE — the Logging API cannot           |
 *
 *  A driver that cannot aggregate says so by not implementing it, and the executor
 *  (`telemetryDriver.ts`) computes the grouping over a completed scan instead — refusing, rather
 *  than rounding, when the scan did not finish. Nothing in the app above this line knows which of
 *  the three happened, except the cost line the result carries.
 *
 *  WHAT A DRIVER PUSHES DOWN IS ITS OWN BUSINESS. It renders as much of the query into its
 *  provider's filter language as that language can express, and the executor applies EVERY
 *  predicate again over the rows regardless. Re-checking a pushed-down predicate is free and makes
 *  the seam honest: a driver may push down nothing at all and still be correct.
 *--------------------------------------------------------------------------------------------*/

import type { LogsQuery } from '../../../../shared/engine';
import type { CloudAccount, LogScope, TelemetryServiceDescriptor } from '../../../../shared/cloud';

/** The half-open window a read covers, ms since the epoch: `start` inclusive, `end` exclusive.
 *  The same definition `LogReadWindow` and `LogsQuery` use, and it must stay that way. */
export interface TelemetryWindow {
	start: number;
	end: number;
}

/** One event, in the shape `logRowOf` turns into a row. Structurally `LogEvent`. */
export interface TelemetryEvent {
	id: string;
	at: number;
	ingestedAt?: number;
	stream?: string;
	message: string;
}

export interface TelemetryScanOptions {
	signal?: AbortSignal;
	/** Events seen so far, for a status line. Called per page, not per event. */
	onProgress?: (events: number) => void;
}

/** What a source-side aggregation returned, plus what it cost. */
export interface TelemetryAggregateResult {
	/** Column names in result order — the driver's own, matching the query's aggregate outputs. */
	columns: string[];
	rows: unknown[][];
	/** What the provider reports about the work it did. Rendered in the results footer. */
	cost?: TelemetryCost;
}

/** What a query actually cost, where the provider says. `engine` names which of a driver's engines
 *  ran, because on CloudWatch that is the difference between free and billed. */
export interface TelemetryCost {
	engine?: string;
	bytesScanned?: number;
	recordsScanned?: number;
	recordsMatched?: number;
	/** True when the answer is over a prefix of the window rather than all of it. */
	truncated?: boolean;
}

/** An open client for one account + one container (an AWS region, an Azure workspace, a GCP
 *  project). Cheap to make; closed by whoever opened it. */
export interface TelemetrySession {
	/** Validate the credentials and the container cheaply, for the Test button and connect. Throws
	 *  a driver-explained error when they are not usable. */
	verify(signal?: AbortSignal): Promise<void>;

	/** Do the credentials sign in at all, with no container chosen yet (a session opened with the
	 *  account's default, which may be empty). The cloud account's Test in a build with nothing else
	 *  to test it with. Throws a driver-explained error, like `verify`. */
	verifyAccount(signal?: AbortSignal): Promise<void>;

	/** Every scope these credentials can see in this container. */
	listScopes(signal?: AbortSignal): Promise<LogScope[]>;

	/**
	 * Field names seen in a scope recently, beyond the fixed contract — the columns the explorer
	 * shows under a scope and completion offers.
	 *
	 * Best-effort by contract: returning `[]` is a legitimate answer and must not be read as "this
	 * scope has no structure". Discovery is what a provider offers cheaply, and two of the three
	 * offer nothing, so a query is never gated on it.
	 */
	discoverFields(scope: string, window: TelemetryWindow, signal?: AbortSignal): Promise<string[]>;

	/** Events in the query's window, oldest first, with as much of the query pushed down as this
	 *  provider can express. NON-DECREASING by `at` is a contract, as it is on the flow seam. */
	scan(query: LogsQuery, options?: TelemetryScanOptions): AsyncIterable<TelemetryEvent>;

	/**
	 * Run a query the user wrote in this PROVIDER's own language (Logs Insights, KQL, a Cloud
	 * Logging filter), bounded by `window`.
	 *
	 * The native escape hatch: `{ lang: 'logs-native' }`. The text is passed through untouched — we
	 * never parse or rewrite somebody's query language — and the WINDOW rides alongside rather than
	 * inside it, because none of the three languages expresses one and a telemetry query is never
	 * unbounded. Absent when a provider has no language worth authoring in.
	 */
	runNative?(text: string, window: TelemetryWindow, scope: string | undefined, options?: TelemetryScanOptions): Promise<TelemetryAggregateResult>;

	/** Group and aggregate at the SOURCE. Absent when the provider has no such API — see the table
	 *  in this file's header. */
	aggregate?(query: LogsQuery, options?: TelemetryScanOptions): Promise<TelemetryAggregateResult>;

	/** Cancel whatever is in flight, where the provider has a way to (CloudWatch's StopQuery). A
	 *  driver with none leaves this out and cancellation is the abort signal alone. */
	cancel?(): Promise<void>;

	close(): void;
}

export interface TelemetryDriverPlugin {
	readonly info: TelemetryServiceDescriptor;
	/** Build a client. Nothing is fetched and nothing is validated: this is not a connect. */
	open(account: CloudAccount, secret: string | undefined, container: string): TelemetrySession;
	/** A failure as a sentence that names the fix, in this provider's own error vocabulary. */
	explain(err: unknown, account: CloudAccount, scope?: string): string;
}

const plugins = new Map<string, () => TelemetryDriverPlugin>();

export function registerTelemetryPlugin(service: string, factory: () => TelemetryDriverPlugin): void {
	plugins.set(service, factory);
}

/** The plugin for a service id, or undefined for one that is declared and not built. */
export function telemetryPlugin(service: string): TelemetryDriverPlugin | undefined {
	return plugins.get(service)?.();
}

/** Every telemetry service this build has. */
export function telemetryServices(): TelemetryServiceDescriptor[] {
	return [...plugins.values()].map((factory) => factory().info);
}

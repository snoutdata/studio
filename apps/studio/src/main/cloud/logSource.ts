/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VENDOR_SERVICES } from '../../shared/cloud';
import type {
	CloudAccount,
	LogEvent,
	LogServiceInfo,
	LogScope,
	CloudVendor,
	LogServiceId,
} from '../../shared/cloud';

/*---------------------------------------------------------------------------------------------
 *  The pluggable contract every LOG backend implements.
 *
 *  The sibling of `objectStore.ts`, and modelled on it deliberately, down to the factory map and
 *  the "new vendors are added in one function" rule. Almost every cloud has this service and they
 *  are the same shape underneath:
 *
 *      | | CloudWatch Logs | Azure Monitor Logs | GCP Cloud Logging |
 *      |---|---|---|---|
 *      | scope     | log group       | table (in a workspace) | log name          |
 *      | sub-scope | log stream      | none                   | none              |
 *      | identity  | `eventId`       | none — synthesized     | `insertId`        |
 *      | producer clock | `timestamp` | `TimeGenerated`       | `timestamp`       |
 *      | service clock  | `ingestionTime` | ingestion latency | `receiveTimestamp` |
 *      | filter    | filter pattern  | KQL                    | log filter        |
 *
 *  So nothing in this file, in the flow's log reader or in the wizard names a vendor. A
 *  driver is the only place that knows what a log group is called or how a window is expressed.
 *
 *  Two deliberate differences from `ObjectStoreDriver`, both because logs are not files:
 *
 *  1. `read` is an ASYNC ITERABLE rather than a download. A window can hold ten events or ten
 *     million, the provider pages it, and the reader must be able to stop at its cap without having
 *     materialised the rest. There is nothing to put on disk and nothing to classify.
 *  2. There is no `head`. What an object IS has to be discovered from its bytes; a log event is
 *     already structured, and its `message` is text by definition.
 *--------------------------------------------------------------------------------------------*/

/** The half-open window a read covers, in ms since the epoch. Mirrors `engine`'s `LogWindow`, and
 *  is repeated here so a driver does not import the engine to describe its own parameters. */
export interface LogReadWindow {
	/** Inclusive. */
	start: number;
	/** Exclusive. */
	end: number;
}

export interface LogReadOptions {
	/** Narrow to a sub-division of the scope, where the provider has one
	 *  ({@link LogServiceInfo.streamNoun}). Ignored by a provider that does not. */
	streamPrefix?: string;
	/** The provider's OWN filter language, passed through untouched. We never parse or translate
	 *  somebody's query language; the wizard says whose it is. */
	filter?: string;
	/**
	 * Stop after this many events.
	 *
	 * A hint the driver may overshoot by up to one page: the reader applies the real cap, because
	 * the cap interacts with the cursor boundary and only the reader knows about that.
	 */
	limit?: number;
	signal?: AbortSignal;
	/** Told how far along the window a read is, so a run of a million events is not a frozen screen. */
	onProgress?: (events: number) => void;
}

/** An open client for one account. Cheap to make, and closed by whoever opened it. */
export interface LogSourceSession {
	/** Every scope these credentials can see, with its size and retention where the API reports them. */
	listScopes(signal?: AbortSignal): Promise<LogScope[]>;

	/**
	 * Events in the window, oldest first.
	 *
	 * NON-DECREASING by {@link LogEvent.at} is a contract, not a courtesy: the cursor advances to the
	 * last event it emitted and the cap cuts the stream at an arbitrary point, and both are only
	 * correct if what comes after is not older than what came before.
	 */
	read(scope: string, window: LogReadWindow, options?: LogReadOptions): AsyncIterable<LogEvent>;

	/** Release sockets. Safe to call twice. */
	close(): void;
}

export interface LogSourceDriver {
	readonly info: LogServiceInfo;

	/** Build a client. Nothing is fetched and nothing is validated: this is not a connect. */
	open(account: CloudAccount, secret: string | undefined): LogSourceSession;

	/** A failure as a sentence that names the fix, in this provider's own error vocabulary. The same
	 *  discipline, and for the same reason, as `ObjectStoreDriver.explain`. */
	explain(err: unknown, account: CloudAccount, scope?: string): string;
}

export type LogSourceDriverFactory = () => LogSourceDriver;

const factories = new Map<LogServiceId, LogSourceDriverFactory>();

export function registerLogSourceDriver(service: LogServiceId, factory: LogSourceDriverFactory): void {
	factories.set(service, factory);
}

/**
 * The driver for a service, or undefined for an arm that is declared and not built.
 *
 * Takes a plain string for the same reason `objectStoreDriver` does: a caller may hold a service id
 * from anywhere. "That is not one of mine" is a normal answer here, not a type error to be cast
 * away at every call site.
 */
export function logSourceDriver(service: string): LogSourceDriver | undefined {
	return factories.get(service as LogServiceId)?.();
}

/**
 * The driver that serves this VENDOR's log events, or undefined when it has none or it is not
 * built. The lookup every caller above the seam uses, because what they hold is an ACCOUNT.
 */
export function logSourceFor(vendor: CloudVendor): LogSourceDriver | undefined {
	const service = VENDOR_SERVICES[vendor]?.logs;
	return service ? logSourceDriver(service) : undefined;
}

/** Every log service, built or not, so a picker can list them and grey out what has no driver. */
export function logSourceServices(): LogServiceInfo[] {
	return ALL_SERVICES.map((service) => logSourceDriver(service)?.info ?? UNBUILT[service]);
}

/** Declared arms, in the order a picker shows them. */
const ALL_SERVICES: LogServiceId[] = ['cloudwatch', 'azureMonitor', 'gcpLogging'];

/**
 * What a service with no driver is called.
 *
 * Written down rather than derived, so a user is told "Azure Monitor Logs is not built yet" instead
 * of seeing an arm that silently does not appear. An arm that is invisible is indistinguishable
 * from one nobody has thought about.
 */
const UNBUILT: Record<LogServiceId, LogServiceInfo> = {
	cloudwatch: { service: 'cloudwatch', label: 'Amazon CloudWatch Logs', scopeNoun: 'log group', built: false },
	azureMonitor: { service: 'azureMonitor', label: 'Azure Monitor Logs', scopeNoun: 'table', built: false },
	gcpLogging: { service: 'gcpLogging', label: 'Google Cloud Logging', scopeNoun: 'log', built: false },
};

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The ClickHouse starter monitor: the six numbers a ClickHouse operator watches, as widgets for
 * the monitors poller.
 *
 * This is the other half of the Operations panel, and the split is the point. Operations answers
 * "what is this server doing RIGHT NOW", reading each system table fresh. It cannot answer "when
 * did the parts start piling up", because a system table holds no history and `query_log` holds
 * only what a query wrote. A monitor answers that, by sampling the same tables on a wall clock
 * and keeping the series - which is exactly what the poller already does, so this file is a list
 * of queries and no machinery at all.
 *
 * Pure: it builds SQL strings from a replica scope and nothing else, so the same list serves a
 * single node and a Cloud service. Which tables are read across replicas is NOT a preference - a
 * per-node table (`query_log`, `metrics`, `merges`, `replicas`, `errors`) must be, or a Cloud user
 * sees one arbitrary replica and a different one each minute; and a REPLICATED one (`parts`) must
 * not be, or every part is counted once per replica. The Operations panel draws the same line for
 * the same reason.
 */

import { clickhouseScopeSettings, clickhouseSystemTable, CLICKHOUSE_APP_MARKER, type ReplicaScope } from './engine';
import type { Monitor, MonitorWidget } from './monitor';

/** A widget before it has an id and a connection: what this file decides. */
export interface StarterWidget {
	title: string;
	sql: string;
	viz: MonitorWidget['viz'];
	/** Why it is on the monitor, for the doc and for anyone reading this list. */
	why: string;
}

/** One minute. Every one of these reads a system table, and a system table read every few seconds
 *  is the thing the Operations panel already does; a monitor is the SLOW view of the same facts. */
const INTERVAL_SEC = 60;

/**
 * The starter widgets for a connection with this replica scope.
 *
 * `now() - 60` rather than a window tied to the poll interval: the poller's cadence is the user's
 * to change, and a query that assumed it would silently start double-counting or dropping the
 * moment they did.
 */
export function clickhouseStarterWidgets(scope?: ReplicaScope): StarterWidget[] {
	const log = clickhouseSystemTable('query_log', scope);
	const settings = clickhouseScopeSettings(scope);
	// A distributed query's remote legs are the same query counted again, and the Operations
	// panel's own health reads run every few seconds and would otherwise BE the workload on a
	// quiet server. Both are left out, the same way the workload digest leaves them out.
	const realQueries = `is_initial_query AND NOT startsWith(query, '${CLICKHOUSE_APP_MARKER}')`;
	return [
		{
			title: 'Queries per second',
			why: 'The shape of the load. Everything else on this monitor is read against it.',
			viz: 'line',
			sql: `SELECT round(countIf(type = 'QueryFinish') / 60, 2) AS queries_per_second
FROM ${log}
WHERE event_time > now() - 60 AND ${realQueries}${settings}`,
		},
		{
			title: 'Failed queries per minute',
			why: 'A step up here is a deploy, a bad BI dashboard, or a memory limit being hit.',
			viz: 'line',
			sql: `SELECT countIf(type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')) AS failed
FROM ${log}
WHERE event_time > now() - 60 AND ${realQueries}${settings}`,
		},
		{
			title: 'Memory used (MB)',
			why: 'MemoryTracking is what the server thinks it holds. Its ceiling is where query 241 comes from.',
			viz: 'area',
			sql: `SELECT round(sum(value) / 1048576, 1) AS memory_mb
FROM ${clickhouseSystemTable('metrics', scope)}
WHERE metric = 'MemoryTracking'${settings}`,
		},
		{
			title: 'Merges running',
			why: 'Merges are how parts stop piling up. A count stuck at zero while parts climb is the failure.',
			viz: 'line',
			sql: `SELECT sum(value) AS merges
FROM ${clickhouseSystemTable('metrics', scope)}
WHERE metric = 'Merge'${settings}`,
		},
		{
			// NOT read across replicas: parts are replicated, so a fan-out counts each one per replica.
			title: 'Parts in the largest partition',
			why: 'The "too many parts" failure, before it happens: inserts slow at 300 and are refused at 3,000.',
			viz: 'line',
			sql: `SELECT max(parts) AS parts_in_the_largest_partition
FROM (
    SELECT count() AS parts
    FROM system.parts
    WHERE active AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
    GROUP BY database, table, partition_id
)`,
		},
		{
			title: 'Replica delay (seconds)',
			why: 'How far behind the furthest replica is. Flat zero on a server with no replicated tables.',
			viz: 'line',
			sql: `SELECT max(absolute_delay) AS delay_seconds
FROM ${clickhouseSystemTable('replicas', scope)}${settings}`,
		},
		{
			// A grouped trend: the first column names the series, the last is the value.
			title: 'Errors by name (cumulative)',
			why: 'system.errors counts since start, so the LINE is flat until something goes wrong and its SLOPE is the rate.',
			viz: 'line',
			sql: `SELECT name, sum(value) AS errors
FROM ${clickhouseSystemTable('errors', scope)}
WHERE value > 0
GROUP BY name
ORDER BY errors DESC
LIMIT 8${settings}`,
		},
	];
}

/** The starter monitor for one connection. `newId` supplies ids (crypto.randomUUID in the app,
 *  a counter in a test), so this stays pure and its output is comparable. */
export function clickhouseStarterMonitor(connectionId: string, label: string, newId: () => string, scope?: ReplicaScope, now = Date.now()): Monitor {
	return {
		id: newId(),
		name: `ClickHouse · ${label}`,
		createdAt: now,
		updatedAt: now,
		widgets: clickhouseStarterWidgets(scope).map((widget) => ({
			id: newId(),
			title: widget.title,
			connectionId,
			sql: widget.sql,
			kind: 'trend',
			viz: widget.viz,
			intervalSec: INTERVAL_SEC,
			retentionMin: 24 * 60,
		})),
	};
}

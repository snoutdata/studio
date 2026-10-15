/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ClickHouse Operations: what a person running ClickHouse checks when something is slow or
 *  stuck, read from the server's own `system.*` tables. Running and failed queries, parts per
 *  partition (the "too many parts" failure), merges, mutations, materialized views, dictionaries,
 *  disks and detached parts, column sizes and replication.
 *
 *  Pure: the SQL each view runs, and the reading of a handful of numbers into a verdict. The panel
 *  (ClickHouseOpsView.tsx) runs them. Nothing here writes, except the actions a row offers (stop a
 *  query, cancel a mutation, reload a dictionary), which the panel confirms with the person first.
 *
 *  Sizes are MB as numbers rather than `formatReadableSize` text, so a column sorts by size and
 *  not alphabetically ("9.5 GiB" before "10 KiB").
 *--------------------------------------------------------------------------------------------*/

import { CLICKHOUSE_APP_MARKER, clickhouseScopeSettings, clickhouseSystemTable, quoteClickHouseIdent, type ReplicaScope } from './engine';

export type OpsViewId = 'running' | 'failed' | 'parts' | 'merges' | 'mutations' | 'views' | 'refreshes' | 'dictionaries' | 'disks' | 'detached' | 'columns' | 'replication' | 'repqueue' | 'distqueue' | 'keeper' | 'clusters' | 'ddl' | 'settings' | 'backups' | 'serverlog' | 'crashlog';

/** The views are grouped, one row of groups and one of the views in the open group: sixteen tabs in
 *  one row cannot be read. */
export type OpsGroup = 'Queries' | 'Storage' | 'Objects' | 'Cluster' | 'Server';

export const OPS_GROUPS: readonly OpsGroup[] = ['Queries', 'Storage', 'Objects', 'Cluster', 'Server'];

/** A write a row offers, built from that row's cells. */
export interface OpsRowAction {
	readonly label: string;
	readonly icon: string;
	/** Asked before it runs. */
	confirm(row: Record<string, unknown>): string;
	/** The statement. With a scope that reads across replicas, one that acts on all of them. */
	sql(row: Record<string, unknown>, scope?: ReplicaScope): string;
	/** The same action on the answering node only, tried when the one across replicas is refused
	 *  (ON CLUSTER needs Keeper, which a cluster without replication does not have). */
	local?(row: Record<string, unknown>): string;
}

export interface OpsView {
	readonly id: OpsViewId;
	readonly group: OpsGroup;
	readonly label: string;
	/** One sentence under the tabs: what this view is for. */
	readonly blurb: string;
	/** The read, for the replicas the scope covers. */
	sql(scope?: ReplicaScope): string;
	/** Shown when the view has no rows, which is usually good news. */
	readonly empty: string;
	/** An error that means "this server does not have that", said plainly instead of as an error. */
	readonly unavailable?: { readonly match: RegExp; readonly message: string };
	readonly action?: OpsRowAction;
	/**
	 * This view BROWSES a tree rather than listing a table.
	 *
	 * Keeper is the only one, and it has to be: `system.zookeeper` refuses to be read without a
	 * `path =` predicate, so there is no fixed SELECT that shows it and no way to see a child
	 * except by asking for its parent first. The panel keeps the current path and this builds the
	 * read for it.
	 */
	readonly browse?: {
		readonly root: string;
		/** The column holding a child's own name, which is what a path is built from. */
		readonly nameColumn: string;
		/** The column saying whether a row has children, so a leaf is not offered as a folder. */
		readonly childrenColumn: string;
		sql(path: string): string;
	};
	/**
	 * This view can be narrowed to one thing, from a box above the grid.
	 *
	 * The server log is the view that needs it and the reason the capability exists: unfiltered it
	 * has to be the recent problems or it is thousands of lines of startup chatter, and filtered it
	 * has to be EVERY line for one query, however quiet. Those are two different reads, so the
	 * filtered one is its own.
	 */
	readonly filter?: {
		readonly label: string;
		readonly placeholder: string;
		sql(value: string, scope?: ReplicaScope): string;
	};
	/** A row of this view points at another view, narrowed by one of its columns: the log for THIS
	 *  query. It navigates and runs nothing, which is why it is not an {@link OpsRowAction}. */
	readonly jump?: {
		readonly label: string;
		readonly icon: string;
		readonly view: OpsViewId;
		readonly column: string;
	};
}

const USER_DATABASES = `database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`;

/**
 * Every statement the panel runs starts with this comment, so the running-queries view can leave
 * the panel's OWN reads out: it refreshes several at once, and a list of what the server is doing
 * that is mostly this panel looking at it is noise.
 */
export const OPS_MARKER = CLICKHOUSE_APP_MARKER;

/** A database or object name, backtick-quoted. Exported because the table page's storage views
 *  (`clickhouseTable.ts`) build the same shape of statement against the same system tables. */
export function quoteName(value: unknown): string {
	return quoteClickHouseIdent(String(value ?? ''));
}

const sys = clickhouseSystemTable;

/** A leading `replica` column when the read spans replicas, so each row says which node it is from. */
function replicaColumn(scope?: ReplicaScope): string {
	return scope?.cluster ? 'hostName() AS replica, ' : '';
}

/** Only the statements a person ran, not the legs a distributed query sends to other nodes (which
 *  would otherwise show a query once per replica it touched). */
function initialOnly(scope?: ReplicaScope): string {
	return scope?.cluster ? ' AND is_initial_query' : '';
}

/** `ON CLUSTER x ` for an action that should reach every replica, or ''. */
function onCluster(scope?: ReplicaScope): string {
	return scope?.cluster ? `ON CLUSTER ${quoteName(scope.cluster)} ` : '';
}

/** A value quoted as a ClickHouse string literal. Backslash IS an escape in ClickHouse, so it is
 *  doubled first; exported for the same reason as `quoteName`. */
export function literal(value: unknown): string {
	return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * One level of Keeper.
 *
 * Read from the answering node ALONE, never through `clusterAllReplicas`: every replica talks to
 * the same Keeper, so reading it once per replica would show every node of the tree N times and
 * say nothing extra. That is the opposite of every other view in the Cluster group, and it is the
 * one thing to get right here.
 *
 * `value` is cut short because a node can hold a large blob and this is a tree browser, not a
 * value viewer; the full cell is still there to open.
 */
export function keeperListSql(path: string): string {
	return `SELECT name, numChildren AS children, dataLength AS bytes, substring(value, 1, 200) AS value,
       mtime AS modified, version, ephemeralOwner AS ephemeral_owner
FROM system.zookeeper
WHERE path = ${literal(keeperPath(path))}
ORDER BY name`;
}

/** A Keeper path, normalised: always absolute, never with a trailing slash except at the root, and
 *  never with a doubled separator. */
export function keeperPath(path: string): string {
	const parts = String(path ?? '').split('/').filter((part) => part !== '' && part !== '.');
	return `/${parts.join('/')}`.replace(/\/$/, '') || '/';
}

/** The path of a child of `path`. */
export function keeperChild(path: string, name: string): string {
	return keeperPath(`${keeperPath(path)}/${name}`);
}

/** Every ancestor of `path`, root first, for the breadcrumb. */
export function keeperTrail(path: string): readonly { readonly name: string; readonly path: string }[] {
	const trail: { name: string; path: string }[] = [{ name: '/', path: '/' }];
	let at = '';
	for (const part of keeperPath(path).split('/').filter(Boolean)) {
		at = `${at}/${part}`;
		trail.push({ name: part, path: at });
	}
	return trail;
}

export const OPS_VIEWS: readonly OpsView[] = [
	{
		id: 'running',
		group: 'Queries',
		label: 'Running queries',
		blurb: 'What the server is doing right now, longest first. Stop one that should not be running.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}round(elapsed, 1) AS seconds, user, query, read_rows,
       round(read_bytes / 1048576, 1) AS read_mb, round(memory_usage / 1048576, 1) AS memory_mb, query_id
FROM ${sys('processes', scope)}
WHERE query_id != queryID() AND NOT startsWith(query, '${OPS_MARKER}')${initialOnly(scope)}
ORDER BY elapsed DESC${clickhouseScopeSettings(scope)}`,
		empty: 'Nothing is running on this server right now.',
		action: {
			label: 'Stop',
			icon: 'debug-stop',
			confirm: (row) => `Stop query ${String(row.query_id)} run by ${String(row.user)}? It has been running for ${String(row.seconds)} s.`,
			sql: (row, scope) => `KILL QUERY ${onCluster(scope)}WHERE query_id = ${literal(row.query_id)}`,
			local: (row) => `KILL QUERY WHERE query_id = ${literal(row.query_id)}`,
		},
	},
	{
		id: 'failed',
		group: 'Queries',
		label: 'Failed queries',
		blurb: 'Errors in the last hour, grouped by kind, most frequent first. What is breaking, beside what is slow. Open one in the server log to see every line the query produced, not just the one it was refused with.',
		sql: (scope) => `SELECT errorCodeToName(exception_code) AS error, count() AS times, max(event_time) AS last_seen,
       uniqExact(user) AS users,${scope?.cluster ? " arrayStringConcat(arraySort(groupUniqArray(hostName())), ', ') AS replicas," : ''} substring(any(exception), 1, 400) AS message, any(query) AS example,
       argMax(query_id, event_time) AS last_query_id
FROM ${sys('query_log', scope)}
WHERE type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing') AND event_time > now() - INTERVAL 1 HOUR
  AND NOT startsWith(query, '${OPS_MARKER}')${initialOnly(scope)}
GROUP BY exception_code
ORDER BY times DESC${clickhouseScopeSettings(scope)}`,
		empty: 'No query has failed in the last hour.',
		// The link the tracker called "why did this fail": the most recent id of this kind of
		// failure, opened in the log that holds everything the server said while running it.
		jump: { label: 'Server log', icon: 'output', view: 'serverlog', column: 'last_query_id' },
	},
	{
		id: 'parts',
		group: 'Storage',
		label: 'Parts',
		blurb: 'Every INSERT writes a part and merges combine them. Too many parts in one partition slows inserts, then refuses them.',
		sql: () => `SELECT database, table, max(parts) AS max_parts_in_a_partition, sum(parts) AS active_parts,
       count() AS partitions, sum(rows) AS rows, round(sum(bytes) / 1048576, 1) AS on_disk_mb
FROM (
    SELECT database, table, partition_id, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes
    FROM system.parts
    WHERE active AND ${USER_DATABASES}
    GROUP BY database, table, partition_id
)
GROUP BY database, table
ORDER BY max_parts_in_a_partition DESC`,
		empty: 'No MergeTree tables with data on this server.',
	},
	{
		id: 'merges',
		group: 'Storage',
		label: 'Merges',
		blurb: 'Background merges in progress. A mutation (ALTER UPDATE or DELETE) runs as a merge too.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, round(elapsed, 1) AS seconds, round(progress * 100, 1) AS percent, num_parts,
       round(total_size_bytes_compressed / 1048576, 1) AS size_mb, is_mutation
FROM ${sys('merges', scope)}
ORDER BY elapsed DESC${clickhouseScopeSettings(scope)}`,
		empty: 'No merges are running.',
	},
	{
		id: 'mutations',
		group: 'Storage',
		label: 'Mutations',
		blurb: 'ALTER UPDATE and DELETE that have not finished. One that keeps failing blocks the ones after it on the same table.',
		sql: () => `SELECT database, table, mutation_id, command, create_time, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE NOT is_done
ORDER BY create_time`,
		empty: 'No mutations are waiting.',
		action: {
			label: 'Cancel',
			icon: 'close',
			confirm: (row) => `Cancel mutation ${String(row.mutation_id)} on ${String(row.database)}.${String(row.table)}? Parts it already rewrote stay rewritten.`,
			sql: (row) => `KILL MUTATION WHERE database = ${literal(row.database)} AND table = ${literal(row.table)} AND mutation_id = ${literal(row.mutation_id)}`,
		},
	},
	{
		id: 'views',
		group: 'Objects',
		label: 'Materialized views',
		blurb: 'Each materialized view is an insert trigger: what it reads from, and the table its rows land in.',
		sql: () => `WITH deps AS (
    SELECT arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep, database || '.' || name AS source
    FROM system.tables WHERE length(dependencies_table) > 0
)
SELECT t.database AS database, t.name AS materialized_view, arrayStringConcat(groupArray(deps.source), ', ') AS reads_from,
       ifNull(nullIf(extract(any(t.create_table_query), 'TO ([^ (]+)'), ''), '(its own inner table)') AS writes_to,
       any(t.as_select) AS definition
FROM system.tables AS t LEFT JOIN deps ON deps.dep.1 = t.database AND deps.dep.2 = t.name
WHERE t.engine = 'MaterializedView'
GROUP BY t.database, t.name
ORDER BY t.database, t.name`,
		empty: 'No materialized views on this server.',
	},
	{
		id: 'refreshes',
		group: 'Objects',
		label: 'Refreshable views',
		blurb: 'Materialized views that re-run on a schedule (REFRESH EVERY): when each last succeeded, when it runs next, and why it failed.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, view, status, last_success_time, round(last_success_duration_ms / 1000, 1) AS last_seconds,
       next_refresh_time, exception
FROM ${sys('view_refreshes', scope)}
ORDER BY exception = '' ASC, database, view${clickhouseScopeSettings(scope)}`,
		empty: 'No refreshable materialized views.',
		unavailable: { match: /UNKNOWN_TABLE|view_refreshes/, message: 'This server is older than refreshable materialized views.' },
		action: {
			label: 'Refresh now',
			icon: 'play',
			confirm: (row) => `Run ${String(row.database)}.${String(row.view)} now, instead of waiting for ${String(row.next_refresh_time)}?`,
			sql: (row) => `SYSTEM REFRESH VIEW ${quoteName(row.database)}.${quoteName(row.view)}`,
		},
	},
	{
		id: 'dictionaries',
		group: 'Objects',
		label: 'Dictionaries',
		blurb: 'In-memory lookup tables. A failed one makes every dictGet on it fail, so its last error is shown in full.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, name, status, type, element_count AS elements, round(bytes_allocated / 1048576, 2) AS memory_mb,
       last_successful_update_time AS last_loaded, loading_duration AS load_seconds, last_exception
FROM ${sys('dictionaries', scope)}
ORDER BY last_exception = '' ASC, database, name${clickhouseScopeSettings(scope)}`,
		empty: 'No dictionaries on this server.',
		action: {
			label: 'Reload',
			icon: 'refresh',
			confirm: (row) => `Reload dictionary ${String(row.database)}.${String(row.name)} from its source now?`,
			sql: (row, scope) => `SYSTEM RELOAD DICTIONARY ${onCluster(scope)}${quoteName(row.database)}.${quoteName(row.name)}`,
			local: (row) => `SYSTEM RELOAD DICTIONARY ${quoteName(row.database)}.${quoteName(row.name)}`,
		},
	},
	{
		id: 'disks',
		group: 'Storage',
		label: 'Disks',
		blurb: 'Free space on each disk. Merges need room to write the part they produce, so a full disk stops them first.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}name, path, round(free_space / 1073741824, 1) AS free_gb, round(total_space / 1073741824, 1) AS total_gb,
       round(100 - free_space * 100 / nullIf(total_space, 0), 1) AS used_percent
FROM ${sys('disks', scope)}
ORDER BY used_percent DESC${clickhouseScopeSettings(scope)}`,
		empty: 'No disks reported.',
	},
	{
		id: 'detached',
		group: 'Storage',
		label: 'Detached parts',
		blurb: 'Parts set aside and no longer read: detached by hand, or by the server because they were broken or unexpected. They still take disk.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, partition_id, name, reason, disk
FROM ${sys('detached_parts', scope)}
WHERE ${USER_DATABASES}
ORDER BY database, table, name${clickhouseScopeSettings(scope)}`,
		empty: 'No detached parts.',
	},
	{
		id: 'columns',
		group: 'Storage',
		label: 'Column sizes',
		blurb: 'The 200 largest columns on disk, and how well each compresses. A poor ratio is often a codec or a LowCardinality away from a big saving.',
		sql: () => `SELECT database, table, name AS column, type,
       round(data_compressed_bytes / 1048576, 2) AS compressed_mb,
       round(data_uncompressed_bytes / 1048576, 2) AS uncompressed_mb,
       round(data_uncompressed_bytes / nullIf(data_compressed_bytes, 0), 1) AS ratio
FROM system.columns
WHERE ${USER_DATABASES} AND data_compressed_bytes > 0
ORDER BY data_compressed_bytes DESC
LIMIT 200`,
		empty: 'No column holds data yet.',
	},
	{
		id: 'replication',
		group: 'Cluster',
		label: 'Replication',
		blurb: 'Replicated tables: how far behind each replica is, and what it still has to do.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, is_readonly, absolute_delay AS delay_s, queue_size, inserts_in_queue, merges_in_queue,
       active_replicas, total_replicas
FROM ${sys('replicas', scope)}
ORDER BY absolute_delay DESC${clickhouseScopeSettings(scope)}`,
		empty: 'No replicated tables on this server.',
	},
	{
		id: 'repqueue',
		group: 'Cluster',
		label: 'Replication queue',
		blurb: 'What each replica still has to fetch or merge, and why an entry is stuck. A queue that only grows is the failure behind "the replica is behind".',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, type, new_part_name AS part, num_tries AS tries,
       is_currently_executing AS running, create_time AS queued, last_attempt_time AS last_try,
       substring(concat(ifNull(last_exception, ''), ifNull(postpone_reason, '')), 1, 400) AS problem
FROM ${sys('replication_queue', scope)}
ORDER BY num_tries DESC, create_time
LIMIT 500${clickhouseScopeSettings(scope)}`,
		empty: 'Every replica has caught up: nothing is waiting to be fetched or merged.',
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, message: 'This server has no replication queue, so it has no replicated tables.' },
		action: {
			// Deliberately node-local and never ON CLUSTER: restarting every replica of a table at
			// once is how a stuck replica becomes an outage. This re-reads the table's state from
			// Keeper on the one node the entry is stuck on, which is the documented repair.
			label: 'Restart replica',
			icon: 'refresh',
			confirm: (row) => `Restart the replica of ${String(row.database)}.${String(row.table)} on this node? It re-reads the table's state from Keeper and starts its queue again. Reads and writes to that table pause while it does.`,
			sql: (row) => `SYSTEM RESTART REPLICA ${quoteName(row.database)}.${quoteName(row.table)}`,
		},
	},
	{
		id: 'distqueue',
		group: 'Cluster',
		label: 'Distributed inserts',
		blurb: 'Rows written to a Distributed table that are still on disk here, waiting to be sent to the shard that owns them. Not lost, not yet arrived.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, is_blocked AS blocked, error_count AS errors, data_files AS files,
       round(data_compressed_bytes / 1048576, 1) AS pending_mb, broken_data_files AS broken,
       substring(ifNull(last_exception, ''), 1, 400) AS problem
FROM ${sys('distribution_queue', scope)}
ORDER BY data_files DESC${clickhouseScopeSettings(scope)}`,
		empty: 'Nothing is waiting to be sent: every Distributed insert has arrived.',
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, message: 'This server has no distribution queue, so it has no Distributed tables.' },
		action: {
			label: 'Send now',
			icon: 'run',
			confirm: (row) => `Send the ${String(row.files)} pending file(s) for ${String(row.database)}.${String(row.table)} now? It waits until they have gone.`,
			sql: (row) => `SYSTEM FLUSH DISTRIBUTED ${quoteName(row.database)}.${quoteName(row.table)}`,
		},
	},
	{
		id: 'keeper',
		group: 'Cluster',
		label: 'Keeper',
		blurb: "What the cluster agrees on, read from Keeper itself: every replicated table's log, its replicas and their positions. Read-only, and the last place to look when a queue makes no sense.",
		// The root listing, for anything that asks a view for its SQL without knowing it browses.
		sql: () => keeperListSql('/'),
		empty: 'Nothing is at this path.',
		unavailable: { match: /NO_ELEMENTS_IN_CONFIG|Zookeeper|Keeper|UNKNOWN_TABLE/i, message: 'This server has no Keeper configured, so there is no coordination tree to read.' },
		browse: { root: '/', nameColumn: 'name', childrenColumn: 'children', sql: (path) => keeperListSql(path) },
	},
	{
		id: 'clusters',
		group: 'Cluster',
		label: 'Clusters',
		blurb: 'Every node of every cluster this server knows, and how often reaching it has failed. A rising error count is a node going away.',
		sql: () => `SELECT cluster, shard_num AS shard, replica_num AS replica, host_name AS host, port, is_local,
       errors_count AS errors, slowdowns_count AS slowdowns, estimated_recovery_time AS recovery_s
FROM system.clusters
ORDER BY errors DESC, cluster, shard, replica`,
		empty: 'This server is not part of a cluster.',
	},
	{
		id: 'ddl',
		group: 'Cluster',
		label: 'DDL queue',
		blurb: 'ON CLUSTER statements and how far each host got with them. A host stuck in the queue is behind on schema.',
		sql: () => `SELECT entry, host, status, exception_code, query_create_time AS created, query
FROM system.distributed_ddl_queue
WHERE status != 'Finished'
ORDER BY query_create_time DESC
LIMIT 200`,
		empty: 'Every ON CLUSTER statement has finished on every host.',
		unavailable: { match: /NO_ELEMENTS_IN_CONFIG|Zookeeper|Keeper/i, message: 'This server has no Keeper configured, so there are no ON CLUSTER statements to track.' },
	},
	{
		id: 'serverlog',
		group: 'Server',
		label: 'Server log',
		// `level` is an Enum8 ordered Fatal .. Trace, and it is tempting to write `level <= 'Warning'`
		// for "this bad or worse". That compiles, runs, and is WRONG: the comparison is against the
		// string, so 'Trace' <= 'Warning' alphabetically and the filter lets everything through. The
		// list is the honest form, and the live server is what caught it.
		blurb: "The server's own log, as rows. Unfiltered it is the problems of the last hour; put a query id in the box and it is every line that query produced, which is the whole answer to \"why did that fail\" rather than the one line the client was sent.",
		sql: (scope) => `SELECT ${replicaColumn(scope)}event_time AS at, toString(level) AS level, logger_name AS logger, query_id, message
FROM ${sys('text_log', scope)}
WHERE event_time > now() - INTERVAL 1 HOUR AND level IN ('Fatal', 'Critical', 'Error', 'Warning')
ORDER BY event_time DESC
LIMIT 500${clickhouseScopeSettings(scope)}`,
		empty: 'Nothing above a warning in the last hour.',
		// Not "an error": logging to a table is OFF in a default install, so the honest answer names
		// the switch rather than reporting a missing table as a fault.
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, message: "This server does not log to a table. Switch it on with a <text_log> section in the server's config, and it will record its own log as rows from the next restart." },
		filter: {
			label: 'Query id or text',
			placeholder: 'a query id, or a word from the message',
			// Every level, and a day rather than an hour: a filter means the person knows what they
			// are looking for, and the line they need is as likely to be a Debug as an Error.
			sql: (value, scope) => `SELECT ${replicaColumn(scope)}event_time AS at, toString(level) AS level, logger_name AS logger, query_id, message
FROM ${sys('text_log', scope)}
WHERE event_time > now() - INTERVAL 1 DAY
  AND (query_id = ${literal(value)} OR positionCaseInsensitive(message, ${literal(value)}) > 0 OR positionCaseInsensitive(toString(logger_name), ${literal(value)}) > 0)
ORDER BY event_time, event_time_microseconds
LIMIT 500${clickhouseScopeSettings(scope)}`,
		},
	},
	{
		id: 'crashlog',
		group: 'Server',
		label: 'Crashes',
		blurb: 'Signals the server has died on, with the stack it died in. A table that does not exist is the good outcome.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}event_time AS at, signal, thread_id, query_id, version,
       substring(arrayStringConcat(trace_full, ' | '), 1, 2000) AS stack
FROM ${sys('crash_log', scope)}
ORDER BY event_time DESC
LIMIT 50${clickhouseScopeSettings(scope)}`,
		empty: 'No crash has been recorded on this server.',
		// The table is CREATED by the first crash, so its absence is the answer, not a failure.
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, message: 'No crash has ever been recorded on this server: ClickHouse creates that table the first time it dies, and it is not there.' },
	},
	{
		id: 'settings',
		group: 'Server',
		label: 'Changed settings',
		blurb: "Settings that differ from ClickHouse's defaults for this user: what makes this server behave unlike the documentation.",
		sql: () => `SELECT name, value, default, description
FROM system.settings
WHERE changed
ORDER BY name`,
		empty: "This user runs on ClickHouse's default settings.",
	},
	{
		id: 'backups',
		group: 'Server',
		label: 'Backups',
		blurb: 'BACKUP and RESTORE since the server started: whether each finished, how big it was, and why one failed.',
		sql: (scope) => `SELECT ${replicaColumn(scope)}name, status, start_time, end_time, num_files AS files, round(total_size / 1048576, 1) AS size_mb, error
FROM ${sys('backups', scope)}
ORDER BY start_time DESC${clickhouseScopeSettings(scope)}`,
		empty: 'No BACKUP or RESTORE has run since this server started.',
	},
];

/** The views in one group, in their order. */
export function viewsIn(group: OpsGroup): OpsView[] {
	return OPS_VIEWS.filter((view) => view.group === group);
}

/** The plain sentence for an error that only means the server lacks the feature, or undefined. */
export function unavailableMessage(view: OpsView, error: string): string | undefined {
	return view.unavailable && view.unavailable.match.test(error) ? view.unavailable.message : undefined;
}

/** The statement the panel sends for a view or a health check: marked as the panel's own. */
export function opsSql(sql: string): string {
	return `${OPS_MARKER} ${sql}`;
}

export function opsView(id: OpsViewId): OpsView {
	return OPS_VIEWS.find((view) => view.id === id) ?? OPS_VIEWS[0];
}

/**
 * The numbers the health summary reads, over the replicas the scope covers. Each is its own query, so a user who may read some system
 * tables and not others still gets the checks they CAN see (a missing one says so, rather than the
 * whole summary failing).
 */
export function healthSql(scope?: ReplicaScope): Record<HealthCheck, string> {
	const tail = clickhouseScopeSettings(scope);
	return {
		running: `SELECT count() AS n, max(elapsed) AS longest FROM ${sys('processes', scope)} WHERE query_id != queryID() AND NOT startsWith(query, '${OPS_MARKER}')${initialOnly(scope)}${tail}`,
		parts: `SELECT database, table, partition_id, count() AS parts
FROM system.parts WHERE active AND ${USER_DATABASES}
GROUP BY database, table, partition_id ORDER BY parts DESC LIMIT 1`,
		limits: `SELECT name, value FROM system.merge_tree_settings WHERE name IN ('parts_to_delay_insert', 'parts_to_throw_insert')`,
		mutations: `SELECT count() AS pending, countIf(latest_fail_reason != '') AS failing FROM system.mutations WHERE NOT is_done`,
		// Replicated tables, dictionaries and refreshable views exist on every replica: each is
		// counted once, and failing when any replica has it failing.
		replication: `SELECT uniqExact(database, table) AS tables, uniqExactIf((database, table), is_readonly) AS readonly, max(absolute_delay) AS delay FROM ${sys('replicas', scope)}${tail}`,
		failed: `SELECT count() AS n, uniqExact(exception_code) AS kinds FROM ${sys('query_log', scope)}
WHERE type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing') AND event_time > now() - INTERVAL 1 HOUR
  AND NOT startsWith(query, '${OPS_MARKER}')${initialOnly(scope)}${tail}`,
		disk: `SELECT ${scope?.cluster ? "hostName() || ':' || name" : 'name'} AS name, round(100 - free_space * 100 / nullIf(total_space, 0), 1) AS used_percent, free_space
FROM ${sys('disks', scope)} ORDER BY used_percent DESC LIMIT 1${tail}`,
		detached: `SELECT count() AS n FROM ${sys('detached_parts', scope)} WHERE ${USER_DATABASES}${tail}`,
		dictionaries: `SELECT uniqExact(database, name) AS total, uniqExactIf((database, name), startsWith(toString(status), 'FAILED') OR last_exception != '') AS failing FROM ${sys('dictionaries', scope)}${tail}`,
		refreshes: `SELECT uniqExact(database, view) AS total, uniqExactIf((database, view), exception != '') AS failing FROM ${sys('view_refreshes', scope)}${tail}`,
	};
}

export type HealthCheck = 'running' | 'parts' | 'limits' | 'mutations' | 'replication' | 'failed' | 'disk' | 'detached' | 'dictionaries' | 'refreshes';

export type HealthLevel = 'ok' | 'warn' | 'error' | 'unknown';

export interface HealthItem {
	readonly level: HealthLevel;
	readonly title: string;
	readonly detail: string;
	/** The view that shows the rows behind it. */
	readonly view: OpsViewId;
}

/** What the health queries returned. `undefined` means the query could not run (usually a grant). */
export interface HealthInput {
	running?: { n: number; longest: number };
	worstPartition?: { database: string; table: string; parts: number } | null;
	delayAt?: number;
	throwAt?: number;
	mutations?: { pending: number; failing: number };
	replication?: { tables: number; readonly: number; delay: number };
	failed?: { n: number; kinds: number };
	disk?: { name: string; usedPercent: number; free: number } | null;
	detached?: number;
	dictionaries?: { total: number; failing: number };
	/** Refreshable views. Absent on a server too old to have them, which shows no card at all. */
	refreshes?: { total: number; failing: number };
}

/** ClickHouse's defaults, used when the server's own values could not be read. */
const DEFAULT_DELAY_AT = 1000;
const DEFAULT_THROW_AT = 3000;
/** A replica this many seconds behind is worth a look. */
const REPLICA_LAG_WARN_S = 300;
/** Disk use at which merges start to be at risk, and at which they will soon stop. */
const DISK_WARN_PERCENT = 80;
const DISK_ERROR_PERCENT = 90;
/** Failed queries in an hour worth flagging: a few are typos, a stream is an application. */
const FAILED_WARN = 20;

function bytes(n: number): string {
	const gb = n / 1073741824;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`;
}

function unknown(view: OpsViewId, title: string): HealthItem {
	return { level: 'unknown', title, detail: 'This user cannot read the system table it needs.', view };
}

/** Read the numbers into four verdicts, worst first within the fixed order of the cards. */
export function assessHealth(input: HealthInput): HealthItem[] {
	const items: HealthItem[] = [];

	if (input.worstPartition === undefined) {
		items.push(unknown('parts', 'Parts'));
	} else if (input.worstPartition === null) {
		items.push({ level: 'ok', title: 'Parts', detail: 'No MergeTree data yet.', view: 'parts' });
	} else {
		const delayAt = input.delayAt ?? DEFAULT_DELAY_AT;
		const throwAt = input.throwAt ?? DEFAULT_THROW_AT;
		const { database, table, parts } = input.worstPartition;
		const where = `${database}.${table}`;
		if (parts >= throwAt) {
			items.push({ level: 'error', title: 'Too many parts', detail: `${where} has ${parts.toLocaleString()} parts in one partition. Inserts into it are being refused (limit ${throwAt.toLocaleString()}).`, view: 'parts' });
		} else if (parts >= delayAt) {
			items.push({ level: 'warn', title: 'Inserts slowed', detail: `${where} has ${parts.toLocaleString()} parts in one partition. Inserts are being delayed from ${delayAt.toLocaleString()}, refused at ${throwAt.toLocaleString()}.`, view: 'parts' });
		} else if (parts >= delayAt / 2) {
			items.push({ level: 'warn', title: 'Parts piling up', detail: `${where} has ${parts.toLocaleString()} parts in one partition, half way to the ${delayAt.toLocaleString()} where inserts slow down. Batch inserts, or check merges.`, view: 'parts' });
		} else {
			items.push({ level: 'ok', title: 'Parts', detail: `At most ${parts.toLocaleString()} parts in a partition (${where}). Inserts slow at ${delayAt.toLocaleString()}.`, view: 'parts' });
		}
	}

	if (!input.mutations) {
		items.push(unknown('mutations', 'Mutations'));
	} else if (input.mutations.failing > 0) {
		items.push({ level: 'error', title: 'Mutations failing', detail: `${input.mutations.failing} of ${input.mutations.pending} pending mutations keep failing, and they block the ones behind them on the same table.`, view: 'mutations' });
	} else if (input.mutations.pending > 0) {
		items.push({ level: 'warn', title: 'Mutations pending', detail: `${input.mutations.pending} mutation${input.mutations.pending === 1 ? ' has' : 's have'} not finished yet.`, view: 'mutations' });
	} else {
		items.push({ level: 'ok', title: 'Mutations', detail: 'None waiting.', view: 'mutations' });
	}

	if (!input.replication) {
		items.push(unknown('replication', 'Replication'));
	} else if (input.replication.tables === 0) {
		items.push({ level: 'ok', title: 'Replication', detail: 'No replicated tables on this server.', view: 'replication' });
	} else if (input.replication.readonly > 0) {
		items.push({ level: 'error', title: 'Replicas read-only', detail: `${input.replication.readonly} replicated table${input.replication.readonly === 1 ? ' is' : 's are'} read-only, usually a lost connection to Keeper. Inserts into them fail.`, view: 'replication' });
	} else if (input.replication.delay >= REPLICA_LAG_WARN_S) {
		items.push({ level: 'warn', title: 'Replica lag', detail: `A replica is ${Math.round(input.replication.delay).toLocaleString()} s behind.`, view: 'replication' });
	} else {
		items.push({ level: 'ok', title: 'Replication', detail: `${input.replication.tables} replicated table${input.replication.tables === 1 ? '' : 's'}, in step.`, view: 'replication' });
	}

	if (input.disk === undefined) {
		items.push(unknown('disks', 'Disk'));
	} else if (input.disk === null) {
		items.push({ level: 'ok', title: 'Disk', detail: 'No disks reported.', view: 'disks' });
	} else {
		const { name, usedPercent, free } = input.disk;
		const detached = input.detached ?? 0;
		if (usedPercent >= DISK_ERROR_PERCENT) {
			items.push({ level: 'error', title: 'Disk nearly full', detail: `Disk ${name} is ${usedPercent}% used (${bytes(free)} free). Merges need room to write, and stop first.`, view: 'disks' });
		} else if (usedPercent >= DISK_WARN_PERCENT) {
			items.push({ level: 'warn', title: 'Disk filling up', detail: `Disk ${name} is ${usedPercent}% used (${bytes(free)} free).`, view: 'disks' });
		} else if (detached > 0) {
			items.push({ level: 'warn', title: 'Detached parts', detail: `${detached} detached part${detached === 1 ? '' : 's'} still on disk, no longer read.`, view: 'detached' });
		} else {
			items.push({ level: 'ok', title: 'Disk', detail: `Disk ${name} is ${usedPercent}% used, ${bytes(free)} free.`, view: 'disks' });
		}
	}

	if (!input.dictionaries) {
		items.push(unknown('dictionaries', 'Dictionaries'));
	} else if (input.dictionaries.failing > 0) {
		items.push({ level: 'error', title: 'Dictionary failing', detail: `${input.dictionaries.failing} of ${input.dictionaries.total} dictionaries failed to load; every dictGet on them fails.`, view: 'dictionaries' });
	} else {
		items.push({ level: 'ok', title: 'Dictionaries', detail: input.dictionaries.total === 0 ? 'No dictionaries.' : `${input.dictionaries.total} loaded without errors.`, view: 'dictionaries' });
	}

	if (input.refreshes && input.refreshes.total > 0) {
		const { total, failing } = input.refreshes;
		items.push(failing > 0
			? { level: 'error', title: 'Refresh failing', detail: `${failing} of ${total} refreshable view${total === 1 ? '' : 's'} failed their last refresh and are serving old data.`, view: 'refreshes' }
			: { level: 'ok', title: 'Refreshable views', detail: `${total} refreshing on schedule.`, view: 'refreshes' });
	}

	if (!input.failed) {
		items.push(unknown('failed', 'Failed queries'));
	} else {
		const { n, kinds } = input.failed;
		items.push({
			level: n >= FAILED_WARN ? 'warn' : 'ok',
			title: 'Failed queries',
			detail: n === 0 ? 'None in the last hour.' : `${n.toLocaleString()} in the last hour, ${kinds} kind${kinds === 1 ? '' : 's'} of error.`,
			view: 'failed',
		});
	}

	if (!input.running) {
		items.push(unknown('running', 'Running'));
	} else {
		const { n, longest } = input.running;
		items.push({
			level: 'ok',
			title: 'Running',
			detail: n === 0 ? 'Nothing running.' : `${n} quer${n === 1 ? 'y' : 'ies'}, the longest for ${Math.round(longest).toLocaleString()} s.`,
			view: 'running',
		});
	}

	return items;
}

/** Named rows (the panel's result → objects), for the action builders and the health reader. */
export function namedRows(fields: readonly { name: string }[], rows: readonly unknown[][]): Record<string, unknown>[] {
	return rows.map((row) => Object.fromEntries(fields.map((field, i) => [field.name, row[i]])));
}

/** A cell as a number, whether ClickHouse sent a number or (for 64-bit values) a string. */
export function num(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

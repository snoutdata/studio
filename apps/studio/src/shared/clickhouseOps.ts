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
import { t } from './i18n/core';

export type OpsViewId = 'running' | 'failed' | 'parts' | 'merges' | 'mutations' | 'views' | 'refreshes' | 'dictionaries' | 'disks' | 'detached' | 'columns' | 'replication' | 'repqueue' | 'distqueue' | 'keeper' | 'clusters' | 'ddl' | 'settings' | 'backups' | 'serverlog' | 'crashlog';

/** The views are grouped, one row of groups and one of the views in the open group: sixteen tabs in
 *  one row cannot be read. */
export type OpsGroup = 'Queries' | 'Storage' | 'Objects' | 'Cluster' | 'Server';

export const OPS_GROUPS: readonly OpsGroup[] = ['Queries', 'Storage', 'Objects', 'Cluster', 'Server'];

/** A group's tab name, in the app's language; the group itself stays an id. */
export function opsGroupLabel(group: OpsGroup): string {
	switch (group) {
		case 'Queries':
			return t('engineClickhouse.groups.queries');
		case 'Storage':
			return t('engineClickhouse.groups.storage');
		case 'Objects':
			return t('engineClickhouse.groups.objects');
		case 'Cluster':
			return t('engineClickhouse.groups.cluster');
		default:
			return t('engineClickhouse.groups.server');
	}
}

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
		get label() { return t('engineClickhouse.views.running.label'); },
		get blurb() { return t('engineClickhouse.views.running.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}round(elapsed, 1) AS seconds, user, query, read_rows,
       round(read_bytes / 1048576, 1) AS read_mb, round(memory_usage / 1048576, 1) AS memory_mb, query_id
FROM ${sys('processes', scope)}
WHERE query_id != queryID() AND NOT startsWith(query, '${OPS_MARKER}')${initialOnly(scope)}
ORDER BY elapsed DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.running.empty'); },
		action: {
			get label() { return t('engineClickhouse.views.running.stop'); },
			icon: 'debug-stop',
			confirm: (row) => t('engineClickhouse.confirm.stop', { id: String(row.query_id), user: String(row.user), seconds: String(row.seconds) }),
			sql: (row, scope) => `KILL QUERY ${onCluster(scope)}WHERE query_id = ${literal(row.query_id)}`,
			local: (row) => `KILL QUERY WHERE query_id = ${literal(row.query_id)}`,
		},
	},
	{
		id: 'failed',
		group: 'Queries',
		get label() { return t('engineClickhouse.views.failed.label'); },
		get blurb() { return t('engineClickhouse.views.failed.blurb'); },
		sql: (scope) => `SELECT errorCodeToName(exception_code) AS error, count() AS times, max(event_time) AS last_seen,
       uniqExact(user) AS users,${scope?.cluster ? " arrayStringConcat(arraySort(groupUniqArray(hostName())), ', ') AS replicas," : ''} substring(any(exception), 1, 400) AS message, any(query) AS example,
       argMax(query_id, event_time) AS last_query_id
FROM ${sys('query_log', scope)}
WHERE type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing') AND event_time > now() - INTERVAL 1 HOUR
  AND NOT startsWith(query, '${OPS_MARKER}')${initialOnly(scope)}
GROUP BY exception_code
ORDER BY times DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.failed.empty'); },
		// The link the tracker called "why did this fail": the most recent id of this kind of
		// failure, opened in the log that holds everything the server said while running it.
		jump: { get label() { return t('engineClickhouse.views.serverlog.label'); }, icon: 'output', view: 'serverlog', column: 'last_query_id' },
	},
	{
		id: 'parts',
		group: 'Storage',
		get label() { return t('engineClickhouse.views.parts.label'); },
		get blurb() { return t('engineClickhouse.views.parts.blurb'); },
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
		get empty() { return t('engineClickhouse.views.parts.empty'); },
	},
	{
		id: 'merges',
		group: 'Storage',
		get label() { return t('engineClickhouse.views.merges.label'); },
		get blurb() { return t('engineClickhouse.views.merges.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, round(elapsed, 1) AS seconds, round(progress * 100, 1) AS percent, num_parts,
       round(total_size_bytes_compressed / 1048576, 1) AS size_mb, is_mutation
FROM ${sys('merges', scope)}
ORDER BY elapsed DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.merges.empty'); },
	},
	{
		id: 'mutations',
		group: 'Storage',
		get label() { return t('engineClickhouse.views.mutations.label'); },
		get blurb() { return t('engineClickhouse.views.mutations.blurb'); },
		sql: () => `SELECT database, table, mutation_id, command, create_time, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE NOT is_done
ORDER BY create_time`,
		get empty() { return t('engineClickhouse.views.mutations.empty'); },
		action: {
			get label() { return t('engineClickhouse.views.mutations.cancel'); },
			icon: 'close',
			confirm: (row) => t('engineClickhouse.confirm.cancelMutation', { id: String(row.mutation_id), table: `${String(row.database)}.${String(row.table)}` }),
			sql: (row) => `KILL MUTATION WHERE database = ${literal(row.database)} AND table = ${literal(row.table)} AND mutation_id = ${literal(row.mutation_id)}`,
		},
	},
	{
		id: 'views',
		group: 'Objects',
		get label() { return t('engineClickhouse.views.views.label'); },
		get blurb() { return t('engineClickhouse.views.views.blurb'); },
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
		get empty() { return t('engineClickhouse.views.views.empty'); },
	},
	{
		id: 'refreshes',
		group: 'Objects',
		get label() { return t('engineClickhouse.views.refreshes.label'); },
		get blurb() { return t('engineClickhouse.views.refreshes.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, view, status, last_success_time, round(last_success_duration_ms / 1000, 1) AS last_seconds,
       next_refresh_time, exception
FROM ${sys('view_refreshes', scope)}
ORDER BY exception = '' ASC, database, view${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.refreshes.empty'); },
		unavailable: { match: /UNKNOWN_TABLE|view_refreshes/, get message() { return t('engineClickhouse.views.refreshes.unavailable'); } },
		action: {
			get label() { return t('engineClickhouse.views.refreshes.now'); },
			icon: 'play',
			confirm: (row) => t('engineClickhouse.confirm.runNow', { view: `${String(row.database)}.${String(row.view)}`, next: String(row.next_refresh_time) }),
			sql: (row) => `SYSTEM REFRESH VIEW ${quoteName(row.database)}.${quoteName(row.view)}`,
		},
	},
	{
		id: 'dictionaries',
		group: 'Objects',
		get label() { return t('engineClickhouse.views.dictionaries.label'); },
		get blurb() { return t('engineClickhouse.views.dictionaries.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, name, status, type, element_count AS elements, round(bytes_allocated / 1048576, 2) AS memory_mb,
       last_successful_update_time AS last_loaded, loading_duration AS load_seconds, last_exception
FROM ${sys('dictionaries', scope)}
ORDER BY last_exception = '' ASC, database, name${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.dictionaries.empty'); },
		action: {
			get label() { return t('engineClickhouse.views.dictionaries.reload'); },
			icon: 'refresh',
			confirm: (row) => t('engineClickhouse.confirm.reloadDict', { dict: `${String(row.database)}.${String(row.name)}` }),
			sql: (row, scope) => `SYSTEM RELOAD DICTIONARY ${onCluster(scope)}${quoteName(row.database)}.${quoteName(row.name)}`,
			local: (row) => `SYSTEM RELOAD DICTIONARY ${quoteName(row.database)}.${quoteName(row.name)}`,
		},
	},
	{
		id: 'disks',
		group: 'Storage',
		get label() { return t('engineClickhouse.views.disks.label'); },
		get blurb() { return t('engineClickhouse.views.disks.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}name, path, round(free_space / 1073741824, 1) AS free_gb, round(total_space / 1073741824, 1) AS total_gb,
       round(100 - free_space * 100 / nullIf(total_space, 0), 1) AS used_percent
FROM ${sys('disks', scope)}
ORDER BY used_percent DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.disks.empty'); },
	},
	{
		id: 'detached',
		group: 'Storage',
		get label() { return t('engineClickhouse.views.detached.label'); },
		get blurb() { return t('engineClickhouse.views.detached.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, partition_id, name, reason, disk
FROM ${sys('detached_parts', scope)}
WHERE ${USER_DATABASES}
ORDER BY database, table, name${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.detached.empty'); },
	},
	{
		id: 'columns',
		group: 'Storage',
		get label() { return t('engineClickhouse.views.columns.label'); },
		get blurb() { return t('engineClickhouse.views.columns.blurb'); },
		sql: () => `SELECT database, table, name AS column, type,
       round(data_compressed_bytes / 1048576, 2) AS compressed_mb,
       round(data_uncompressed_bytes / 1048576, 2) AS uncompressed_mb,
       round(data_uncompressed_bytes / nullIf(data_compressed_bytes, 0), 1) AS ratio
FROM system.columns
WHERE ${USER_DATABASES} AND data_compressed_bytes > 0
ORDER BY data_compressed_bytes DESC
LIMIT 200`,
		get empty() { return t('engineClickhouse.views.columns.empty'); },
	},
	{
		id: 'replication',
		group: 'Cluster',
		get label() { return t('engineClickhouse.views.replication.label'); },
		get blurb() { return t('engineClickhouse.views.replication.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, is_readonly, absolute_delay AS delay_s, queue_size, inserts_in_queue, merges_in_queue,
       active_replicas, total_replicas
FROM ${sys('replicas', scope)}
ORDER BY absolute_delay DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.replication.empty'); },
	},
	{
		id: 'repqueue',
		group: 'Cluster',
		get label() { return t('engineClickhouse.views.repqueue.label'); },
		get blurb() { return t('engineClickhouse.views.repqueue.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, type, new_part_name AS part, num_tries AS tries,
       is_currently_executing AS running, create_time AS queued, last_attempt_time AS last_try,
       substring(concat(ifNull(last_exception, ''), ifNull(postpone_reason, '')), 1, 400) AS problem
FROM ${sys('replication_queue', scope)}
ORDER BY num_tries DESC, create_time
LIMIT 500${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.repqueue.empty'); },
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, get message() { return t('engineClickhouse.views.repqueue.unavailable'); } },
		action: {
			// Deliberately node-local and never ON CLUSTER: restarting every replica of a table at
			// once is how a stuck replica becomes an outage. This re-reads the table's state from
			// Keeper on the one node the entry is stuck on, which is the documented repair.
			get label() { return t('engineClickhouse.views.repqueue.restart'); },
			icon: 'refresh',
			confirm: (row) => t('engineClickhouse.confirm.restartReplica', { table: `${String(row.database)}.${String(row.table)}` }),
			sql: (row) => `SYSTEM RESTART REPLICA ${quoteName(row.database)}.${quoteName(row.table)}`,
		},
	},
	{
		id: 'distqueue',
		group: 'Cluster',
		get label() { return t('engineClickhouse.views.distqueue.label'); },
		get blurb() { return t('engineClickhouse.views.distqueue.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}database, table, is_blocked AS blocked, error_count AS errors, data_files AS files,
       round(data_compressed_bytes / 1048576, 1) AS pending_mb, broken_data_files AS broken,
       substring(ifNull(last_exception, ''), 1, 400) AS problem
FROM ${sys('distribution_queue', scope)}
ORDER BY data_files DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.distqueue.empty'); },
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, get message() { return t('engineClickhouse.views.distqueue.unavailable'); } },
		action: {
			get label() { return t('engineClickhouse.views.distqueue.send'); },
			icon: 'run',
			confirm: (row) => t('engineClickhouse.confirm.sendNow', { files: String(row.files), table: `${String(row.database)}.${String(row.table)}` }),
			sql: (row) => `SYSTEM FLUSH DISTRIBUTED ${quoteName(row.database)}.${quoteName(row.table)}`,
		},
	},
	{
		id: 'keeper',
		group: 'Cluster',
		get label() { return t('engineClickhouse.views.keeper.label'); },
		get blurb() { return t('engineClickhouse.views.keeper.blurb'); },
		// The root listing, for anything that asks a view for its SQL without knowing it browses.
		sql: () => keeperListSql('/'),
		get empty() { return t('engineClickhouse.views.keeper.empty'); },
		unavailable: { match: /NO_ELEMENTS_IN_CONFIG|Zookeeper|Keeper|UNKNOWN_TABLE/i, get message() { return t('engineClickhouse.views.keeper.unavailable'); } },
		browse: { root: '/', nameColumn: 'name', childrenColumn: 'children', sql: (path) => keeperListSql(path) },
	},
	{
		id: 'clusters',
		group: 'Cluster',
		get label() { return t('engineClickhouse.views.clusters.label'); },
		get blurb() { return t('engineClickhouse.views.clusters.blurb'); },
		sql: () => `SELECT cluster, shard_num AS shard, replica_num AS replica, host_name AS host, port, is_local,
       errors_count AS errors, slowdowns_count AS slowdowns, estimated_recovery_time AS recovery_s
FROM system.clusters
ORDER BY errors DESC, cluster, shard, replica`,
		get empty() { return t('engineClickhouse.views.clusters.empty'); },
	},
	{
		id: 'ddl',
		group: 'Cluster',
		get label() { return t('engineClickhouse.views.ddl.label'); },
		get blurb() { return t('engineClickhouse.views.ddl.blurb'); },
		sql: () => `SELECT entry, host, status, exception_code, query_create_time AS created, query
FROM system.distributed_ddl_queue
WHERE status != 'Finished'
ORDER BY query_create_time DESC
LIMIT 200`,
		get empty() { return t('engineClickhouse.views.ddl.empty'); },
		unavailable: { match: /NO_ELEMENTS_IN_CONFIG|Zookeeper|Keeper/i, get message() { return t('engineClickhouse.views.ddl.unavailable'); } },
	},
	{
		id: 'serverlog',
		group: 'Server',
		get label() { return t('engineClickhouse.views.serverlog.label'); },
		// `level` is an Enum8 ordered Fatal .. Trace, and it is tempting to write `level <= 'Warning'`
		// for "this bad or worse". That compiles, runs, and is WRONG: the comparison is against the
		// string, so 'Trace' <= 'Warning' alphabetically and the filter lets everything through. The
		// list is the honest form, and the live server is what caught it.
		get blurb() { return t('engineClickhouse.views.serverlog.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}event_time AS at, toString(level) AS level, logger_name AS logger, query_id, message
FROM ${sys('text_log', scope)}
WHERE event_time > now() - INTERVAL 1 HOUR AND level IN ('Fatal', 'Critical', 'Error', 'Warning')
ORDER BY event_time DESC
LIMIT 500${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.serverlog.empty'); },
		// Not "an error": logging to a table is OFF in a default install, so the honest answer names
		// the switch rather than reporting a missing table as a fault.
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, get message() { return t('engineClickhouse.views.serverlog.unavailable'); } },
		filter: {
			get label() { return t('engineClickhouse.views.serverlog.filterLabel'); },
			get placeholder() { return t('engineClickhouse.views.serverlog.filterPlaceholder'); },
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
		get label() { return t('engineClickhouse.views.crashes.label'); },
		get blurb() { return t('engineClickhouse.views.crashes.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}event_time AS at, signal, thread_id, query_id, version,
       substring(arrayStringConcat(trace_full, ' | '), 1, 2000) AS stack
FROM ${sys('crash_log', scope)}
ORDER BY event_time DESC
LIMIT 50${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.crashes.empty'); },
		// The table is CREATED by the first crash, so its absence is the answer, not a failure.
		unavailable: { match: /UNKNOWN_TABLE|doesn't exist|does not exist/i, get message() { return t('engineClickhouse.views.crashes.unavailable'); } },
	},
	{
		id: 'settings',
		group: 'Server',
		get label() { return t('engineClickhouse.views.settings.label'); },
		get blurb() { return t('engineClickhouse.views.settings.blurb'); },
		sql: () => `SELECT name, value, default, description
FROM system.settings
WHERE changed
ORDER BY name`,
		get empty() { return t('engineClickhouse.views.settings.empty'); },
	},
	{
		id: 'backups',
		group: 'Server',
		get label() { return t('engineClickhouse.views.backups.label'); },
		get blurb() { return t('engineClickhouse.views.backups.blurb'); },
		sql: (scope) => `SELECT ${replicaColumn(scope)}name, status, start_time, end_time, num_files AS files, round(total_size / 1048576, 1) AS size_mb, error
FROM ${sys('backups', scope)}
ORDER BY start_time DESC${clickhouseScopeSettings(scope)}`,
		get empty() { return t('engineClickhouse.views.backups.empty'); },
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
	return { level: 'unknown', title, detail: t('engineClickhouse.health.cannotRead'), view };
}

/** Read the numbers into four verdicts, worst first within the fixed order of the cards. */
export function assessHealth(input: HealthInput): HealthItem[] {
	const items: HealthItem[] = [];

	if (input.worstPartition === undefined) {
		items.push(unknown('parts', t('engineClickhouse.health.parts')));
	} else if (input.worstPartition === null) {
		items.push({ level: 'ok', title: t('engineClickhouse.health.parts'), detail: t('engineClickhouse.health.noMergeTree'), view: 'parts' });
	} else {
		const delayAt = input.delayAt ?? DEFAULT_DELAY_AT;
		const throwAt = input.throwAt ?? DEFAULT_THROW_AT;
		const { database, table, parts } = input.worstPartition;
		const where = `${database}.${table}`;
		if (parts >= throwAt) {
			items.push({ level: 'error', title: t('engineClickhouse.health.tooManyParts'), detail: t('engineClickhouse.health.tooManyPartsDetail', { where, parts, limit: throwAt }), view: 'parts' });
		} else if (parts >= delayAt) {
			items.push({ level: 'warn', title: t('engineClickhouse.health.insertsSlowed'), detail: t('engineClickhouse.health.insertsSlowedDetail', { where, parts, delay: delayAt, limit: throwAt }), view: 'parts' });
		} else if (parts >= delayAt / 2) {
			items.push({ level: 'warn', title: t('engineClickhouse.health.partsPiling'), detail: t('engineClickhouse.health.partsPilingDetail', { where, parts, delay: delayAt }), view: 'parts' });
		} else {
			items.push({ level: 'ok', title: t('engineClickhouse.health.parts'), detail: t('engineClickhouse.health.partsOk', { parts, where, delay: delayAt }), view: 'parts' });
		}
	}

	if (!input.mutations) {
		items.push(unknown('mutations', t('engineClickhouse.health.mutations')));
	} else if (input.mutations.failing > 0) {
		items.push({ level: 'error', title: t('engineClickhouse.health.mutationsFailing'), detail: t('engineClickhouse.health.mutationsFailingDetail', { failing: input.mutations.failing, pending: input.mutations.pending }), view: 'mutations' });
	} else if (input.mutations.pending > 0) {
		items.push({ level: 'warn', title: t('engineClickhouse.health.mutationsPending'), detail: t('engineClickhouse.health.mutationsPendingDetail', { count: input.mutations.pending }), view: 'mutations' });
	} else {
		items.push({ level: 'ok', title: t('engineClickhouse.health.mutations'), detail: t('engineClickhouse.health.noneWaiting'), view: 'mutations' });
	}

	if (!input.replication) {
		items.push(unknown('replication', t('engineClickhouse.health.replication')));
	} else if (input.replication.tables === 0) {
		items.push({ level: 'ok', title: t('engineClickhouse.health.replication'), detail: t('engineClickhouse.health.noReplicated'), view: 'replication' });
	} else if (input.replication.readonly > 0) {
		items.push({ level: 'error', title: t('engineClickhouse.health.replicasReadonly'), detail: t('engineClickhouse.health.replicasReadonlyDetail', { count: input.replication.readonly }), view: 'replication' });
	} else if (input.replication.delay >= REPLICA_LAG_WARN_S) {
		items.push({ level: 'warn', title: t('engineClickhouse.health.replicaLag'), detail: t('engineClickhouse.health.replicaLagDetail', { seconds: Math.round(input.replication.delay) }), view: 'replication' });
	} else {
		items.push({ level: 'ok', title: t('engineClickhouse.health.replication'), detail: t('engineClickhouse.health.replicatedInStep', { count: input.replication.tables }), view: 'replication' });
	}

	if (input.disk === undefined) {
		items.push(unknown('disks', t('engineClickhouse.health.disk')));
	} else if (input.disk === null) {
		items.push({ level: 'ok', title: t('engineClickhouse.health.disk'), detail: t('engineClickhouse.health.noDisks'), view: 'disks' });
	} else {
		const { name, usedPercent, free } = input.disk;
		const detached = input.detached ?? 0;
		if (usedPercent >= DISK_ERROR_PERCENT) {
			items.push({ level: 'error', title: t('engineClickhouse.health.diskNearlyFull'), detail: t('engineClickhouse.health.diskNearlyFullDetail', { name, used: usedPercent, free: bytes(free) }), view: 'disks' });
		} else if (usedPercent >= DISK_WARN_PERCENT) {
			items.push({ level: 'warn', title: t('engineClickhouse.health.diskFilling'), detail: t('engineClickhouse.health.diskFillingDetail', { name, used: usedPercent, free: bytes(free) }), view: 'disks' });
		} else if (detached > 0) {
			items.push({ level: 'warn', title: t('engineClickhouse.health.detachedParts'), detail: t('engineClickhouse.health.detachedDetail', { count: detached }), view: 'detached' });
		} else {
			items.push({ level: 'ok', title: t('engineClickhouse.health.disk'), detail: t('engineClickhouse.health.diskOk', { name, used: usedPercent, free: bytes(free) }), view: 'disks' });
		}
	}

	if (!input.dictionaries) {
		items.push(unknown('dictionaries', t('engineClickhouse.health.dictionaries')));
	} else if (input.dictionaries.failing > 0) {
		items.push({ level: 'error', title: t('engineClickhouse.health.dictFailing'), detail: t('engineClickhouse.health.dictFailingDetail', { failing: input.dictionaries.failing, total: input.dictionaries.total }), view: 'dictionaries' });
	} else {
		items.push({ level: 'ok', title: t('engineClickhouse.health.dictionaries'), detail: input.dictionaries.total === 0 ? t('engineClickhouse.health.noDicts') : t('engineClickhouse.health.dictsLoaded', { n: input.dictionaries.total }), view: 'dictionaries' });
	}

	if (input.refreshes && input.refreshes.total > 0) {
		const { total, failing } = input.refreshes;
		items.push(failing > 0
			? { level: 'error', title: t('engineClickhouse.health.refreshFailing'), detail: t('engineClickhouse.health.refreshFailingDetail', { failing, count: total }), view: 'refreshes' }
			: { level: 'ok', title: t('engineClickhouse.health.refreshableViews'), detail: t('engineClickhouse.health.refreshingSchedule', { n: total }), view: 'refreshes' });
	}

	if (!input.failed) {
		items.push(unknown('failed', t('engineClickhouse.health.failed')));
	} else {
		const { n, kinds } = input.failed;
		items.push({
			level: n >= FAILED_WARN ? 'warn' : 'ok',
			title: t('engineClickhouse.health.failed'),
			detail: n === 0 ? t('engineClickhouse.health.noneLastHour') : t('engineClickhouse.health.failedDetail', { n, count: kinds }),
			view: 'failed',
		});
	}

	if (!input.running) {
		items.push(unknown('running', t('engineClickhouse.health.running')));
	} else {
		const { n, longest } = input.running;
		items.push({
			level: 'ok',
			title: t('engineClickhouse.health.running'),
			detail: n === 0 ? t('engineClickhouse.health.nothingRunning') : t('engineClickhouse.health.runningDetail', { count: n, seconds: Math.round(longest) }),
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

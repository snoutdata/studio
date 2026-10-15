/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QueryResult } from './query';

/*
 * Pulse 3b: what the DATABASE is doing.
 *
 * The other half of Pulse (3a) is free and universal: it replays what THIS app ran. This half is
 * the database's own account of itself, read from the same family of runtime views the Workload
 * advisor already reads, and it is a different bargain entirely: it is a
 * query the user did not type, against a database they may pay for by the read. So it is OFF until
 * asked for, it is sampled at background priority, it names the view
 * it reads, and an engine with no such view declines BY NAME rather than showing an empty world.
 *
 * This module is pure and node-testable. It is deliberately NOT in `shared/engine/`: the engine is
 * the layer every query and prompt passes through, and a visualisation's sampler is neither.
 *
 * THE FIXED COLUMN CONTRACT. Every vendor's query aliases into the SAME five column names, so
 * `readPulseRows` has no per-vendor branch at all. Adding an engine is a query and a reason, never
 * a mapping (the pattern the users-and-privileges reader uses):
 *
 *     session_id | statement_text | duration_ms | session_state | user_name
 *
 * Names were chosen to be legal, unreserved column aliases on all five engines: `sql`, `query`,
 * `text`, `state`, `rows` and `user` are each reserved somewhere, and `session_user` is a standard
 * function.
 *
 * EXCLUDING OURSELVES. A sampler that reads the activity view is itself activity, so without care
 * Pulse shows one statement running forever: its own. Two guards, both needed:
 *
 *   1. Every query carries the literal marker `snout_orbit_pulse` in a comment, and every query
 *      filters out statements whose text contains that marker. The filter's own WHERE clause holds
 *      the marker too, which is what makes it self-excluding, and it also drops a sampler running
 *      in a SECOND SnoutData window against the same database, which a session-id test cannot see.
 *   2. Where the engine can name the current session cheaply (`pg_backend_pid()`, `CONNECTION_ID()`,
 *      `@@SPID`, `USERENV('SID')`) it is excluded as well, because it is exact, it costs nothing,
 *      and it does not depend on the server having recorded the statement text at all.
 *
 * Both guards were driven against a live Postgres 17 and MySQL 8 on 2026-09-06 (a probe ran the
 * MARKED statement in a DIFFERENT session so only guard 1 could hide it): neither engine ever
 * showed the sampler its own statement, and neither showed the marked statement of another session.
 *
 * That live run also corrected the reason this comment used to give for guard 2. It said a
 * truncated statement text could lose the marker. It cannot, on any engine here, because the marker
 * is the FIRST thing in every query and every one of these views truncates the TAIL: measured on
 * Postgres with `track_activity_query_size = 100` (its floor is 100 bytes and the marker ends at
 * byte 30), a marker placed at the end of a statement was cut off while one at the head survived.
 * Guard 2 still earns its place for the reason above; it just is not the truncation that earns it.
 */

/** One statement the database says is running or just ran. */
export interface PulseSample {
	/** Stable per (connection, database session, statement), so a long query sampled ten times is
	 *  one packet and not ten. See {@link readPulseRows} for how it is built. */
	id: string;
	sql: string;
	/** Milliseconds it has been running, where the view reports it. */
	durationMs?: number;
	state?: string;
	user?: string;
	sampledAt: number;
}

/** The activity read for one driver: the SQL, what it reads, and what to try if it is refused. */
export interface PulseSourceQuery {
	/**
	 * The activity SELECT. Aliases into the fixed column contract above, begins with SELECT so it
	 * passes the read-only guard unchanged, and reads nothing but the engine's own runtime views.
	 */
	sql: string;
	/** The view this reads, named so the UI can say exactly what it queries rather than "activity". */
	sourceName: string;
	/**
	 * A second query to try when the first one fails, for engines where the richer view is optional.
	 * MySQL is the case that needs it: `performance_schema` can be compiled out or unreadable, and
	 * `information_schema.processlist` is always there.
	 */
	fallbackSql?: string;
	fallbackSourceName?: string;
	/**
	 * A one-shot precondition run before the first sample, whose first cell must be truthy or the
	 * fallback is taken instead. It exists because of a defect the live run found and nothing else
	 * could have caught: a view that is switched OFF does not fail, it returns NO ROWS, and a
	 * fallback that only fires on an error therefore never fires. See `MYSQL_PULSE_READY`.
	 */
	requiresSql?: string;
	/** What to tell the user when {@link requiresSql} says no. A whole sentence, shown verbatim. */
	requiresReason?: string;
}

/** What the renderer is told when it asks whether a connection can be sampled at all. Carries the
 *  refusal in the database's own terms so the UI never has to invent one. */
export interface PulseSupport {
	supported: boolean;
	/** The driver asked about, so a stale answer can be spotted. */
	driver: string;
	/** The view Pulse would read (`pg_stat_activity`, `sys.dm_exec_requests`, …). Present only when
	 *  supported, and shown to the user, because a feature that queries someone's database says
	 *  what it queries. */
	source?: string;
	/** Why not. Present only when `supported` is false, and always a whole sentence. */
	reason?: string;
}

/** The answer to "start sampling this connection". */
export interface PulseStart {
	/** True when a sampler is now running for this connection. */
	started: boolean;
	/** The interval actually in force, after the floor and ceiling. */
	intervalMs: number;
	/** Why it did not start. Present only when `started` is false. */
	reason?: string;
}

/** The comment marker every Pulse query carries so it can exclude itself. See the header. */
export const PULSE_MARKER = 'snout_orbit_pulse';

/** How many statements one sample may carry. A busy server has thousands of sessions and the world
 *  cannot draw them; the heaviest/oldest few hundred are the ones worth seeing. */
export const PULSE_ROW_CAP = 200;

/** Default sampling interval. Fast enough to feel live, slow enough that the read is cheap. */
export const DEFAULT_PULSE_INTERVAL_MS = 2000;

/** The floor. Below this the sampler is hammering someone's production database on a render loop's
 *  behalf, which is not a thing a user should be able to ask for by dragging a slider. */
export const MIN_PULSE_INTERVAL_MS = 500;

/** Clamp a caller-supplied interval to something a database can live with. */
export function clampPulseInterval(ms: number | undefined): number {
	if (!Number.isFinite(ms) || ms === undefined) {
		return DEFAULT_PULSE_INTERVAL_MS;
	}
	return Math.max(MIN_PULSE_INTERVAL_MS, Math.min(60_000, Math.trunc(ms)));
}

/**
 * What Postgres puts in `pg_stat_activity.query` for a session the reader is not allowed to see.
 * It is a literal string and not NULL, which is the whole reason this constant has to exist.
 */
export const POSTGRES_MASKED_STATEMENT = '<insufficient privilege>';

// Postgres. `pg_stat_activity` is always there and needs no extension (unlike pg_stat_statements,
// which the Workload advisor needs). `backend_type` keeps autovacuum and the checkpointer out;
// `state NOT LIKE 'idle%'` keeps sessions that are merely holding their last statement out, which
// is what "idle backends" means here.
//
// The `backend_type IS NULL` arm is not defensive noise, it is a defect the live run found. This
// query used to say `backend_type = 'client backend'` flat, and a non-superuser reading a live
// Postgres 17 got ZERO rows, every poll, for ever, while the rail said Pulse was fine. Measured:
// a role with no pg_read_all_stats DOES see every other session's ROW, but `usename`, `state`,
// `query_start` and `backend_type` all come back NULL and `query` comes back as the literal
// '<insufficient privilege>'. So the equality test threw away exactly the rows that carried the
// news. Keeping them lets `readPulse` count them and say what is happening; a superuser is
// unaffected, because `backend_type` is never NULL for a reader who can see the row.
const POSTGRES_PULSE = `SELECT /* ${PULSE_MARKER} */
       pid::text AS session_id,
       query AS statement_text,
       (EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::bigint AS duration_ms,
       state AS session_state,
       usename AS user_name
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND (backend_type IS NULL OR backend_type = 'client backend')
  AND query IS NOT NULL AND query <> ''
  AND COALESCE(state, '') NOT LIKE 'idle%'
  AND query NOT LIKE '%${PULSE_MARKER}%'
ORDER BY query_start
LIMIT ${PULSE_ROW_CAP}`;

// MySQL. `events_statements_current` is one row per thread holding the statement that thread is
// running now, which is exactly what Pulse wants; TIMER_WAIT is picoseconds, so /1e9 is
// milliseconds, and the live run confirmed it really is elapsed-so-far on a statement that has not
// finished (256ms, 1262ms, 2266ms across three polls of one `SELECT SLEEP(4)`). Joined to `threads`
// for the connection id and the login, because the statement table knows neither. PROCESSLIST_ID IS
// NULL means an internal background thread.
//
// `END_EVENT_ID IS NULL` is the fix for the second defect the live run found. "Current" in
// `events_statements_current` does NOT mean "running": the row survives the statement and keeps the
// LAST statement of an idle connection, with its final duration frozen. Measured on MySQL 8: a
// finished `SELECT SLEEP(1)` on a still-open connection came back in every subsequent poll, for
// ever, at a fixed 1006ms. Pulse would have lit those tables permanently, which is the exact
// "one statement running forever" failure this module's header was written to prevent. A finished
// event has END_EVENT_ID set; a running one has NULL.
const MYSQL_PULSE = `SELECT /* ${PULSE_MARKER} */
       CONCAT('thread-', t.\`PROCESSLIST_ID\`) AS session_id,
       esc.\`SQL_TEXT\` AS statement_text,
       ROUND(esc.\`TIMER_WAIT\` / 1e9) AS duration_ms,
       t.\`PROCESSLIST_STATE\` AS session_state,
       t.\`PROCESSLIST_USER\` AS user_name
FROM performance_schema.events_statements_current esc
JOIN performance_schema.threads t ON t.\`THREAD_ID\` = esc.\`THREAD_ID\`
WHERE t.\`PROCESSLIST_ID\` IS NOT NULL
  AND t.\`PROCESSLIST_ID\` <> CONNECTION_ID()
  AND esc.\`END_EVENT_ID\` IS NULL
  AND esc.\`SQL_TEXT\` IS NOT NULL AND esc.\`SQL_TEXT\` <> ''
  AND esc.\`SQL_TEXT\` NOT LIKE '%${PULSE_MARKER}%'
ORDER BY esc.\`TIMER_WAIT\` DESC
LIMIT ${PULSE_ROW_CAP}`;

/**
 * The precondition for MySQL's richer view, and the reason `requiresSql` exists at all.
 *
 * A server with `performance_schema = OFF`, or with the statement consumers switched off, does not
 * REFUSE the query above. It answers it, with no rows, for ever. The sampler's fallback fires on a
 * failure, so nothing would have made it fire, and Pulse would sit there empty and green. Measured
 * on a stock MariaDB 11 (performance_schema is OFF by default there), which is what sent MariaDB to
 * its own query below and gave MySQL this check.
 *
 * Returns one cell: 1 when the view will really report, 0 when it will not. When performance_schema
 * is off the setup tables exist and are EMPTY, so the count is 0 and no error is raised, which is
 * why the check reads them rather than trusting @@performance_schema alone.
 */
const MYSQL_PULSE_READY = `SELECT /* ${PULSE_MARKER} */ CASE WHEN @@performance_schema = 1 AND (
         SELECT COUNT(*) FROM performance_schema.setup_consumers
         WHERE \`NAME\` IN ('global_instrumentation', 'thread_instrumentation', 'events_statements_current')
           AND \`ENABLED\` = 'YES') = 3 THEN 1 ELSE 0 END AS pulse_ready`;

// The fallback for MySQL: performance_schema can be built out, switched off or unreadable, and the
// processlist never is. Coarser (TIME is whole seconds, so the live run saw a statement report 0ms
// and then 1000ms, and INFO is only the current statement of a non-sleeping thread) but it is the
// difference between a degraded Pulse and no Pulse.
const MYSQL_PROCESSLIST_PULSE = `SELECT /* ${PULSE_MARKER} */
       CONCAT('thread-', p.\`ID\`) AS session_id,
       p.\`INFO\` AS statement_text,
       p.\`TIME\` * 1000 AS duration_ms,
       p.\`STATE\` AS session_state,
       p.\`USER\` AS user_name
FROM information_schema.PROCESSLIST p
WHERE p.\`ID\` <> CONNECTION_ID()
  AND p.\`COMMAND\` <> 'Sleep'
  AND p.\`INFO\` IS NOT NULL AND p.\`INFO\` <> ''
  AND p.\`INFO\` NOT LIKE '%${PULSE_MARKER}%'
ORDER BY p.\`TIME\` DESC
LIMIT ${PULSE_ROW_CAP}`;

// MariaDB gets its own query rather than MySQL's, and the live run is the reason. MariaDB ships
// with performance_schema OFF (measured: @@performance_schema = 0 on a stock mariadb:11), so the
// MySQL query returned an empty result set on every poll and, because an empty result is not a
// failure, the fallback never fired. MariaDB does not need a fallback at all: its
// `information_schema.PROCESSLIST` carries TIME_MS, a millisecond DECIMAL that MySQL's does not
// have (measured 707.629 while a `SELECT SLEEP(3)` was running), so the always-present view is also
// the precise one here. One view, no precondition, no silent empty.
const MARIADB_PULSE = `SELECT /* ${PULSE_MARKER} */
       CONCAT('thread-', p.\`ID\`) AS session_id,
       p.\`INFO\` AS statement_text,
       ROUND(p.\`TIME_MS\`) AS duration_ms,
       p.\`STATE\` AS session_state,
       p.\`USER\` AS user_name
FROM information_schema.PROCESSLIST p
WHERE p.\`ID\` <> CONNECTION_ID()
  AND p.\`COMMAND\` <> 'Sleep'
  AND p.\`INFO\` IS NOT NULL AND p.\`INFO\` <> ''
  AND p.\`INFO\` NOT LIKE '%${PULSE_MARKER}%'
ORDER BY p.\`TIME_MS\` DESC
LIMIT ${PULSE_ROW_CAP}`;

// SQL Server. `dm_exec_requests` is the live request list; the statement text lives elsewhere and
// is reached by CROSS APPLY through the sql_handle, the same shape the Workload advisor uses.
// total_elapsed_time is already milliseconds here (unlike dm_exec_query_stats, where it is
// microseconds). session_id > 50 drops the internal system sessions. Needs VIEW SERVER STATE.
const SQLSERVER_PULSE = `SELECT /* ${PULSE_MARKER} */ TOP (${PULSE_ROW_CAP})
       CAST(r.session_id AS varchar(20)) AS session_id,
       SUBSTRING(t.text, 1, 4000) AS statement_text,
       r.total_elapsed_time AS duration_ms,
       r.status AS session_state,
       s.login_name AS user_name
FROM sys.dm_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
LEFT JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
WHERE r.session_id <> @@SPID
  AND r.session_id > 50
  AND t.text IS NOT NULL
  AND t.text NOT LIKE '%${PULSE_MARKER}%'
ORDER BY r.total_elapsed_time DESC`;

// Oracle. `v$session` carries the session and `v$sql` the text it is running; the join is on
// sql_id AND child_number, because one sql_id has several children and they are different plans of
// the same text. last_call_et is whole seconds since the session started its current call. Needs
// SELECT ANY DICTIONARY, or SELECT on V_$SESSION and V_$SQL. ROWNUM outside the ordered inline
// view, since Oracle applies ROWNUM before ORDER BY.
const ORACLE_PULSE = `SELECT /* ${PULSE_MARKER} */ * FROM (
  SELECT TO_CHAR(s.sid) || ':' || TO_CHAR(s.serial#) AS session_id,
         q.sql_text AS statement_text,
         s.last_call_et * 1000 AS duration_ms,
         s.status AS session_state,
         s.username AS user_name
  FROM v$session s
  JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number
  WHERE s.type = 'USER'
    AND s.username IS NOT NULL
    AND s.status = 'ACTIVE'
    AND s.sid <> TO_NUMBER(SYS_CONTEXT('USERENV', 'SID'))
    AND q.sql_text IS NOT NULL
    AND q.sql_text NOT LIKE '%${PULSE_MARKER}%'
  ORDER BY s.last_call_et DESC
) WHERE ROWNUM <= ${PULSE_ROW_CAP}`;

// Redshift. A Postgres fork, but pg_stat_activity is not the right view here: STV_RECENTS is the
// cluster-wide list of queries with their state, which is what a leader node actually knows.
// duration is microseconds and is only meaningful once a query has finished, so a running one
// reports 0 rather than a lie. Ordered by start time so the oldest running statement leads.
const REDSHIFT_PULSE = `SELECT /* ${PULSE_MARKER} */
       CAST(pid AS varchar(20)) AS session_id,
       query AS statement_text,
       CAST(duration / 1000 AS bigint) AS duration_ms,
       status AS session_state,
       user_name
FROM stv_recents
WHERE status = 'Running'
  AND query IS NOT NULL
  AND query NOT LIKE '%${PULSE_MARKER}%'
ORDER BY starttime
LIMIT ${PULSE_ROW_CAP}`;

const PULSE_SOURCES: Record<string, PulseSourceQuery> = {
	postgres: { sql: POSTGRES_PULSE, sourceName: 'pg_stat_activity' },
	'mysql-aurora': {
		sql: MYSQL_PULSE,
		sourceName: 'performance_schema.events_statements_current',
		fallbackSql: MYSQL_PROCESSLIST_PULSE,
		fallbackSourceName: 'information_schema.processlist',
		requiresSql: MYSQL_PULSE_READY,
		requiresReason: "This server is not recording statements in performance_schema, so Pulse is reading information_schema.processlist instead. Durations there are whole seconds.",
	},
	mariadb: { sql: MARIADB_PULSE, sourceName: 'information_schema.processlist' },
	sqlserver: { sql: SQLSERVER_PULSE, sourceName: 'sys.dm_exec_requests' },
	oracle: { sql: ORACLE_PULSE, sourceName: 'v$session' },
	redshift: { sql: REDSHIFT_PULSE, sourceName: 'stv_recents' },
};

/*
 * Why an engine cannot do this, in a sentence a user reads. Never the word "unsupported": a person
 * who turned Pulse on wants to know whether the problem is their database, their privileges, or us,
 * and each of these three answers is a different one of those. Sentences, no em-dashes, per
 * the house style.
 */
const PULSE_REASONS: Record<string, string> = {
	sqlite: "SQLite runs inside this app rather than on a server, so it keeps no list of what other sessions are doing. Pulse still shows what this app ran.",
	duckdb: "DuckDB runs inside this app rather than on a server, so it keeps no list of what other sessions are doing. Pulse still shows what this app ran.",
	mongodb: "MongoDB reports its running operations through currentOp, which SnoutData does not read yet, so there is no database-wide activity to draw here.",
	pinecone: "Pinecone is a hosted vector index with no session activity to read, so there is nothing database-wide to draw here.",
	snowflake: "Snowflake reports running queries through its own query history, which SnoutData does not sample yet, so there is no live activity to draw here.",
	db2: "Db2 reports running statements through MON_GET_ACTIVITY, which SnoutData does not read yet, so there is no live activity to draw here.",
	hana: "SAP HANA reports running statements through M_ACTIVE_STATEMENTS, which SnoutData does not read yet, so there is no live activity to draw here.",
	cloudwatch: "A log service has no database sessions to sample. What you query here is the log itself.",
	azureMonitor: "A log service has no database sessions to sample. What you query here is the log itself.",
	gcpLogging: "A log service has no database sessions to sample. What you query here is the log itself.",
};

const UNKNOWN_DRIVER_REASON = "SnoutData does not know how to read live activity from this database, so Pulse can only show what this app ran.";

/** The activity read for a driver, or undefined when that engine exposes no such view. */
export function pulseSourceFor(driver: string | undefined): PulseSourceQuery | undefined {
	return driver ? PULSE_SOURCES[driver] : undefined;
}

/** The activity query for a driver, or undefined when that engine exposes no such view. */
export function pulseQueryFor(driver: string | undefined): string | undefined {
	return pulseSourceFor(driver)?.sql;
}

/** Whether this driver can be sampled at all. */
export function pulseSupported(driver: string | undefined): boolean {
	return pulseSourceFor(driver) !== undefined;
}

/** The view a driver's Pulse reads, so the UI can name it. Undefined when there is none. */
export function pulseSourceName(driver: string | undefined): string | undefined {
	return pulseSourceFor(driver)?.sourceName;
}

/** Why a driver cannot do this, in a sentence a user reads. Empty for a driver that CAN. */
export function pulseUnavailableReason(driver: string | undefined): string {
	if (pulseSupported(driver)) {
		return '';
	}
	return (driver && PULSE_REASONS[driver]) || UNKNOWN_DRIVER_REASON;
}

/** Map result field name (lowercased) to column index. Oracle folds unquoted aliases to uppercase
 *  and Postgres to lowercase, so the contract is matched case-insensitively or it is not matched. */
function columnIndex(fields: QueryResult['fields']): Map<string, number> {
	const index = new Map<string, number>();
	for (let i = 0; i < fields.length; i++) {
		index.set(fields[i].name.toLowerCase(), i);
	}
	return index;
}

/** Read a cell as trimmed text, or undefined when it is absent/null/blank. */
function text(row: unknown[], at: number | undefined): string | undefined {
	if (at === undefined) {
		return undefined;
	}
	const value = row[at];
	if (value === null || value === undefined) {
		return undefined;
	}
	const s = String(value).trim();
	return s === '' ? undefined : s;
}

/** Read a cell as a finite number of milliseconds. Drivers hand back bigints as strings (pg does
 *  for int8), so this coerces rather than trusting the type. Negatives are a clock artefact, not a
 *  duration, and are dropped. */
function millis(row: unknown[], at: number | undefined): number | undefined {
	if (at === undefined) {
		return undefined;
	}
	const value = row[at];
	if (value === null || value === undefined || value === '') {
		return undefined;
	}
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** FNV-1a over the statement text. Not a security hash: it exists so the same statement in the same
 *  session yields the same id on every sample, without carrying the whole SQL around as a key. */
function hashText(value: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

/** What one Pulse poll produced: the statements it can show, and how many it was not allowed to. */
export interface PulseReading {
	samples: PulseSample[];
	/**
	 * Rows the database returned but refused to describe. Postgres hands a reader who lacks
	 * `pg_read_all_stats` a row per session with `query` set to the literal
	 * {@link POSTGRES_MASKED_STATEMENT}, so the sessions ARE there and their statements are not.
	 * Counted rather than dropped in silence, because "Pulse is empty" and "Pulse is not allowed to
	 * look" are different answers and the user is owed the second one.
	 */
	maskedRows: number;
}

/**
 * Rows from a Pulse query, turned into samples. No per-vendor branch: every query aliases into the
 * fixed column contract, so this reads the same five names whatever ran it. Tolerant of a missing
 * optional column (an engine that reports no duration simply has none) and of a missing session id.
 *
 * The id is `[connection:]session:hash(sql)`, which is what makes a long-running statement ONE
 * packet across many samples while a session that moves on to its next statement gets a new one.
 * Session alone would merge every statement a busy session ever runs; the SQL alone would merge
 * the same statement running in twenty sessions, which is precisely the thing worth seeing. Driven
 * against Postgres 17 and MySQL 8: one id, stable over three polls of one long statement, and two
 * distinct ids for byte-identical SQL in two sessions.
 */
export function readPulse(result: QueryResult, now: number, connectionId?: string): PulseReading {
	const index = columnIndex(result.fields);
	const sqlAt = index.get('statement_text');
	if (sqlAt === undefined) {
		return { samples: [], maskedRows: 0 };
	}
	const sessionAt = index.get('session_id');
	const durationAt = index.get('duration_ms');
	const stateAt = index.get('session_state');
	const userAt = index.get('user_name');
	const prefix = connectionId ? `${connectionId}:` : '';
	const samples: PulseSample[] = [];
	let maskedRows = 0;
	for (let i = 0; i < result.rows.length; i++) {
		const row = result.rows[i];
		const sql = text(row, sqlAt);
		// A session with no statement text is a session Pulse has nothing to say about.
		if (!sql) {
			continue;
		}
		// Not a statement, a refusal. Drawing '<insufficient privilege>' in the feed as though it
		// were SQL would be worse than drawing nothing, and it must never reach the graph, where
		// `statementTargets` would match it against the schema's own names.
		if (sql === POSTGRES_MASKED_STATEMENT) {
			maskedRows++;
			continue;
		}
		const session = text(row, sessionAt) ?? `row-${i}`;
		samples.push({
			id: `${prefix}${session}:${hashText(sql)}`,
			sql,
			durationMs: millis(row, durationAt),
			state: text(row, stateAt),
			user: text(row, userAt),
			sampledAt: now,
		});
	}
	return { samples, maskedRows };
}

/** {@link readPulse}, for the callers that only want the statements. */
export function readPulseRows(result: QueryResult, now: number, connectionId?: string): PulseSample[] {
	return readPulse(result, now, connectionId).samples;
}

/** What to tell someone whose login the database will not let see other sessions. A whole sentence,
 *  shown verbatim in Orbit's rail, so it says what to do about it rather than only that it happened. */
export function maskedRowsMessage(count: number): string {
	const sessions = count === 1 ? '1 session is' : `${count} sessions are`;
	return `${sessions} hidden from this login, so their statements cannot be shown. On Postgres, granting pg_read_all_stats to this role (or connecting as a superuser) is what makes them visible.`;
}

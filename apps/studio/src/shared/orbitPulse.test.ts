/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_PULSE_INTERVAL_MS,
	MIN_PULSE_INTERVAL_MS,
	PULSE_MARKER,
	clampPulseInterval,
	pulseQueryFor,
	pulseSourceFor,
	pulseSourceName,
	pulseSupported,
	POSTGRES_MASKED_STATEMENT,
	maskedRowsMessage,
	pulseUnavailableReason,
	readPulse,
	readPulseRows,
} from './orbitPulse';
import type { QueryResult } from './query';

/** A result in the fixed Pulse column contract, with only the columns a caller names. */
function result(names: string[], rows: unknown[][]): QueryResult {
	return { fields: names.map((name) => ({ name })), rows, rowCount: rows.length, durationMs: 1 };
}

test('pulseQueryFor: each supported engine names its own activity view', () => {
	const expected: Record<string, string> = {
		postgres: 'pg_stat_activity',
		'mysql-aurora': 'performance_schema.events_statements_current',
		// MariaDB reads the processlist, not performance_schema, and the live run is why: a stock
		// MariaDB 11 ships performance_schema OFF, so the MySQL query answered every poll with no
		// rows. See the MARIADB_PULSE comment in orbitPulse.ts.
		mariadb: 'information_schema.processlist',
		sqlserver: 'sys.dm_exec_requests',
		oracle: 'v$session',
		redshift: 'stv_recents',
	};
	for (const [driver, view] of Object.entries(expected)) {
		const sql = pulseQueryFor(driver);
		assert.ok(sql, `${driver} should have an activity query`);
		// The view name is compared case-insensitively: MariaDB's query says PROCESSLIST because that
		// is the table's name, while the sentence shown to the user says processlist.
		assert.ok(sql.toLowerCase().includes(view.toLowerCase()), `${driver} query should read ${view}`);
		assert.equal(pulseSupported(driver), true);
		assert.equal(pulseSourceName(driver), view);
		assert.equal(pulseUnavailableReason(driver), '');
	}
});

test('pulseQueryFor: SQL Server reaches the statement text through dm_exec_sql_text', () => {
	const sql = pulseQueryFor('sqlserver');
	assert.ok(sql?.includes('sys.dm_exec_sql_text'));
	assert.ok(sql?.includes('CROSS APPLY'));
});

test('pulseQueryFor: Oracle joins v$session to v$sql', () => {
	const sql = pulseQueryFor('oracle');
	assert.ok(sql?.includes('v$session'));
	assert.ok(sql?.includes('v$sql'));
});

test('every activity query is a SELECT, aliases the fixed column contract, and excludes itself', () => {
	for (const driver of ['postgres', 'mysql-aurora', 'mariadb', 'sqlserver', 'oracle', 'redshift']) {
		const source = pulseSourceFor(driver);
		assert.ok(source);
		for (const sql of [source.sql, source.fallbackSql].filter((s): s is string => Boolean(s))) {
			// Begins with SELECT so the read-only guard passes it unchanged.
			assert.match(sql, /^SELECT\b/, `${driver}: must begin with SELECT`);
			for (const column of ['session_id', 'statement_text', 'duration_ms', 'session_state', 'user_name']) {
				assert.ok(sql.includes(`AS ${column}`) || sql.includes(`\n       ${column}\n`) || sql.includes(` ${column}\n`), `${driver}: missing the ${column} alias`);
			}
			// The marker is both carried and filtered, which is what makes the query self-excluding.
			assert.ok(sql.includes(`/* ${PULSE_MARKER} */`), `${driver}: must carry the marker`);
			assert.ok(sql.includes(`NOT LIKE '%${PULSE_MARKER}%'`), `${driver}: must filter the marker`);
		}
	}
});

test('the Postgres query excludes this backend and idle sessions', () => {
	const sql = pulseQueryFor('postgres') ?? '';
	assert.ok(sql.includes('pg_backend_pid()'));
	assert.ok(sql.includes("NOT LIKE 'idle%'"));
});

test('the Postgres query keeps the rows a non-superuser is not allowed to read', () => {
	// Measured on Postgres 17: a role without pg_read_all_stats gets a row per session with
	// backend_type NULL and query set to '<insufficient privilege>'. A flat
	// `backend_type = 'client backend'` therefore discarded every one of them and Pulse was empty,
	// every poll, for ever, while the rail said it was fine.
	const sql = pulseQueryFor('postgres') ?? '';
	assert.ok(sql.includes("(backend_type IS NULL OR backend_type = 'client backend')"));
});

test('MySQL carries a processlist fallback; nobody else does', () => {
	const mysql = pulseSourceFor('mysql-aurora');
	assert.ok(mysql?.fallbackSql?.includes('information_schema.PROCESSLIST'));
	assert.equal(mysql?.fallbackSourceName, 'information_schema.processlist');
	// MariaDB has no fallback because it needs none: its primary IS the always-present view.
	assert.equal(pulseSourceFor('mariadb')?.fallbackSql, undefined);
	assert.equal(pulseSourceFor('postgres')?.fallbackSql, undefined);
	assert.equal(pulseSourceFor('oracle')?.fallbackSql, undefined);
});

test('MySQL asks whether performance_schema is really recording before trusting it', () => {
	// The defect this guards, found on a live server: performance_schema OFF does not make the
	// activity query FAIL, it makes it answer with no rows, so a fallback that fires on failure
	// never fires and Pulse sits empty and green for ever.
	const source = pulseSourceFor('mysql-aurora');
	assert.ok(source?.requiresSql, 'MySQL needs a precondition');
	assert.match(source.requiresSql, /^SELECT\b/);
	assert.ok(source.requiresSql.includes('@@performance_schema'));
	assert.ok(source.requiresSql.includes('setup_consumers'));
	assert.ok(source.requiresSql.includes(`/* ${PULSE_MARKER} */`), 'the precondition is activity too, so it carries the marker');
	assert.ok(source.requiresReason && source.requiresReason.endsWith('.'));
	assert.ok(!source.requiresReason.includes('—'), 'no em-dashes in UI text');
	// Nothing else claims one, because nothing else has a view that can be switched off in silence.
	for (const driver of ['postgres', 'mariadb', 'sqlserver', 'oracle', 'redshift']) {
		assert.equal(pulseSourceFor(driver)?.requiresSql, undefined, `${driver} should have no precondition`);
	}
});

test('the MySQL query only reports statements that have not finished', () => {
	// events_statements_current keeps the LAST statement of an idle connection, with its duration
	// frozen. Measured on MySQL 8: without this, one finished SELECT SLEEP(1) came back in every
	// later poll at a fixed 1006ms, for ever.
	assert.ok(pulseQueryFor('mysql-aurora')?.includes('`END_EVENT_ID` IS NULL'));
});

test('the MariaDB query reads milliseconds, not whole seconds', () => {
	const sql = pulseQueryFor('mariadb') ?? '';
	assert.ok(sql.includes('TIME_MS'), 'MariaDB has a millisecond column and MySQL does not');
	assert.ok(sql.includes('CONNECTION_ID()'), 'and still excludes the sampler own thread');
	assert.ok(!sql.includes('performance_schema'), 'and never touches performance_schema');
});

test('engines with no activity view decline by name, in a sentence', () => {
	for (const driver of ['sqlite', 'duckdb', 'mongodb', 'pinecone', 'snowflake', 'db2', 'hana', 'cloudwatch', 'azureMonitor', 'gcpLogging']) {
		assert.equal(pulseQueryFor(driver), undefined, `${driver} should have no activity query`);
		assert.equal(pulseSupported(driver), false);
		assert.equal(pulseSourceName(driver), undefined);
		const reason = pulseUnavailableReason(driver);
		assert.ok(reason.length > 20, `${driver}: the reason should be a sentence`);
		assert.ok(reason.endsWith('.'), `${driver}: the reason should be a sentence`);
		// "Unsupported" is exactly the word the reason exists to avoid, and an em-dash is against
		// house rules in user-facing text.
		assert.ok(!/unsupported/i.test(reason), `${driver}: never the word "unsupported"`);
		assert.ok(!reason.includes('—'), `${driver}: no em-dashes in UI text`);
	}
});

test('an unknown or missing driver declines rather than throwing', () => {
	assert.equal(pulseQueryFor('made-up'), undefined);
	assert.equal(pulseQueryFor(undefined), undefined);
	assert.equal(pulseSupported(undefined), false);
	assert.ok(pulseUnavailableReason('made-up').includes('does not know'));
	assert.ok(pulseUnavailableReason(undefined).length > 20);
});

test('clampPulseInterval: floors, ceilings, and defaults', () => {
	assert.equal(clampPulseInterval(undefined), DEFAULT_PULSE_INTERVAL_MS);
	assert.equal(clampPulseInterval(Number.NaN), DEFAULT_PULSE_INTERVAL_MS);
	assert.equal(clampPulseInterval(0), MIN_PULSE_INTERVAL_MS);
	assert.equal(clampPulseInterval(-5000), MIN_PULSE_INTERVAL_MS);
	assert.equal(clampPulseInterval(2500), 2500);
	assert.equal(clampPulseInterval(999_999), 60_000);
});

test('readPulseRows: maps a realistic Postgres result set', () => {
	const rows = result(
		['session_id', 'statement_text', 'duration_ms', 'session_state', 'user_name'],
		[
			['4821', 'SELECT * FROM orders WHERE id = 7', '1350', 'active', 'app'],
			['4822', 'UPDATE customers SET tier = $1', 42, 'active', 'etl'],
		],
	);
	const samples = readPulseRows(rows, 1000);
	assert.equal(samples.length, 2);
	assert.equal(samples[0].sql, 'SELECT * FROM orders WHERE id = 7');
	assert.equal(samples[0].durationMs, 1350);
	assert.equal(samples[0].state, 'active');
	assert.equal(samples[0].user, 'app');
	assert.equal(samples[0].sampledAt, 1000);
	assert.equal(samples[1].durationMs, 42);
	assert.notEqual(samples[0].id, samples[1].id);
});

test('readPulseRows: matches the column contract whatever case the engine folded it to', () => {
	// Oracle folds unquoted aliases to uppercase, so this is the same result set Oracle returns.
	const samples = readPulseRows(result(['SESSION_ID', 'STATEMENT_TEXT', 'DURATION_MS'], [['12:9', 'SELECT 1 FROM DUAL', 3000]]), 5);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].sql, 'SELECT 1 FROM DUAL');
	assert.equal(samples[0].durationMs, 3000);
});

test('readPulseRows: tolerates missing optional columns', () => {
	const samples = readPulseRows(result(['statement_text'], [['SELECT 1']]), 7);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].durationMs, undefined);
	assert.equal(samples[0].state, undefined);
	assert.equal(samples[0].user, undefined);
	assert.ok(samples[0].id.length > 0);
});

test('readPulseRows: a result without the statement column yields nothing', () => {
	assert.deepEqual(readPulseRows(result(['session_id', 'duration_ms'], [['1', 5]]), 0), []);
});

test('readPulseRows: drops rows with no statement text', () => {
	// A non-privileged Postgres user sees other backends with `query` masked to null or blank; that
	// is the normal degraded read, not an error, so those rows are simply not drawn.
	const samples = readPulseRows(
		result(['session_id', 'statement_text'], [['1', null], ['2', '   '], ['3', ''], ['4', 'SELECT 1']]),
		0,
	);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].sql, 'SELECT 1');
});

test('readPulseRows: a bad duration is dropped rather than drawn', () => {
	const samples = readPulseRows(
		result(['statement_text', 'duration_ms'], [['SELECT 1', null], ['SELECT 2', 'nonsense'], ['SELECT 3', -12]]),
		0,
	);
	assert.deepEqual(samples.map((s) => s.durationMs), [undefined, undefined, undefined]);
});

test('readPulseRows: ids are stable across samples of the same running statement', () => {
	const rows = result(['session_id', 'statement_text'], [['77', 'SELECT pg_sleep(30)']]);
	const first = readPulseRows(rows, 1000);
	const second = readPulseRows(rows, 3000);
	assert.equal(first[0].id, second[0].id);
	assert.notEqual(first[0].sampledAt, second[0].sampledAt);
});

test('readPulseRows: a session moving on to another statement gets a new id', () => {
	const before = readPulseRows(result(['session_id', 'statement_text'], [['77', 'SELECT 1']]), 0);
	const after = readPulseRows(result(['session_id', 'statement_text'], [['77', 'SELECT 2']]), 0);
	assert.notEqual(before[0].id, after[0].id);
});

test('readPulseRows: the same statement in two sessions stays two samples', () => {
	const samples = readPulseRows(result(['session_id', 'statement_text'], [['1', 'SELECT 1'], ['2', 'SELECT 1']]), 0);
	assert.equal(samples.length, 2);
	assert.notEqual(samples[0].id, samples[1].id);
});

test('readPulseRows: the connection id scopes ids so two databases never collide', () => {
	const rows = result(['session_id', 'statement_text'], [['1', 'SELECT 1']]);
	const a = readPulseRows(rows, 0, 'conn-a');
	const b = readPulseRows(rows, 0, 'conn-b');
	assert.notEqual(a[0].id, b[0].id);
	assert.ok(a[0].id.startsWith('conn-a:'));
});

test('readPulseRows: rows with no session id still get distinct ids', () => {
	const samples = readPulseRows(result(['statement_text'], [['SELECT 1'], ['SELECT 1']]), 0);
	assert.equal(samples.length, 2);
	assert.notEqual(samples[0].id, samples[1].id);
});

/*
 * Below here: fixtures taken verbatim from a live run of the activity queries against
 * Postgres 17, MySQL 8 and MariaDB 11 in containers on 2026-09-06. They exist so the reader is
 * tested on what a database actually hands back, including the shapes the drivers coerce (pg
 * returns bigint as a string, mysql2 returns DECIMAL as a string) rather than on values invented to
 * suit the code.
 */

test('readPulse: the live Postgres shape, bigint duration and all', () => {
	const { samples, maskedRows } = readPulse(
		result(
			['session_id', 'statement_text', 'duration_ms', 'session_state', 'user_name'],
			[['81', 'SELECT pg_sleep(4) /* orbit_probe_busy_1 */', '1260', 'active', 'orbit']],
		),
		1000,
		'conn-1',
	);
	assert.equal(maskedRows, 0);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].durationMs, 1260);
	assert.equal(samples[0].state, 'active');
	assert.equal(samples[0].id, 'conn-1:81:' + samples[0].id.split(':')[2]);
});

test('readPulse: the live MariaDB shape, where mysql2 hands DECIMAL back as a string', () => {
	const { samples } = readPulse(
		result(
			['session_id', 'statement_text', 'duration_ms', 'session_state', 'user_name'],
			[['thread-15', 'SELECT SLEEP(3) /* orbit_probe_busy_1 */', '1256', 'User sleep', 'root']],
		),
		0,
	);
	assert.equal(samples[0].durationMs, 1256);
	assert.equal(samples[0].state, 'User sleep');
});

test("readPulse: '<insufficient privilege>' is counted, never drawn", () => {
	// This is the literal string Postgres puts in `query` for a session the reader may not see. It
	// is not SQL, so it must never reach the feed or the graph, where statementTargets would happily
	// match it against the schema's own names.
	const { samples, maskedRows } = readPulse(
		result(
			['session_id', 'statement_text', 'duration_ms', 'session_state', 'user_name'],
			[
				['75', 'SELECT pg_sleep(3)', '1268', 'active', 'watcher'],
				['32', POSTGRES_MASKED_STATEMENT, null, null, 'orbit'],
				['30', POSTGRES_MASKED_STATEMENT, null, null, null],
			],
		),
		0,
	);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].sql, 'SELECT pg_sleep(3)');
	assert.equal(maskedRows, 2);
});

test('readPulse: a whole poll the database refused to describe reads as masked, not as quiet', () => {
	// The difference this test exists to keep: "nothing is running" and "you are not allowed to
	// look" produce the same empty sample list, and only maskedRows tells them apart.
	const rows = [['32', POSTGRES_MASKED_STATEMENT], ['30', POSTGRES_MASKED_STATEMENT], ['28', POSTGRES_MASKED_STATEMENT]];
	const masked = readPulse(result(['session_id', 'statement_text'], rows), 0);
	const quiet = readPulse(result(['session_id', 'statement_text'], []), 0);
	assert.deepEqual(masked.samples, []);
	assert.deepEqual(quiet.samples, []);
	assert.equal(masked.maskedRows, 3);
	assert.equal(quiet.maskedRows, 0);
});

test('readPulseRows is readPulse without the count, so existing callers are unchanged', () => {
	const rows = result(['session_id', 'statement_text'], [['1', 'SELECT 1'], ['2', POSTGRES_MASKED_STATEMENT]]);
	assert.deepEqual(readPulseRows(rows, 4, 'c'), readPulse(rows, 4, 'c').samples);
});

test('maskedRowsMessage: a sentence that says what to do about it', () => {
	const one = maskedRowsMessage(1);
	const many = maskedRowsMessage(7);
	assert.ok(one.startsWith('1 session is hidden'));
	assert.ok(many.startsWith('7 sessions are hidden'));
	for (const message of [one, many]) {
		assert.ok(message.endsWith('.'));
		// Verified live: granting pg_read_all_stats to the role made the same query report every
		// session, so the advice in this sentence is not a guess.
		assert.ok(message.includes('pg_read_all_stats'));
		assert.ok(!message.includes('—'), 'no em-dashes in UI text');
	}
});

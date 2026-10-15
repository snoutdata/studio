/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialectFor, listDialects } from './index';

test('quoteIdent uses the per-vendor quoting char and escapes it', () => {
	assert.equal(dialectFor('mysql-aurora').quoteIdent('a`b'), '`a``b`');
	assert.equal(dialectFor('postgres').quoteIdent('a"b'), '"a""b"');
	assert.equal(dialectFor('sqlserver').quoteIdent('a]b'), '[a]]b]');
	assert.equal(dialectFor('oracle').quoteIdent('a"b'), '"a""b"');
});

/**
 * Read a ClickHouse backtick identifier the way the server's lexer does: `\` escapes the next
 * character and a doubled backtick is one backtick. Returns the name and where the quote closed.
 */
function readClickHouseIdent(sql: string): { name: string; end: number } {
	assert.equal(sql[0], '`');
	let name = '';
	for (let i = 1; i < sql.length; i++) {
		const c = sql[i];
		if (c === '\\') {
			name += sql[i + 1] ?? '';
			i++;
		} else if (c === '`' && sql[i + 1] === '`') {
			name += '`';
			i++;
		} else if (c === '`') {
			return { name, end: i };
		} else {
			name += c;
		}
	}
	return { name, end: -1 };
}

/** Names a ClickHouse catalog could hold that try to step out of their quotes. */
const HOSTILE_CLICKHOUSE_NAMES = ['x\\`; DROP TABLE t; --', 'a\\', '\\`', 'a`b', 'tab\\\\`le'];

test('ClickHouse identifiers escape the backslash as well as the backtick, so a name stays one identifier', () => {
	const q = dialectFor('clickhouse').quoteIdent;
	assert.equal(q('x\\`y'), '`x\\\\``y`');
	for (const name of HOSTILE_CLICKHOUSE_NAMES) {
		const quoted = q(name);
		assert.deepEqual(readClickHouseIdent(quoted), { name, end: quoted.length - 1 }, name);
	}
	// MySQL does not read a backslash inside backticks, so its quoting is unchanged.
	assert.equal(dialectFor('mysql-aurora').quoteIdent('a\\b'), '`a\\b`');
});

test('unknown / undefined driver falls back to generic (mysql-style quoting, sql formatter)', () => {
	assert.equal(dialectFor(undefined).quoteIdent('x'), '`x`');
	assert.equal(dialectFor('made-up').quoteIdent('x'), '`x`');
	assert.equal(dialectFor(undefined).formatterLanguage, 'sql');
});

test('booleanLiteral: postgres TRUE/FALSE, everyone else 1/0', () => {
	assert.equal(dialectFor('postgres').booleanLiteral(true), 'TRUE');
	assert.equal(dialectFor('postgres').booleanLiteral(false), 'FALSE');
	for (const id of ['mysql-aurora', 'mariadb', 'sqlserver', 'oracle', 'db2']) {
		assert.equal(dialectFor(id).booleanLiteral(true), '1');
		assert.equal(dialectFor(id).booleanLiteral(false), '0');
	}
});

test('mariadb mirrors mysql but with its own formatter language + display name', () => {
	const maria = dialectFor('mariadb');
	assert.equal(maria.quoteIdent('a`b'), '`a``b`');
	assert.equal(maria.formatterLanguage, 'mariadb');
	assert.equal(maria.isTransactionalDdl, false);
	assert.equal(maria.defaultPort, 3306);
	assert.equal(maria.aiDisplayName, 'MariaDB');
	assert.equal(maria.limitClause('SELECT * FROM t', 100), 'SELECT * FROM t\nLIMIT 100');
});

test('formatterLanguage maps to the sql-formatter dialect', () => {
	assert.equal(dialectFor('mysql-aurora').formatterLanguage, 'mysql');
	assert.equal(dialectFor('postgres').formatterLanguage, 'postgresql');
	assert.equal(dialectFor('sqlserver').formatterLanguage, 'transactsql');
	assert.equal(dialectFor('oracle').formatterLanguage, 'plsql');
	assert.equal(dialectFor('db2').formatterLanguage, 'db2');
});

test('isTransactionalDdl: only postgres (oracle auto-commits its DDL)', () => {
	assert.equal(dialectFor('postgres').isTransactionalDdl, true);
	assert.equal(dialectFor('mysql-aurora').isTransactionalDdl, false);
	assert.equal(dialectFor('sqlserver').isTransactionalDdl, false);
	assert.equal(dialectFor('oracle').isTransactionalDdl, false);
	assert.equal(dialectFor('db2').isTransactionalDdl, false);
});

test('limitClause: LIMIT vs TOP vs FETCH FIRST', () => {
	assert.equal(dialectFor('mysql-aurora').limitClause('SELECT * FROM t', 100), 'SELECT * FROM t\nLIMIT 100');
	assert.equal(dialectFor('postgres').limitClause('SELECT * FROM t', 100), 'SELECT * FROM t\nLIMIT 100');
	assert.equal(dialectFor('sqlserver').limitClause('SELECT * FROM t', 100), 'SELECT TOP 100 * FROM t');
	assert.equal(dialectFor('sqlserver').limitClause('SELECT DISTINCT a FROM t', 100), 'SELECT DISTINCT TOP 100 a FROM t');
	assert.equal(dialectFor('oracle').limitClause('SELECT * FROM t', 100), 'SELECT * FROM t\nFETCH FIRST 100 ROWS ONLY');
});

test('windowClause: offset 0 matches limitClause, deeper windows page per dialect', () => {
	// The first window and the auto-LIMIT must agree, or "fetch more" would re-shape the statement.
	for (const driver of ['mysql-aurora', 'postgres', 'sqlserver', 'oracle', 'db2', 'snowflake']) {
		const d = dialectFor(driver);
		assert.equal(d.windowClause('SELECT * FROM t', 100, 0), d.limitClause('SELECT * FROM t', 100), driver);
	}
	assert.equal(dialectFor('postgres').windowClause('SELECT * FROM t', 200, 400), 'SELECT * FROM t\nLIMIT 200 OFFSET 400');
	assert.equal(dialectFor('oracle').windowClause('SELECT * FROM t', 200, 400), 'SELECT * FROM t\nOFFSET 400 ROWS FETCH NEXT 200 ROWS ONLY');
	assert.equal(dialectFor('db2').windowClause('SELECT * FROM t', 200, 400), 'SELECT * FROM t\nOFFSET 400 ROWS FETCH NEXT 200 ROWS ONLY');
	// The user's own ORDER BY is preserved, and the window lands after it.
	assert.equal(dialectFor('postgres').windowClause('SELECT * FROM t ORDER BY id', 50, 50), 'SELECT * FROM t ORDER BY id\nLIMIT 50 OFFSET 50');
});

test('windowClause: SQL Server drops TOP past the first window and always has an ORDER BY', () => {
	const ms = dialectFor('sqlserver');
	// T-SQL rejects OFFSET..FETCH without an ORDER BY, so an unordered statement gets the no-op one.
	assert.equal(ms.windowClause('SELECT * FROM t', 200, 400), 'SELECT * FROM t\nORDER BY (SELECT NULL)\nOFFSET 400 ROWS FETCH NEXT 200 ROWS ONLY');
	// …and a statement that brings its own ORDER BY keeps exactly that one (never two).
	assert.equal(ms.windowClause('SELECT * FROM t ORDER BY id', 200, 400), 'SELECT * FROM t ORDER BY id\nOFFSET 400 ROWS FETCH NEXT 200 ROWS ONLY');
	assert.ok(!ms.windowClause('SELECT * FROM t', 200, 400).includes('TOP'));
	// An ORDER BY nested in OVER(…) or a subquery is NOT the statement's own: it still needs one,
	// or T-SQL rejects the OFFSET..FETCH.
	assert.match(ms.windowClause('SELECT ROW_NUMBER() OVER (ORDER BY id) AS n, a FROM t', 200, 400), /ORDER BY \(SELECT NULL\)/);
	assert.match(ms.windowClause('SELECT * FROM (SELECT a FROM t ORDER BY a) x', 200, 400), /ORDER BY \(SELECT NULL\)/);
	// …and a literal that merely contains the words doesn't count as one either.
	assert.match(ms.windowClause("SELECT 'order by x' AS s FROM t", 200, 400), /ORDER BY \(SELECT NULL\)/);
});

test('sqlserver hasLimit also catches an OFFSET..FETCH tail (TOP cannot coexist with it)', () => {
	const ms = dialectFor('sqlserver');
	assert.ok(ms.hasLimit('SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY'));
	assert.ok(!ms.hasLimit('SELECT * FROM t ORDER BY id'));
	// DATETIMEOFFSET is not an OFFSET clause.
	assert.ok(!ms.hasLimit('SELECT CAST(a AS DATETIMEOFFSET) FROM t'));
});

test('hasLimit detects an existing cap per dialect', () => {
	assert.ok(dialectFor('mysql-aurora').hasLimit('select * from t limit 10'));
	assert.ok(!dialectFor('mysql-aurora').hasLimit('select * from t'));
	assert.ok(dialectFor('sqlserver').hasLimit('SELECT TOP 5 * FROM t'));
	assert.ok(dialectFor('oracle').hasLimit('SELECT * FROM t FETCH FIRST 5 ROWS ONLY'));
	assert.ok(dialectFor('oracle').hasLimit('SELECT * FROM t OFFSET 5 ROWS'));
});

test('paginatedSelect: LIMIT/OFFSET vs OFFSET/FETCH', () => {
	const page = { limit: 51, offset: 100, orderBy: '', fallbackOrderBy: '"id"' };
	assert.equal(
		dialectFor('postgres').paginatedSelect('SELECT * FROM "t"', page),
		'SELECT * FROM "t" LIMIT 51 OFFSET 100',
	);
	// OFFSET/FETCH needs a deterministic order: uses fallbackOrderBy when orderBy is empty.
	assert.equal(
		dialectFor('sqlserver').paginatedSelect('SELECT * FROM [t]', page),
		'SELECT * FROM [t] ORDER BY "id" OFFSET 100 ROWS FETCH NEXT 51 ROWS ONLY',
	);
	assert.equal(
		dialectFor('oracle').paginatedSelect('SELECT * FROM "T"', page),
		'SELECT * FROM "T" ORDER BY "id" OFFSET 100 ROWS FETCH NEXT 51 ROWS ONLY',
	);
	// An explicit ORDER BY is preserved verbatim.
	const sorted = { limit: 51, offset: 0, orderBy: ' ORDER BY "name" DESC', fallbackOrderBy: '"id"' };
	assert.equal(
		dialectFor('oracle').paginatedSelect('SELECT * FROM "T"', sorted),
		'SELECT * FROM "T" ORDER BY "name" DESC OFFSET 0 ROWS FETCH NEXT 51 ROWS ONLY',
	);
});

test('peekOne: TOP 1 vs LIMIT 1 vs FETCH FIRST 1', () => {
	assert.equal(dialectFor('mysql-aurora').peekOne('a, b', '`t` WHERE `id` = 1'), 'SELECT a, b FROM `t` WHERE `id` = 1 LIMIT 1');
	assert.equal(dialectFor('sqlserver').peekOne('a, b', '[t] WHERE [id] = 1'), 'SELECT TOP 1 a, b FROM [t] WHERE [id] = 1');
	assert.equal(dialectFor('oracle').peekOne('a, b', '"T" WHERE "ID" = 1'), 'SELECT a, b FROM "T" WHERE "ID" = 1 FETCH FIRST 1 ROWS ONLY');
});

test('listDialects exposes the shipped drivers with sensible ports', () => {
	const ids = listDialects().map((d) => d.driverId);
	assert.deepEqual(ids, ['mysql-aurora', 'mariadb', 'postgres', 'sqlserver', 'oracle', 'db2', 'sqlite', 'duckdb', 'snowflake', 'redshift', 'hana', 'clickhouse', 'mongodb', 'pinecone', 'cloudwatch', 'azureMonitor', 'gcpLogging']);
	// ClickHouse: the HTTP port, backtick quoting, lowercase true/false, LIMIT, and its own formatter.
	assert.equal(dialectFor('clickhouse').defaultPort, 8123);
	assert.equal(dialectFor('clickhouse').quoteIdent('a`b'), '`a``b`');
	assert.equal(dialectFor('clickhouse').limitClause('SELECT 1', 5), 'SELECT 1\nLIMIT 5');
	assert.equal(dialectFor('clickhouse').hasLimit('SELECT 1 LIMIT 5'), true);
	// A trailing SETTINGS / FORMAT is where a LIMIT may NOT go: it goes before it.
	assert.equal(dialectFor('clickhouse').limitClause('SELECT * FROM t SETTINGS max_threads = 2', 100), 'SELECT * FROM t\nLIMIT 100\nSETTINGS max_threads = 2');
	assert.equal(dialectFor('clickhouse').limitClause('SELECT * FROM t FORMAT CSV', 100), 'SELECT * FROM t\nLIMIT 100\nFORMAT CSV');
	assert.equal(dialectFor('clickhouse').windowClause('SELECT * FROM t SETTINGS a = 1', 50, 100), 'SELECT * FROM t\nLIMIT 50 OFFSET 100\nSETTINGS a = 1');
	// ...but a column called `settings`, or a SETTINGS inside a subquery, is not that tail.
	assert.equal(dialectFor('clickhouse').limitClause('SELECT settings FROM t', 5), 'SELECT settings FROM t\nLIMIT 5');
	assert.equal(dialectFor('clickhouse').limitClause('SELECT * FROM (SELECT 1 SETTINGS a = 1)', 5), 'SELECT * FROM (SELECT 1 SETTINGS a = 1)\nLIMIT 5');
	// LIMIT n BY caps rows per group, not the result; a subquery's LIMIT does not cap the outer one.
	assert.equal(dialectFor('clickhouse').hasLimit('SELECT * FROM t LIMIT 1 BY user_id'), false);
	assert.equal(dialectFor('clickhouse').hasLimit('SELECT * FROM t LIMIT 10 BY user_id'), false);
	assert.equal(dialectFor('clickhouse').hasLimit('SELECT * FROM t LIMIT 1 BY user_id LIMIT 100'), true);
	assert.equal(dialectFor('clickhouse').hasLimit('SELECT * FROM (SELECT * FROM t LIMIT 5)'), false);
	assert.equal(dialectFor('clickhouse').hasLimit('SELECT * FROM t LIMIT 5, 10'), true);
	assert.equal(dialectFor('oracle').defaultPort, 1521);
	assert.equal(dialectFor('oracle').aiDisplayName, 'Oracle');
	assert.equal(dialectFor('db2').defaultPort, 50000);
	assert.equal(dialectFor('db2').aiDisplayName, 'Db2');
	// Snowflake: cloud warehouse, double-quote quoting, native TRUE/FALSE booleans, LIMIT/OFFSET.
	assert.equal(dialectFor('snowflake').aiDisplayName, 'Snowflake');
	assert.equal(dialectFor('snowflake').quoteIdent('a"b'), '"a""b"');
	assert.equal(dialectFor('snowflake').booleanLiteral(true), 'TRUE');
	// Redshift: Postgres-family warehouse — lower-folded identifiers, LIMIT/OFFSET, its own port.
	assert.equal(dialectFor('redshift').defaultPort, 5439);
	assert.equal(dialectFor('redshift').foldsIdentifierCase, 'lower');
	assert.equal(dialectFor('redshift').formatterLanguage, 'redshift');
	assert.equal(dialectFor('redshift').booleanLiteral(false), 'FALSE');
	// Redshift's EXPLAIN has no JSON output, so the plan advisor has nothing to parse there.
	assert.equal(dialectFor('redshift').explainJson, undefined);
	// SAP HANA: uppercase-folded identifiers, LIMIT/OFFSET, non-transactional DDL, generic formatter.
	assert.equal(dialectFor('hana').defaultPort, 30015);
	assert.equal(dialectFor('hana').foldsIdentifierCase, 'upper');
	assert.equal(dialectFor('hana').formatterLanguage, 'sql');
	assert.equal(dialectFor('hana').isTransactionalDdl, false);
	assert.equal(dialectFor('hana').quoteIdent('a"b'), '"a""b"');
	assert.equal(dialectFor('hana').booleanLiteral(true), 'TRUE');
	// MongoDB is a document backend whose dialect only governs the SQL we *generate* for the
	// SQL→pipeline transcriber (Postgres-style double-quote + LIMIT/OFFSET).
	assert.equal(dialectFor('mongodb').defaultPort, 27017);
	assert.equal(dialectFor('mongodb').quoteIdent('a"b'), '"a""b"');
	// Pinecone is a vector backend; its dialect only governs the SQL we generate for the
	// SQL→vector-query transcriber. No TCP port (the index host is a URL) → 0 hides host/port.
	assert.equal(dialectFor('pinecone').defaultPort, 0);
	assert.equal(dialectFor('pinecone').quoteIdent('a"b'), '"a""b"');
	// The three cloud LOG services are telemetry backends: no port to connect to (a connection is a
	// cloud account plus a region), Postgres-style quoting because that is the grammar `sqlToLogs`
	// parses, and a display name that is the SERVICE's, since the account it uses is the vendor's.
	for (const id of ['cloudwatch', 'azureMonitor', 'gcpLogging']) {
		assert.equal(dialectFor(id).defaultPort, 0, id);
		assert.equal(dialectFor(id).quoteIdent('a"b'), '"a""b"', id);
		assert.equal(dialectFor(id).booleanLiteral(true), 'TRUE', id);
	}
	assert.equal(dialectFor('cloudwatch').displayName, 'Amazon CloudWatch Logs');
	assert.equal(dialectFor('azureMonitor').displayName, 'Azure Monitor Logs');
	assert.equal(dialectFor('gcpLogging').displayName, 'Google Cloud Logging');
});

test('sqlite is file-based: double-quote quoting, LIMIT/OFFSET, transactional DDL, no port', () => {
	const sqlite = dialectFor('sqlite');
	assert.equal(sqlite.quoteIdent('a"b'), '"a""b"');
	assert.equal(sqlite.defaultPort, 0);
	assert.equal(sqlite.formatterLanguage, 'sqlite');
	// SQLite has fully transactional DDL (unlike the other non-Postgres vendors).
	assert.equal(sqlite.isTransactionalDdl, true);
	assert.equal(sqlite.booleanLiteral(true), '1');
	assert.equal(sqlite.limitClause('SELECT * FROM t', 100), 'SELECT * FROM t\nLIMIT 100');
	assert.equal(
		sqlite.paginatedSelect('SELECT * FROM "t"', { limit: 51, offset: 100, orderBy: '', fallbackOrderBy: '"id"' }),
		'SELECT * FROM "t" LIMIT 51 OFFSET 100',
	);
});

test('duckdb is file-based: double-quote quoting, native booleans, LIMIT/OFFSET, transactional DDL, no port', () => {
	const duckdb = dialectFor('duckdb');
	assert.equal(duckdb.quoteIdent('a"b'), '"a""b"');
	assert.equal(duckdb.defaultPort, 0);
	assert.equal(duckdb.aiDisplayName, 'DuckDB');
	// Postgres-compatible SQL → the PostgreSQL formatter (sql-formatter has no DuckDB dialect).
	assert.equal(duckdb.formatterLanguage, 'postgresql');
	// DuckDB has transactional DDL (like SQLite/Postgres) and a native BOOLEAN type.
	assert.equal(duckdb.isTransactionalDdl, true);
	assert.equal(duckdb.booleanLiteral(true), 'TRUE');
	assert.equal(
		duckdb.paginatedSelect('SELECT * FROM "t"', { limit: 51, offset: 100, orderBy: '', fallbackOrderBy: '"id"' }),
		'SELECT * FROM "t" LIMIT 51 OFFSET 100',
	);
});

test('workloadDigest: each SQL vendor names its own runtime-stats view and injects topN', () => {
	const cases: Array<[string, string]> = [
		['mysql-aurora', 'events_statements_summary_by_digest'],
		['mariadb', 'events_statements_summary_by_digest'],
		['postgres', 'pg_stat_statements'],
		['sqlserver', 'sys.dm_exec_query_stats'],
		['oracle', 'v$sqlarea'],
		['db2', 'MON_GET_PKG_CACHE_STMT'],
		['snowflake', 'information_schema.query_history'],
	];
	for (const [id, view] of cases) {
		const sql = dialectFor(id).workloadDigest!(15);
		assert.ok(sql, `${id} should yield digest SQL`);
		assert.ok(sql!.includes(view), `${id} digest should query ${view}`);
		assert.ok(/^\s*(SELECT|WITH)\b/i.test(sql!), `${id} digest must be a read-only SELECT/WITH`);
		assert.ok(sql!.includes('15'), `${id} digest should inject topN`);
		assert.ok(/query_text/.test(sql!), `${id} digest must expose the query_text column`);
	}
});

test('workloadDigest: clamps topN to a sane positive integer', () => {
	const digest = (n: number): string => dialectFor('postgres').workloadDigest!(n)!;
	assert.ok(digest(0).includes('LIMIT 15'), 'zero falls back to the default cap');
	assert.ok(digest(-5).includes('LIMIT 1'), 'negative is clamped up to the floor of 1');
	assert.ok(digest(9999).includes('LIMIT 200'), 'oversized is clamped to 200');
	assert.ok(digest(7.9).includes('LIMIT 7'), 'fractional is truncated');
});

test('workloadDigest: unavailable for SQLite, generic, and the non-SQL backends', () => {
	assert.equal(dialectFor('sqlite').workloadDigest!(15), null);
	assert.equal(dialectFor('duckdb').workloadDigest!(15), null);
	assert.equal(dialectFor('made-up').workloadDigest!(15), null);
	// Document/vector backends do not implement the optional method at all.
	assert.equal(dialectFor('mongodb').workloadDigest, undefined);
	assert.equal(dialectFor('pinecone').workloadDigest, undefined);
});

test('explainJson: wraps a SELECT in the vendor EXPLAIN-JSON form (Postgres/MySQL/MariaDB), strips trailing ;', () => {
	assert.equal(dialectFor('postgres').explainJson!('SELECT * FROM t;'), 'EXPLAIN (FORMAT JSON) SELECT * FROM t');
	assert.equal(dialectFor('mysql-aurora').explainJson!('SELECT * FROM t'), 'EXPLAIN FORMAT=JSON SELECT * FROM t');
	assert.equal(dialectFor('mariadb').explainJson!('SELECT 1'), 'EXPLAIN FORMAT=JSON SELECT 1');
});

test('explainJson: absent for vendors without a supported plan JSON (degrade to no-op)', () => {
	for (const id of ['sqlserver', 'oracle', 'db2', 'snowflake', 'sqlite', 'duckdb', 'made-up']) {
		assert.equal(dialectFor(id).explainJson, undefined, `${id} should not implement explainJson yet`);
	}
	assert.equal(dialectFor('mongodb').explainJson, undefined);
});

test('db2 uses double-quote quoting, OFFSET/FETCH pagination and the db2 formatter', () => {
	const db2 = dialectFor('db2');
	assert.equal(db2.quoteIdent('a"b'), '"a""b"');
	assert.equal(db2.foldsIdentifierCase, 'upper');
	assert.equal(db2.limitClause('SELECT * FROM t', 100), 'SELECT * FROM t\nFETCH FIRST 100 ROWS ONLY');
	assert.ok(db2.hasLimit('SELECT * FROM t FETCH FIRST 5 ROWS ONLY'));
	assert.equal(
		db2.paginatedSelect('SELECT * FROM "T"', { limit: 51, offset: 100, orderBy: '', fallbackOrderBy: '"id"' }),
		'SELECT * FROM "T" ORDER BY "id" OFFSET 100 ROWS FETCH NEXT 51 ROWS ONLY',
	);
});

test('ClickHouse finds its replicas, and says what stops it reading across them', async () => {
	const probe = dialectFor('clickhouse').replicaScope!;
	// A runner answering like a server: `replicas` in the default cluster, then each probe's fate.
	function server(replicas: number, refuse: (sql: string) => string | undefined): (sql: string) => Promise<Record<string, unknown>[]> {
		return async (sql) => {
			const refusal = refuse(sql);
			if (refusal) {
				throw new Error(refusal);
			}
			return [{ n: sql.includes('system.clusters') ? replicas : 1 }];
		};
	}
	assert.deepEqual(await probe(server(1, () => undefined)), { replicas: 1, settings: '' });
	const cloud = await probe(server(3, () => undefined));
	assert.equal(cloud.cluster, 'default');
	assert.equal(cloud.replicas, 3);
	assert.match(cloud.settings, /^SETTINGS max_execution_time = \d+, skip_unavailable_shards = 1$/);
	// readonly = 1: the settings are refused, the read itself is not.
	const readonly = await probe(server(3, (sql) => (sql.includes('SETTINGS') ? "Code: 164. Cannot modify 'max_execution_time' setting in readonly mode. (READONLY)" : undefined)));
	assert.deepEqual(readonly, { replicas: 3, cluster: 'default', settings: '' });
	// No READ ON REMOTE: one replica, and the reason in a sentence.
	const denied = await probe(server(3, (sql) => (sql.includes('clusterAllReplicas') ? 'it is necessary to have the grant READ ON REMOTE. (ACCESS_DENIED)' : undefined)));
	assert.equal(denied.cluster, undefined);
	assert.match(denied.limitation ?? '', /3 replicas .* READ ON REMOTE/);
	// system.clusters unreadable: treated as one node, never an error.
	assert.deepEqual(await probe(server(3, (sql) => (sql.includes('system.clusters') ? 'denied' : undefined))), { replicas: 1, settings: '' });
});

test('the ClickHouse workload digest reads every replica when there are several', () => {
	const digest = dialectFor('clickhouse').workloadDigest!;
	const single = digest(25)!;
	assert.match(single, /FROM system\.query_log\n/);
	assert.match(single, /AND is_initial_query\n/);
	assert.match(single, /LIMIT 25$/);
	const across = digest(25, { replicas: 3, cluster: 'default', settings: 'SETTINGS max_execution_time = 15' })!;
	assert.match(across, /FROM clusterAllReplicas\('default', system\.query_log\)\n/);
	assert.match(across, /LIMIT 25\nSETTINGS max_execution_time = 15$/);
});

test('ClickHouse {name:Type} placeholders are found once each, never inside a string or comment', () => {
	const params = dialectFor('clickhouse').queryParameters!;
	assert.deepEqual(params('SELECT * FROM t WHERE id = {id:UInt32} AND tag IN {tags:Array(String)} OR id = {id:UInt32}'), [
		{ name: 'id', type: 'UInt32' },
		{ name: 'tags', type: 'Array(String)' },
	]);
	assert.deepEqual(params('SELECT {m: Map(String, UInt8)} FROM {t:Identifier}'), [{ name: 'm', type: 'Map(String, UInt8)' }, { name: 't', type: 'Identifier' }]);
	assert.deepEqual(params("SELECT '{x:UInt8}', `{y:UInt8}` -- {z:UInt8}\n/* {w:UInt8} */"), []);
	// A JSON literal or a Map literal is not a placeholder.
	assert.deepEqual(params("SELECT map('a', 1), '{\"a\": 1}'"), []);
	assert.deepEqual(dialectFor('postgres').queryParameters, undefined);
});

test('ClickHouse binds parameter values in the escaped format the HTTP interface parses', () => {
	const bind = dialectFor('clickhouse').bindParameters!;
	assert.equal(bind({ id: '42', name: "O'Brien" }), "SET param_id = '42', param_name = 'O\\'Brien'");
	// A backslash is doubled for the parameter format, then again for the SQL string it travels in.
	assert.equal(bind({ p: 'C:\\x\ty' }), "SET param_p = 'C:\\\\\\\\x\\\\ty'");
});

test('the ClickHouse workload digest ranks by time, data read or peak memory, in the SQL', () => {
	const digest = dialectFor('clickhouse').workloadDigest!;
	assert.deepEqual(dialectFor('clickhouse').workloadRankings, ['time', 'read', 'memory']);
	assert.match(digest(25)!, /ORDER BY total_ms DESC/);
	assert.match(digest(25, undefined, 'read')!, /ORDER BY read_mb DESC/);
	assert.match(digest(25, undefined, 'memory')!, /ORDER BY peak_memory_mb DESC/);
	// The five shared columns come first; the two extra ones after.
	assert.match(digest(25)!, /AS query_text, count\(\) AS calls,[\s\S]*AS total_ms,[\s\S]*AS mean_ms, sum\(result_rows\) AS `rows`,[\s\S]*AS read_mb, [\s\S]*AS peak_memory_mb/);
	assert.equal(dialectFor('postgres').workloadRankings, undefined);
	// The app's own reads of the server (the Operations panel, progress) are not the user's workload.
	assert.match(digest(25)!, /AND NOT startsWith\(query, '\/\* snoutdata-ops \*\/'\)/);
});

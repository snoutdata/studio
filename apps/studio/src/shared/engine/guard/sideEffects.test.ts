/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { uncheckedCall, writingCall } from './sideEffects';

// A SELECT that changes something through a function it calls.
test('functions that change state are found, wherever they hide', () => {
	assert.equal(writingCall('SELECT pg_terminate_backend(pid) FROM pg_stat_activity'), 'pg_terminate_backend');
	assert.equal(writingCall("SELECT dblink_exec('dbname=x', 'DELETE FROM t')"), 'dblink_exec');
	assert.equal(writingCall("SELECT set_config('search_path', 'x', false)"), 'set_config');
	assert.equal(writingCall("SELECT lo_export(1, '/tmp/x')"), 'lo_export');
	assert.equal(writingCall("SELECT nextval('s')"), 'nextval');
	assert.equal(writingCall("SELECT pg_catalog.pg_cancel_backend(1)"), 'pg_cancel_backend');
	assert.equal(writingCall("SELECT query_to_xml('delete from t returning 1', true, false, '')"), 'query_to_xml');
	assert.equal(writingCall("SELECT utl_http.request('https://x') FROM dual", 'oracle'), 'utl_http.request');
	assert.equal(writingCall("SELECT GET_LOCK('a', 10)", 'mysql-aurora'), 'get_lock');
	assert.equal(writingCall('SELECT system$cancel_query(\'1\')', 'snowflake'), 'system$cancel_query');
	assert.equal(writingCall('SELECT "pg_terminate_backend"(1)'), 'pg_terminate_backend');
});

test('a name in a comment is not a call, nor a bare word in a string', () => {
	assert.equal(writingCall("SELECT 'pg_terminate_backend'"), undefined);
	assert.equal(writingCall('SELECT 1 -- pg_terminate_backend(1)'), undefined);
	assert.equal(writingCall('SELECT * FROM [dbo].[orders] (NOLOCK)', 'sqlserver'), undefined);
});

test('only known-pure built-ins run unasked', () => {
	assert.equal(uncheckedCall('SELECT count(*), lower(name), coalesce(a, 0) FROM t WHERE id IN (1, 2)'), undefined);
	assert.equal(uncheckedCall('SELECT CAST(x AS varchar(10)), date_trunc(\'day\', ts) FROM t'), undefined);
	assert.equal(uncheckedCall('SELECT archive_old_rows()'), 'archive_old_rows');
	assert.equal(uncheckedCall('SELECT pg_sleep(60)'), 'pg_sleep');
	assert.equal(uncheckedCall('SELECT SLEEP(60)', 'mysql-aurora'), 'sleep');
	assert.equal(uncheckedCall("SELECT * FROM url('https://x/?d=1', CSV)", 'clickhouse'), 'url');
	assert.equal(uncheckedCall('SELECT pg_terminate_backend(1)'), 'pg_terminate_backend');
});

// Snowflake files a SYSTEM$ function that acts under names that do not say so, so every one is a
// write unless it is on the short list that only reports.
test('every Snowflake SYSTEM$ call is a write unless it only reports', () => {
	for (const call of [
		"SYSTEM$TASK_DEPENDENTS_ENABLE('db.s.root_task')",
		"SYSTEM$ENABLE_BEHAVIOR_CHANGE_BUNDLE('2026_05')",
		"SYSTEM$DISABLE_BEHAVIOR_CHANGE_BUNDLE('2026_05')",
		"SYSTEM$GENERATE_SCIM_ACCESS_TOKEN('OKTA')",
		"SYSTEM$GLOBAL_ACCOUNT_SET_PARAMETER('org.acct', 'ENABLE_ACCOUNT_DATABASE_REPLICATION', 'true')",
		"SYSTEM$CLEANUP_DATABASE_ROLE_GRANTS('db.r', 'share')",
		"SYSTEM$AUTHORIZE_PRIVATELINK('123', 'token')",
		"SYSTEM$AUTHORIZE_STAGE_PRIVATELINK_ACCESS('x')",
		"SYSTEM$SOMETHING_NEW_NEXT_YEAR()",
	]) {
		assert.ok(writingCall(`SELECT ${call}`, 'snowflake'), call);
	}
});

test('the Snowflake SYSTEM$ functions that only report stay reads', () => {
	for (const call of [
		"SYSTEM$CLUSTERING_INFORMATION('t')",
		'SYSTEM$TYPEOF(1)',
		'SYSTEM$WHITELIST()',
		'SYSTEM$ALLOWLIST()',
		"SYSTEM$GET_TAG('db.s.tag', 't', 'table')",
		"SYSTEM$EXPLAIN_PLAN_JSON('select 1')",
		"SYSTEM$PIPE_STATUS('p')",
	]) {
		assert.equal(writingCall(`SELECT ${call}`, 'snowflake'), undefined, call);
	}
});

test('advancing a sequence is a write on every engine', () => {
	assert.equal(writingCall('SELECT my_seq.nextval FROM dual', 'oracle'), 'sequence NEXTVAL');
	assert.equal(writingCall('SELECT MY_SEQ.NEXTVAL', 'snowflake'), 'sequence NEXTVAL');
	assert.equal(writingCall('SELECT "S"."SEQ".NEXTVAL FROM DUMMY', 'hana'), 'sequence NEXTVAL');
	assert.equal(writingCall('SELECT NEXT VALUE FOR dbo.order_seq', 'sqlserver'), 'NEXT VALUE FOR');
	assert.equal(writingCall('VALUES NEXT VALUE FOR order_seq', 'db2'), 'NEXT VALUE FOR');
	assert.equal(writingCall('SELECT NEXTVAL FOR order_seq FROM sysibm.sysdummy1', 'db2'), 'NEXTVAL FOR');
	assert.equal(writingCall('SELECT NEXT VALUE FOR s', 'mariadb'), 'NEXT VALUE FOR');
	assert.equal(writingCall("SELECT setval('s', 1)"), 'setval');
	assert.equal(writingCall('SELECT NEXTVAL(s)', 'mariadb'), 'nextval');
	// Reading where a sequence is does not move it, and the words in a string move nothing.
	assert.equal(writingCall('SELECT my_seq.currval FROM dual', 'oracle'), undefined);
	assert.equal(writingCall("SELECT 'next value for x'", 'sqlserver'), undefined);
});

// A READ ONLY transaction does not stop an effect that lands outside the database.
test('calls that act outside the database are writes, schema-qualified or not', () => {
	assert.equal(writingCall("SELECT http_get('https://x')"), 'http_get');
	assert.equal(writingCall("SELECT extensions.http_post('https://x', 'b', 'text/plain')"), 'http_post');
	assert.equal(writingCall("SELECT net.http_post(url := 'https://x')"), 'net.http_post');
	assert.equal(writingCall("SELECT * FROM aws_lambda.invoke('f', '{}'::json)"), 'aws_lambda.invoke');
	assert.equal(writingCall("SELECT * FROM aws_s3.query_export_to_s3('SELECT 1', 'u')"), 'aws_s3.query_export_to_s3');
	assert.equal(writingCall("SELECT query_export_to_s3('SELECT 1', 'u')"), 'query_export_to_s3');
	assert.equal(writingCall("SELECT pg_background_launch('DELETE FROM t')"), 'pg_background_launch');
	assert.equal(writingCall("SELECT lambda_async('arn', '{}')", 'mysql-aurora'), 'lambda_async');
	assert.equal(writingCall("SELECT utl_mail.send('a', 'b') FROM dual", 'oracle'), 'utl_mail.send');
	// A schema of the same name elsewhere is not one of these.
	assert.equal(writingCall('SELECT reports.invoked_count(1)'), undefined);
	assert.equal(writingCall('SELECT network.http_status(1)'), undefined);
});

// Quoting a name hides it from a check that reads blanked text, so quoted names are read unquoted
// before any name is matched (an outside review, 2026-10-14).
test('a sequence advanced through quoted names is still a write', () => {
	for (const driver of ['snowflake', 'hana', 'oracle', 'db2', 'mariadb', undefined]) {
		assert.equal(writingCall('SELECT "SEQ1"."NEXTVAL"', driver), 'sequence NEXTVAL', String(driver));
		assert.equal(writingCall('SELECT SEQ1."NEXTVAL"', driver), 'sequence NEXTVAL', String(driver));
		assert.equal(writingCall('SELECT "S"."SEQ1"."nextval" FROM DUMMY', driver), 'sequence NEXTVAL', String(driver));
		assert.equal(writingCall('SELECT "SEQ1".NeXtVaL', driver), 'sequence NEXTVAL', String(driver));
	}
	assert.equal(writingCall('SELECT NEXT VALUE FOR "dbo"."order_seq"', 'sqlserver'), 'NEXT VALUE FOR');
	assert.equal(writingCall('SELECT NEXT VALUE FOR [dbo].[order_seq]', 'sqlserver'), 'NEXT VALUE FOR');
	assert.equal(writingCall('SELECT NEXTVAL FOR "ORDER_SEQ" FROM sysibm.sysdummy1', 'db2'), 'NEXTVAL FOR');
	assert.equal(writingCall('SELECT `s`.`nextval`', 'mariadb'), 'sequence NEXTVAL');
	// A quoted name with the words in it is one name, not the phrase.
	assert.equal(writingCall('SELECT "next value for" FROM t', 'sqlserver'), undefined);
	assert.equal(writingCall('SELECT "SEQ1"."CURRVAL"', 'snowflake'), undefined);
});

test('a function reached through a quoted schema or package is still found', () => {
	assert.equal(writingCall("SELECT \"aws_s3\".\"query_export_to_s3\"('SELECT 1', 'u')"), 'aws_s3.query_export_to_s3');
	assert.equal(writingCall("SELECT \"aws_s3\".some_export_shipped_next_year('u')"), 'aws_s3.some_export_shipped_next_year');
	assert.equal(writingCall("SELECT \"UTL_HTTP\".REQUEST('https://x') FROM dual", 'oracle'), 'utl_http.request');
	assert.equal(writingCall("SELECT \"SYS\".\"DBMS_LOCK\".SLEEP(5) FROM dual", 'oracle'), 'dbms_lock.sleep');
	assert.equal(writingCall("VALUES \"DB2MQ\".\"MQSEND\"('x')", 'db2'), 'db2mq.mqsend');
	assert.equal(writingCall("VALUES \"DB2MQ1C\".NEWFN('x')", 'db2'), 'db2mq1c.newfn');
	assert.equal(writingCall('SELECT "pg_catalog"."pg_ls_dir"(\'.\')'), 'pg_ls_dir');
	assert.equal(writingCall('SELECT "pg_ls_dir"(\'.\')'), 'pg_ls_dir');
	assert.equal(writingCall('SELECT `sys_exec`(\'x\')', 'mysql-aurora'), 'sys_exec');
	assert.equal(writingCall("SELECT [master].[dbo].[xp_cmdshell]('dir')", 'sqlserver'), 'xp_cmdshell');
	assert.equal(writingCall('SELECT "SYSTEM$CANCEL_ALL_QUERIES"(1)', 'snowflake'), 'system$cancel_all_queries');
	// A quoted name that is not a known function is still a call nobody can check.
	assert.equal(writingCall('SELECT "my_udf"(1)'), 'a function named in quotes');
	// A string that only names the schema is not a call.
	assert.equal(writingCall("SELECT 'aws_s3.query_export_to_s3'"), undefined);
});

test('a function named by IDENTIFIER(...) is not a read', () => {
	assert.equal(writingCall("SELECT IDENTIFIER('SYSTEM$CANCEL_ALL_QUERIES')(1)", 'snowflake'), 'a function named by IDENTIFIER');
	assert.equal(writingCall("SELECT identifier('my_udf') ( 1 )", 'snowflake'), 'a function named by IDENTIFIER');
	assert.equal(writingCall('SELECT IDENTIFIER($fn)(1)', 'snowflake'), 'a function named by IDENTIFIER');
	assert.equal(writingCall("SELECT * FROM TABLE(IDENTIFIER('my_udtf')(1))", 'snowflake'), 'a function named by IDENTIFIER');
	// IDENTIFIER naming a table or a column is a read.
	assert.equal(writingCall("SELECT * FROM IDENTIFIER('db.s.orders')", 'snowflake'), undefined);
	assert.equal(writingCall("SELECT IDENTIFIER('amount') FROM IDENTIFIER('t') WHERE id IN (1)", 'snowflake'), undefined);
	assert.equal(writingCall("SELECT * FROM TABLE('db.s.orders')", 'snowflake'), undefined);
});

test('reads that quote their table and column names stay reads', () => {
	for (const [sql, driver] of [
		['SELECT "Order Id", "t"."amount", count("x") FROM "public"."orders" AS "t" GROUP BY 1', undefined],
		['SELECT "NAME", "CURRVAL" FROM "S"."SEQUENCES"', 'hana'],
		['SELECT `id`, `name` FROM `db`.`users` WHERE `id` IN (1, 2)', 'mysql-aurora'],
		['SELECT [id], [name] FROM [dbo].[orders] (NOLOCK)', 'sqlserver'],
		['SELECT "ID" FROM "DB"."S"."T" WHERE "ID" > 1', 'snowflake'],
		['SELECT "a" FROM "t" WHERE "b" IN (1, 2)', 'oracle'],
	] as const) {
		assert.equal(writingCall(sql, driver), undefined, sql);
	}
	assert.equal(uncheckedCall('SELECT "Order Id", lower("name") FROM "public"."orders"'), undefined);
});

// A function that runs the SQL it is handed as a string runs whatever that string calls, and the
// checks above read strings blanked. So the known runners are refused by name, and in a read a
// refused call written inside ANY string is refused, whatever wrapper might run it.
test('a function that runs a query handed to it as a string is a write', () => {
	assert.equal(writingCall("SELECT * FROM ts_stat('select to_tsvector(body) from t')"), 'ts_stat');
	assert.equal(writingCall("SELECT ts_rewrite('a & b'::tsquery, 'select t, s from aliases')"), 'ts_rewrite');
	assert.equal(writingCall("SELECT * FROM crosstab('select a, b, c from t') AS ct(a text, b text)"), 'crosstab');
	assert.equal(writingCall("SELECT * FROM crosstab3('select a, b, c from t')"), 'crosstab3');
	assert.equal(writingCall("SELECT * FROM connectby('t', 'id', 'parent_id', '1', 0) AS c(id int, p int, l int)"), 'connectby');
	assert.equal(writingCall("SELECT * FROM xpath_table('id', 'doc', 'docs', '/a', 'true') AS x(id int, a text)"), 'xpath_table');
	assert.equal(writingCall("SELECT cursor_to_xml('c', 10, false, true, '')"), 'cursor_to_xml');
	assert.equal(writingCall("SELECT run_command_on_workers('select 1')"), 'run_command_on_workers');
	assert.equal(writingCall("SELECT DBMS_XMLGEN.getxml('select 1 from dual') FROM dual", 'oracle'), 'dbms_xmlgen.getxml');
	assert.equal(writingCall("SELECT sys.dbms_xmlgen.getxmltype('select 1 from dual') FROM dual", 'oracle'), 'dbms_xmlgen.getxmltype');
	assert.equal(writingCall('SELECT "DBMS_XMLGEN"."GETXML"(\'select 1 from dual\') FROM dual', 'oracle'), 'dbms_xmlgen.getxml');
	assert.equal(writingCall("SELECT DBMS_XMLQUERY.getxml('select 1 from dual') FROM dual", 'oracle'), 'dbms_xmlquery.getxml');
	assert.equal(writingCall('SELECT XMLTYPE(CURSOR(SELECT * FROM t)) FROM dual', 'oracle'), 'XMLTYPE(CURSOR)');
	assert.equal(writingCall('SELECT xmltype ( cursor ( SELECT 1 FROM dual ) ) FROM dual', 'oracle'), 'XMLTYPE(CURSOR)');
	assert.equal(writingCall("SELECT XMLQUERY('db2-fn:sqlquery(\"SELECT doc FROM t\")') FROM sysibm.sysdummy1", 'db2'), 'db2-fn:sqlquery');
	assert.equal(writingCall("SELECT * FROM XMLTABLE('db2-fn:sqlquery (\"SELECT doc FROM t\")' COLUMNS a INT PATH '/a') AS x", 'db2'), 'db2-fn:sqlquery');
	assert.equal(writingCall("SELECT 1 FROM t WHERE XMLEXISTS('DB2-FN:SQLQUERY(\"SELECT doc FROM t\")')", 'db2'), 'db2-fn:sqlquery');
	// The forms that only work on their arguments stay reads.
	assert.equal(writingCall("SELECT ts_rewrite('a & b'::tsquery, 'a'::tsquery, 'c'::tsquery)"), undefined);
	assert.equal(writingCall('SELECT XMLTYPE(doc) FROM t', 'oracle'), undefined);
	assert.equal(writingCall("SELECT XMLQUERY('$d/a' PASSING doc AS \"d\") FROM t", 'db2'), undefined);
});

test('a refused call inside any string is refused, whatever runs the string', () => {
	for (const [sql, driver, name] of [
		["SELECT my_runner('select pg_terminate_backend(1)')", undefined, 'pg_terminate_backend'],
		["SELECT f('select to_tsvector(dblink_exec(''dbname=app'',''DROP TABLE orders''))')", 'postgres', 'dblink_exec'],
		["SELECT f('select g(''select dblink_exec(''''a'''', ''''b'''')'')')", 'postgres', 'dblink_exec'],
		['SELECT f(\'select "pg_terminate_backend"(1)\')', 'postgres', 'pg_terminate_backend'],
		["SELECT f('select dblink_exec/* x */(1)')", 'postgres', 'dblink_exec'],
		["SELECT f(E'select \\x64blink_exec(1)')", 'postgres', 'dblink_exec'],
		["SELECT f(E'select dblink_exec(\\'a\\')')", 'postgres', 'dblink_exec'],
		["SELECT f(U&'select d\\0062link_exec(1)')", 'postgres', 'dblink_exec'],
		["SELECT f($$select dblink_exec('a', 'b')$$)", 'postgres', 'dblink_exec'],
		["SELECT f($q$select aws_lambda.invoke(1)$q$)", 'postgres', 'aws_lambda.invoke'],
		["SELECT f(q'[select utl_http.request('x') from dual]') FROM dual", 'oracle', 'utl_http.request'],
		["SELECT f('select utl_http.request(''http://evil.example/'') from dual') FROM dual", 'oracle', 'utl_http.request'],
		["SELECT f('select system$cancel_all_queries(1)')", 'snowflake', 'system$cancel_all_queries'],
		["SELECT f('select load_file(''/etc/passwd'')')", 'mariadb', 'LOAD_FILE'],
		['SELECT f("select sys_exec(\'id\')")', 'mariadb', 'sys_exec'],
		["SELECT * FROM t WHERE note = 'dblink_exec('", 'postgres', 'dblink_exec'],
	] as const) {
		assert.equal(writingCall(sql, driver), name, `${driver}: ${sql}`);
	}
});

test('strings that only mention a function stay reads', () => {
	for (const sql of [
		"SELECT * FROM t WHERE note = 'call dblink later'",
		"SELECT * FROM t WHERE note = 'it''s dblink time'",
		"SELECT * FROM t WHERE url LIKE 'https://%'",
		"SELECT format('%s(%s)', 'lower', 'x')",
		"SELECT 'lower(x)', 'count(*)'",
		// A catalog spells a serial column's default as a call; reading it is not running it, and
		// Postgres refuses nextval() in a read-only transaction whatever runs it.
		"SELECT * FROM information_schema.columns WHERE column_default LIKE 'nextval(%'",
		"SELECT * FROM information_schema.columns WHERE column_default LIKE '%.NEXTVAL'",
		"SELECT * FROM t WHERE note = 'the next value for the batch'",
	]) {
		assert.equal(writingCall(sql), undefined, sql);
		assert.equal(writingCall(sql, 'somedb'), undefined, sql);
	}
});

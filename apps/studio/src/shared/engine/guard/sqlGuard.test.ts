/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { destructiveStatement, guardReadings, guardStatements, readOnlyEscape } from './sqlGuard';

describe('destructiveStatement', () => {
	test('read-only queries are not destructive', () => {
		assert.equal(destructiveStatement('SELECT * FROM t'), undefined);
		assert.equal(destructiveStatement('  EXPLAIN SELECT * FROM t'), undefined);
		assert.equal(destructiveStatement('WITH x AS (SELECT 1) SELECT * FROM x'), undefined);
		assert.equal(destructiveStatement('SHOW TABLES'), undefined);
	});

	test('flags write/DDL verbs', () => {
		assert.equal(destructiveStatement('INSERT INTO t VALUES (1)')?.verb, 'INSERT');
		assert.equal(destructiveStatement('drop table t')?.verb, 'DROP');
		assert.equal(destructiveStatement('TRUNCATE t')?.verb, 'TRUNCATE');
		assert.equal(destructiveStatement('ALTER TABLE t ADD c int')?.verb, 'ALTER');
	});

	test('marks UPDATE/DELETE without WHERE as unfiltered', () => {
		assert.deepEqual(destructiveStatement('DELETE FROM t'), { verb: 'DELETE', unfiltered: true });
		assert.deepEqual(destructiveStatement('UPDATE t SET x = 1'), { verb: 'UPDATE', unfiltered: true });
	});

	test('UPDATE/DELETE with WHERE is filtered', () => {
		assert.deepEqual(destructiveStatement('DELETE FROM t WHERE id = 1'), { verb: 'DELETE', unfiltered: false });
		assert.deepEqual(destructiveStatement('UPDATE t SET x = 1 WHERE id = 2'), { verb: 'UPDATE', unfiltered: false });
	});

	test('catches a destructive statement after a leading read-only one', () => {
		assert.equal(destructiveStatement('SELECT 1; DROP TABLE t')?.verb, 'DROP');
	});
});

test('a ClickHouse mutation is the DELETE or UPDATE it performs', () => {
	assert.deepEqual(destructiveStatement('ALTER TABLE events DELETE WHERE ts < now() - INTERVAL 1 DAY'), { verb: 'DELETE', unfiltered: false });
	assert.deepEqual(destructiveStatement('ALTER TABLE shop.events ON CLUSTER default UPDATE kind = 1 WHERE id = 5'), { verb: 'UPDATE', unfiltered: false });
	// ClickHouse requires a WHERE on a mutation, so "every row" is written WHERE 1.
	assert.deepEqual(destructiveStatement('ALTER TABLE events DELETE WHERE 1'), { verb: 'DELETE', unfiltered: true });
	assert.deepEqual(destructiveStatement('ALTER TABLE events UPDATE kind = 0 WHERE true SETTINGS mutations_sync = 1'), { verb: 'UPDATE', unfiltered: true });
	// Other ALTERs are still ALTER.
	assert.deepEqual(destructiveStatement('ALTER TABLE events DROP PARTITION 202601'), { verb: 'ALTER', unfiltered: false });
});

test('a WHERE that holds for every row is no filter, on any engine', () => {
	assert.equal(destructiveStatement('DELETE FROM t WHERE 1 = 1')?.unfiltered, true);
	assert.equal(destructiveStatement('UPDATE t SET a = 1 WHERE (true)')?.unfiltered, true);
	assert.equal(destructiveStatement('DELETE FROM t WHERE 1 = 1 AND id = 5')?.unfiltered, false);
	assert.equal(destructiveStatement('UPDATE t SET a = (SELECT b FROM u WHERE 1 = 1)')?.unfiltered, false);
});

// The QA pass of 2026-10-01 ran every one of these on a project marked production, with no
// question asked by the dashboard or the server.
describe('a write that does not lead with its verb is still a write', () => {
	test('a data-modifying CTE is the write inside it', () => {
		assert.deepEqual(destructiveStatement('WITH gone AS (DELETE FROM t RETURNING *) SELECT count(*) FROM gone'), { verb: 'DELETE', unfiltered: true });
		assert.deepEqual(destructiveStatement('with g as (delete from t where id < 3 returning *) select * from g where 1 = 1'), { verb: 'DELETE', unfiltered: false });
		assert.equal(destructiveStatement('WITH n AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM n')?.verb, 'INSERT');
		assert.equal(destructiveStatement('WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT 1')?.unfiltered, true);
	});

	test('an opaque block, procedure or prepared statement is asked about', () => {
		assert.equal(destructiveStatement("DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$")?.verb, 'DO');
		assert.equal(destructiveStatement('do $body$ begin delete from t; end $body$')?.verb, 'DO');
		assert.equal(destructiveStatement('CALL purge_everything()')?.verb, 'CALL');
		assert.equal(destructiveStatement('EXECUTE stmt(1)')?.verb, 'EXECUTE');
	});

	test('a comment in front does not hide the verb', () => {
		assert.equal(destructiveStatement('/* tidy */ DROP TABLE t')?.verb, 'DROP');
		assert.equal(destructiveStatement('-- tidy\nDELETE FROM t')?.verb, 'DELETE');
		assert.equal(destructiveStatement('/* a /* nested */ one */ truncate t')?.verb, 'TRUNCATE');
		assert.equal(destructiveStatement('# mysql\nDROP TABLE t')?.verb, 'DROP');
	});

	test('EXPLAIN ANALYZE runs its statement; EXPLAIN does not', () => {
		assert.deepEqual(destructiveStatement('EXPLAIN ANALYZE DELETE FROM t'), { verb: 'DELETE', unfiltered: true });
		assert.equal(destructiveStatement('explain (analyze, buffers) update t set a = 1 where id = 2')?.verb, 'UPDATE');
		assert.equal(destructiveStatement('EXPLAIN DELETE FROM t'), undefined);
		assert.equal(destructiveStatement('EXPLAIN (ANALYZE false) DELETE FROM t'), undefined);
	});

	test('COPY FROM loads, SELECT INTO creates, and the schema-changing verbs count', () => {
		assert.equal(destructiveStatement("COPY t FROM '/tmp/x.csv'")?.verb, 'INSERT');
		assert.equal(destructiveStatement('COPY t TO STDOUT'), undefined);
		assert.equal(destructiveStatement('SELECT * INTO backup FROM t')?.verb, 'CREATE');
		assert.equal(destructiveStatement('SELECT * FROM t WHERE id IN (SELECT id FROM u)'), undefined);
		assert.equal(destructiveStatement("COMMENT ON TABLE t IS 'x'")?.verb, 'COMMENT');
		assert.equal(destructiveStatement('REFRESH MATERIALIZED VIEW v')?.verb, 'REFRESH');
	});

	test('a string or a comment can neither hide a statement nor invent one', () => {
		assert.equal(destructiveStatement("SELECT ';drop table t'"), undefined);
		assert.equal(destructiveStatement("SELECT 'it''s; drop table t'"), undefined);
		assert.equal(destructiveStatement('SELECT "delete" FROM t'), undefined);
		assert.equal(destructiveStatement("SELECT E'\\'; drop table t'"), undefined);
		assert.equal(destructiveStatement('SELECT $$; drop table t$$'), undefined);
		assert.equal(destructiveStatement("SELECT '--'; DROP TABLE t")?.verb, 'DROP');
		assert.equal(destructiveStatement('SELECT 1 # 2; DROP TABLE t')?.verb, 'DROP');
		assert.equal(destructiveStatement("SELECT '/*'; DROP TABLE t; SELECT '*/'")?.verb, 'DROP');
	});

	test('reads that only look like writes stay reads', () => {
		assert.equal(destructiveStatement('WITH x AS (SELECT * FROM t FOR UPDATE) SELECT * FROM x'), undefined);
		assert.equal(destructiveStatement('WITH x AS (SELECT * FROM t FOR NO KEY UPDATE) SELECT * FROM x'), undefined);
		assert.equal(destructiveStatement('SELECT inserted_at, updated_by FROM t'), undefined);
		assert.equal(destructiveStatement("SELECT data #> '{a,b}' FROM t"), undefined);
		assert.equal(destructiveStatement('SELECT $1::int'), undefined);
	});
});

// The guard reads a statement the way the connection's engine reads it, so what the server runs is
// what was judged.
describe('the SQL is read the way the connection\'s engine reads it', () => {
	test('MySQL executable comments are code', () => {
		assert.equal(destructiveStatement('/*!50000 DROP TABLE orders */', 'mysql-aurora')?.verb, 'DROP');
		assert.equal(destructiveStatement('/*M!100100 DROP TABLE orders */', 'mariadb')?.verb, 'DROP');
		assert.equal(destructiveStatement('WITH a AS (SELECT 1) /*!DELETE FROM orders*/ -- limit', 'mysql-aurora')?.verb, 'DELETE');
		assert.equal(destructiveStatement('SELECT 1 /*! ; DROP TABLE orders */', 'mariadb')?.verb, 'DROP');
		// An optimizer hint is still a comment.
		assert.equal(destructiveStatement('SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t', 'mysql-aurora'), undefined);
	});

	// TiDB runs `/*T! ... */` and `/*T![feature] ... */`, MariaDB `/*M! ... */`, and every MySQL-family
	// server a versioned `/*!NNNNN ... */` only when its version is high enough, so which of them a
	// server runs is not something the text says. A statement holding one is not a plain read.
	test('every executable comment form is code, and a gated one is never a plain read', () => {
		for (const driver of ['mysql-aurora', 'mariadb', 'some-new-driver']) {
			assert.equal(destructiveStatement('/*T! DELETE FROM orders WHERE EXISTS (*/ SELECT 1 /*T! ) */', driver)?.verb, 'DELETE', driver);
			assert.equal(destructiveStatement('/*T! INSERT INTO t2 */ SELECT * FROM t1', driver)?.verb, 'INSERT', driver);
			assert.ok(destructiveStatement("SELECT * FROM t /*T! INTO OUTFILE '/tmp/x' */", driver), driver);
			assert.equal(destructiveStatement('/*T![clustered_index] DROP TABLE orders */', driver)?.verb, 'DROP', driver);
			assert.equal(destructiveStatement('/*M! DROP TABLE orders */', driver)?.verb, 'DROP', driver);
			assert.equal(destructiveStatement('/*M!100100 DELETE FROM orders */ SELECT 1', driver)?.verb, 'DELETE', driver);
			// Gated forms run in combinations neither the code nor the comment reading is: here
			// MySQL skips the versioned one and runs the DELETE alone.
			assert.ok(destructiveStatement("SELECT 1 FROM t WHERE 'a' = /*!99999 'b' AND 1 IN (SELECT 1) OR 'c' = */ /*! (DELETE FROM orders) */", driver), driver);
			assert.ok(destructiveStatement('SELECT /*!40001 SQL_NO_CACHE */ * FROM t', driver), driver);
			assert.ok(destructiveStatement('SELECT 1 /*T![placement] */', driver), driver);
			assert.ok(destructiveStatement('SELECT 1 /*M!100500 */', driver), driver);
			// Hints and ordinary comments, a `!` in one included, are still comments.
			assert.equal(destructiveStatement('SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t', driver), undefined, driver);
			assert.equal(destructiveStatement('SELECT /* careful! */ * FROM t /* T! M! */', driver), undefined, driver);
			assert.equal(destructiveStatement("SELECT '/*T! DROP TABLE t */' FROM t", driver), undefined, driver);
			assert.equal(destructiveStatement('SELECT 1 -- /*T! DROP TABLE t */', driver), undefined, driver);
		}
	});

	test('an engine whose comments do not nest ends the comment at the first */', () => {
		for (const driver of ['mysql-aurora', 'oracle', 'sqlite', 'snowflake', 'clickhouse', 'db2']) {
			assert.equal(destructiveStatement('/* /* */ DROP TABLE orders', driver)?.verb, 'DROP', driver);
		}
		// Postgres nests, and so does the cloud copy's default.
		assert.equal(destructiveStatement('/* /* */ DROP TABLE orders */ SELECT 1'), undefined);
	});

	test('MySQL needs whitespace after --', () => {
		assert.equal(destructiveStatement('WITH a AS (SELECT 2 --1) DELETE FROM orders', 'mysql-aurora')?.verb, 'DELETE');
		assert.equal(destructiveStatement('SELECT 1 -- note\n', 'mysql-aurora'), undefined);
	});

	test('MySQL and Snowflake escape with a backslash in every string', () => {
		assert.equal(destructiveStatement("WITH a AS (SELECT '\\'') DELETE FROM orders -- '", 'mysql-aurora')?.verb, 'DELETE');
		assert.equal(destructiveStatement('WITH a AS (SELECT "\\"") DELETE FROM orders -- "', 'mariadb')?.verb, 'DELETE');
		assert.equal(destructiveStatement("SELECT '\\''; DROP TABLE orders; -- '", 'snowflake')?.verb, 'DROP');
		assert.equal(destructiveStatement("SELECT 'it\\'s fine' FROM t", 'mysql-aurora'), undefined);
	});

	test('SQL Server [bracketed] names are names', () => {
		assert.equal(destructiveStatement("SELECT 1 AS [x']; DROP TABLE orders; --']", 'sqlserver')?.verb, 'DROP');
		assert.equal(destructiveStatement('SELECT [delete], [drop table] FROM [orders]', 'sqlserver'), undefined);
	});

	test('Oracle q-quoted strings and Snowflake // comments', () => {
		assert.equal(destructiveStatement("SELECT q'[it's]' FROM dual", 'oracle'), undefined);
		assert.equal(destructiveStatement("SELECT q'[x]'; DROP TABLE orders", 'oracle')?.verb, 'DROP');
		assert.equal(destructiveStatement('SELECT 1 // a note\n; DROP TABLE orders', 'snowflake')?.verb, 'DROP');
	});

	test('an unknown driver is read every way there is', () => {
		assert.equal(destructiveStatement('/*!50000 DROP TABLE orders */', '')?.verb, 'DROP');
		assert.equal(destructiveStatement("SELECT 1 AS [x']; DROP TABLE orders; --']", 'some-new-engine')?.verb, 'DROP');
	});
});

// A statement is a read only when it is positively one; procedural wrappers and every other verb ask.
describe('anything not positively a read is asked about', () => {
	test('SQL Server batches: control flow and writes with no semicolon', () => {
		assert.deepEqual(destructiveStatement("IF OBJECT_ID('orders') IS NOT NULL DROP TABLE orders", 'sqlserver'), { verb: 'DROP', unfiltered: false });
		assert.deepEqual(destructiveStatement('BEGIN DELETE FROM orders END', 'sqlserver'), { verb: 'DELETE', unfiltered: true });
		assert.equal(destructiveStatement('DECLARE @n int DELETE FROM orders', 'sqlserver')?.verb, 'DELETE');
		assert.equal(destructiveStatement('SET NOCOUNT ON DELETE FROM orders', 'sqlserver')?.verb, 'DELETE');
		assert.equal(destructiveStatement('SELECT 1 DROP TABLE orders', 'sqlserver')?.verb, 'DROP');
		assert.equal(destructiveStatement("xp_cmdshell 'del c:\\x'", 'sqlserver')?.verb, 'XP_CMDSHELL');
		assert.equal(destructiveStatement("sp_rename 'a', 'b'", 'sqlserver')?.verb, 'SP_RENAME');
		assert.equal(destructiveStatement("SELECT * FROM OPENQUERY(srv, 'DELETE FROM t')", 'sqlserver')?.verb, 'OPENQUERY');
		assert.equal(destructiveStatement('DECLARE @n int', 'sqlserver')?.verb, 'DECLARE');
		// What stays a read.
		assert.equal(destructiveStatement('SET NOCOUNT ON', 'sqlserver'), undefined);
		assert.equal(destructiveStatement('SELECT TOP 10 * FROM sys.dm_exec_requests', 'sqlserver'), undefined);
		assert.equal(destructiveStatement('SELECT name, create_date FROM sys.objects', 'sqlserver'), undefined);
		assert.equal(destructiveStatement('BEGIN TRAN', 'sqlserver'), undefined);
		assert.equal(destructiveStatement('USE [shop]', 'sqlserver'), undefined);
	});

	test('PL/SQL and Snowflake Scripting blocks', () => {
		assert.equal(destructiveStatement("BEGIN EXECUTE IMMEDIATE 'DROP TABLE orders'; END; --", 'oracle')?.verb, 'BEGIN');
		assert.equal(destructiveStatement('DECLARE n NUMBER; BEGIN n := 1; END;', 'oracle')?.verb, 'DECLARE');
		assert.equal(destructiveStatement('BEGIN DELETE FROM orders; END;', 'snowflake')?.verb, 'BEGIN');
		assert.equal(destructiveStatement('BEGIN; SELECT 1; COMMIT', 'snowflake'), undefined);
	});

	test('the verbs nobody listed', () => {
		const cases: [string, string, string?][] = [
			['RENAME TABLE a TO b', 'RENAME', 'mysql-aurora'],
			["LOAD DATA INFILE '/x' INTO TABLE t", 'LOAD DATA', 'mysql-aurora'],
			['UPSERT INTO t VALUES (1)', 'UPSERT'],
			['UNDROP TABLE t', 'UNDROP', 'snowflake'],
			["BACKUP DATABASE d TO DISK = 'x'", 'BACKUP', 'sqlserver'],
			["RESTORE DATABASE d FROM DISK = 'x'", 'RESTORE', 'sqlserver'],
			['DBCC CHECKDB', 'DBCC', 'sqlserver'],
			['KILL 52', 'KILL', 'sqlserver'],
			['SHUTDOWN', 'SHUTDOWN', 'sqlserver'],
			['DENY SELECT ON t TO u', 'DENY', 'sqlserver'],
			["BULK INSERT t FROM 'x'", 'BULK INSERT', 'sqlserver'],
			['PURGE RECYCLEBIN', 'PURGE', 'oracle'],
			['RESET MASTER', 'RESET', 'mysql-aurora'],
			['FLUSH PRIVILEGES', 'FLUSH', 'mysql-aurora'],
			['SET GLOBAL read_only = 0', 'SET', 'mysql-aurora'],
			["SET PASSWORD = 'x'", 'SET', 'mysql-aurora'],
			['LOCK TABLES t WRITE', 'LOCK', 'mysql-aurora'],
			['LOCK TABLE t IN ACCESS EXCLUSIVE MODE', 'LOCK'],
			['VACUUM FULL t', 'VACUUM'],
			["LOAD 'auto_explain'", 'LOAD'],
			["ATTACH DATABASE 'x.db' AS x", 'ATTACH', 'sqlite'],
			['DETACH DATABASE x', 'DETACH', 'sqlite'],
			['PRAGMA journal_mode = DELETE', 'PRAGMA', 'sqlite'],
			['PRAGMA user_version(5)', 'PRAGMA', 'sqlite'],
			['SYSTEM DROP DNS CACHE', 'SYSTEM', 'clickhouse'],
			['EXCHANGE TABLES a AND b', 'EXCHANGE', 'clickhouse'],
			["PUT file:///x @stage", 'PUT', 'snowflake'],
			['REMOVE @stage/x', 'REMOVE', 'snowflake'],
			['OPTIMIZE TABLE t FINAL', 'OPTIMIZE', 'clickhouse'],
			['INSTALL httpfs', 'INSTALL', 'duckdb'],
		];
		for (const [sql, verb, driver] of cases) {
			assert.equal(destructiveStatement(sql, driver)?.verb, verb, sql);
		}
	});

	test('a SELECT INTO behind a WITH makes a table', () => {
		assert.equal(destructiveStatement('WITH x AS (SELECT 1 AS a) SELECT * INTO t FROM x')?.verb, 'CREATE');
		assert.equal(destructiveStatement('WITH x AS (SELECT a INTO y FROM t) SELECT * FROM x'), undefined);
	});

	test('COPY out of a write is the write', () => {
		assert.equal(destructiveStatement('COPY (DELETE FROM t RETURNING *) TO STDOUT')?.verb, 'DELETE');
	});

	test('session bookkeeping stays quiet', () => {
		for (const sql of ['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK TO SAVEPOINT a', 'SET search_path = public', 'RESET search_path', 'SHOW ALL', 'DISCARD ALL', '(SELECT 1) UNION (SELECT 2)', 'VALUES (1)', 'TABLE t']) {
			assert.equal(destructiveStatement(sql), undefined, sql);
		}
		for (const sql of ['SET NAMES utf8mb4', 'SET @x = 1', 'SET SESSION sql_mode = \'\'', 'USE shop']) {
			assert.equal(destructiveStatement(sql, 'mysql-aurora'), undefined, sql);
		}
		assert.equal(destructiveStatement('PRAGMA table_info(t)', 'sqlite'), undefined);
		assert.equal(destructiveStatement('PRAGMA user_version', 'sqlite'), undefined);
		assert.equal(destructiveStatement('USE WAREHOUSE wh', 'snowflake'), undefined);
	});
});

// A write nested inside a read is a write. Db2 has no read-only session, so on Db2
// this is the only thing between `SELECT * FROM OLD TABLE (DELETE FROM orders)` and the database,
// for the agent, the assistant, a read-only connection and the prod confirm alike.
describe('a write nested inside a read is the write', () => {
	test('Db2 data-change table references', () => {
		const cases: [string, string, boolean][] = [
			['SELECT * FROM OLD TABLE (DELETE FROM orders)', 'DELETE', true],
			['SELECT * FROM OLD TABLE(DELETE FROM orders WHERE id = 1)', 'DELETE', false],
			['select id from final table (update orders set status = 0)', 'UPDATE', true],
			['SELECT * FROM FINAL TABLE (UPDATE (SELECT * FROM orders) SET status = 0)', 'UPDATE', true],
			['SELECT id FROM NEW TABLE (INSERT INTO orders (id) VALUES (1))', 'INSERT', false],
			['SELECT * FROM FINAL TABLE (MERGE INTO orders o USING s ON o.id = s.id WHEN MATCHED THEN DELETE)', 'MERGE', false],
			['SELECT COUNT(*) FROM (SELECT * FROM OLD TABLE (DELETE FROM orders)) AS x', 'DELETE', true],
			['VALUES (SELECT COUNT(*) FROM OLD TABLE (DELETE FROM orders))', 'DELETE', true],
			['WITH x AS (SELECT 1 AS a FROM sysibm.sysdummy1) SELECT * FROM OLD TABLE (DELETE FROM orders)', 'DELETE', true],
			['(SELECT 1 FROM sysibm.sysdummy1) UNION ALL (SELECT 1 FROM OLD TABLE (DELETE FROM orders))', 'DELETE', true],
		];
		for (const [sql, verb, unfiltered] of cases) {
			for (const driver of ['db2', undefined, 'some-new-driver']) {
				assert.deepEqual(destructiveStatement(sql, driver), { verb, unfiltered }, `${driver}: ${sql}`);
			}
		}
	});

	test('a comment or a line break between the parenthesis and the verb hides nothing', () => {
		for (const sql of [
			'SELECT * FROM OLD TABLE (/* tidy */ DELETE FROM orders)',
			'SELECT * FROM OLD TABLE (-- tidy\nDELETE FROM orders)',
			'SELECT * FROM OLD TABLE (\n\tDELETE\n\tFROM orders\n)',
			'SELECT * FROM OLD TABLE (/* a /* nested */ b */ DELETE FROM orders)',
			"SELECT 'x' AS note FROM OLD TABLE (DELETE FROM orders) -- ')'",
			'SELECT * FROM OLD TABLE ("ORDERS" IS NULL OR DELETE FROM orders)',
		]) {
			assert.equal(destructiveStatement(sql, 'db2')?.verb, 'DELETE', sql);
		}
	});

	test('Postgres: a data-modifying CTE, MERGE in a CTE, a WITH in front of the write', () => {
		assert.equal(destructiveStatement('WITH m AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING t.*) SELECT * FROM m')?.verb, 'MERGE');
		assert.equal(destructiveStatement('WITH a AS (WITH b AS (SELECT 1) DELETE FROM t RETURNING *) SELECT * FROM a')?.verb, 'DELETE');
		assert.equal(destructiveStatement('WITH a AS NOT MATERIALIZED (/* x */ UPDATE t SET a = 1 RETURNING *) SELECT 1')?.verb, 'UPDATE');
		assert.equal(destructiveStatement('WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)')?.verb, 'DELETE');
		assert.equal(destructiveStatement('WITH x AS (SELECT 1) TRUNCATE t')?.verb, 'TRUNCATE');
		assert.equal(destructiveStatement('COPY (UPDATE t SET a = 1 RETURNING *) TO STDOUT')?.verb, 'UPDATE');
		assert.equal(destructiveStatement('COPY (INSERT INTO t VALUES (1) RETURNING *) TO STDOUT')?.verb, 'INSERT');
		assert.equal(destructiveStatement("COPY t TO PROGRAM 'rm -rf /tmp/x'")?.verb, 'COPY');
		assert.equal(destructiveStatement("COPY t TO '/tmp/t.csv'", 'duckdb')?.verb, 'COPY');
		assert.equal(destructiveStatement('COPY (SELECT * FROM t) TO STDOUT'), undefined);
	});

	test('SQL Server composable DML and OUTPUT, Oracle WITH FUNCTION', () => {
		assert.equal(destructiveStatement('INSERT INTO history SELECT * FROM (DELETE FROM orders OUTPUT deleted.*) AS d', 'sqlserver')?.verb, 'INSERT');
		assert.equal(destructiveStatement('SELECT * FROM (DELETE FROM orders OUTPUT deleted.*) AS d', 'sqlserver')?.verb, 'DELETE');
		assert.equal(destructiveStatement('WITH x AS (SELECT 1 AS a) MERGE orders AS o USING x ON 1 = 0 WHEN NOT MATCHED THEN INSERT (id) VALUES (1);', 'sqlserver')?.verb, 'MERGE');
		assert.equal(destructiveStatement('WITH FUNCTION f RETURN NUMBER IS BEGIN DELETE FROM orders; RETURN 1; END; SELECT f FROM dual', 'oracle')?.verb, 'DELETE');
	});

	test('MySQL and the others: a nested write in a subquery is still judged', () => {
		for (const driver of ['mysql-aurora', 'mariadb', 'sqlite', 'snowflake', 'clickhouse', 'hana', 'duckdb', 'redshift', 'oracle']) {
			assert.equal(destructiveStatement('SELECT * FROM (DELETE FROM t RETURNING *) x', driver)?.verb, 'DELETE', driver);
		}
		// MySQL runs the inside of an executable comment, so a write there is nested code.
		assert.equal(destructiveStatement('SELECT * FROM t WHERE id IN (/*!DELETE FROM t*/ SELECT 1)', 'mysql-aurora')?.verb, 'DELETE');
	});

	test('reads that only look like a nested write stay reads', () => {
		const reads: [string, string | undefined][] = [
			["SELECT * FROM t WHERE note = 'OLD TABLE (DELETE FROM orders)'", 'db2'],
			['SELECT "DELETE", "UPDATE" FROM t', 'db2'],
			['SELECT * FROM t /* FINAL TABLE (UPDATE t SET a = 1) */', 'db2'],
			["SELECT replace(name, 'a', 'b') FROM t", undefined],
			["SELECT (replace(name, 'a', 'b')) AS n FROM t", undefined],
			["WITH x AS (SELECT replace(name, 'a', 'b') AS n FROM t) SELECT * FROM x", undefined],
			["SELECT insert(name, 1, 2, 'x') FROM t", 'mysql-aurora'],
			['SELECT * FROM (SELECT * FROM t FOR UPDATE) x', undefined],
			['SELECT * FROM (SELECT * FROM t FOR UPDATE OF t SKIP LOCKED) x', undefined],
			['SELECT * FROM (SELECT * FROM t WITH RS USE AND KEEP UPDATE LOCKS) x', 'db2'],
			['SELECT * FROM (SELECT merge, a FROM t) x', undefined],
			['SELECT * FROM (SELECT t.update FROM t) x', undefined],
			['SELECT * FROM (SELECT a AS delete FROM t) x', undefined],
			['SELECT count(update) FROM t', undefined],
			['SELECT deleted_at, updated_by, create_time FROM (SELECT * FROM t) x', undefined],
			['VALUES (1), (2)', undefined],
		];
		for (const [sql, driver] of reads) {
			assert.equal(destructiveStatement(sql, driver), undefined, sql);
		}
	});
});

// Snowflake's `->>` flow operator runs the statement after it, so the guard splits on it the way it
// splits on `;`, and an anonymous procedure is the CALL it is.
test('Snowflake: a statement after ->> is judged, and WITH ... AS PROCEDURE is a CALL', () => {
	assert.equal(destructiveStatement('SHOW TABLES ->> DROP TABLE orders', 'snowflake')?.verb, 'DROP');
	assert.equal(destructiveStatement('SELECT 1 ->> DELETE FROM orders', 'snowflake')?.verb, 'DELETE');
	assert.equal(destructiveStatement('SHOW TABLES /* x */ ->> // y\n DROP TABLE orders', 'snowflake')?.verb, 'DROP');
	assert.equal(destructiveStatement("SELECT '->> DROP TABLE orders'", 'snowflake'), undefined);
	assert.equal(
		destructiveStatement("WITH p AS PROCEDURE () RETURNS VARCHAR LANGUAGE SQL AS $$ begin drop table orders; end $$ CALL p()", 'snowflake')?.verb,
		'CALL',
	);
	assert.deepEqual(guardStatements('SHOW TABLES ->> SELECT 1', 'snowflake').includes('SELECT 1'), true);
	// Postgres's ->> is a JSON operator, not a separator.
	assert.equal(destructiveStatement("SELECT data->>'k' FROM t", 'postgres'), undefined);
	assert.deepEqual(guardStatements("SELECT data->>'k' FROM t", 'postgres'), ["SELECT data->>' ' FROM t"]);
});

// T-SQL needs no `;` between statements, so a COMMIT inside what reads as a SELECT ends the
// read-only run's transaction and whatever follows it autocommits. Found by an outside review on
// 2026-10-14: every one of these passed as a read.
describe('SQL Server: a statement after a COMMIT with no semicolon', () => {
	test('transaction control inside a read is not a read', () => {
		const cases: [string, string][] = [
			['SELECT 1 AS n COMMIT DISABLE TRIGGER trg_audit ON dbo.orders', 'COMMIT'],
			['SELECT 1 AS n COMMIT ENABLE TRIGGER ALL ON dbo.orders', 'COMMIT'],
			['SELECT 1 AS n COMMIT RECEIVE TOP (1) * FROM dbo.q', 'COMMIT'],
			["SELECT 1 AS n COMMIT DECLARE @p varbinary(16) WRITETEXT dbo.t.c @p 'x'", 'COMMIT'],
			['SELECT 1 ROLLBACK SELECT 2', 'ROLLBACK'],
			['SELECT 1 SAVE TRANSACTION s', 'SAVE TRANSACTION'],
			['SELECT 1 BEGIN TRAN', 'BEGIN TRAN'],
			['SELECT 1 BEGIN DISTRIBUTED TRANSACTION', 'BEGIN DISTRIBUTED TRANSACTION'],
			['COMMIT', 'COMMIT'],
			['ROLLBACK TRANSACTION', 'ROLLBACK'],
		];
		for (const [sql, verb] of cases) {
			assert.equal(destructiveStatement(sql, 'sqlserver')?.verb, verb, sql);
			assert.equal(destructiveStatement(sql, 'some-new-engine')?.verb, verb, sql);
		}
	});

	test('statements that act without a write verb, anywhere in a batch', () => {
		const cases: [string, string][] = [
			['SELECT 1 DISABLE TRIGGER trg_audit ON dbo.orders', 'DISABLE TRIGGER'],
			['SELECT 1 ENABLE TRIGGER ALL ON DATABASE', 'ENABLE TRIGGER'],
			['SELECT 1 RECEIVE TOP (1) * FROM dbo.q', 'RECEIVE'],
			["DECLARE @p varbinary(16) WRITETEXT dbo.t.c @p 'x'", 'WRITETEXT'],
			["SELECT 1 UPDATETEXT dbo.t.c @p 0 NULL 'x'", 'UPDATETEXT'],
			["SELECT 1 SEND ON CONVERSATION @h ('x')", 'SEND ON CONVERSATION'],
			['SELECT 1 END CONVERSATION @h', 'END CONVERSATION'],
			['SELECT 1 BEGIN DIALOG @h FROM SERVICE a TO SERVICE \'b\'', 'BEGIN DIALOG'],
			['SELECT 1 CHECKPOINT', 'CHECKPOINT'],
		];
		for (const [sql, verb] of cases) {
			assert.equal(destructiveStatement(sql, 'sqlserver')?.verb, verb, sql);
		}
	});

	test('what stays a read', () => {
		for (const sql of [
			'BEGIN TRAN',
			'BEGIN TRANSACTION',
			'SELECT [commit], [receive] FROM [log]',
			'SELECT l.receive, l.receive AS received FROM dbo.log AS l',
			"SELECT 'COMMIT DISABLE TRIGGER t ON x' AS s",
			'SELECT 1 -- COMMIT\n',
		]) {
			assert.equal(destructiveStatement(sql, 'sqlserver'), undefined, sql);
		}
	});

	test('other engines keep their transaction control', () => {
		assert.equal(destructiveStatement('BEGIN; SELECT 1; COMMIT', 'postgres'), undefined);
		assert.equal(destructiveStatement('COMMIT', 'mysql-aurora'), undefined);
	});
});

// A database or a role can turn standard_conforming_strings off, and then a backslash escapes a
// quote in a PLAIN string too. Read by the on-rules alone, `'a\', '` is two strings with a comma
// between them; the server reads one string, and what the guard took for a second string is code.
// Found by an outside review on 2026-10-14, which deleted rows through a read-only run on a local
// Postgres 17. So Postgres-family text is lexed by both rules and the worse answer is taken.
describe('Postgres: a backslash-escaped quote under standard_conforming_strings = off', () => {
	const hidden = [
		"SELECT 'a\\', '; DELETE FROM t; --'",
		"SELECT 'a\\', '; SET default_transaction_read_only = off; COMMIT; DELETE FROM t; --'",
		"SELECT E'x\\\\', 'a\\', '; DELETE FROM t; --'",
		"SELECT * FROM t WHERE p = 'C:\\' OR q = '; DROP TABLE t; --'",
	];

	test('a statement only the off-rules see is judged', () => {
		for (const driver of [undefined, 'postgres', 'redshift']) {
			for (const sql of hidden) {
				assert.ok(destructiveStatement(sql, driver), `${driver}: ${sql}`);
			}
		}
	});

	test('both readings are taken, and a string is still a string under each', () => {
		assert.equal(guardReadings("SELECT 'a\\', 'b'", 'postgres').length, 2);
		assert.equal(destructiveStatement("SELECT E'\\'; drop table t'", 'postgres'), undefined);
		assert.equal(destructiveStatement("SELECT 'it''s; drop table t'", 'postgres'), undefined);
		assert.equal(destructiveStatement("SELECT 'C:\\temp\\file' FROM t", 'postgres'), undefined);
	});
});

// The read-only run's transaction, and the session default behind it, are what the database-side
// layer is. A read that ends the one or switches off the other has stepped out of it.
describe('readOnlyEscape', () => {
	test('transaction control inside a read', () => {
		const cases: [string, string][] = [
			['SELECT 1; COMMIT', 'COMMIT'],
			['SELECT 1; END', 'END'],
			['SELECT 1; END TRANSACTION', 'END'],
			['SELECT 1; ABORT', 'ABORT'],
			['SELECT 1; ROLLBACK', 'ROLLBACK'],
			['SELECT 1; START TRANSACTION READ WRITE', 'START TRANSACTION'],
			['SELECT 1; BEGIN', 'BEGIN'],
			["SELECT 1; PREPARE TRANSACTION 'x'", 'PREPARE TRANSACTION'],
			["SELECT 1; COMMIT PREPARED 'x'", 'COMMIT'],
			['SELECT 1; SAVEPOINT s', 'SAVEPOINT'],
		];
		for (const [sql, verb] of cases) {
			assert.equal(readOnlyEscape(sql, 'postgres'), verb, sql);
		}
	});

	test('a setting that turns read-only off, on every engine', () => {
		const cases: [string, string | undefined][] = [
			['SET default_transaction_read_only = off', 'postgres'],
			['SET SESSION default_transaction_read_only TO off', 'postgres'],
			['set local transaction_read_only = off', 'postgres'],
			['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'postgres'],
			['SET TRANSACTION READ WRITE', 'postgres'],
			['RESET default_transaction_read_only', 'postgres'],
			['RESET ALL', 'postgres'],
			['DISCARD ALL', 'postgres'],
			["SELECT set_config('default_transaction_read_only', 'off', false)", 'postgres'],
			["SELECT pg_catalog.set_config('transaction_read_only', 'off', true)", undefined],
			['SET SESSION TRANSACTION READ WRITE', 'mysql-aurora'],
			['SET @@session.transaction_read_only = 0', 'mysql-aurora'],
			['SET tx_read_only = 0', 'mariadb'],
		];
		for (const [sql, driver] of cases) {
			assert.ok(readOnlyEscape(sql, driver), sql);
		}
	});

	test('a hidden escape under the off-rules is found too', () => {
		assert.ok(readOnlyEscape("SELECT 'a\\', '; SET default_transaction_read_only = off; END; --'", 'postgres'));
	});

	test('reads and harmless settings are not escapes', () => {
		for (const sql of [
			'SELECT 1',
			"SET statement_timeout = '5s'",
			'SET search_path TO app',
			"SELECT 'commit; end'",
			'SELECT end_date, begin_at FROM t',
			"SELECT current_setting('transaction_read_only')",
			'SHOW transaction_read_only',
		]) {
			assert.equal(readOnlyEscape(sql, 'postgres'), undefined, sql);
		}
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { readOnlyError } from '../context/tools';
import { writingCall } from './sideEffects';
import { destructiveStatement, guardStatements, serverFileAccess } from './sqlGuard';

// A statement that reaches a file on the database server is never a read, whatever it leads with
// and on whatever engine it is read for. Every case is run through both gates for every driver the
// guard knows, plus none (Postgres) and an unknown one: the prod confirm and read-only hard block
// (`destructiveStatement`), and the agent's and the assistant's read check (`readOnlyError`).

const DRIVERS: (string | undefined)[] = [undefined, 'postgres', 'redshift', 'duckdb', 'mysql-aurora', 'mariadb', 'sqlserver', 'oracle', 'sqlite', 'snowflake', 'clickhouse', 'db2', 'hana', 'mongodb', 'pinecone', 'some-new-driver'];

const CORPUS: [string, string][] = [
	// MySQL 8's TABLE and VALUES statements take INTO OUTFILE/DUMPFILE as a SELECT does.
	["TABLE orders INTO OUTFILE '/var/lib/mysql-files/o.csv'", 'INTO OUTFILE'],
	["TABLE orders INTO DUMPFILE '/tmp/o.bin'", 'INTO DUMPFILE'],
	["VALUES ROW(1, 'a'), ROW(2, 'b') INTO OUTFILE '/tmp/v.csv'", 'INTO OUTFILE'],
	["VALUES ROW(1) INTO DUMPFILE '/tmp/v.bin'", 'INTO DUMPFILE'],
	["TABLE orders ORDER BY id LIMIT 10 INTO OUTFILE '/tmp/o.csv' FIELDS TERMINATED BY ','", 'INTO OUTFILE'],
	["SELECT * FROM orders INTO OUTFILE '/tmp/o.csv'", 'INTO OUTFILE'],
	["SELECT payload FROM blobs LIMIT 1 INTO DUMPFILE '/tmp/b.bin'", 'INTO DUMPFILE'],
	["(SELECT 1) UNION (SELECT 2) INTO OUTFILE '/tmp/u.csv'", 'INTO OUTFILE'],
	["WITH x AS (SELECT 1) SELECT * FROM x INTO OUTFILE '/tmp/x.csv'", 'INTO OUTFILE'],
	["SELECT 1 UNION TABLE orders INTO OUTFILE '/tmp/t.csv'", 'INTO OUTFILE'],
	["select *\nfrom orders\ninto\toutfile '/tmp/o.csv'", 'INTO OUTFILE'],
	["SELECT * FROM orders INTO/* a comment */OUTFILE '/tmp/o.csv'", 'INTO OUTFILE'],
	["EXPLAIN TABLE orders INTO OUTFILE '/tmp/o.csv'", 'INTO OUTFILE'],
	["SHOW TABLES; TABLE orders INTO OUTFILE '/tmp/o.csv'", 'INTO OUTFILE'],
	// MySQL reads a server (or client) file.
	["LOAD DATA INFILE '/etc/passwd' INTO TABLE t", 'LOAD DATA'],
	["LOAD DATA LOCAL INFILE '/home/me/.ssh/id_rsa' INTO TABLE t", 'LOAD DATA'],
	["LOAD XML INFILE '/tmp/x.xml' INTO TABLE t", 'LOAD XML'],
	["SELECT LOAD_FILE('/etc/passwd')", 'LOAD_FILE'],
	["SELECT id FROM t WHERE note = LOAD_FILE('/etc/hosts')", 'LOAD_FILE'],
	["VALUES ROW(load_file('/etc/passwd'))", 'LOAD_FILE'],
	// Postgres: large objects and the admin file functions.
	["SELECT lo_export(16409, '/tmp/out.bin')", 'LO_EXPORT'],
	["SELECT lo_import('/etc/passwd')", 'LO_IMPORT'],
	["SELECT pg_file_write('/tmp/x', 'data', false)", 'PG_FILE_WRITE'],
	["SELECT pg_read_file('/etc/passwd')", 'PG_READ_FILE'],
	["SELECT pg_read_binary_file('postgresql.auto.conf')", 'PG_READ_BINARY_FILE'],
	["WITH f AS (SELECT pg_catalog.pg_read_file('pg_hba.conf') AS body) SELECT body FROM f", 'PG_READ_FILE'],
	// SQL Server.
	["SELECT * FROM OPENROWSET(BULK 'C:\\secrets.txt', SINGLE_CLOB) AS f", 'OPENROWSET'],
	["SELECT 1 EXEC xp_cmdshell 'whoami'", 'XP_CMDSHELL'],
	["SELECT 1; EXEC master..xp_cmdshell 'dir'", 'XP_CMDSHELL'],
	["SELECT 1; BULK INSERT t FROM 'C:\\data.csv'", 'BULK INSERT'],
	["DECLARE @o INT; EXEC sp_OACreate 'Scripting.FileSystemObject', @o OUT", 'SP_OACREATE'],
	// Oracle.
	["SELECT DBMS_LOB.GETLENGTH(BFILENAME('DATA_PUMP_DIR', 'x.dmp')) FROM dual", 'BFILENAME'],
	["SELECT UTL_FILE.FOPEN('DIR', 'f.txt', 'w') FROM dual", 'UTL_FILE.FOPEN'],
	// SQLite (the CLI's fileio extension, and extensions themselves).
	["SELECT writefile('/tmp/x', 'data')", 'WRITEFILE'],
	["SELECT readfile('/etc/passwd')", 'READFILE'],
	["SELECT load_extension('/tmp/evil.so')", 'LOAD_EXTENSION'],
];

describe('a statement that reaches a file on the database server is never a read', () => {
	test('serverFileAccess names what it does', () => {
		for (const [sql, verb] of CORPUS) {
			const found = guardStatements(sql, 'some-new-driver').map(serverFileAccess).find(Boolean);
			assert.equal(found, verb, sql);
		}
	});

	test('the prod confirm and the read-only block refuse it on every engine', () => {
		for (const driver of DRIVERS) {
			for (const [sql] of CORPUS) {
				assert.ok(destructiveStatement(sql, driver), `${driver ?? '(none)'}: ${sql}`);
			}
		}
	});

	test('the agent and the assistant cannot run it as a read on any engine', () => {
		for (const driver of DRIVERS) {
			for (const [sql] of CORPUS) {
				assert.ok(readOnlyError(sql, driver), `${driver ?? '(none)'}: ${sql}`);
			}
		}
		assert.match(readOnlyError("TABLE orders INTO OUTFILE '/tmp/o.csv'", 'mysql-aurora') ?? '', /file on the database server \(INTO OUTFILE\)/);
	});

	test('the words in a string, a comment or a name are not a file', () => {
		for (const driver of DRIVERS) {
			for (const sql of [
				"SELECT 'TABLE t INTO OUTFILE /tmp/x' AS note",
				'SELECT 1 -- INTO OUTFILE\n',
				'SELECT 1 /* LOAD_FILE(x) */',
				'SELECT outfile, dumpfile FROM exports',
				'SELECT file_name, load_date FROM loads',
				'SELECT pg_size_pretty(pg_total_relation_size(1))',
				'TABLE orders',
				'VALUES (1), (2)',
			]) {
				assert.equal(destructiveStatement(sql, driver), undefined, `${driver ?? '(none)'}: ${sql}`);
			}
		}
	});
});

describe('resetting what the server keeps about itself is a write', () => {
	test('statistics, slots, buffers and backups are refused as reads', () => {
		for (const [sql, name] of [
			['SELECT pg_stat_statements_reset()', 'pg_stat_statements_reset'],
			['SELECT pg_stat_statements_reset(0, 0, 0)', 'pg_stat_statements_reset'],
			['SELECT pg_stat_reset()', 'pg_stat_reset'],
			['SELECT pg_stat_reset_shared(\'bgwriter\')', 'pg_stat_reset_shared'],
			['SELECT pg_stat_monitor_reset()', 'pg_stat_monitor_reset'],
			['SELECT pg_buffercache_evict(1)', 'pg_buffercache_evict'],
			["SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)", 'pg_logical_slot_get_changes'],
			["SELECT pg_backup_start('x')", 'pg_backup_start'],
			["SELECT pg_notify('c', 'p')", 'pg_notify'],
		] as const) {
			assert.equal(writingCall(sql, 'postgres'), name, sql);
			assert.match(readOnlyError(sql, 'postgres') ?? '', /changes the database/, sql);
		}
		assert.equal(writingCall("SELECT * FROM pg_logical_slot_peek_changes('s', NULL, NULL)", 'postgres'), undefined);
	});
});

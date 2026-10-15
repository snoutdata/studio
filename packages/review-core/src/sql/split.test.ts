/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { maskSql, MYSQL_LEX, ORACLE_LEX, POSTGRES_LEX, SQLSERVER_LEX } from './mask.js';
import { singleStatementRefusal, splitStatements } from './split.js';

const sqls = (text: string, rules = POSTGRES_LEX): string[] => splitStatements(text, rules).map((s) => s.sql);

describe('statements split the way each vendor lexes', () => {
	test('Postgres: a backslash in a standard string escapes nothing', () => {
		assert.deepEqual(sqls("SELECT 'a\\'; DROP TABLE users; -- '"), ["SELECT 'a\\';", 'DROP TABLE users;', "-- '"]);
	});

	test('Postgres: an E string does take the backslash as an escape', () => {
		assert.deepEqual(sqls("SELECT E'a\\'; b'; SELECT 2"), ["SELECT E'a\\'; b';", 'SELECT 2']);
		// `e` closing a word is not the prefix.
		assert.deepEqual(sqls("SELECT name'a\\'; SELECT 2"), ["SELECT name'a\\';", 'SELECT 2']);
	});

	test('Postgres: a backslash in a quoted name escapes nothing', () => {
		assert.deepEqual(sqls('SELECT "a\\"; DROP TABLE users'), ['SELECT "a\\";', 'DROP TABLE users']);
	});

	test('Postgres: a dollar-quoted body is one string, and $1 is not a quote', () => {
		const fn = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql; SELECT $1";
		assert.deepEqual(sqls(fn), ["CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql;", 'SELECT $1']);
	});

	test('MySQL: the backslash is an escape in both string forms, and --x is not a comment', () => {
		assert.deepEqual(sqls("SELECT 'a\\'; b'; SELECT 2", MYSQL_LEX), ["SELECT 'a\\'; b';", 'SELECT 2']);
		assert.deepEqual(sqls('SELECT 1 --x; SELECT 2', MYSQL_LEX), ['SELECT 1 --x;', 'SELECT 2']);
		assert.deepEqual(sqls('SELECT 1 # ; not a statement\nFROM t', MYSQL_LEX), ['SELECT 1 # ; not a statement\nFROM t']);
	});

	test('SQL Server and Oracle: no backslash escapes; Oracle q-quotes are one string', () => {
		assert.deepEqual(sqls("SELECT 'a\\'; SELECT [x;y]", SQLSERVER_LEX), ["SELECT 'a\\';", 'SELECT [x;y]']);
		assert.deepEqual(sqls("SELECT q'[it's; here]' FROM dual; SELECT 2 FROM dual", ORACLE_LEX), ["SELECT q'[it's; here]' FROM dual;", 'SELECT 2 FROM dual']);
	});

	test('with no rules named, the legacy reading is unchanged', () => {
		assert.deepEqual(splitStatements("SELECT 'a\\'; b'; SELECT 2").map((s) => s.sql), ["SELECT 'a\\'; b';", 'SELECT 2']);
		assert.equal(maskSql("'x").unterminated, true);
		assert.equal(maskSql("'x'").unterminated, false);
	});
});

describe('singleStatementRefusal', () => {
	test('one ordinary statement passes, with or without its terminator', () => {
		assert.equal(singleStatementRefusal("SELECT id FROM orders WHERE note = 'a;b'"), undefined);
		assert.equal(singleStatementRefusal('SELECT 1; -- done'), undefined);
		assert.equal(singleStatementRefusal('UPDATE t SET a = 1 WHERE "b;c" = 2;'), undefined);
	});

	test('anything some vendor could read as a second statement is refused', () => {
		const refused = [
			"SELECT 'a\\'; DROP TABLE users; -- '", // backslash read two ways
			"SELECT 'a\\';", // unterminated under backslash escapes
			'SELECT "a\\"; DROP TABLE users; --"',
			"SELECT $$ ' $$; DROP TABLE users; --'", // a dollar quote hides the quote
			'SELECT 1 --x; DROP TABLE users', // MySQL needs a space after --
			"SELECT q'!'!' ; DROP TABLE x; --' FROM dual", // Oracle alternative quoting
			'SELECT 1 /*! ; DROP TABLE users */', // MySQL runs executable comments
			'SELECT 1 /*M! ; DROP TABLE users */', // and MariaDB its own
			'SELECT 1 /*T! ; DROP TABLE users */', // and TiDB its own
			'SELECT 1 /*T![clustered_index] ; DROP TABLE users */',
			'SELECT 1 /* never closed',
			'SELECT 1; SELECT 2',
		];
		for (const sql of refused) {
			assert.ok(singleStatementRefusal(sql), sql);
		}
	});
});

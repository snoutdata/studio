/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { containsSqlSecret, redactSqlSecrets, REDACTED_SECRET } from './redact';

describe('redactSqlSecrets', () => {
	it('leaves ordinary SQL untouched', () => {
		const sql = 'SELECT id, name FROM users WHERE id = 1';
		assert.equal(redactSqlSecrets(sql), sql);
		assert.equal(containsSqlSecret(sql), false);
	});

	it('redacts a MySQL IDENTIFIED BY password', () => {
		assert.equal(
			redactSqlSecrets("CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2'"),
			`CREATE USER 'app'@'%' IDENTIFIED BY ${REDACTED_SECRET}`,
		);
	});

	it('redacts a MySQL IDENTIFIED WITH plugin BY password', () => {
		assert.equal(
			redactSqlSecrets("ALTER USER 'a'@'%' IDENTIFIED WITH caching_sha2_password BY 'p@ss'"),
			`ALTER USER 'a'@'%' IDENTIFIED WITH caching_sha2_password BY ${REDACTED_SECRET}`,
		);
	});

	it('redacts a Postgres PASSWORD literal', () => {
		assert.equal(
			redactSqlSecrets(`CREATE ROLE app WITH LOGIN PASSWORD 'hunter2'`),
			`CREATE ROLE app WITH LOGIN PASSWORD ${REDACTED_SECRET}`,
		);
		assert.equal(
			redactSqlSecrets(`ALTER ROLE app WITH ENCRYPTED PASSWORD 'x'`),
			`ALTER ROLE app WITH ENCRYPTED PASSWORD ${REDACTED_SECRET}`,
		);
	});

	it('redacts a T-SQL PASSWORD = N-literal', () => {
		assert.equal(
			redactSqlSecrets(`CREATE LOGIN [app] WITH PASSWORD = N'hunter2', CHECK_POLICY = OFF`),
			`CREATE LOGIN [app] WITH PASSWORD = ${REDACTED_SECRET}, CHECK_POLICY = OFF`,
		);
	});

	it('redacts an Oracle bare password and its REPLACE clause', () => {
		assert.equal(
			redactSqlSecrets('ALTER USER app IDENTIFIED BY newpw REPLACE oldpw'),
			`ALTER USER app IDENTIFIED BY ${REDACTED_SECRET} REPLACE ${REDACTED_SECRET}`,
		);
	});

	it('redacts MySQL SET PASSWORD FOR', () => {
		assert.equal(
			redactSqlSecrets(`SET PASSWORD FOR 'app'@'%' = 'hunter2'`),
			`SET PASSWORD FOR 'app'@'%' = ${REDACTED_SECRET}`,
		);
	});

	it('does not redact PASSWORD EXPIRE, which carries no secret', () => {
		const sql = "ALTER USER 'app'@'%' PASSWORD EXPIRE";
		assert.equal(redactSqlSecrets(sql), sql);
	});

	it('does not redact IDENTIFIED BY RANDOM PASSWORD, which carries no secret', () => {
		const sql = "CREATE USER 'app'@'%' IDENTIFIED BY RANDOM PASSWORD";
		assert.equal(redactSqlSecrets(sql), sql);
	});

	it('leaves REPLACE INTO and the REPLACE function alone', () => {
		const dml = "REPLACE INTO t (a) VALUES ('x')";
		assert.equal(redactSqlSecrets(dml), dml);
		const call = "SELECT REPLACE(name, 'a', 'b') FROM t WHERE password_hash IS NULL";
		assert.equal(redactSqlSecrets(call), call);
	});

	it('redacts every secret in a multi-statement script', () => {
		const out = redactSqlSecrets(
			"CREATE USER 'a'@'%' IDENTIFIED BY 'one'; GRANT SELECT ON db.* TO 'a'@'%'; SET PASSWORD FOR 'a'@'%' = 'two'",
		);
		assert.equal(out.includes('one'), false);
		assert.equal(out.includes('two'), false);
		assert.equal(out.includes('GRANT SELECT ON db.*'), true);
	});

	it('redacts a password containing a doubled quote', () => {
		const out = redactSqlSecrets("CREATE USER a IDENTIFIED BY 'it''s a secret'");
		assert.equal(out.includes('secret'), false);
		assert.equal(out, `CREATE USER a IDENTIFIED BY ${REDACTED_SECRET}`);
	});

	it('produces a redaction that is not runnable SQL', () => {
		// The point of `<redacted>`: a history row re-run must FAIL, never silently set the
		// password to the redaction text.
		assert.equal(REDACTED_SECRET.startsWith("'"), false);
		assert.equal(/^[A-Za-z0-9_$#]+$/.test(REDACTED_SECRET), false);
	});
});

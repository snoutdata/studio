/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mysqlDefaultExpression } from './introspection';

// INFORMATION_SCHEMA.COLUMNS reports string defaults UNQUOTED — a `varchar(1) DEFAULT 'N'`
// column comes back as the single character `N`. Passing that through produced `DEFAULT N` in
// the DDL view and in every generated ALTER, which is not valid SQL. These pin the
// normalisation back to a pasteable SQL expression.

test('mysqlDefaultExpression: a string default is quoted', () => {
	assert.equal(mysqlDefaultExpression('N', 'varchar(1)', ''), "'N'");
	assert.equal(mysqlDefaultExpression('active', 'varchar(20)', null), "'active'");
	assert.equal(mysqlDefaultExpression('', 'varchar(20)', ''), "''");
});

test('mysqlDefaultExpression: numeric defaults stay bare', () => {
	assert.equal(mysqlDefaultExpression('0', 'int', ''), '0');
	assert.equal(mysqlDefaultExpression('0.00', 'decimal(10,2)', ''), '0.00');
	assert.equal(mysqlDefaultExpression('1', 'tinyint(1)', ''), '1');
	assert.equal(mysqlDefaultExpression('2026', 'year', ''), '2026');
});

test('mysqlDefaultExpression: time functions are expressions, not strings', () => {
	// MySQL 5.7 reports these with an empty EXTRA, so only the name identifies them.
	assert.equal(mysqlDefaultExpression('CURRENT_TIMESTAMP', 'timestamp', ''), 'CURRENT_TIMESTAMP');
	assert.equal(mysqlDefaultExpression('current_timestamp(6)', 'datetime(6)', ''), 'current_timestamp(6)');
	assert.equal(mysqlDefaultExpression('now()', 'datetime', ''), 'now()');
});

test('mysqlDefaultExpression: MySQL 8 flags expression defaults in EXTRA', () => {
	assert.equal(mysqlDefaultExpression("(concat('a','b'))", 'varchar(20)', 'DEFAULT_GENERATED'), "(concat('a','b'))");
	assert.equal(mysqlDefaultExpression('CURRENT_TIMESTAMP', 'timestamp', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'), 'CURRENT_TIMESTAMP');
});

test('mysqlDefaultExpression: no default stays null; quotes and backslashes escape', () => {
	assert.equal(mysqlDefaultExpression(null, 'varchar(10)', ''), null);
	assert.equal(mysqlDefaultExpression("it's", 'varchar(10)', ''), "'it''s'");
	assert.equal(mysqlDefaultExpression('a\\b', 'varchar(10)', ''), "'a\\\\b'");
	// A literal four-character "NULL" default is a string, not the keyword — a real null
	// arrives as SQL NULL and is handled above.
	assert.equal(mysqlDefaultExpression('NULL', 'varchar(10)', ''), "'NULL'");
});

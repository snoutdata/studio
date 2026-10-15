/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { editableSource } from './editableQuery';

test('plain single-table select is editable', () => {
	assert.deepEqual(editableSource('SELECT * FROM users'), { table: 'users' });
	assert.deepEqual(editableSource('select id, name from users'), { table: 'users' });
});

test('schema-qualified and aliased tables resolve to the table', () => {
	assert.deepEqual(editableSource('SELECT * FROM public.users'), { schema: 'public', table: 'users' });
	assert.deepEqual(editableSource('SELECT u.* FROM users u'), { table: 'users' });
	assert.deepEqual(editableSource('SELECT * FROM `app`.`orders` AS o'), { schema: 'app', table: 'orders' });
});

test('clauses after FROM are ignored', () => {
	assert.deepEqual(editableSource('SELECT * FROM users WHERE id = 1 ORDER BY name LIMIT 100'), { table: 'users' });
	assert.deepEqual(editableSource('SELECT * FROM users;'), { table: 'users' });
});

test('non-editable queries return null', () => {
	assert.equal(editableSource('SELECT a.*, b.* FROM a JOIN b ON a.id = b.a_id'), null);
	assert.equal(editableSource('SELECT * FROM a, b'), null);
	assert.equal(editableSource('SELECT count(*) FROM users GROUP BY status'), null);
	assert.equal(editableSource('SELECT DISTINCT status FROM users'), null);
	assert.equal(editableSource('SELECT * FROM users UNION SELECT * FROM admins'), null);
	assert.equal(editableSource('SELECT * FROM (SELECT * FROM users) t'), null);
	assert.equal(editableSource('WITH t AS (SELECT 1) SELECT * FROM t'), null);
	assert.equal(editableSource('UPDATE users SET name = 1'), null);
	assert.equal(editableSource('SELECT 1'), null);
});

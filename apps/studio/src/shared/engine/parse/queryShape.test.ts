/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeQuery } from './queryShape';

test('collapses queries differing only in literals to one shape', () => {
	const a = canonicalizeQuery('SELECT * FROM users WHERE id = 5');
	const b = canonicalizeQuery('SELECT * FROM users WHERE id = 6');
	assert.equal(a, b);
	assert.equal(a, 'select * from users where id=?');
});

test('string and numeric literals both become holes', () => {
	assert.equal(
		canonicalizeQuery("SELECT name FROM t WHERE status = 'active' AND age > 21"),
		'select name from t where status=? and age>?',
	);
});

test('formatting, case, and whitespace do not change the shape', () => {
	const messy = canonicalizeQuery("select\n\tID,\n\tNAME\nFROM   Users\nWHERE  id=1  ");
	const tidy = canonicalizeQuery('SELECT id, name FROM users WHERE id = 2');
	assert.equal(messy, tidy);
});

test('strips line and block comments', () => {
	assert.equal(
		canonicalizeQuery('SELECT 1 -- trailing note\nFROM t /* block */ WHERE x = 9'),
		'select ? from t where x=?',
	);
});

test('collapses variable-length IN lists so arity does not fragment', () => {
	const two = canonicalizeQuery('SELECT * FROM t WHERE id IN (1, 2)');
	const five = canonicalizeQuery('SELECT * FROM t WHERE id IN (1,2,3,4,5)');
	assert.equal(two, five);
	assert.equal(two, 'select * from t where id in (?)');
});

test('does not clobber digits inside identifiers', () => {
	assert.equal(
		canonicalizeQuery('SELECT col1, col2 FROM table3 WHERE col1 = 7'),
		'select col1, col2 from table3 where col1=?',
	);
});

test('drops the trailing semicolon', () => {
	assert.equal(canonicalizeQuery('SELECT 1;'), canonicalizeQuery('SELECT 1'));
});

test('empty / whitespace-only input yields an empty shape', () => {
	assert.equal(canonicalizeQuery(''), '');
	assert.equal(canonicalizeQuery('   \n  '), '');
});

test('unparseable / non-SQL text still yields a stable normalized shape (never throws)', () => {
	// A syntax error is exactly the kind of input we record; it must still produce a key.
	assert.equal(canonicalizeQuery('SLECT * FORM  users;'), 'slect * form users');
	assert.doesNotThrow(() => canonicalizeQuery('{ $match: { qty: { $gt: 100 } } }'));
});

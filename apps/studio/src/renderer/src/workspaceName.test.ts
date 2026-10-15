/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { suggestFileName } from './workspaceName';

test('names from the leading verb + primary table', () => {
	assert.equal(suggestFileName('SELECT * FROM orders'), 'select-orders.sql');
	assert.equal(suggestFileName('select id from public.customers c'), 'select-customers.sql');
	assert.equal(suggestFileName('INSERT INTO orders (id) VALUES (1)'), 'insert-orders.sql');
	assert.equal(suggestFileName('UPDATE orders SET total = 1'), 'update-orders.sql');
	assert.equal(suggestFileName('DELETE FROM orders WHERE id = 1'), 'delete-orders.sql');
	assert.equal(suggestFileName('CREATE TABLE customers (id int)'), 'create-customers.sql');
	assert.equal(suggestFileName('DROP TABLE IF EXISTS customers'), 'drop-customers.sql');
});

test('ignores leading comments and uses the first statement', () => {
	assert.equal(suggestFileName('-- daily report\nSELECT * FROM orders;\nSELECT 1;'), 'select-orders.sql');
	assert.equal(suggestFileName('/* header */ select * from invoices'), 'select-invoices.sql');
});

test('falls back to query.sql when there is nothing to parse', () => {
	assert.equal(suggestFileName(''), 'query.sql');
	assert.equal(suggestFileName('   \n  '), 'query.sql');
	assert.equal(suggestFileName('SELECT 1'), 'select.sql');
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { completionFocus, guardCompletion, isCompletionPosition } from './completionGuard';
import type { DatabaseSchema } from '../../schema';

function column(name: string) {
	return { name, dataType: 'varchar', nullable: true, isPrimaryKey: false };
}

const schema: DatabaseSchema = {
	database: 'shop',
	fetchedAt: 0,
	tables: [
		{
			name: 'customer',
			kind: 'table',
			columns: [column('id'), column('name'), column('email'), column('primary_phone'), column('created_at')],
			primaryKey: ['id'],
			foreignKeys: [],
		},
		{
			name: 'orders',
			kind: 'table',
			columns: [column('id'), column('customer_id'), column('total'), column('status')],
			primaryKey: ['id'],
			foreignKeys: [],
		},
	],
};

test('leaves a correct completion alone', () => {
	const result = guardCompletion('name, email', 'select id, ', ' from customer;', schema);
	assert.equal(result.verdict, 'clean');
	assert.equal(result.text, 'name, email');
});

test('repairs a hallucinated table to the real one', () => {
	// The model's classic failure: an invented plural/variant of a table that exists.
	const result = guardCompletion('customers', 'select * from ', ';', schema);
	assert.equal(result.verdict, 'repaired');
	assert.equal(result.text, 'customer');
	assert.deepEqual(result.repairs, [{ from: 'customers', to: 'customer' }]);
});

test('cuts at a table that resembles nothing in the schema', () => {
	const result = guardCompletion('customer_satisfaction_survey', 'select * from ', ';', schema);
	assert.equal(result.verdict, 'rejected');
	assert.equal(result.text, '');
	assert.equal(result.cut, 'customer_satisfaction_survey');
});

test('accepts a database- or schema-qualified table', () => {
	// The qualifier is not a table and never will be in `schema.tables`; only the name after the
	// dot is the table to check.
	const result = guardCompletion('shop.customer', 'select * from ', ';', schema);
	assert.equal(result.verdict, 'clean');
	// …and the table half is still checked.
	assert.equal(guardCompletion('shop.customers', 'select * from ', ';', schema).text, 'shop.customer');
});

test('repairs a hallucinated column against the tables in scope', () => {
	const result = guardCompletion('emial', 'select ', ' from customer;', schema);
	assert.equal(result.verdict, 'repaired');
	assert.equal(result.text, 'email');
});

test('cuts the completion where an invented column starts, keeping the good head', () => {
	const result = guardCompletion('name, loyalty_points_balance', 'select ', ' from customer;', schema);
	assert.equal(result.verdict, 'truncated');
	assert.equal(result.text, 'name');
	assert.equal(result.cut, 'loyalty_points_balance');
});

test('checks a qualified column against its own alias table', () => {
	const result = guardCompletion('o.shipping_country', 'select c.name, ', ' from customer c join orders o on o.customer_id = c.id;', schema);
	assert.equal(result.verdict, 'rejected');
	assert.equal(result.cut, 'shipping_country');
});

test('accepts a qualified column that the alias table really has', () => {
	const result = guardCompletion('o.status', 'select c.name, ', ' from customer c join orders o on o.customer_id = c.id;', schema);
	assert.equal(result.verdict, 'clean');
});

test('never second-guesses a word the user typed themselves', () => {
	// `legacy_flag` isn't in the schema (a view we didn't introspect, say) but the user wrote it,
	// so a completion repeating it must pass through untouched.
	const result = guardCompletion('legacy_flag', 'select legacy_flag, ', ' from customer;', schema);
	assert.equal(result.verdict, 'clean');
});

test('skips column checking when a CTE puts the scope in doubt', () => {
	const prefix = 'with recent as (select * from orders) select ';
	const result = guardCompletion('whatever_column', prefix, ' from recent;', schema);
	assert.equal(result.verdict, 'clean');
});

test('leaves aliases and function calls alone', () => {
	const result = guardCompletion('count(*) as order_count', 'select ', ' from orders;', schema);
	assert.equal(result.verdict, 'clean');
});

test('cuts a value the model invented for a predicate', () => {
	// The documented end-of-buffer failure: the column is real, the phone number is fiction.
	const result = guardCompletion("phone = '789-456-1234'", 'select * from customer where primary_', '', schema);
	assert.equal(result.verdict, 'truncated');
	assert.equal(result.text, 'phone');
});

test('cuts an invented value after a real column too', () => {
	const result = guardCompletion("status = 'shipped'", 'select * from orders where ', '', schema);
	assert.equal(result.verdict, 'truncated');
	assert.equal(result.text, 'status');
});

test('keeps a value the user already typed somewhere', () => {
	const result = guardCompletion("status = 'shipped'", "select * from orders where status <> 'shipped' or ", '', schema);
	assert.equal(result.verdict, 'clean');
});

test('leaves conventional constants alone', () => {
	assert.equal(guardCompletion('total desc limit 10', 'select * from orders order by ', '', schema).verdict, 'clean');
	assert.equal(guardCompletion('when status is null then 0 else 1 end', 'select case ', ' from orders', schema).verdict, 'clean');
});

test('cuts invented INSERT values', () => {
	const result = guardCompletion("values ('Ada', 'ada@example.com')", 'insert into customer (name, email) ', '', schema);
	assert.equal(result.verdict, 'truncated');
	assert.equal(result.text, 'values');
});

test('cuts an invented IN list', () => {
	const result = guardCompletion("in ('new', 'paid')", 'select * from orders where status ', '', schema);
	assert.equal(result.verdict, 'truncated');
	assert.equal(result.text, 'in');
});

test('passes everything through with no schema', () => {
	const result = guardCompletion('anything_at_all', 'select ', ' from nowhere;', null);
	assert.equal(result.verdict, 'clean');
});

test('does not check a token the user started and the model finished', () => {
	// The renderer normally gates this position away, but an explicit trigger can still hit it:
	// the completion is only the tail of an identifier, so it is not a whole name to validate.
	const result = guardCompletion('_phone', 'select primary', ' from customer;', schema);
	assert.equal(result.verdict, 'clean');
});

test('trigger gate: skips mid-identifier and qualified positions', () => {
	assert.equal(isCompletionPosition('select * from customer_', ''), false);
	assert.equal(isCompletionPosition('select c.', ' from customer c'), false);
	assert.equal(isCompletionPosition('select * from ', ''), false);
	assert.equal(isCompletionPosition('insert into ', ''), false);
});

test('trigger gate: skips strings and comments', () => {
	assert.equal(isCompletionPosition("select * from customer where name = '", "'"), false);
	assert.equal(isCompletionPosition('select 1; -- what about ', ''), false);
	assert.equal(isCompletionPosition('/* a note ', ''), false);
});

test('trigger gate: allows clause bodies, predicates and join conditions', () => {
	assert.equal(isCompletionPosition('select id, ', ' from customer'), true);
	assert.equal(isCompletionPosition('select * from customer where ', ''), true);
	assert.equal(isCompletionPosition('select * from customer c join orders o on ', ''), true);
	assert.equal(isCompletionPosition('select * from orders group by ', ''), true);
});

test('trigger gate: never fires when the current statement is empty', () => {
	// After a `;` there is no gap to fill — a completion there fabricates a whole new query.
	assert.equal(isCompletionPosition('select * from customer;', ''), false);
	assert.equal(isCompletionPosition('select * from customer;\n', ''), false);
	assert.equal(isCompletionPosition('select * from customer;\n\n  ', ''), false);
	// A blank line is a statement boundary too, semicolon or not.
	assert.equal(isCompletionPosition('select * from customer\n\n', ''), false);
	// But a `;` inside a string literal doesn't end the statement being typed.
	assert.equal(isCompletionPosition("select * from customer where note = 'a;b' and ", ''), true);
	// And a second statement genuinely under way still completes.
	assert.equal(isCompletionPosition('select 1;\nselect id, ', ' from customer'), true);
});

test('trigger gate: never fires on an empty buffer', () => {
	assert.equal(isCompletionPosition('', ''), false);
	assert.equal(isCompletionPosition('   \n ', ''), false);
});

test('focus is the current statement, not the surrounding buffer', () => {
	// The real failure: a scratch pad full of earlier SQL made every table mentioned anywhere score
	// a whole-word hit, drowning out the fragment actually under the cursor.
	const prefix = 'select * from voucher where id > 1500;\n\nupdate delivery set status_id = 2;\n\nselect * from cus';
	assert.equal(completionFocus(prefix, ';'), 'select * from cus;');
	// No statement boundary at all — fall back to a window rather than returning nothing.
	assert.ok(completionFocus('select * from cus', '').includes('cus'));
});

test('a value borrowed from an unrelated statement is still fabrication', () => {
	// The user typed this date 36 lines earlier, against a different table. That
	// makes it a guess about the statement being written now, and a wrong date filter fails silently.
	const prefix = "select * from orders where date(created_at) = '2023-10-16';\n\nselect * from cus";
	const result = guardCompletion("tomer where created_at > '2023-10-16';", prefix, '', schema);
	assert.equal(result.verdict, 'truncated');
	assert.equal(result.text, 'tomer where created_at');
});

test('a value from the SAME statement is inference, not fabrication', () => {
	const prefix = "select * from orders where status = 'shipped' or ";
	assert.equal(guardCompletion("status = 'shipped'", prefix, '', schema).verdict, 'clean');
});

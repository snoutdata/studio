/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { notNullTarget, parseStatement } from './parse.js';
import { splitStatements } from './split.js';
import { tokenize } from './tokenize.js';

describe('tokenize', () => {
	test('keeps the contents of quoted identifiers, which masking would blank', () => {
		const tokens = tokenize('ALTER TABLE "order items" DROP COLUMN `ship date`');
		const idents = tokens.filter((t) => t.quoted).map((t) => t.value);
		assert.deepEqual(idents, ['order items', 'ship date']);
	});

	test('a semicolon inside a literal is not structure', () => {
		const tokens = tokenize("INSERT INTO t VALUES ('a;b')");
		assert.equal(tokens.filter((t) => t.value === ';').length, 0);
		assert.equal(tokens.find((t) => t.type === 'string')?.value, 'a;b');
	});

	test('dollar-quoted bodies survive whole', () => {
		const tokens = tokenize("CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql");
		assert.ok(tokens.some((t) => t.type === 'string' && t.value.includes('SELECT 1')));
	});

	test('comments are dropped, not tokenized', () => {
		const tokens = tokenize('SELECT 1 -- DROP TABLE users\n, 2 /* DELETE FROM t */');
		assert.equal(tokens.filter((t) => t.upper === 'DROP' || t.upper === 'DELETE').length, 0);
	});
});

describe('splitStatements', () => {
	test('splits on semicolons and reports 1-based lines', () => {
		const sql = 'CREATE TABLE a (id int);\n\nALTER TABLE a ADD COLUMN b int;\n';
		const spans = splitStatements(sql);
		assert.equal(spans.length, 2);
		assert.equal(spans[0].line, 1);
		assert.equal(spans[1].line, 3);
	});

	test('does not split on a semicolon inside a string or a comment', () => {
		const sql = "INSERT INTO t VALUES ('a;b'); -- and; then\nSELECT 1;";
		const spans = splitStatements(sql);
		assert.equal(spans.length, 2);
		assert.ok(spans[0].sql.startsWith('INSERT'));
	});

	test('a blank line inside one statement does not end it', () => {
		const sql = 'CREATE TABLE a (\n\tid int,\n\n\tname text\n);';
		assert.equal(splitStatements(sql).length, 1);
	});

	test('a file with no terminator is still one statement', () => {
		assert.equal(splitStatements('SELECT 1').length, 1);
	});
});

describe('parseStatement — DDL', () => {
	test('CREATE TABLE reads its columns, defaults and nullability', () => {
		const s = parseStatement(`CREATE TABLE orders (
			id BIGSERIAL PRIMARY KEY,
			customer_id BIGINT NOT NULL REFERENCES customers (id),
			status VARCHAR(16) NOT NULL DEFAULT 'new',
			note TEXT
		)`);
		assert.equal(s.kind, 'createTable');
		assert.equal(s.object, 'orders');
		assert.deepEqual(s.columns?.map((c) => c.name), ['id', 'customer_id', 'status', 'note']);
		const status = s.columns?.find((c) => c.name === 'status');
		assert.equal(status?.dataType, 'VARCHAR(16)');
		assert.equal(status?.notNull, true);
		assert.equal(status?.hasDefault, true);
		assert.equal(status?.defaultExpr, "'new'");
		assert.equal(s.columns?.find((c) => c.name === 'note')?.notNull, false);
		assert.equal(s.columns?.find((c) => c.name === 'id')?.autoIncrement, true);
		assert.deepEqual(s.columns?.find((c) => c.name === 'customer_id')?.references, {
			table: 'customers',
			columns: ['id'],
		});
	});

	test('a table-level constraint is not read as a column', () => {
		const s = parseStatement('CREATE TABLE t (a int, b int, PRIMARY KEY (a), UNIQUE (b))');
		assert.deepEqual(s.columns?.map((c) => c.name), ['a', 'b']);
	});

	test('CREATE UNIQUE INDEX … CONCURRENTLY', () => {
		const s = parseStatement('CREATE UNIQUE INDEX CONCURRENTLY ux_users_email ON users (email)');
		assert.equal(s.kind, 'createIndex');
		assert.equal(s.object, 'ux_users_email');
		assert.equal(s.onTable, 'users');
		assert.deepEqual(s.indexColumns, ['email']);
		assert.equal(s.unique, true);
		assert.equal(s.concurrently, true);
	});

	test('an index with a sort direction and a USING clause still reports its columns', () => {
		const s = parseStatement('CREATE INDEX idx ON t USING btree (a DESC, b ASC)');
		assert.deepEqual(s.indexColumns, ['a', 'b']);
	});

	test('MySQL DROP INDEX names its table', () => {
		const s = parseStatement('DROP INDEX idx_orders_customer ON orders');
		assert.equal(s.kind, 'dropIndex');
		assert.equal(s.object, 'idx_orders_customer');
		assert.equal(s.onTable, 'orders');
	});

	test('Postgres SET NOT NULL', () => {
		const s = parseStatement('ALTER TABLE orders ALTER COLUMN ship_date SET NOT NULL');
		assert.equal(s.kind, 'alterTable');
		assert.equal(s.object, 'orders');
		assert.deepEqual(s.actions, [{ type: 'setNotNull', column: 'ship_date' }]);
	});

	test('one ALTER carrying several actions reads them all', () => {
		const s = parseStatement(
			"ALTER TABLE orders ADD COLUMN status varchar(16) NOT NULL DEFAULT 'new', DROP COLUMN legacy_flag, ALTER COLUMN note TYPE text",
		);
		assert.equal(s.actions?.length, 3);
		assert.equal(s.actions?.[0].type, 'addColumn');
		assert.deepEqual(s.actions?.[1], { type: 'dropColumn', column: 'legacy_flag' });
		assert.deepEqual(s.actions?.[2], { type: 'alterColumnType', column: 'note', dataType: 'text' });
	});

	test('ADD CONSTRAINT … FOREIGN KEY', () => {
		const s = parseStatement(
			'ALTER TABLE order_items ADD CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders (id)',
		);
		assert.deepEqual(s.actions, [
			{ type: 'addForeignKey', name: 'fk_oi_order', columns: ['order_id'], refTable: 'orders', refColumns: ['id'] },
		]);
	});

	test('MySQL MODIFY COLUMN is a type change, and carries whether it is NOT NULL', () => {
		// MySQL has no SET NOT NULL: MODIFY restates the whole column, so adding the constraint
		// and changing the type are one statement. `notNull` is how the rules see the constraint
		// at all on MySQL, which is most of our users. See `notNullTarget`.
		const s = parseStatement('ALTER TABLE users MODIFY COLUMN email VARCHAR(64) NOT NULL');
		assert.deepEqual(s.actions, [{ type: 'alterColumnType', column: 'email', dataType: 'VARCHAR(64)', notNull: true }]);
		assert.equal(notNullTarget(s.actions![0]), 'email');
	});

	test('a MODIFY that does not say NOT NULL is not making anything NOT NULL', () => {
		const s = parseStatement('ALTER TABLE users MODIFY COLUMN email VARCHAR(64)');
		assert.deepEqual(s.actions, [{ type: 'alterColumnType', column: 'email', dataType: 'VARCHAR(64)', notNull: false }]);
		assert.equal(notNullTarget(s.actions![0]), undefined);
	});

	test("notNullTarget reads both vendors' spelling of the same intent", () => {
		const pg = parseStatement('ALTER TABLE orders ALTER COLUMN ship_date SET NOT NULL');
		const my = parseStatement('ALTER TABLE orders MODIFY ship_date DATE NOT NULL');
		assert.equal(notNullTarget(pg.actions![0]), 'ship_date');
		assert.equal(notNullTarget(my.actions![0]), 'ship_date');
	});

	test('MySQL CHANGE COLUMN with a new name is a rename', () => {
		const s = parseStatement('ALTER TABLE users CHANGE COLUMN email email_address VARCHAR(64)');
		assert.deepEqual(s.actions, [{ type: 'renameColumn', from: 'email', to: 'email_address' }]);
	});

	test('DROP TABLE … CASCADE', () => {
		const s = parseStatement('DROP TABLE IF EXISTS legacy_orders CASCADE');
		assert.equal(s.kind, 'dropTable');
		assert.equal(s.object, 'legacy_orders');
		assert.equal(s.ifExists, true);
		assert.equal(s.cascade, true);
	});

	test('a schema-qualified, quoted name keeps both parts', () => {
		const s = parseStatement('ALTER TABLE "sales"."orders" DROP COLUMN "ship date"');
		assert.equal(s.object, 'sales.orders');
		assert.deepEqual(s.actions, [{ type: 'dropColumn', column: 'ship date' }]);
	});
});

describe('parseStatement — queries', () => {
	test('reads tables, aliases and the columns they are filtered on', () => {
		const s = parseStatement(
			'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = ? ORDER BY o.created_at',
		);
		assert.equal(s.kind, 'select');
		assert.deepEqual(s.tables, [{ name: 'orders', alias: 'o' }, { name: 'customers', alias: 'c' }]);
		const where = s.predicates?.find((p) => p.role === 'where');
		assert.equal(where?.column, 'status');
		assert.equal(where?.table, 'orders');
		const join = s.predicates?.filter((p) => p.role === 'join') ?? [];
		assert.deepEqual(join.map((p) => `${p.table}.${p.column}`).sort(), ['customers.id', 'orders.customer_id']);
	});

	test('a column wrapped in a function is marked wrapped', () => {
		const s = parseStatement('SELECT 1 FROM orders WHERE DATE(created_at) = ?');
		const p = s.predicates?.find((x) => x.column === 'created_at');
		assert.equal(p?.wrapped, true);
		assert.equal(p?.table, 'orders');
	});

	test('an unqualified column in a single-table query resolves to that table', () => {
		const s = parseStatement('SELECT * FROM orders WHERE customer_id = 7');
		assert.equal(s.predicates?.[0].table, 'orders');
	});

	test('DELETE with no WHERE is flagged as unfiltered', () => {
		assert.equal(parseStatement('DELETE FROM sessions').unfiltered, true);
		assert.equal(parseStatement('DELETE FROM sessions WHERE id = 1').unfiltered, false);
	});

	test('a CTE still reads as the statement it leads to', () => {
		const s = parseStatement('WITH recent AS (SELECT 1) SELECT * FROM orders WHERE id = 1');
		assert.equal(s.kind, 'select');
	});

	test('an unrecognised statement is `other`, not a guess', () => {
		assert.equal(parseStatement('GRANT SELECT ON orders TO analyst').kind, 'other');
		assert.equal(parseStatement('').kind, 'other');
	});
});

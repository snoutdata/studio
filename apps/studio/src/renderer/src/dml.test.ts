/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { QueryField } from '../../shared/query';
import type { TableInfo } from '../../shared/schema';
import { buildDml, defaultAction, editRefusal, generateRowSql, valueLiteral, NULL_VALUE, type RowInsert, type RowUpdate } from './dml';

const TABLE: TableInfo = {
	name: 'users',
	schema: 'app',
	kind: 'table',
	columns: [
		{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'name', dataType: 'varchar(100)', nullable: false, isPrimaryKey: false },
		{ name: 'age', dataType: 'int', nullable: true, isPrimaryKey: false },
		{ name: 'active', dataType: 'boolean', nullable: false, isPrimaryKey: false, default: '1' },
		{ name: 'created_at', dataType: 'timestamp', nullable: false, isPrimaryKey: false },
	],
	primaryKey: ['id'],
	foreignKeys: [],
};

const FIELDS: QueryField[] = [{ name: 'id' }, { name: 'name' }, { name: 'age' }, { name: 'active' }, { name: 'created_at' }];

function ok(result: { sql: string } | { error: string }): string {
	if ('error' in result) {
		throw new Error(`expected sql, got error: ${result.error}`);
	}
	return result.sql;
}

describe('valueLiteral', () => {
	test('quotes strings and escapes single quotes', () => {
		assert.equal(valueLiteral("O'Brien", TABLE.columns[1], 'mysql-aurora'), "'O''Brien'");
	});
	test('passes numeric values through for numeric columns', () => {
		assert.equal(valueLiteral('42', TABLE.columns[2], 'mysql-aurora'), '42');
	});
	test('a non-numeric value in a numeric column is quoted, not injected', () => {
		assert.equal(valueLiteral('42; DROP TABLE x', TABLE.columns[2], 'mysql-aurora'), "'42; DROP TABLE x'");
	});
	test('empty on a nullable column is NULL', () => {
		assert.equal(valueLiteral('', TABLE.columns[2], 'postgres'), 'NULL');
	});
	test('booleans map per dialect', () => {
		assert.equal(valueLiteral('true', TABLE.columns[3], 'postgres'), 'TRUE');
		assert.equal(valueLiteral('true', TABLE.columns[3], 'mysql-aurora'), '1');
		assert.equal(valueLiteral('0', TABLE.columns[3], 'postgres'), 'FALSE');
	});
});

describe('generateRowSql', () => {
	const ROW = [1, "O'Brien", 30, 1, '2024-01-01 00:00:00'];

	test('SELECT lists columns and targets the row by primary key', () => {
		assert.equal(
			generateRowSql('select', TABLE, 'mysql-aurora', FIELDS, ROW),
			'SELECT `id`, `name`, `age`, `active`, `created_at`\nFROM `app`.`users`\nWHERE `id` = 1;',
		);
	});

	test('INSERT lists every column with escaped literals', () => {
		assert.equal(
			generateRowSql('insert', TABLE, 'mysql-aurora', FIELDS, ROW),
			"INSERT INTO `app`.`users` (`id`, `name`, `age`, `active`, `created_at`)\nVALUES (1, 'O''Brien', 30, 1, '2024-01-01 00:00:00');",
		);
	});

	test('UPDATE sets all columns and keys on the primary key', () => {
		assert.equal(
			generateRowSql('update', TABLE, 'postgres', FIELDS, ROW),
			`UPDATE "app"."users"\nSET "id" = 1, "name" = 'O''Brien', "age" = 30, "active" = 1, "created_at" = '2024-01-01 00:00:00'\nWHERE "id" = 1;`,
		);
	});

	test('DELETE targets the row by primary key', () => {
		assert.equal(
			generateRowSql('delete', TABLE, 'mysql-aurora', FIELDS, ROW),
			'DELETE FROM `app`.`users`\nWHERE `id` = 1;',
		);
	});

	test('with no primary key in the result, the WHERE matches every column', () => {
		const noPk: TableInfo = { ...TABLE, primaryKey: [], columns: TABLE.columns.map((c) => ({ ...c, isPrimaryKey: false })) };
		assert.equal(
			generateRowSql('delete', noPk, 'mysql-aurora', FIELDS, [1, 'Ann', null, 1, 'x']),
			"DELETE FROM `app`.`users`\nWHERE `id` = 1 AND `name` = 'Ann' AND `age` IS NULL AND `active` = 1 AND `created_at` = 'x';",
		);
	});
});

describe('buildDml', () => {
	test('UPDATE sets edited columns keyed by the primary key', () => {
		const updates: RowUpdate[] = [{ original: [1, 'Ann', 30, 1], set: new Map([[1, 'Annie'], [2, '31']]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates, deletes: [], inserts: [] }));
		assert.equal(sql, "UPDATE `app`.`users` SET `name` = 'Annie', `age` = 31 WHERE `id` = 1;");
	});

	test('Postgres uses double-quote identifiers', () => {
		const updates: RowUpdate[] = [{ original: [7, 'X', null, true], set: new Map([[1, 'Y']]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'postgres', fields: FIELDS, updates, deletes: [], inserts: [] }));
		assert.equal(sql, 'UPDATE "app"."users" SET "name" = \'Y\' WHERE "id" = 7;');
	});

	test('SQL Server uses bracket identifiers and bit (1/0) booleans', () => {
		const updates: RowUpdate[] = [{ original: [7, 'X', null, true], set: new Map([[1, 'Y'], [3, 'true']]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'sqlserver', fields: FIELDS, updates, deletes: [], inserts: [] }));
		assert.equal(sql, 'UPDATE [app].[users] SET [name] = \'Y\', [active] = 1 WHERE [id] = 7;');
	});

	test('DELETE keys on the primary key', () => {
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates: [], deletes: [[5, 'Bo', 9, 0]], inserts: [] }));
		assert.equal(sql, 'DELETE FROM `app`.`users` WHERE `id` = 5;');
	});

	test('INSERT lists only the provided columns', () => {
		const inserts: RowInsert[] = [{ values: new Map([[1, 'Cy'], [2, '20']]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates: [], deletes: [], inserts }));
		assert.equal(sql, "INSERT INTO `app`.`users` (`name`, `age`) VALUES ('Cy', 20);");
	});

	test('orders deletes, then updates, then inserts', () => {
		const sql = ok(buildDml({
			table: TABLE,
			driver: 'mysql-aurora',
			fields: FIELDS,
			updates: [{ original: [2, 'B', 1, 1], set: new Map([[1, 'BB']]) }],
			deletes: [[3, 'C', 2, 0]],
			inserts: [{ values: new Map([[1, 'D']]) }],
		}));
		const lines = sql.split('\n');
		assert.match(lines[0], /^DELETE/);
		assert.match(lines[1], /^UPDATE/);
		assert.match(lines[2], /^INSERT/);
	});

	test('errors when an UPDATE/DELETE has no primary key in the result', () => {
		const noPk: TableInfo = { ...TABLE, primaryKey: [], columns: TABLE.columns.map((c) => ({ ...c, isPrimaryKey: false })) };
		const result = buildDml({ table: noPk, driver: 'mysql-aurora', fields: FIELDS, updates: [{ original: [1, 'A', 1, 1], set: new Map([[1, 'Z']]) }], deletes: [], inserts: [] });
		assert.ok('error' in result);
	});

	test('inserts are allowed without a primary key', () => {
		const noPk: TableInfo = { ...TABLE, primaryKey: [], columns: TABLE.columns.map((c) => ({ ...c, isPrimaryKey: false })) };
		const sql = ok(buildDml({ table: noPk, driver: 'mysql-aurora', fields: FIELDS, updates: [], deletes: [], inserts: [{ values: new Map([[1, 'D']]) }] }));
		assert.match(sql, /^INSERT/);
	});

	test('a NULL primary key value uses IS NULL', () => {
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates: [], deletes: [[null, 'x', 1, 1]], inserts: [] }));
		assert.match(sql, /WHERE `id` IS NULL/);
	});

	test('UPDATE to a DEFAULT expr emits col = DEFAULT verbatim', () => {
		const updates: RowUpdate[] = [{ original: [1, 'Ann', 30, 1, 't'], set: new Map([[3, { sql: 'DEFAULT', display: '(default)', omitOnInsert: true }]]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates, deletes: [], inserts: [] }));
		assert.equal(sql, 'UPDATE `app`.`users` SET `active` = DEFAULT WHERE `id` = 1;');
	});

	test('UPDATE to current time emits CURRENT_TIMESTAMP unquoted', () => {
		const updates: RowUpdate[] = [{ original: [1, 'Ann', 30, 1, 't'], set: new Map([[4, { sql: 'CURRENT_TIMESTAMP', display: '(current time)' }]]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'postgres', fields: FIELDS, updates, deletes: [], inserts: [] }));
		assert.equal(sql, 'UPDATE "app"."users" SET "created_at" = CURRENT_TIMESTAMP WHERE "id" = 1;');
	});

	test('UPDATE to explicit NULL emits col = NULL', () => {
		const updates: RowUpdate[] = [{ original: [1, 'Ann', 30, 1, 't'], set: new Map([[2, NULL_VALUE]]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates, deletes: [], inserts: [] }));
		assert.equal(sql, 'UPDATE `app`.`users` SET `age` = NULL WHERE `id` = 1;');
	});

	test('INSERT omits a DEFAULT-marked column so the DB fills it', () => {
		const inserts: RowInsert[] = [{ values: new Map<number, string | { sql: string; display: string; omitOnInsert?: boolean }>([[1, 'Cy'], [3, { sql: 'DEFAULT', display: '(default)', omitOnInsert: true }]]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates: [], deletes: [], inserts }));
		assert.equal(sql, "INSERT INTO `app`.`users` (`name`) VALUES ('Cy');");
	});

	test('INSERT keeps a NULL expr (only DEFAULT is omitted)', () => {
		const inserts: RowInsert[] = [{ values: new Map<number, string | typeof NULL_VALUE>([[1, 'Cy'], [2, NULL_VALUE]]) }];
		const sql = ok(buildDml({ table: TABLE, driver: 'mysql-aurora', fields: FIELDS, updates: [], deletes: [], inserts }));
		assert.equal(sql, "INSERT INTO `app`.`users` (`name`, `age`) VALUES ('Cy', NULL);");
	});
});

describe('defaultAction', () => {
	test('a column with a declared default sets DEFAULT (omitted on insert)', () => {
		const action = defaultAction(TABLE.columns[3]); // active, default '1'
		assert.ok(action);
		assert.match(action.label, /Set to default \(1\)/);
		assert.equal(action.value.sql, 'DEFAULT');
		assert.equal(action.value.omitOnInsert, true);
	});

	test('a temporal column with no default sets the current time', () => {
		const action = defaultAction(TABLE.columns[4]); // created_at, timestamp, no default
		assert.ok(action);
		assert.equal(action.label, 'Set to current time');
		assert.equal(action.value.sql, 'CURRENT_TIMESTAMP');
	});

	test('a nullable column with no default sets NULL', () => {
		const action = defaultAction(TABLE.columns[2]); // age, int, nullable
		assert.ok(action);
		assert.equal(action.value.sql, 'NULL');
	});

	test('a non-nullable column with no default and no temporal fallback has no action', () => {
		assert.equal(defaultAction(TABLE.columns[1]), null); // name, varchar, not null, no default
	});
});

test('a table that cannot be edited says why, and names what to do about it', () => {
	const keyed = { kind: 'table' as const, primaryKey: ['id'], columns: [{ name: 'id' }] } as never;
	const unkeyed = { kind: 'table' as const, primaryKey: [], columns: [{ name: 'label' }] } as never;
	const open = { readOnly: false, gridActionsAllowed: true };

	// The case that prompted this: the first hosted database anybody imported had two
	// tables with no primary key, the app correctly refused, and said nothing at all.
	assert.match(editRefusal(unkeyed, open) ?? '', /no primary key/);
	assert.equal(editRefusal(keyed, open), null);

	// Ordered by what the user can act on: a read-only connection is a setting they own,
	// and it is a better answer than the primary key they would go and add for nothing.
	assert.match(editRefusal(unkeyed, { ...open, readOnly: true }) ?? '', /read-only/);
	assert.match(editRefusal(unkeyed, { ...open, gridActionsAllowed: false }) ?? '', /production/);

	// A view is refused for a reason of its own, before either.
	const view = { kind: 'view' as const, primaryKey: ['id'], columns: [{ name: 'id' }] } as never;
	assert.match(editRefusal(view, open) ?? '', /view/i);
	assert.equal(editRefusal(undefined, open), null);
});

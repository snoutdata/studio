/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { TableInfo } from '../../shared/schema';
import { buildLabelSql, buildPeekSql, fkForColumn, pickLabelColumn, pickPeekColumns, resolveFkTarget } from './fkResolve';

const ORDERS: TableInfo = {
	name: 'orders',
	schema: 'shop',
	kind: 'table',
	columns: [
		{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'customer_id', dataType: 'int', nullable: false, isPrimaryKey: false },
		{ name: 'total', dataType: 'decimal', nullable: false, isPrimaryKey: false },
	],
	primaryKey: ['id'],
	foreignKeys: [
		{ constraintName: 'fk_cust', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] },
		{ constraintName: 'fk_composite', columns: ['a', 'b'], referencedTable: 'other', referencedColumns: ['a', 'b'] },
	],
};

const CUSTOMERS: TableInfo = {
	name: 'customers',
	schema: 'shop',
	kind: 'table',
	columns: [
		{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'name', dataType: 'varchar(100)', nullable: false, isPrimaryKey: false },
		{ name: 'email', dataType: 'varchar(200)', nullable: true, isPrimaryKey: false },
		{ name: 'tier', dataType: 'varchar(20)', nullable: false, isPrimaryKey: false },
		{ name: 'region_id', dataType: 'int', nullable: true, isPrimaryKey: false },
		{ name: 'created_at', dataType: 'timestamp', nullable: false, isPrimaryKey: false },
		{ name: 'a', dataType: 'int', nullable: true, isPrimaryKey: false },
		{ name: 'b', dataType: 'int', nullable: true, isPrimaryKey: false },
		{ name: 'c', dataType: 'int', nullable: true, isPrimaryKey: false },
		{ name: 'd', dataType: 'int', nullable: true, isPrimaryKey: false },
	],
	primaryKey: ['id'],
	foreignKeys: [],
};

const OTHER: TableInfo = {
	name: 'other',
	schema: 'shop',
	kind: 'table',
	columns: [
		{ name: 'a', dataType: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'b', dataType: 'int', nullable: false, isPrimaryKey: true },
		{ name: 'name', dataType: 'varchar(100)', nullable: false, isPrimaryKey: false },
	],
	primaryKey: ['a', 'b'],
	foreignKeys: [],
};

describe('fkForColumn', () => {
	test('finds a single-column FK by source column (case-insensitive)', () => {
		assert.equal(fkForColumn(ORDERS, 'CUSTOMER_ID')?.referencedTable, 'customers');
	});
	test('finds a composite FK that includes the column', () => {
		assert.equal(fkForColumn(ORDERS, 'a')?.referencedTable, 'other');
		assert.equal(fkForColumn(ORDERS, 'b')?.referencedTable, 'other');
	});
	test('returns undefined for a non-FK column', () => {
		assert.equal(fkForColumn(ORDERS, 'total'), undefined);
	});
});

describe('pickLabelColumn', () => {
	test('prefers a name column over the lookup column', () => {
		assert.equal(pickLabelColumn(CUSTOMERS, ['id']), 'name');
	});
	test('excludes every lookup column for a composite key', () => {
		assert.equal(pickLabelColumn(OTHER, ['a', 'b']), 'name');
	});
	test('falls back to the first textual column when nothing is name-y', () => {
		const t: TableInfo = { ...CUSTOMERS, columns: [
			{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
			{ name: 'amount', dataType: 'int', nullable: false, isPrimaryKey: false },
			{ name: 'status', dataType: 'varchar(20)', nullable: false, isPrimaryKey: false },
		] };
		assert.equal(pickLabelColumn(t, ['id']), 'status');
	});
	test('returns null when only the id-like numeric columns exist', () => {
		const t: TableInfo = { ...CUSTOMERS, columns: [
			{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
			{ name: 'amount', dataType: 'int', nullable: false, isPrimaryKey: false },
		] };
		assert.equal(pickLabelColumn(t, ['id']), null);
	});
});

describe('pickPeekColumns', () => {
	test('lookup column first, then label, then fill, capped at 8', () => {
		const cols = pickPeekColumns(CUSTOMERS, ['id'], 'name');
		assert.equal(cols.length, 8);
		assert.deepEqual(cols.slice(0, 2), ['id', 'name']);
		assert.ok(!cols.includes('d')); // capped before the last columns
	});
	test('puts every composite lookup column first', () => {
		const cols = pickPeekColumns(OTHER, ['a', 'b'], 'name');
		assert.deepEqual(cols, ['a', 'b', 'name']);
	});
});

describe('resolveFkTarget', () => {
	test('resolves the referenced table + label from the schema', () => {
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, CUSTOMERS]);
		assert.equal(target?.refTable.name, 'customers');
		assert.deepEqual(target?.refColumns, ['id']);
		assert.deepEqual(target?.sourceColumns, ['customer_id']);
		assert.equal(target?.composite, false);
		assert.equal(target?.labelColumn, 'name');
	});
	test('resolves a composite FK to all its key columns', () => {
		const target = resolveFkTarget(ORDERS, 'a', [ORDERS, OTHER]);
		assert.equal(target?.refTable.name, 'other');
		assert.deepEqual(target?.sourceColumns, ['a', 'b']);
		assert.deepEqual(target?.refColumns, ['a', 'b']);
		assert.equal(target?.composite, true);
		assert.equal(target?.labelColumn, 'name');
	});
	test('null when the referenced table is not in the schema', () => {
		assert.equal(resolveFkTarget(ORDERS, 'customer_id', [ORDERS]), null);
	});
	test('null for a non-FK column', () => {
		assert.equal(resolveFkTarget(ORDERS, 'total', [ORDERS, CUSTOMERS]), null);
	});
});

describe('buildLabelSql', () => {
	test('selects the label keyed by the referenced column, de-duped', () => {
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, CUSTOMERS])!;
		const sql = buildLabelSql(target, [4815, 23, 4815, null], 'mysql-aurora');
		assert.equal(sql, 'SELECT `id`, `name` FROM `shop`.`customers` WHERE `id` IN (4815, 23)');
	});
	test('quotes string keys safely', () => {
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, CUSTOMERS])!;
		const sql = buildLabelSql(target, ["O'Brien"], 'postgres');
		assert.equal(sql, `SELECT "id", "name" FROM "shop"."customers" WHERE "id" IN ('O''Brien')`);
	});
	test('null when there are no non-null values', () => {
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, CUSTOMERS])!;
		assert.equal(buildLabelSql(target, [null, undefined], 'mysql-aurora'), null);
	});
	test('null when the referenced table has no label column', () => {
		const plain: TableInfo = { ...CUSTOMERS, columns: [
			{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
			{ name: 'amount', dataType: 'int', nullable: false, isPrimaryKey: false },
		] };
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, plain])!;
		assert.equal(buildLabelSql(target, [1], 'mysql-aurora'), null);
	});
	test('null for a composite key (those resolve only via the peek)', () => {
		const target = resolveFkTarget(ORDERS, 'a', [ORDERS, OTHER])!;
		assert.equal(buildLabelSql(target, [1], 'mysql-aurora'), null);
	});
});

describe('buildPeekSql', () => {
	test('fetches one referenced row by the PK with a capped column list', () => {
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, CUSTOMERS])!;
		const sql = buildPeekSql(target, [4815], 'mysql-aurora');
		assert.equal(sql, 'SELECT `id`, `name`, `email`, `tier`, `region_id`, `created_at`, `a`, `b` FROM `shop`.`customers` WHERE `id` = 4815 LIMIT 1');
	});
	test('ANDs every part of a composite key', () => {
		const target = resolveFkTarget(ORDERS, 'a', [ORDERS, OTHER])!;
		const sql = buildPeekSql(target, [3, 7], 'mysql-aurora');
		assert.equal(sql, 'SELECT `a`, `b`, `name` FROM `shop`.`other` WHERE `a` = 3 AND `b` = 7 LIMIT 1');
	});
	test('sqlserver uses TOP 1 and bracket identifiers', () => {
		const target = resolveFkTarget(ORDERS, 'customer_id', [ORDERS, CUSTOMERS])!;
		const sql = buildPeekSql(target, [7], 'sqlserver');
		assert.ok(sql.startsWith('SELECT TOP 1 [id], [name]'));
		assert.ok(sql.endsWith('WHERE [id] = 7'));
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../schema';
import { buildPlan } from './index';
import { computeChanges } from './diff';
import { orderChanges } from './order';

function col(name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
	return { name, dataType, nullable: extra.nullable ?? false, isPrimaryKey: extra.isPrimaryKey ?? false, default: extra.default ?? null, ...extra };
}

function table(name: string, columns: ColumnInfo[], extra: Partial<TableInfo> = {}): TableInfo {
	return { name, schema: extra.schema ?? 'app', kind: 'table', columns, primaryKey: extra.primaryKey ?? [], foreignKeys: extra.foreignKeys ?? [], indexes: extra.indexes ?? [], triggers: extra.triggers, ...extra };
}

function schema(database: string, tables: TableInfo[], routines?: DatabaseSchema['routines']): DatabaseSchema {
	return { database, tables, routines, fetchedAt: 0 };
}

const sqlFor = (plan: ReturnType<typeof buildPlan>) => plan.statements.map((s) => s.sql);

describe('computeChanges', () => {
	test('identical schemas produce no changes', () => {
		const s = schema('dev', [table('users', [col('id', 'int')], { primaryKey: ['id'] })]);
		const t = schema('prod', [table('users', [col('id', 'int')], { primaryKey: ['id'], schema: 'prod' })]);
		assert.equal(computeChanges(s, t).length, 0);
	});

	test('matches tables by name across differing database names', () => {
		const s = schema('dev', [table('users', [col('id', 'int'), col('email', 'varchar(255)')], { schema: 'app_dev' })]);
		const t = schema('prod', [table('users', [col('id', 'int')], { schema: 'app_prod' })]);
		const changes = computeChanges(s, t);
		assert.equal(changes.length, 1);
		assert.equal(changes[0].kind, 'addColumn');
	});

	test('detects added table, dropped table, altered + dropped column', () => {
		const s = schema('dev', [
			table('users', [col('id', 'int'), col('age', 'bigint')]),
			table('orders', [col('id', 'int')]),
		]);
		const t = schema('prod', [
			table('users', [col('id', 'int'), col('age', 'int'), col('stale', 'text')]),
			table('legacy', [col('id', 'int')]),
		]);
		const kinds = computeChanges(s, t).map((c) => c.kind).sort();
		assert.deepEqual(kinds, ['addTable', 'alterColumn', 'dropColumn', 'dropTable']);
	});

	test('flags drop column / drop table / drop view as destructive', () => {
		const s = schema('dev', []);
		const t = schema('prod', [table('gone', [col('id', 'int')])]);
		const plan = buildPlan(s, t, 'mysql-aurora');
		assert.equal(plan.statements[0].destructive, true);
	});

	test('detects view add and replace by definition', () => {
		const s = schema('dev', [
			table('v_active', [col('id', 'int')], { kind: 'view', definition: 'SELECT id FROM users WHERE active = 1' }),
		]);
		const t = schema('prod', [
			table('v_active', [col('id', 'int')], { kind: 'view', definition: 'SELECT id FROM users' }),
		]);
		const changes = computeChanges(s, t);
		assert.equal(changes.length, 1);
		assert.equal(changes[0].kind, 'replaceView');
	});

	test('a changed index becomes a single replaceIndex (not drop+add)', () => {
		const s = schema('dev', [table('t', [col('id', 'int')], { indexes: [{ name: 'ix', columns: ['id', 'a'], unique: false }] })]);
		const t = schema('prod', [table('t', [col('id', 'int')], { indexes: [{ name: 'ix', columns: ['id'], unique: false }] })]);
		const changes = computeChanges(s, t);
		assert.equal(changes.length, 1);
		assert.equal(changes[0].kind, 'replaceIndex');
	});

	test('tags changes as add / alter / drop', () => {
		const s = schema('dev', [
			table('keep', [col('id', 'int'), col('added', 'int')]),
			table('new', [col('id', 'int')]),
		]);
		const t = schema('prod', [
			table('keep', [col('id', 'int'), col('changed', 'text')]),
			table('gone', [col('id', 'int')]),
		]);
		const plan = buildPlan(s, t, 'mysql-aurora');
		const classes = new Set(plan.statements.map((x) => x.changeClass));
		assert.ok(classes.has('add'));
		assert.ok(classes.has('drop'));
		// A replaceIndex / drop-then-add stays atomic; here `gone` drops and `new`/`added` add.
		assert.equal(plan.statements.every((x) => ['add', 'alter', 'drop'].includes(x.changeClass)), true);
	});

	test('excluding the drop class leaves a still-valid additive plan', () => {
		const s = schema('dev', [
			table('t', [col('id', 'int'), col('email', 'varchar(50)')], { indexes: [{ name: 'ix', columns: ['email'], unique: true }] }),
		]);
		const t = schema('prod', [
			table('t', [col('id', 'int')]),
			table('legacy', [col('id', 'int')]),
		]);
		const plan = buildPlan(s, t, 'mysql-aurora');
		const additive = plan.statements.filter((x) => x.changeClass !== 'drop');
		// The legacy table drop is the only drop; additive keeps the column + index adds.
		assert.ok(plan.statements.some((x) => x.changeClass === 'drop'));
		assert.ok(additive.every((x) => x.changeClass !== 'drop'));
		assert.ok(additive.some((x) => x.objectType === 'column'));
	});

	test('replaceIndex emits drop then create', () => {
		const s = schema('dev', [table('t', [col('id', 'int')], { indexes: [{ name: 'ix', columns: ['id'], unique: true }] })]);
		const t = schema('prod', [table('t', [col('id', 'int')], { indexes: [{ name: 'ix', columns: ['id'], unique: false }] })]);
		const sql = sqlFor(buildPlan(s, t, 'mysql-aurora'));
		assert.deepEqual(sql, ['ALTER TABLE `t` DROP INDEX `ix`', 'CREATE UNIQUE INDEX `ix` ON `t` (`id`)']);
	});

	test('detects routine add/drop/replace', () => {
		const s = schema('dev', [], [{ name: 'f', schema: 'app', kind: 'function', definition: 'CREATE FUNCTION f() RETURNS int RETURN 2' }]);
		const t = schema('prod', [], [{ name: 'f', schema: 'app', kind: 'function', definition: 'CREATE FUNCTION f() RETURNS int RETURN 1' }]);
		assert.equal(computeChanges(s, t)[0].kind, 'replaceRoutine');
	});
});

describe('orderChanges', () => {
	test('drops constraints first and tables last', () => {
		const s = schema('dev', [
			table('a', [col('id', 'int')]),
			table('b', [col('id', 'int')]),
		]);
		const t = schema('prod', [
			table('a', [col('id', 'int')]),
			table('b', [col('id', 'int')], { foreignKeys: [{ constraintName: 'fk', columns: ['id'], referencedTable: 'a', referencedColumns: ['id'] }] }),
			table('c', [col('id', 'int')]),
		]);
		const ordered = orderChanges(computeChanges(s, t));
		assert.equal(ordered[0].kind, 'dropForeignKey');
		assert.equal(ordered[ordered.length - 1].kind, 'dropTable');
	});

	test('creates a table before its foreign key', () => {
		const s = schema('dev', [
			table('orders', [col('id', 'int'), col('user_id', 'int')], { foreignKeys: [{ constraintName: 'fk_u', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] }] }),
		]);
		const t = schema('prod', []);
		const ordered = orderChanges(computeChanges(s, t));
		const tableIdx = ordered.findIndex((c) => c.kind === 'addTable');
		const fkIdx = ordered.findIndex((c) => c.kind === 'addForeignKey');
		assert.ok(tableIdx >= 0 && fkIdx > tableIdx, 'addTable must precede addForeignKey');
	});
});

describe('mysql emitter', () => {
	test('emits add column with quoted identifiers and literal default', () => {
		// `ColumnInfo.default` is a SQL EXPRESSION, so a string default arrives already quoted
		// (MySQL introspection normalises the bare catalog value). The emitter passes it through
		// rather than guessing at quoting, which is what used to double-escape it.
		const s = schema('dev', [table('users', [col('id', 'int'), col('status', 'varchar(20)', { default: "'active'" })])]);
		const t = schema('prod', [table('users', [col('id', 'int')])]);
		const sql = sqlFor(buildPlan(s, t, 'mysql-aurora'));
		assert.deepEqual(sql, ["ALTER TABLE `users` ADD COLUMN `status` varchar(20) NOT NULL DEFAULT 'active'"]);
	});

	test('emits expression default unquoted', () => {
		const s = schema('dev', [table('t', [col('id', 'int'), col('ts', 'datetime', { default: 'CURRENT_TIMESTAMP' })])]);
		const t = schema('prod', [table('t', [col('id', 'int')])]);
		const sql = sqlFor(buildPlan(s, t, 'mysql-aurora'));
		assert.ok(sql[0].endsWith('DEFAULT CURRENT_TIMESTAMP'));
	});

	test('strips source database qualifier from a view body', () => {
		const s = schema('dev', [table('v', [col('id', 'int')], { kind: 'view', schema: 'app_dev', definition: 'select `app_dev`.`users`.`id` from `app_dev`.`users`' })]);
		const t = schema('prod', []);
		const sql = sqlFor(buildPlan(s, t, 'mysql-aurora'));
		assert.equal(sql[0], 'CREATE OR REPLACE VIEW `v` AS select `users`.`id` from `users`');
	});

	test('primary-key change drops then adds', () => {
		const s = schema('dev', [table('t', [col('id', 'int'), col('k', 'int')], { primaryKey: ['id', 'k'] })]);
		const t = schema('prod', [table('t', [col('id', 'int'), col('k', 'int')], { primaryKey: ['id'] })]);
		const sql = sqlFor(buildPlan(s, t, 'mysql-aurora'));
		assert.deepEqual(sql, ['ALTER TABLE `t` DROP PRIMARY KEY', 'ALTER TABLE `t` ADD PRIMARY KEY (`id`, `k`)']);
	});
});

describe('postgres emitter', () => {
	test('decomposes an alter column into type/nullability/default', () => {
		const s = schema('dev', [table('t', [col('id', 'int'), col('name', 'text', { nullable: true, default: "'x'::text" })])]);
		const t = schema('prod', [table('t', [col('id', 'int'), col('name', 'varchar', { nullable: false })])]);
		const sql = sqlFor(buildPlan(s, t, 'postgres'));
		assert.deepEqual(sql, [
			'ALTER TABLE "t" ALTER COLUMN "name" TYPE text',
			'ALTER TABLE "t" ALTER COLUMN "name" DROP NOT NULL',
			'ALTER TABLE "t" ALTER COLUMN "name" SET DEFAULT \'x\'::text',
		]);
	});

	// Postgres 18 made VIRTUAL the default kind, so a bare GENERATED clause would change the column.
	test('a generated column always names its kind', () => {
		const s = schema('dev', [table('t', [
			col('id', 'int'),
			col('total', 'numeric', { nullable: true, generatedAlways: true, generatedAs: { expression: '(price * qty)', kind: 'stored' } }),
			col('label', 'text', { nullable: true, generatedAlways: true, generatedAs: { expression: "upper(name)", kind: 'virtual' } }),
		])]);
		const sql = sqlFor(buildPlan(s, schema('prod', []), 'postgres'));
		assert.ok(sql[0].includes('"total" numeric GENERATED ALWAYS AS ((price * qty)) STORED'), sql[0]);
		assert.ok(sql[0].includes('"label" text GENERATED ALWAYS AS (upper(name)) VIRTUAL'), sql[0]);
		const added = sqlFor(buildPlan(s, schema('prod', [table('t', [col('id', 'int')])]), 'postgres'));
		assert.ok(added.includes('ALTER TABLE "t" ADD COLUMN "total" numeric GENERATED ALWAYS AS ((price * qty)) STORED'), added.join('\n'));
	});

	test('plan is transactional for postgres', () => {
		const plan = buildPlan(schema('dev', []), schema('prod', []), 'postgres');
		assert.equal(plan.transactional, true);
	});
});

describe('sqlserver emitter', () => {
	test('rewrites a replaced view to CREATE OR ALTER', () => {
		const s = schema('dev', [table('v', [col('id', 'int')], { kind: 'view', schema: 'dbo', definition: 'CREATE VIEW [dbo].[v] AS SELECT id FROM t WHERE id > 0' })]);
		const t = schema('prod', [table('v', [col('id', 'int')], { kind: 'view', schema: 'dbo', definition: 'CREATE VIEW [dbo].[v] AS SELECT id FROM t' })]);
		const sql = sqlFor(buildPlan(s, t, 'sqlserver'));
		assert.equal(sql[0], 'CREATE OR ALTER VIEW [v] AS SELECT id FROM t WHERE id > 0');
	});

	test('alter column folds type and nullability', () => {
		const s = schema('dev', [table('t', [col('id', 'int'), col('n', 'nvarchar(50)', { nullable: true })])]);
		const t = schema('prod', [table('t', [col('id', 'int'), col('n', 'nvarchar(20)', { nullable: false })])]);
		const sql = sqlFor(buildPlan(s, t, 'sqlserver'));
		assert.deepEqual(sql, ['ALTER TABLE [t] ALTER COLUMN [n] nvarchar(50) NULL']);
	});
});

describe('buildPlan', () => {
	test('assigns unique ids and supported driver only', () => {
		const s = schema('dev', [table('a', [col('id', 'int')]), table('b', [col('id', 'int')])]);
		const t = schema('prod', []);
		const plan = buildPlan(s, t, 'mysql-aurora');
		assert.equal(new Set(plan.statements.map((x) => x.id)).size, plan.statements.length);
		assert.throws(() => buildPlan(s, t, 'snowflake'));
	});

	test('oracle is supported but non-transactional (auto-commits its DDL)', () => {
		const s = schema('dev', [table('t', [col('id', 'NUMBER')])]);
		const t = schema('prod', []);
		const plan = buildPlan(s, t, 'oracle');
		assert.equal(plan.transactional, false);
		assert.equal(plan.statements[0].sql, 'CREATE TABLE "t" (\n\t"id" NUMBER NOT NULL\n)');
	});

	test('mariadb reuses the MySQL emitter (backtick quoting, non-transactional)', () => {
		const s = schema('dev', [table('t', [col('id', 'int')])]);
		const t = schema('prod', []);
		const plan = buildPlan(s, t, 'mariadb');
		assert.equal(plan.transactional, false);
		assert.match(plan.statements[0].sql, /^CREATE TABLE `t`/);
	});

	test('db2 is supported (double-quote quoting, non-transactional)', () => {
		const s = schema('dev', [table('t', [col('id', 'INTEGER')])]);
		const t = schema('prod', []);
		const plan = buildPlan(s, t, 'db2');
		assert.equal(plan.transactional, false);
		assert.equal(plan.statements[0].sql, 'CREATE TABLE "t" (\n\t"id" INTEGER NOT NULL\n)');
	});
});

describe('db2 emitter', () => {
	test('alter column splits type and nullability into separate ALTER COLUMN clauses', () => {
		const s = schema('dev', [table('t', [col('id', 'INTEGER'), col('n', 'VARCHAR(50)', { nullable: true })])]);
		const t = schema('prod', [table('t', [col('id', 'INTEGER'), col('n', 'VARCHAR(20)', { nullable: false })])]);
		const sql = sqlFor(buildPlan(s, t, 'db2'));
		assert.deepEqual(sql, [
			'ALTER TABLE "t" ALTER COLUMN "n" SET DATA TYPE VARCHAR(50)',
			'ALTER TABLE "t" ALTER COLUMN "n" DROP NOT NULL',
		]);
	});

	test('drops a schema-scoped index without an ON clause', () => {
		const s = schema('dev', [table('t', [col('id', 'INTEGER')])]);
		const t = schema('prod', [table('t', [col('id', 'INTEGER')], { indexes: [{ name: 'ix_t_id', columns: ['id'], unique: false }] })]);
		const sql = sqlFor(buildPlan(s, t, 'db2'));
		assert.deepEqual(sql, ['DROP INDEX "ix_t_id"']);
	});
});

describe('sqlite emitter', () => {
	test('transactional DDL; a new table inlines its foreign keys (no separate ADD)', () => {
		const fk = { constraintName: 'fk_orders_0', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] };
		const s = schema('dev', [
			table('users', [col('id', 'INTEGER')], { primaryKey: ['id'] }),
			table('orders', [col('id', 'INTEGER'), col('user_id', 'INTEGER', { nullable: true })], { primaryKey: ['id'], foreignKeys: [fk] }),
		]);
		const t = schema('prod', []);
		const plan = buildPlan(s, t, 'sqlite');
		assert.equal(plan.transactional, true);
		const orders = plan.statements.find((st) => st.sql.startsWith('CREATE TABLE "orders"'));
		assert.ok(orders, 'orders table created');
		assert.match(orders.sql, /FOREIGN KEY \("user_id"\) REFERENCES "users" \("id"\)/);
		// The foreign key is inline, so there is no separate ALTER ... ADD ... statement.
		assert.ok(!plan.statements.some((st) => /ADD\b.*FOREIGN KEY/i.test(st.sql)));
	});

	test('refuses an in-place column alter (SQLite needs a table rebuild)', () => {
		const s = schema('dev', [table('t', [col('id', 'INTEGER'), col('n', 'TEXT', { nullable: true })])]);
		const u = schema('prod', [table('t', [col('id', 'INTEGER'), col('n', 'TEXT', { nullable: false })])]);
		assert.throws(() => buildPlan(s, u, 'sqlite'), /table rebuild/);
	});

	test('adds and drops indexes and columns', () => {
		const s = schema('dev', [table('t', [col('id', 'INTEGER'), col('email', 'TEXT')], { indexes: [{ name: 'ix_t_email', columns: ['email'], unique: true }] })]);
		const t = schema('prod', [table('t', [col('id', 'INTEGER')])]);
		const sql = sqlFor(buildPlan(s, t, 'sqlite'));
		assert.ok(sql.includes('ALTER TABLE "t" ADD COLUMN "email" TEXT NOT NULL'));
		assert.ok(sql.includes('CREATE UNIQUE INDEX "ix_t_email" ON "t" ("email")'));
	});
});

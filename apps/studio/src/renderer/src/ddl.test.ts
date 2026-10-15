/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPrimaryKeySql, createTableSql, alterTableSql, dropPrimaryKeySql, notNullSql, tableDdl, createIndexSql, dropIndexSql, suggestIndexName, draftFromTable, seriesAlterSql, type TableDraft } from './ddl';
import type { TableInfo } from '../../shared/schema';

function col(name: string, dataType: string, opts: Partial<{ nullable: boolean; isPrimaryKey: boolean; default: string | null; comment: string; autoIncrement: boolean }> = {}) {
	return {
		name,
		dataType,
		nullable: opts.nullable ?? true,
		isPrimaryKey: opts.isPrimaryKey ?? false,
		default: opts.default ?? null,
		comment: opts.comment,
		autoIncrement: opts.autoIncrement,
	};
}

const users: TableInfo = {
	name: 'users',
	schema: 'app',
	kind: 'table',
	columns: [
		col('id', 'int', { nullable: false, isPrimaryKey: true }),
		col('email', 'varchar(255)', { nullable: false }),
		col('age', 'int'),
	],
	primaryKey: ['id'],
	foreignKeys: [],
};

test('createTableSql (mysql): backticks, NOT NULL, default, PRIMARY KEY', () => {
	const draft: TableDraft = {
		schema: 'app',
		name: 'product',
		columns: [
			{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '' },
			{ name: 'price', dataType: 'decimal(10,2)', nullable: false, isPrimaryKey: false, default: '0' },
		],
	};
	const sql = createTableSql(draft, 'mysql-aurora');
	assert.equal(sql,
		'CREATE TABLE `app`.`product` (\n'
		+ '  `id` int NOT NULL,\n'
		+ '  `price` decimal(10,2) NOT NULL DEFAULT 0,\n'
		+ '  PRIMARY KEY (`id`)\n'
		+ ');');
});

test('createTableSql (postgres): double quotes', () => {
	const draft: TableDraft = {
		name: 'product',
		columns: [{ name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true, default: '' }],
	};
	const sql = createTableSql(draft, 'postgres');
	assert.equal(sql, 'CREATE TABLE "product" (\n  "id" integer NOT NULL,\n  PRIMARY KEY ("id")\n);');
});

test('createTableSql (sqlserver): bracket quoting + named PK constraint', () => {
	const draft: TableDraft = {
		schema: 'dbo',
		name: 'product',
		columns: [
			{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '' },
			{ name: 'price', dataType: 'decimal(10,2)', nullable: false, isPrimaryKey: false, default: '0' },
		],
	};
	const sql = createTableSql(draft, 'sqlserver');
	assert.equal(sql,
		'CREATE TABLE [dbo].[product] (\n'
		+ '  [id] int NOT NULL,\n'
		+ '  [price] decimal(10,2) NOT NULL DEFAULT 0,\n'
		+ '  CONSTRAINT [PK_product] PRIMARY KEY ([id])\n'
		+ ');');
});

test('alterTableSql (sqlserver): sp_rename, ALTER COLUMN merges type+null, named DEFAULT', () => {
	const draft = draftFromTable(users);
	const age = draft.columns.find((c) => c.originalName === 'age')!;
	age.name = 'years';
	age.dataType = 'bigint';
	age.nullable = false;
	age.default = '0';
	const sql = alterTableSql(users, draft, 'sqlserver');
	assert.match(sql, /EXEC sp_rename N'\[app\]\.\[users\]\.\[age\]', N'years', 'COLUMN';/);
	assert.match(sql, /ALTER TABLE \[app\]\.\[users\] ALTER COLUMN \[years\] bigint NOT NULL;/);
	assert.match(sql, /ALTER TABLE \[app\]\.\[users\] DROP CONSTRAINT IF EXISTS \[DF_users_years\];/);
	assert.match(sql, /ALTER TABLE \[app\]\.\[users\] ADD CONSTRAINT \[DF_users_years\] DEFAULT 0 FOR \[years\];/);
});

test('alterTableSql (sqlserver): a hostile name cannot leave sp_rename\'s string arguments', () => {
	// A column or table name is the database's (or the designer's) text, not ours: a quote in it
	// used to end the literal, and whatever followed ran as its own statement.
	const hostile: TableInfo = { ...users, schema: "app'", name: "us]ers'; DROP TABLE audit; --" };
	const draft = draftFromTable(hostile);
	const age = draft.columns.find((c) => c.originalName === 'age')!;
	age.name = "x', 'y'; DROP TABLE users; --";
	const sql = alterTableSql(hostile, draft, 'sqlserver');
	const rename = sql.split('\n').find((line) => line.startsWith('EXEC sp_rename'))!;
	assert.equal(rename, "EXEC sp_rename N'[app''].[us]]ers''; DROP TABLE audit; --].[age]', N'x'', ''y''; DROP TABLE users; --', 'COLUMN';");
	// Each argument is one literal: no quote is left unpaired outside them.
	const outside = rename.replace(/N'(?:[^']|'')*'/g, '').replace(/'COLUMN'/, '');
	assert.equal(outside.includes("'"), false);
});

test('alterTableSql (sqlserver): adds a column without the COLUMN keyword', () => {
	const draft = draftFromTable(users);
	draft.columns.push({ name: 'created_at', dataType: 'datetime2', nullable: false, isPrimaryKey: false, default: 'SYSUTCDATETIME()' });
	const sql = alterTableSql(users, draft, 'sqlserver');
	assert.match(sql, /ALTER TABLE \[app\]\.\[users\] ADD \[created_at\] datetime2 NOT NULL DEFAULT SYSUTCDATETIME\(\);/);
});

test('alterTableSql (sqlserver): PK change drops then re-adds a named constraint', () => {
	const draft = draftFromTable(users);
	draft.columns.find((c) => c.originalName === 'id')!.isPrimaryKey = false;
	draft.columns.find((c) => c.originalName === 'email')!.isPrimaryKey = true;
	const sql = alterTableSql(users, draft, 'sqlserver');
	assert.match(sql, /DROP CONSTRAINT IF EXISTS \[PK_users\];/);
	assert.match(sql, /ADD CONSTRAINT \[PK_users\] PRIMARY KEY \(\[email\]\);/);
	assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS [PK_users]') < sql.indexOf('ADD CONSTRAINT [PK_users]'));
});

test('quoteIdent / dropIndexSql (sqlserver): brackets, ON-table drop', () => {
	assert.equal(createIndexSql({ schema: 'dbo', table: 'users', name: 'IX_users_email', unique: true, columns: ['email'] }, 'sqlserver'),
		'CREATE UNIQUE INDEX [IX_users_email] ON [dbo].[users] ([email]);');
	assert.equal(dropIndexSql({ schema: 'dbo', table: 'users', name: 'IX_users_email' }, 'sqlserver'),
		'DROP INDEX [IX_users_email] ON [dbo].[users];');
});

test('alterTableSql returns empty when nothing changed', () => {
	assert.equal(alterTableSql(users, draftFromTable(users), 'mysql-aurora'), '');
});

test('alterTableSql (mysql): add, drop, and modify columns', () => {
	const draft = draftFromTable(users);
	draft.columns.push({ name: 'created_at', dataType: 'datetime', nullable: false, isPrimaryKey: false, default: 'CURRENT_TIMESTAMP' });
	draft.columns = draft.columns.filter((c) => c.originalName !== 'age'); // drop age
	const email = draft.columns.find((c) => c.originalName === 'email')!;
	email.dataType = 'varchar(320)'; // widen
	const sql = alterTableSql(users, draft, 'mysql-aurora');
	assert.match(sql, /ALTER TABLE `app`\.`users` DROP COLUMN `age`;/);
	assert.match(sql, /ALTER TABLE `app`\.`users` ADD COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;/);
	assert.match(sql, /ALTER TABLE `app`\.`users` CHANGE COLUMN `email` `email` varchar\(320\) NOT NULL;/);
});

test('alterTableSql (mysql): rename via CHANGE keeps old and new name', () => {
	const draft = draftFromTable(users);
	draft.columns.find((c) => c.originalName === 'email')!.name = 'email_address';
	const sql = alterTableSql(users, draft, 'mysql-aurora');
	assert.match(sql, /CHANGE COLUMN `email` `email_address` varchar\(255\) NOT NULL;/);
});

test('alterTableSql (postgres): one ALTER COLUMN per attribute + rename', () => {
	const draft = draftFromTable(users);
	const age = draft.columns.find((c) => c.originalName === 'age')!;
	age.name = 'years';
	age.dataType = 'bigint';
	age.nullable = false;
	age.default = '0';
	const sql = alterTableSql(users, draft, 'postgres');
	assert.match(sql, /ALTER TABLE "app"\."users" RENAME COLUMN "age" TO "years";/);
	assert.match(sql, /ALTER TABLE "app"\."users" ALTER COLUMN "years" TYPE bigint;/);
	assert.match(sql, /ALTER TABLE "app"\."users" ALTER COLUMN "years" SET NOT NULL;/);
	assert.match(sql, /ALTER TABLE "app"\."users" ALTER COLUMN "years" SET DEFAULT 0;/);
});

test('tableDdl renders columns, primary key, and foreign-key constraints', () => {
	const orders: TableInfo = {
		name: 'orders',
		schema: 'app',
		kind: 'table',
		columns: [col('id', 'int', { nullable: false, isPrimaryKey: true }), col('user_id', 'int', { nullable: false })],
		primaryKey: ['id'],
		foreignKeys: [{ constraintName: 'fk_orders_user', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] }],
	};
	const sql = tableDdl(orders, 'mysql-aurora');
	assert.match(sql, /CREATE TABLE `app`\.`orders` \(/);
	assert.match(sql, /`user_id` int NOT NULL/);
	assert.match(sql, /PRIMARY KEY \(`id`\)/);
	assert.match(sql, /CONSTRAINT `fk_orders_user` FOREIGN KEY \(`user_id`\) REFERENCES `users` \(`id`\)/);
});

// The DDL view synthesizes CREATE TABLE from our own model instead of asking the server for
// SHOW CREATE TABLE, so anything the model holds and the output drops is a silent lie about
// the table. These pin the four things it used to drop.

const documented: TableInfo = {
	name: 'payout',
	schema: 'app',
	kind: 'table',
	comment: "Money we've sent out",
	columns: [
		col('id', 'int', { nullable: false, isPrimaryKey: true, autoIncrement: true }),
		col('amount', 'decimal(10,2)', { nullable: false, comment: 'Gross, before fees' }),
		col('returned', 'varchar(1)', { nullable: false, default: "'N'" }),
	],
	primaryKey: ['id'],
	foreignKeys: [],
	indexes: [{ name: 'idx_payout_amount', columns: ['amount'], unique: false }],
	stats: { engine: 'InnoDB', collation: 'utf8mb4_0900_ai_ci', autoIncrement: 42 },
};

test('tableDdl (mysql): emits comments, indexes, auto-increment and table options', () => {
	const sql = tableDdl(documented, 'mysql-aurora');
	assert.match(sql, /`id` int NOT NULL AUTO_INCREMENT/);
	assert.match(sql, /`amount` decimal\(10,2\) NOT NULL COMMENT 'Gross, before fees'/);
	assert.match(sql, /KEY `idx_payout_amount` \(`amount`\)/);
	assert.match(sql, /\) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Money we''ve sent out';/);
});

test('tableDdl: a string default keeps the quotes the catalog reports', () => {
	// Regression: MySQL INFORMATION_SCHEMA reports string defaults unquoted, and emitting the
	// bare value produced `DEFAULT N` — not valid SQL. The introspector now normalises to a SQL
	// expression, so whatever reaches here is pasted through verbatim.
	assert.match(tableDdl(documented, 'mysql-aurora'), /`returned` varchar\(1\) NOT NULL DEFAULT 'N'/);
});

test('tableDdl (postgres): indexes and comments become trailing statements', () => {
	const sql = tableDdl(documented, 'postgres');
	assert.match(sql, /CREATE INDEX "idx_payout_amount" ON "app"\."payout" \("amount"\);/);
	assert.match(sql, /COMMENT ON TABLE "app"\."payout" IS 'Money we''ve sent out';/);
	assert.match(sql, /COMMENT ON COLUMN "app"\."payout"\."amount" IS 'Gross, before fees';/);
	// Postgres carries the sequence in the DEFAULT, so it must not gain a MySQL keyword.
	assert.doesNotMatch(sql, /AUTO_INCREMENT/);
	assert.doesNotMatch(sql, /ENGINE=/);
});

test('tableDdl (sqlserver): IDENTITY inline, descriptions as extended properties', () => {
	const sql = tableDdl(documented, 'sqlserver');
	assert.match(sql, /\[id\] int IDENTITY\(1,1\) NOT NULL/);
	assert.match(sql, /sp_addextendedproperty @name = N'MS_Description', @value = N'Gross, before fees'.*@level2name = 'amount';/);
});

test('alterTableSql (mysql): CHANGE COLUMN keeps auto-increment and the comment', () => {
	// MySQL's CHANGE COLUMN redefines the column from the clause alone, so anything omitted is
	// dropped from the table. Retyping `id` used to quietly remove its AUTO_INCREMENT.
	const draft = draftFromTable(documented);
	draft.columns[0].dataType = 'bigint';
	draft.columns[1].dataType = 'decimal(12,2)';
	const sql = alterTableSql(documented, draft, 'mysql-aurora');
	assert.match(sql, /CHANGE COLUMN `id` `id` bigint NOT NULL AUTO_INCREMENT/);
	assert.match(sql, /COMMENT 'Gross, before fees'/);
});

test('alterTableSql: a carried comment is never itself a change', () => {
	// The designer shows comments but cannot edit them, so an untouched table must produce
	// no statements at all rather than a no-op CHANGE COLUMN per documented column.
	assert.equal(alterTableSql(documented, draftFromTable(documented), 'mysql-aurora'), '');
});

test('createIndexSql: unique + multi-column, per dialect', () => {
	const idx = { schema: 'app', table: 'users', name: 'idx_users_email', unique: true, columns: ['email'] };
	assert.equal(createIndexSql(idx, 'mysql-aurora'), 'CREATE UNIQUE INDEX `idx_users_email` ON `app`.`users` (`email`);');
	assert.equal(createIndexSql({ ...idx, unique: false, columns: ['a', 'b'] }, 'postgres'), 'CREATE INDEX "idx_users_email" ON "app"."users" ("a", "b");');
});

test('dropIndexSql: MySQL needs ON table, Postgres is schema-scoped', () => {
	assert.equal(dropIndexSql({ schema: 'app', table: 'users', name: 'idx_users_email' }, 'mysql-aurora'), 'DROP INDEX `idx_users_email` ON `app`.`users`;');
	assert.equal(dropIndexSql({ schema: 'app', table: 'users', name: 'idx_users_email' }, 'postgres'), 'DROP INDEX "app"."idx_users_email";');
});

test('suggestIndexName is table_columns_idx', () => {
	assert.equal(suggestIndexName('users', ['email', 'status']), 'users_email_status_idx');
});

test('alterTableSql: changing the primary key drops then re-adds it', () => {
	const draft = draftFromTable(users);
	draft.columns.find((c) => c.originalName === 'id')!.isPrimaryKey = false;
	draft.columns.find((c) => c.originalName === 'email')!.isPrimaryKey = true;
	const mysql = alterTableSql(users, draft, 'mysql-aurora');
	assert.match(mysql, /DROP PRIMARY KEY;/);
	assert.match(mysql, /ADD PRIMARY KEY \(`email`\);/);
	// Drop must come before the re-add.
	assert.ok(mysql.indexOf('DROP PRIMARY KEY') < mysql.indexOf('ADD PRIMARY KEY'));

	const pg = alterTableSql(users, draft, 'postgres');
	assert.match(pg, /DROP CONSTRAINT IF EXISTS "users_pkey";/);
	assert.match(pg, /ADD PRIMARY KEY \("email"\);/);
});

test('createTableSql: the auto-increment column is spelled the way each engine wants it', () => {
	function draft(): TableDraft {
		return {
			name: 'product',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '', autoIncrement: true },
				{ name: 'name', dataType: 'text', nullable: true, isPrimaryKey: false, default: '' },
			],
		};
	}
	assert.match(createTableSql(draft(), 'mysql-aurora'), /`id` int NOT NULL AUTO_INCREMENT/);
	// Postgres, Oracle and HANA reject an explicit NOT NULL on an identity column.
	assert.match(createTableSql(draft(), 'postgres'), /"id" int GENERATED BY DEFAULT AS IDENTITY,/);
	assert.match(createTableSql(draft(), 'sqlserver'), /\[id\] int IDENTITY\(1,1\) NOT NULL/);
	assert.match(createTableSql(draft(), 'oracle'), /"id" int GENERATED BY DEFAULT AS IDENTITY,/);
	assert.match(createTableSql(draft(), 'db2'), /"id" int NOT NULL GENERATED BY DEFAULT AS IDENTITY/);
	assert.match(createTableSql(draft(), 'snowflake'), /"id" int AUTOINCREMENT NOT NULL/);
});

test('createTableSql (sqlite): the key is written inline, not as a second PRIMARY KEY line', () => {
	const draft: TableDraft = {
		name: 'product',
		columns: [
			{ name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, default: '', autoIncrement: true },
			{ name: 'name', dataType: 'TEXT', nullable: true, isPrimaryKey: false, default: '' },
		],
	};
	const sql = createTableSql(draft, 'sqlite');
	assert.match(sql, /"id" INTEGER PRIMARY KEY AUTOINCREMENT,/);
	assert.equal(sql.match(/PRIMARY KEY/g)?.length, 1);
});

test('createTableSql: a generated column carries no DEFAULT, since the sequence is the value', () => {
	const draft: TableDraft = {
		name: 'product',
		columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '7', autoIncrement: true }],
	};
	assert.doesNotMatch(createTableSql(draft, 'postgres'), /DEFAULT 7/);
});

test('alterTableSql (postgres): ticking auto-increment adds an identity, unticking drops it', () => {
	const table: TableInfo = {
		name: 'product', schema: 'app', kind: 'table', primaryKey: ['id'], foreignKeys: [],
		columns: [col('id', 'int', { nullable: false, isPrimaryKey: true })],
	};
	const on = alterTableSql(table, {
		schema: 'app', name: 'product',
		columns: [{ originalName: 'id', name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '', autoIncrement: true }],
	}, 'postgres');
	assert.equal(on, 'ALTER TABLE "app"."product" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY;');

	const identity: TableInfo = { ...table, columns: [col('id', 'int', { nullable: false, isPrimaryKey: true, autoIncrement: true })] };
	const off = alterTableSql(identity, {
		schema: 'app', name: 'product',
		columns: [{ originalName: 'id', name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '', autoIncrement: false }],
	}, 'postgres');
	assert.equal(off, 'ALTER TABLE "app"."product" ALTER COLUMN "id" DROP IDENTITY IF EXISTS;');
});

test('alterTableSql (oracle/db2): auto-increment is added and dropped in each vendor\'s own shape', () => {
	const table: TableInfo = {
		name: 'product', schema: 'app', kind: 'table', primaryKey: ['id'], foreignKeys: [],
		columns: [col('id', 'NUMBER', { nullable: false, isPrimaryKey: true })],
	};
	const draft: TableDraft = {
		schema: 'app', name: 'product',
		columns: [{ originalName: 'id', name: 'id', dataType: 'NUMBER', nullable: false, isPrimaryKey: true, default: '', autoIncrement: true }],
	};
	assert.equal(alterTableSql(table, draft, 'oracle'), 'ALTER TABLE "app"."product" MODIFY ("id" GENERATED BY DEFAULT AS IDENTITY);');
	assert.equal(alterTableSql(table, draft, 'db2'), 'ALTER TABLE "app"."product" ALTER COLUMN "id" SET GENERATED BY DEFAULT AS IDENTITY;');
});

test('alterTableSql (mysql): CHANGE COLUMN restates AUTO_INCREMENT rather than a separate statement', () => {
	const table: TableInfo = {
		name: 'product', schema: 'app', kind: 'table', primaryKey: ['id'], foreignKeys: [],
		columns: [col('id', 'int', { nullable: false, isPrimaryKey: true })],
	};
	const sql = alterTableSql(table, {
		schema: 'app', name: 'product',
		columns: [{ originalName: 'id', name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, default: '', autoIncrement: true }],
	}, 'mysql-aurora');
	assert.equal(sql, 'ALTER TABLE `app`.`product` CHANGE COLUMN `id` `id` int NOT NULL AUTO_INCREMENT;');
});

test('tableDdl (postgres): a serial keeps its nextval default and gains no identity clause', () => {
	const table: TableInfo = {
		name: 'product', schema: 'public', kind: 'table', primaryKey: ['id'], foreignKeys: [],
		columns: [
			col('id', 'integer', { nullable: false, isPrimaryKey: true, default: "nextval('product_id_seq'::regclass)", autoIncrement: true }),
			col('code', 'integer', { nullable: false, autoIncrement: true }),
		],
	};
	const sql = tableDdl(table, 'postgres');
	assert.match(sql, /"id" integer NOT NULL DEFAULT nextval\('product_id_seq'::regclass\)/);
	// A true identity column has no default at all, so it is the one that gets the clause.
	assert.match(sql, /"code" integer GENERATED BY DEFAULT AS IDENTITY/);
});

test('dropPrimaryKeySql: by real constraint name where the vendor needs one, positionally elsewhere', () => {
	const target = { schema: 'app', name: 'product', constraintName: 'product_custom_pk' };
	assert.equal(dropPrimaryKeySql(target, 'postgres'), 'ALTER TABLE "app"."product" DROP CONSTRAINT IF EXISTS "product_custom_pk";');
	assert.equal(dropPrimaryKeySql(target, 'sqlserver'), 'ALTER TABLE [app].[product] DROP CONSTRAINT IF EXISTS [product_custom_pk];');
	// MySQL and Oracle have exactly one primary key and drop it without naming it.
	assert.equal(dropPrimaryKeySql(target, 'mysql-aurora'), 'ALTER TABLE `app`.`product` DROP PRIMARY KEY;');
	assert.equal(dropPrimaryKeySql(target, 'oracle'), 'ALTER TABLE "app"."product" DROP PRIMARY KEY;');
	// Without a reported name it falls back to each vendor's own default naming.
	assert.equal(dropPrimaryKeySql({ schema: 'app', name: 'product' }, 'postgres'), 'ALTER TABLE "app"."product" DROP CONSTRAINT IF EXISTS "product_pkey";');
	assert.equal(dropPrimaryKeySql({ schema: 'app', name: 'product' }, 'sqlserver'), 'ALTER TABLE [app].[product] DROP CONSTRAINT IF EXISTS [PK_product];');
});

test('addPrimaryKeySql: composite columns, named only where the drop needs to find it again', () => {
	const target = { name: 'product' };
	assert.equal(addPrimaryKeySql(target, ['tenant', 'id'], 'postgres'), 'ALTER TABLE "product" ADD PRIMARY KEY ("tenant", "id");');
	assert.equal(addPrimaryKeySql(target, ['id'], 'sqlserver'), 'ALTER TABLE [product] ADD CONSTRAINT [PK_product] PRIMARY KEY ([id]);');
});

test('notNullSql: each engine\'s own shape, since only some promote a key column for you', () => {
	const target = { schema: 'app', name: 'product' };
	assert.equal(notNullSql(target, 'id', 'int', 'postgres'), 'ALTER TABLE "app"."product" ALTER COLUMN "id" SET NOT NULL;');
	assert.equal(notNullSql(target, 'id', 'int', 'sqlserver'), 'ALTER TABLE [app].[product] ALTER COLUMN [id] int NOT NULL;');
	assert.equal(notNullSql(target, 'id', 'int', 'mysql-aurora'), 'ALTER TABLE `app`.`product` MODIFY COLUMN `id` int NOT NULL;');
	assert.equal(notNullSql(target, 'id', 'NUMBER', 'oracle'), 'ALTER TABLE "app"."product" MODIFY ("id" NOT NULL);');
});

test('alterTableSql: dropping the old key uses the name introspection reported, not the guess', () => {
	const table: TableInfo = {
		name: 'product', schema: 'app', kind: 'table', primaryKey: ['id'], primaryKeyName: 'product_custom_pk', foreignKeys: [],
		columns: [col('id', 'int', { nullable: false, isPrimaryKey: true }), col('sku', 'text', { nullable: false })],
	};
	const sql = alterTableSql(table, {
		schema: 'app', name: 'product',
		columns: [
			{ originalName: 'id', name: 'id', dataType: 'int', nullable: false, isPrimaryKey: false, default: '' },
			{ originalName: 'sku', name: 'sku', dataType: 'text', nullable: false, isPrimaryKey: true, default: '' },
		],
	}, 'postgres');
	assert.equal(sql, [
		'ALTER TABLE "app"."product" DROP CONSTRAINT IF EXISTS "product_custom_pk";',
		'ALTER TABLE "app"."product" ADD PRIMARY KEY ("sku");',
	].join('\n'));
});

test('alterTableSql: ticking PK on a table that has none is one ADD PRIMARY KEY, nothing else', () => {
	// The exact case from `public.hello`: an identity column that was never made the key.
	const table: TableInfo = {
		name: 'hello', schema: 'public', kind: 'table', primaryKey: [], foreignKeys: [],
		columns: [col('said', 'text'), col('id', 'integer', { nullable: false, autoIncrement: true })],
	};
	const sql = alterTableSql(table, {
		schema: 'public', name: 'hello',
		columns: [
			{ originalName: 'said', name: 'said', dataType: 'text', nullable: true, isPrimaryKey: false, default: '' },
			{ originalName: 'id', name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true, default: '', autoIncrement: true },
		],
	}, 'postgres');
	assert.equal(sql, 'ALTER TABLE "public"."hello" ADD PRIMARY KEY ("id");');
});

// ---- SnoutTime series ----

test('postgres: a new table made a series is the CREATE and then SnoutTime\'s calls', () => {
	const draft: TableDraft = {
		schema: 'public',
		name: 'metrics',
		columns: [
			{ name: 'ts', dataType: 'timestamptz', nullable: false, isPrimaryKey: false, default: '' },
			{ name: 'v', dataType: 'float8', nullable: true, isPrimaryKey: false, default: '' },
		],
		series: { timeColumn: 'ts', interval: '1 day', retention: '90 days', sealAfter: '' },
	};
	const sql = createTableSql(draft, 'postgres');
	assert.match(sql, /^CREATE TABLE "public"\."metrics" \(/);
	assert.match(sql, /\);\nSELECT snouttime\.create_series\('"public"\."metrics"', 'ts', partition_interval => interval '1 day'\);\nSELECT snouttime\.set_retention\('"public"\."metrics"', interval '90 days'\);$/);
	// every other engine ignores it
	assert.doesNotMatch(createTableSql(draft, 'mysql-aurora'), /snouttime/);
});

test('postgres: an existing table switched to a series gets the calls; a series gets only a retention change', () => {
	const plain: TableInfo = { name: 'events', schema: 'public', kind: 'table', columns: [col('ts', 'timestamptz', { nullable: false })], primaryKey: [], foreignKeys: [] };
	const draft = { ...draftFromTable(plain), series: { timeColumn: 'ts', interval: '1 week', retention: '', sealAfter: '' } };
	assert.deepEqual(seriesAlterSql(plain, draft, 'postgres'), [`SELECT snouttime.create_series('"public"."events"', 'ts', partition_interval => interval '1 week');`]);

	const series: TableInfo = { ...plain, series: { timeColumn: 'ts', timeType: 'timestamp with time zone', partitionSize: '1 day', retention: '30 days', partitions: [], rollups: [] } };
	const unchanged = draftFromTable(series);
	assert.deepEqual(unchanged.series, { timeColumn: 'ts', interval: '1 day', retention: '30 days', sealAfter: '' });
	assert.deepEqual(seriesAlterSql(series, unchanged, 'postgres'), []);
	assert.deepEqual(seriesAlterSql(series, { ...unchanged, series: { ...unchanged.series!, retention: '' } }, 'postgres'),
		[`SELECT snouttime.set_retention('"public"."events"', NULL::interval);`]);
});

test('postgres: an integer series retention that is not a number stays inside a literal', () => {
	// An edited retention on an existing series is not checked by the form, and on an integer
	// series it was written into the statement bare.
	const plain: TableInfo = { name: 'events', schema: 'public', kind: 'table', columns: [col('seq', 'bigint', { nullable: false })], primaryKey: [], foreignKeys: [] };
	const series: TableInfo = { ...plain, series: { timeColumn: 'seq', timeType: 'bigint', partitionSize: '1000', retention: '', partitions: [], rollups: [] } };
	const draft = draftFromTable(series);
	assert.deepEqual(seriesAlterSql(series, { ...draft, series: { ...draft.series!, retention: '5000' } }, 'postgres'),
		[`SELECT snouttime.set_retention('"public"."events"', 5000::bigint);`]);
	assert.deepEqual(seriesAlterSql(series, { ...draft, series: { ...draft.series!, retention: "1); DROP TABLE events; --" } }, 'postgres'),
		[`SELECT snouttime.set_retention('"public"."events"', '1); DROP TABLE events; --'::bigint);`]);
});

test('tableDdl (postgres): a generated column names STORED or VIRTUAL, never neither', () => {
	// Postgres 18 made VIRTUAL the default, so a bare GENERATED clause would recreate a stored
	// column as a computed-on-read one.
	const t: TableInfo = {
		name: 'line',
		schema: 'app',
		kind: 'table',
		columns: [
			{ name: 'price', dataType: 'numeric', nullable: false, isPrimaryKey: false },
			{ name: 'total', dataType: 'numeric', nullable: true, isPrimaryKey: false, generatedAlways: true, generatedAs: { expression: '(price * 2)', kind: 'stored' } },
			{ name: 'cents', dataType: 'bigint', nullable: true, isPrimaryKey: false, generatedAlways: true, generatedAs: { expression: '((price * 100))::bigint', kind: 'virtual' } },
		],
		primaryKey: [],
		foreignKeys: [],
	};
	const sql = tableDdl(t, 'postgres');
	assert.match(sql, /"total" numeric GENERATED ALWAYS AS \(\(price \* 2\)\) STORED NULL/);
	assert.match(sql, /"cents" bigint GENERATED ALWAYS AS \(\(\(price \* 100\)\)::bigint\) VIRTUAL NULL/);
	assert.doesNotMatch(sql, /DEFAULT/);
});

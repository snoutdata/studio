/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alterTableSql, createTableSql, tableDdl } from './ddl';
import { literalFromValue } from './dml';
import type { TableInfo } from '../../shared/schema';

test('ClickHouse designer: the key columns become the ORDER BY and are never Nullable', () => {
	const sql = createTableSql({ name: 'events', columns: [
		{ name: 'k', dataType: 'UInt32', nullable: true, isPrimaryKey: true, default: '' },
		{ name: 'v', dataType: 'String', nullable: true, isPrimaryKey: false, default: "'x'" },
	] }, 'clickhouse');
	// One clause per line, the way SHOW CREATE TABLE writes it: a table that also has a partition
	// key, a TTL and settings is unreadable on one line.
	assert.equal(sql, "CREATE TABLE `events` (\n  `k` UInt32,\n  `v` Nullable(String) DEFAULT 'x'\n) ENGINE = MergeTree\nORDER BY (`k`);");
});

test('ClickHouse designer: the engine, its partitioning, its TTL and a per-column codec', () => {
	const sql = createTableSql({
		schema: 'shop',
		name: 'events',
		columns: [
			{ name: 'ts', dataType: 'DateTime', nullable: true, isPrimaryKey: true, default: '', codec: 'Delta, ZSTD(3)' },
			{ name: 'body', dataType: 'String', nullable: false, isPrimaryKey: false, default: '', codec: 'CODEC(ZSTD(1))' },
		],
		engine: { engine: 'ReplacingMergeTree', parameter: 'ts', replicated: false, cluster: '', partitionBy: 'toYYYYMM(ts)', ttl: 'ts + INTERVAL 90 DAY', settings: 'index_granularity = 4096' },
	}, 'clickhouse');
	assert.equal(sql, [
		'CREATE TABLE `shop`.`events` (',
		'  `ts` DateTime CODEC(Delta, ZSTD(3)),',
		'  `body` String CODEC(ZSTD(1))',
		') ENGINE = ReplacingMergeTree(ts)',
		'PARTITION BY toYYYYMM(ts)',
		'ORDER BY (`ts`)',
		'TTL ts + INTERVAL 90 DAY',
		'SETTINGS index_granularity = 4096;',
	].join('\n'));
});

test('ClickHouse designer: created on every replica', () => {
	const sql = createTableSql({
		schema: 'shop',
		name: 'events',
		columns: [{ name: 'id', dataType: 'UInt64', nullable: false, isPrimaryKey: true, default: '' }],
		engine: { engine: 'MergeTree', parameter: '', replicated: true, cluster: 'default', partitionBy: '', ttl: '', settings: '' },
	}, 'clickhouse');
	assert.match(sql, /^CREATE TABLE `shop`\.`events` ON CLUSTER `default` \(/);
	assert.match(sql, /ENGINE = ReplicatedMergeTree\('\/clickhouse\/tables\/\{shard\}\/shop\/events', '\{replica\}'\)/);
});

test('ClickHouse designer: rename, retype, clear a default, add', () => {
	const original: TableInfo = { name: 't', kind: 'table', primaryKey: [], foreignKeys: [], columns: [
		{ name: 'v', dataType: 'Nullable(String)', nullable: true, isPrimaryKey: false, default: "'x'" },
	] };
	const sql = alterTableSql(original, { name: 't', columns: [
		{ originalName: 'v', name: 'val', dataType: 'Nullable(String)', nullable: false, isPrimaryKey: false, default: '' },
		{ name: 'n', dataType: 'Int64', nullable: true, isPrimaryKey: false, default: '' },
	] }, 'clickhouse');
	assert.equal(sql, [
		'ALTER TABLE `t` RENAME COLUMN `v` TO `val`;',
		'ALTER TABLE `t` MODIFY COLUMN `val` String;',
		'ALTER TABLE `t` MODIFY COLUMN `val` REMOVE DEFAULT;',
		'ALTER TABLE `t` ADD COLUMN `n` Nullable(Int64);',
	].join('\n'));
});

test('the DDL view shows the engine\'s own CREATE statement when there is one', () => {
	const table: TableInfo = { name: 'e', kind: 'table', primaryKey: [], foreignKeys: [], columns: [], createStatement: 'CREATE TABLE shop.e (`a` UInt8) ENGINE = MergeTree ORDER BY a' };
	assert.equal(tableDdl(table, 'clickhouse'), 'CREATE TABLE shop.e (`a` UInt8) ENGINE = MergeTree ORDER BY a;');
});

test('a string literal doubles backslashes where a backslash is an escape', () => {
	assert.equal(literalFromValue('a\\', 'clickhouse'), "'a\\\\'");
	assert.equal(literalFromValue('a\\', 'mysql-aurora'), "'a\\\\'");
	assert.equal(literalFromValue('a\\', 'postgres'), "'a\\'");
});

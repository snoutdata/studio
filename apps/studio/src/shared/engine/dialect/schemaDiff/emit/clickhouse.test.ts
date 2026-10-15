/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { TableInfo } from '../../../../schema';
import { clickhouseColumnType } from './clickhouse';
import { emitterFor } from './index';

const emitter = emitterFor('clickhouse', ['shop']);

describe('ClickHouse emitter', () => {
	test('a table described by columns becomes a MergeTree ordered by its key, which cannot be Nullable', () => {
		const table: TableInfo = {
			name: 'dest', kind: 'table', primaryKey: ['id'], foreignKeys: [],
			indexes: [{ name: 'by_email', columns: ['email'], unique: false }],
			columns: [
				{ name: 'id', dataType: 'Int64', nullable: true, isPrimaryKey: true },
				{ name: 'email', dataType: 'String', nullable: true, isPrimaryKey: false },
			],
		};
		const [sql] = emitter.emit({ kind: 'addTable', table });
		assert.match(sql, /`id` Int64,/);
		assert.match(sql, /`email` Nullable\(String\)/);
		assert.match(sql, /INDEX `by_email` email TYPE bloom_filter GRANULARITY 1/);
		assert.match(sql, /\) ENGINE = MergeTree ORDER BY \(`id`\)$/);
	});

	test('no key means ORDER BY tuple()', () => {
		const [sql] = emitter.emit({ kind: 'addTable', table: { name: 't', kind: 'table', primaryKey: [], foreignKeys: [], columns: [{ name: 'a', dataType: 'String', nullable: false, isPrimaryKey: false }] } });
		assert.match(sql, /ORDER BY tuple\(\)$/);
	});

	test('a table introspected with its own CREATE statement is copied from it, without the source database', () => {
		const createStatement = 'CREATE TABLE shop.events (`ts` DateTime) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY ts TTL ts + INTERVAL 30 DAY';
		const [sql] = emitter.emit({ kind: 'addTable', table: { name: 'events', schema: 'shop', kind: 'table', primaryKey: [], foreignKeys: [], columns: [], createStatement } });
		assert.equal(sql, 'CREATE TABLE events (`ts` DateTime) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY ts TTL ts + INTERVAL 30 DAY');
	});

	test('clearing a default takes its own REMOVE DEFAULT', () => {
		const before = { name: 'v', dataType: 'String', nullable: false, isPrimaryKey: false, default: "'x'" };
		const after = { ...before, default: null };
		assert.deepEqual(emitter.emit({ kind: 'alterColumn', table: 't', before, after }), [
			'ALTER TABLE `t` MODIFY COLUMN `v` String',
			'ALTER TABLE `t` MODIFY COLUMN `v` REMOVE DEFAULT',
		]);
	});

	test('a skip index keeps its own type', () => {
		assert.deepEqual(emitter.emit({ kind: 'addIndex', table: 't', index: { name: 'amt', columns: ['amount'], unique: false, method: 'minmax GRANULARITY 4' } }), [
			'ALTER TABLE `t` ADD INDEX `amt` amount TYPE minmax GRANULARITY 4',
		]);
	});

	test('the primary key cannot be changed in place, and says so', () => {
		assert.throws(() => emitter.emit({ kind: 'setPrimaryKey', table: 't', before: ['a'], after: ['b'] }), /cannot change the primary key/);
	});

	test('foreign keys do not exist here, so they emit nothing', () => {
		assert.deepEqual(emitter.emit({ kind: 'addForeignKey', table: 't', fk: { constraintName: 'f', columns: ['a'], referencedTable: 'u', referencedColumns: ['id'] } }), []);
	});
});

describe('clickhouseColumnType', () => {
	test('folds nullability into the type, both ways', () => {
		assert.equal(clickhouseColumnType({ name: 'a', dataType: 'String', nullable: true, isPrimaryKey: false }), 'Nullable(String)');
		assert.equal(clickhouseColumnType({ name: 'a', dataType: 'Nullable(String)', nullable: true, isPrimaryKey: false }), 'Nullable(String)');
		assert.equal(clickhouseColumnType({ name: 'a', dataType: 'Nullable(String)', nullable: false, isPrimaryKey: false }), 'String');
		assert.equal(clickhouseColumnType({ name: 'a', dataType: 'LowCardinality(Nullable(String))', nullable: false, isPrimaryKey: false }), 'LowCardinality(String)');
		assert.equal(clickhouseColumnType({ name: 'a', dataType: 'Array(String)', nullable: true, isPrimaryKey: false }), 'Array(String)');
	});
});

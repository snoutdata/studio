/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clickhouseMessage, writtenRows } from './clickhouseDriver';
import { clickhouseStructuralDigest, introspectClickHouse, type ClickHouseRowRunner } from './introspection';

const TABLES = [
	{ database: 'shop', name: 'events', engine: 'MergeTree', as_select: '', sorting_key: 'kind, ts', total_rows: '1000', total_bytes: '19091', comment: 'click events' },
	{ database: 'shop', name: 'big', engine: 'View', as_select: 'SELECT * FROM shop.events', sorting_key: '', total_rows: null, total_bytes: null, comment: '' },
];

const COLUMNS = [
	{ database: 'shop', table: 'events', name: 'ts', type: 'DateTime', default_kind: '', default_expression: '', comment: '' },
	{ database: 'shop', table: 'events', name: 'amount', type: 'Nullable(Float64)', default_kind: '', default_expression: '', comment: 'in cents' },
	{ database: 'shop', table: 'events', name: 'tag', type: 'LowCardinality(Nullable(String))', default_kind: 'DEFAULT', default_expression: "'x'", comment: '' },
	{ database: 'shop', table: 'big', name: 'ts', type: 'DateTime', default_kind: '', default_expression: '', comment: '' },
];

const run: ClickHouseRowRunner = async (sql) => (sql.includes('system.tables') ? TABLES : sql.includes('count()') ? [{ n: '4', h: '123' }] : COLUMNS);

describe('ClickHouse introspection', () => {
	test('a database is a schema, views carry their body, tables their sort key', async () => {
		const schema = await introspectClickHouse(run, 'shop', true);
		const events = schema.tables.find((t) => t.name === 'events');
		const big = schema.tables.find((t) => t.name === 'big');
		assert.equal(events?.schema, 'shop');
		assert.equal(events?.kind, 'table');
		assert.deepEqual(events?.stats, { rowCount: 1000, totalBytes: 19091, engine: 'MergeTree ORDER BY (kind, ts)' });
		assert.equal(events?.comment, 'click events');
		assert.equal(big?.kind, 'view');
		assert.equal(big?.definition, 'SELECT * FROM shop.events');
	});

	test('nullability comes from the type, including under LowCardinality', async () => {
		const schema = await introspectClickHouse(run, 'shop', true);
		const cols = schema.tables.find((t) => t.name === 'events')?.columns ?? [];
		assert.deepEqual(cols.map((c) => [c.name, c.nullable]), [['ts', false], ['amount', true], ['tag', true]]);
		assert.equal(cols[2].default, "'x'");
		assert.equal(cols[1].comment, 'in cents');
	});

	test('the sort key is never reported as a primary key, so no grid edit can hit many rows', async () => {
		const schema = await introspectClickHouse(run, 'shop', true);
		for (const table of schema.tables) {
			assert.deepEqual(table.primaryKey, []);
			assert.ok(table.columns.every((c) => !c.isPrimaryKey));
		}
	});

	test('key roles, codec and on-disk size come off the same rows', async () => {
		const tables = [{ database: 'shop', name: 'visits', engine: 'MergeTree', as_select: '', partition_key: 'toYYYYMM(ts)', primary_key: 'user', sorting_key: 'user, ts', sampling_key: 'user', total_rows: '10', total_bytes: '100', comment: '' }];
		const columns = [
			{ database: 'shop', table: 'visits', name: 'user', type: 'UInt64', default_kind: '', default_expression: '', comment: '', compression_codec: '', is_in_primary_key: 1, is_in_sorting_key: 1, data_compressed_bytes: '2048', data_uncompressed_bytes: '8192' },
			{ database: 'shop', table: 'visits', name: 'ts', type: 'DateTime', default_kind: '', default_expression: '', comment: '', compression_codec: 'CODEC(Delta(4), ZSTD(3))', is_in_primary_key: 0, is_in_sorting_key: 1, data_compressed_bytes: '0', data_uncompressed_bytes: '0' },
			{ database: 'shop', table: 'visits', name: 'v', type: 'Float64', default_kind: '', default_expression: '', comment: '', compression_codec: '', is_in_primary_key: '0', is_in_sorting_key: '0', data_compressed_bytes: '10', data_uncompressed_bytes: '80' },
		];
		const schema = await introspectClickHouse(async (sql) => (sql.includes('system.tables') ? tables : sql.includes('system.columns') ? columns : []), 'shop', true);
		const visits = schema.tables[0];
		assert.equal(visits.stats?.engine, 'MergeTree PARTITION BY (toYYYYMM(ts)) PRIMARY KEY (user) ORDER BY (user, ts) SAMPLE BY (user)');
		assert.deepEqual(visits.columns.map((c) => c.sortKey), ['primary', 'sort', undefined]);
		assert.equal(visits.columns[1].codec, 'CODEC(Delta(4), ZSTD(3))');
		assert.deepEqual(visits.columns[0].storedBytes, { compressed: 2048, uncompressed: 8192 });
		assert.equal(visits.columns[1].storedBytes, undefined);
		// Still never a primary key in the uniqueness sense.
		assert.ok(visits.columns.every((c) => !c.isPrimaryKey));
	});

	test('a materialized view carries both ends of its wiring, and a dictionary is not a table', async () => {
		const tables = [
			{ database: 'shop', name: 'events', engine: 'MergeTree', as_select: '', sorting_key: 'ts', total_rows: '10', total_bytes: '100', comment: '', dependencies_database: ['shop'], dependencies_table: ['daily_mv'] },
			{ database: 'shop', name: 'daily', engine: 'SummingMergeTree', as_select: '', sorting_key: 'day', total_rows: '2', total_bytes: '20', comment: '' },
			{ database: 'shop', name: 'daily_mv', engine: 'MaterializedView', as_select: 'SELECT toDate(ts) AS day FROM shop.events', sorting_key: '', total_rows: null, total_bytes: null, comment: '', create_table_query: 'CREATE MATERIALIZED VIEW shop.daily_mv TO shop.daily AS SELECT toDate(ts) AS day FROM shop.events' },
			{ database: 'shop', name: 'codes', engine: 'Dictionary', as_select: '', sorting_key: '', total_rows: null, total_bytes: null, comment: '', create_table_query: "CREATE DICTIONARY shop.codes (`code` String, `label` String) PRIMARY KEY code SOURCE(FILE(path '/x')) LAYOUT(COMPLEX_KEY_HASHED())" },
		];
		const dictionaries = [{ database: 'shop', name: 'codes', key_names: ['code'], key_types: ['String'], attribute_names: ['label'], attribute_types: ['String'] }];
		const schema = await introspectClickHouse(
			async (sql) => (sql.includes('system.dictionaries') ? dictionaries : sql.includes('system.tables') ? tables : []),
			'shop', true,
		);
		const byName = new Map(schema.tables.map((t) => [t.name, t]));
		assert.equal(byName.get('daily_mv')?.viewEngine, 'MaterializedView');
		assert.deepEqual(byName.get('daily_mv')?.lineage, {
			readsFrom: [{ schema: 'shop', name: 'events' }],
			writesTo: { schema: 'shop', name: 'daily' },
		});
		assert.deepEqual(byName.get('events')?.lineage?.feeds, [{ schema: 'shop', name: 'daily_mv' }]);
		assert.deepEqual(byName.get('daily')?.lineage?.writtenBy, [{ schema: 'shop', name: 'daily_mv' }]);
		// A dictionary has no parts, so no stats line pretending it is stored like a table.
		assert.equal(byName.get('codes')?.kind, 'dictionary');
		assert.equal(byName.get('codes')?.stats, undefined);
		assert.deepEqual(byName.get('codes')?.dictionary, { keyColumns: ['code'], attributes: [{ name: 'label', dataType: 'String' }], layout: 'COMPLEX_KEY_HASHED', sourceKind: 'FILE' });
	});

	test('a user refused system.dictionaries keeps the dictionary, without its key', async () => {
		const tables = [{ database: 'shop', name: 'codes', engine: 'Dictionary', as_select: '', sorting_key: '', total_rows: null, total_bytes: null, comment: '', create_table_query: 'CREATE DICTIONARY shop.codes (`code` String) PRIMARY KEY code LAYOUT(FLAT())' }];
		const schema = await introspectClickHouse(
			async (sql) => {
				if (sql.includes('system.dictionaries')) {
					throw new Error('Code: 497. Not enough privileges');
				}
				return sql.includes('system.tables') ? tables : [];
			},
			'shop', true,
		);
		assert.equal(schema.tables[0].kind, 'dictionary');
		assert.deepEqual(schema.tables[0].dictionary, { keyColumns: [], attributes: [], layout: 'FLAT' });
	});

	test('a JSON column is sampled with its names escaped, so a backslash before a backtick stays inside the quotes', async () => {
		const tables = [{ database: 'sh\\`op', name: 'ev\\`; DROP TABLE x; --', engine: 'MergeTree', as_select: '', sorting_key: '', total_rows: '1', total_bytes: '1', comment: '' }];
		const columns = [{ database: 'sh\\`op', table: 'ev\\`; DROP TABLE x; --', name: 'pay\\`load', type: 'JSON', default_kind: '', default_expression: '', comment: '' }];
		const sent: string[] = [];
		await introspectClickHouse(async (sql) => {
			sent.push(sql);
			return sql.includes('system.tables') ? tables : sql.includes('system.columns') ? columns : [];
		}, 'sh\\`op', true);
		const sample = sent.find((sql) => sql.includes('JSONAllPaths'));
		assert.ok(sample);
		assert.ok(sample.includes('JSONAllPaths(`pay\\\\``load`)'), sample);
		assert.ok(sample.includes('FROM `sh\\\\``op`.`ev\\\\``; DROP TABLE x; --`'), sample);
	});

	test('views are left out when not asked for', async () => {
		const schema = await introspectClickHouse(run, 'shop', false);
		assert.deepEqual(schema.tables.map((t) => t.name), ['events']);
	});

	test('digest is count and hash', async () => {
		assert.equal(await clickhouseStructuralDigest(run), '4:123');
	});
});

describe('ClickHouse HTTP answers', () => {
	test('the version tail is dropped from an error', () => {
		assert.equal(
			clickhouseMessage("Code: 60. DB::Exception: Unknown table 'nope'. (UNKNOWN_TABLE) (version 26.8.6.5 (official build))\n"),
			"Code: 60. DB::Exception: Unknown table 'nope'. (UNKNOWN_TABLE)",
		);
		assert.equal(clickhouseMessage('Code: 1. DB::Exception: x (version 25.3.1.1)'), 'Code: 1. DB::Exception: x');
	});

	test('written rows come from the summary header', () => {
		assert.equal(writtenRows('{"read_rows":"5","written_rows":"5"}'), 5);
		assert.equal(writtenRows(undefined), 0);
		assert.equal(writtenRows('not json'), 0);
	});
});

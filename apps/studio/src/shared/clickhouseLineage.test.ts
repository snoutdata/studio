/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clickhouseDictionary, clickhouseLineage, isRefreshableView, lineageKey, materializedViewTarget, type LineageRow } from './clickhouseLineage';

/** The shape the live server hands back (ClickHouse 26.8, the `shop` fixture database). */
const ROWS: LineageRow[] = [
	{
		database: 'shop', name: 'events', engine: 'MergeTree',
		dependencies_database: ['shop'], dependencies_table: ['daily_sales_mv'],
	},
	{ database: 'shop', name: 'daily_sales', engine: 'SummingMergeTree', dependencies_database: [], dependencies_table: [] },
	{
		database: 'shop', name: 'daily_sales_mv', engine: 'MaterializedView',
		create_table_query: 'CREATE MATERIALIZED VIEW shop.daily_sales_mv TO shop.daily_sales (`day` Date) AS SELECT toDate(ts) AS day FROM shop.events GROUP BY day',
		dependencies_database: [], dependencies_table: [],
	},
	{
		database: 'shop', name: 'top_urls_mv', engine: 'MaterializedView',
		create_table_query: 'CREATE MATERIALIZED VIEW shop.top_urls_mv REFRESH EVERY 1 HOUR (`url` String) ENGINE = MergeTree ORDER BY url AS SELECT url FROM shop.events',
		dependencies_database: [], dependencies_table: [],
	},
	{
		database: 'shop', name: 'users', engine: 'ReplacingMergeTree',
		dependencies_database: ['shop'], dependencies_table: ['user_count_mv'],
	},
	{
		database: 'shop', name: 'user_count_mv', engine: 'MaterializedView',
		create_table_query: 'CREATE MATERIALIZED VIEW shop.user_count_mv (`country` String) ENGINE = SummingMergeTree ORDER BY country AS SELECT country FROM shop.users',
		dependencies_database: [], dependencies_table: [],
	},
];

describe('ClickHouse lineage', () => {
	test('both ends of an insert-trigger view, from one pass over the rows', () => {
		const map = clickhouseLineage(ROWS);
		assert.deepEqual(map.get(lineageKey('shop', 'daily_sales_mv')), {
			readsFrom: [{ schema: 'shop', name: 'events' }],
			writesTo: { schema: 'shop', name: 'daily_sales' },
		});
		// The source knows what writing to it also writes to, which is the whole point.
		assert.deepEqual(map.get(lineageKey('shop', 'events'))?.feeds, [{ schema: 'shop', name: 'daily_sales_mv' }]);
		// And the target knows where its rows come from: nobody inserts into it by hand.
		assert.deepEqual(map.get(lineageKey('shop', 'daily_sales'))?.writtenBy, [{ schema: 'shop', name: 'daily_sales_mv' }]);
	});

	test('a view with no TO owns an inner table, so it writes nowhere worth naming', () => {
		const view = clickhouseLineage(ROWS).get(lineageKey('shop', 'user_count_mv'));
		assert.deepEqual(view?.readsFrom, [{ schema: 'shop', name: 'users' }]);
		assert.equal(view?.writesTo, undefined);
	});

	test('a refreshable view is not an insert trigger, so its sources are unknown and it says so', () => {
		// The server records NO dependency for one. An empty readsFrom would read as "nothing
		// feeds it", which is a different and wrong statement.
		const view = clickhouseLineage(ROWS).get(lineageKey('shop', 'top_urls_mv'));
		assert.equal(view?.refreshable, true);
		assert.equal(view?.readsFrom, undefined);
		assert.equal(clickhouseLineage(ROWS).get(lineageKey('shop', 'events'))?.feeds?.length, 1);
	});

	test('an object with nothing to say gets no entry at all', () => {
		assert.equal(clickhouseLineage([{ database: 'shop', name: 'archive', engine: 'MergeTree' }]).size, 0);
	});
});

describe('materializedViewTarget', () => {
	test('reads the TO target, quoted or not, and defaults the database to the view\'s own', () => {
		assert.deepEqual(materializedViewTarget('CREATE MATERIALIZED VIEW a.v TO b.t AS SELECT 1', 'a'), { schema: 'b', name: 't' });
		assert.deepEqual(materializedViewTarget('CREATE MATERIALIZED VIEW `a`.`v` TO `b b`.`t.t` AS SELECT 1', 'a'), { schema: 'b b', name: 't.t' });
		assert.deepEqual(materializedViewTarget('CREATE MATERIALIZED VIEW v TO t AS SELECT 1', 'a'), { schema: 'a', name: 't' });
		assert.deepEqual(materializedViewTarget('CREATE MATERIALIZED VIEW IF NOT EXISTS a.v TO b.t AS SELECT 1', 'a'), { schema: 'b', name: 't' });
	});

	test('no TO clause is no target, and a TO inside the SELECT is not one either', () => {
		assert.equal(materializedViewTarget('CREATE MATERIALIZED VIEW a.v (`x` UInt8) ENGINE = MergeTree ORDER BY x AS SELECT 1 AS x', 'a'), undefined);
		// `toDate` and a column called `to` both live in the body; only the clause after the name counts.
		assert.equal(materializedViewTarget('CREATE MATERIALIZED VIEW a.v ENGINE = Memory AS SELECT toDate(ts) FROM a.e', 'a'), undefined);
		assert.equal(materializedViewTarget(undefined, 'a'), undefined);
	});
});

describe('isRefreshableView', () => {
	test('REFRESH EVERY and REFRESH AFTER, and nothing else', () => {
		assert.equal(isRefreshableView('CREATE MATERIALIZED VIEW a.v REFRESH EVERY 1 HOUR AS SELECT 1'), true);
		assert.equal(isRefreshableView('CREATE MATERIALIZED VIEW a.v REFRESH AFTER 1 MINUTE AS SELECT 1'), true);
		assert.equal(isRefreshableView('CREATE MATERIALIZED VIEW a.v TO b.t AS SELECT 1'), false);
	});
});

describe('clickhouseDictionary', () => {
	const create = "CREATE DICTIONARY shop.country_names (`code` String, `name` String) PRIMARY KEY code SOURCE(CLICKHOUSE(QUERY 'SELECT 1' USER 'default' PASSWORD '[HIDDEN]')) LIFETIME(MIN 0 MAX 300) LAYOUT(COMPLEX_KEY_HASHED())";

	test('key and attributes come from the catalog, layout and source kind from the DDL', () => {
		const info = clickhouseDictionary(
			{ database: 'shop', name: 'country_names', key_names: ['code'], key_types: ['String'], attribute_names: ['name'], attribute_types: ['String'] },
			create,
		);
		assert.deepEqual(info, { keyColumns: ['code'], attributes: [{ name: 'name', dataType: 'String' }], layout: 'COMPLEX_KEY_HASHED', sourceKind: 'CLICKHOUSE' });
	});

	test('the source kind is the only thing taken from SOURCE, because the clause holds credentials', () => {
		const info = clickhouseDictionary({ database: 'd', name: 'n', key_names: ['id'] }, create);
		assert.equal(info?.sourceKind, 'CLICKHOUSE');
		assert.ok(!JSON.stringify(info).includes('PASSWORD'));
		assert.ok(!JSON.stringify(info).includes('default'));
	});

	test('a dictionary the user cannot read system.dictionaries for still gets its layout', () => {
		assert.deepEqual(clickhouseDictionary(undefined, create), { keyColumns: [], attributes: [], layout: 'COMPLEX_KEY_HASHED', sourceKind: 'CLICKHOUSE' });
		assert.equal(clickhouseDictionary(undefined, undefined), undefined);
	});
});

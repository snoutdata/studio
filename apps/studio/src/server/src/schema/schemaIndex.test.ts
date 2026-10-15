/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseSchema } from '../../../shared/schema';
import { marked } from 'marked';
import { buildSchemaIndex, describeColumn, describeTable, inferredJoinEdges, joinEdges, markdownCode, markdownText } from './schemaIndex';

const schema: DatabaseSchema = {
	database: 'shop',
	fetchedAt: 0,
	tables: [
		{
			name: 'orders',
			schema: 'shop',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'customer_id', dataType: 'int', nullable: false, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [{ constraintName: 'fk_customer', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] }],
		},
		{
			name: 'customers',
			schema: 'shop',
			kind: 'table',
			columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
			primaryKey: ['id'],
			foreignKeys: [],
		},
	],
};

describe('buildSchemaIndex', () => {
	const index = buildSchemaIndex([schema]);

	test('lookups by name, database, and the distinct database list', () => {
		assert.deepStrictEqual(
			{
				orders: index.find('ORDERS')?.table.name,
				inShop: index.inDatabase('shop').map((entry) => entry.table.name),
				databases: index.databases,
				missing: index.findByName('nope'),
			},
			{ orders: 'orders', inShop: ['orders', 'customers'], databases: ['shop'], missing: [] },
		);
	});
});

describe('joinEdges', () => {
	const index = buildSchemaIndex([schema]);
	const project = (source: string) =>
		joinEdges(index.find(source)!, index).map((edge) => ({ target: edge.target.table.name, on: edge.on }));

	test('outgoing FK edge from the referencing table', () => {
		assert.deepStrictEqual(project('orders'), [{ target: 'customers', on: [{ from: 'customer_id', to: 'id' }] }]);
	});

	test('incoming FK edge is surfaced from the referenced table too', () => {
		assert.deepStrictEqual(project('customers'), [{ target: 'orders', on: [{ from: 'id', to: 'customer_id' }] }]);
	});
});

// A schema with no declared foreign keys at all — only naming conventions to go on.
const noFkSchema: DatabaseSchema = {
	database: 'blog',
	fetchedAt: 0,
	tables: [
		{
			name: 'posts',
			schema: 'blog',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'user_id', dataType: 'int', nullable: false, isPrimaryKey: false },
				{ name: 'tag_id', dataType: 'int', nullable: true, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [],
		},
		{
			name: 'users',
			schema: 'blog',
			kind: 'table',
			columns: [{ name: 'id', dataType: 'int unsigned', nullable: false, isPrimaryKey: true }],
			primaryKey: ['id'],
			foreignKeys: [],
		},
		{
			name: 'comments',
			schema: 'blog',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'post_id', dataType: 'int', nullable: false, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [],
		},
		{
			name: 'tags',
			schema: 'blog',
			kind: 'table',
			columns: [{ name: 'id', dataType: 'varchar(36)', nullable: false, isPrimaryKey: true }],
			primaryKey: ['id'],
			foreignKeys: [],
		},
	],
};

describe('inferredJoinEdges', () => {
	const index = buildSchemaIndex([noFkSchema]);
	const project = (source: string) =>
		inferredJoinEdges(index.find(source)!, index).map((edge) => ({ target: edge.target.table.name, on: edge.on }));

	test('infers outgoing <x>_id → x (modulo plural, modulo int width) and incoming refs', () => {
		// posts.user_id → users.id (int vs int unsigned still joinable); incoming comments.post_id.
		// posts.tag_id is dropped: tags.id is varchar, not type-compatible with an int column.
		assert.deepStrictEqual(project('posts'), [
			{ target: 'users', on: [{ from: 'user_id', to: 'id' }] },
			{ target: 'comments', on: [{ from: 'id', to: 'post_id' }] },
		]);
	});

	test('all inferred edges carry the inferred flag', () => {
		assert.ok(inferredJoinEdges(index.find('posts')!, index).every((edge) => edge.inferred === true));
	});

	test('incoming inference matches the singularized table name', () => {
		assert.deepStrictEqual(project('users'), [{ target: 'posts', on: [{ from: 'id', to: 'user_id' }] }]);
	});
});

describe('hover text for a ClickHouse column and table', () => {
	const table = {
		name: 'visits', kind: 'table' as const, primaryKey: [], foreignKeys: [],
		stats: { engine: 'MergeTree PRIMARY KEY (user) ORDER BY (user, ts)' },
		columns: [
			{ name: 'user', dataType: 'UInt64', nullable: false, isPrimaryKey: false, sortKey: 'primary' as const, storedBytes: { compressed: 2048, uncompressed: 8192 } },
			{ name: 'ts', dataType: 'DateTime', nullable: false, isPrimaryKey: false, sortKey: 'sort' as const, codec: 'CODEC(Delta(4), ZSTD(3))' },
		],
	};
	test('says where the column is in the key, its codec and its size on disk', () => {
		const user = describeColumn({ table, database: 'shop' }, table.columns[0]);
		assert.match(user, /sort key, in the primary index/);
		assert.match(user, /on disk: 2\.0 KB compressed, 8\.0 KB raw \(4\.0x\)/);
		const ts = describeColumn({ table, database: 'shop' }, table.columns[1]);
		assert.match(ts, /· sort key$/m);
		assert.match(ts, /codec: `CODEC\(Delta\(4\), ZSTD\(3\)\)`/);
	});
	test('the table says its engine line', () => {
		assert.match(describeTable({ table, database: 'shop' }), /engine: `MergeTree PRIMARY KEY \(user\) ORDER BY \(user, ts\)`/);
	});
});

describe('database text in hover and completion docs is plain text, never markup', () => {
	// Rendered the way Monaco renders hover markdown (marked, GFM), then checked for anything that
	// would fetch or navigate. A comment image with a host is an SMB fetch on Windows.
	const beacon = '![](file://attacker.example/share/x.png) [docs](https://attacker.example) <img src="file://h/s/y.png"> www.attacker.example';
	const table = {
		name: 'orders![](file://h/s/t.png)', kind: 'table' as const, primaryKey: ['id'], foreignKeys: [], comment: beacon,
		columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, comment: beacon, default: "x`` ![](file://h/s/d.png) ``\n\n![](file://h/s/e.png)" }],
	};
	function html(markdown: string): string {
		return marked.parse(markdown, { async: false, gfm: true }) as string;
	}

	test('a column comment, a name or a default can carry no image and no link', () => {
		for (const markdown of [describeColumn({ table, database: 'shop' }, table.columns[0]), describeTable({ table, database: 'shop' })]) {
			const rendered = html(markdown);
			assert.doesNotMatch(rendered, /<img/i, rendered);
			assert.doesNotMatch(rendered, /<a /i, rendered);
			assert.match(rendered, /file:\/\/attacker\.example\/share\/x\.png/, 'the words are still there, as text');
		}
	});

	test('the escapes keep the text as written', () => {
		assert.equal(markdownText('a_b*c'), 'a\\_b\\*c');
		assert.equal(markdownCode('a`b'), '``a`b``');
		assert.equal(markdownCode('`x'), '`` `x ``');
		assert.match(html(describeColumn({ table, database: 'shop' }, table.columns[0])), /<strong>orders!\[\]\(file:\/\/h\/s\/t\.png\)\.id<\/strong>/);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import type { CompletionItem } from 'vscode-languageserver/node';

import type { DatabaseSchema } from '../../../shared/schema';
import { emptyCatalog, type DialectCatalog } from '../../../shared/catalog';
import { buildCompletions, resolveCompletion } from './completionProvider';
import type { CompletionContext, FromRef } from './sqlAnalyzer';

// orders ──(declared FK)──▶ customers ; order_item.order_id ──(no FK, convention only)──▶ orders
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
		{
			name: 'order_item',
			schema: 'shop',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'order_id', dataType: 'int', nullable: false, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [],
		},
	],
};

function joinSuggestions(from: FromRef[]): CompletionItem[] {
	const context: CompletionContext = { kind: 'table', from, ctes: [], joining: true, word: '' };
	return buildCompletions(context, [schema]).items.filter((item) => item.kind === CompletionItemKind.Snippet);
}

describe('join completions', () => {
	test('aliases the joined table and emits a mirrored-tabstop snippet for a declared FK', () => {
		const item = joinSuggestions([{ table: 'orders', alias: 'o' }]).find((i) => i.label.startsWith('customers'));
		assert.ok(item, 'expected a customers JOIN suggestion');
		assert.equal(item.label, 'customers c ON o.customer_id = c.id');
		assert.equal(item.insertText, 'customers ${1:c} ON o.customer_id = ${1:c}.id');
		assert.equal(item.insertTextFormat, InsertTextFormat.Snippet);
		assert.equal(item.detail, 'JOIN via FK · shop');
		assert.equal(item.sortText, '0_customers');
	});

	test('infers a JOIN from naming convention when no FK is declared, ranked below FKs', () => {
		const item = joinSuggestions([{ table: 'orders', alias: 'o' }]).find((i) => i.label.startsWith('order_item'));
		assert.ok(item, 'expected an inferred order_item JOIN suggestion');
		assert.equal(item.insertText, 'order_item ${1:oi} ON o.id = ${1:oi}.order_id');
		assert.equal(item.detail, 'JOIN (inferred) · shop');
		assert.equal(item.sortText, '1_order_item');
	});

	test('a declared FK is not also offered as an inferred duplicate', () => {
		const customers = joinSuggestions([{ table: 'orders', alias: 'o' }]).filter((i) => i.label.startsWith('customers'));
		assert.equal(customers.length, 1);
	});

	test('the generated alias is unique against aliases already in scope', () => {
		// `c` is taken by another relation, so customers must fall back to `c2`.
		const item = joinSuggestions([{ table: 'orders', alias: 'o' }, { table: 'coupon', alias: 'c' }]).find((i) => i.label.startsWith('customers'));
		assert.ok(item);
		assert.equal(item.insertText, 'customers ${1:c2} ON o.customer_id = ${1:c2}.id');
	});
});

// A cloud log scope is a table whose name is not a SQL name.
const logSchema: DatabaseSchema = {
	database: 'us-west-2',
	fetchedAt: 0,
	tables: [
		{
			name: '/aws/lambda/checkout',
			schema: 'us-west-2',
			kind: 'table',
			columns: [
				{ name: 'ts', dataType: 'timestamp', nullable: false, isPrimaryKey: false },
				{ name: 'message', dataType: 'string', nullable: true, isPrimaryKey: false },
			],
			primaryKey: [],
			foreignKeys: [],
		},
	],
};

describe('a name that is not a plain SQL name', () => {
	function tableItems(driverId?: string): CompletionItem[] {
		return buildCompletions({ kind: 'table', from: [], ctes: [], joining: false, word: '' }, [logSchema], { driverId })
			.items.filter((item) => item.kind === CompletionItemKind.Struct);
	}

	test('is inserted quoted, in the connection\'s own quoting character', () => {
		// Inserted bare, `/aws/lambda/checkout` does not parse — and that was the whole of the user
		// having to add the quotes by hand after every completion.
		const cloudwatch = tableItems('cloudwatch').find((item) => item.label === '/aws/lambda/checkout');
		assert.ok(cloudwatch);
		assert.equal(cloudwatch.insertText, '"/aws/lambda/checkout"');
		// The label stays the bare name, and filtering matches what the user types, not the quotes.
		assert.equal(cloudwatch.filterText, '/aws/lambda/checkout');
		// MySQL would spell the same name with backticks.
		assert.equal(tableItems('mysql-aurora')[0].insertText, '`/aws/lambda/checkout`');
	});

	test('a plain name is left exactly as it was', () => {
		const orders = buildCompletions({ kind: 'table', from: [], ctes: [], joining: false, word: '' }, [schema], { driverId: 'postgres' })
			.items.find((item) => item.label === 'orders');
		assert.ok(orders);
		assert.equal(orders.insertText, undefined, 'a plain name needs no insertText of its own');
	});
});

describe('ranking in an expression position', () => {
	// `SELECT * FROM orders WHERE …` — the columns of the table the statement already named are
	// what the user is reaching for, and before the ranks they came back tied with the keyword
	// list and every table in the database, so Monaco fell back to the label and sank them.
	// Aliasing the table and typing `a.` was the only way to see them, which is what was reported.
	const from: FromRef[] = [{ table: 'orders' }];
	const items = buildCompletions({ kind: 'expression', from, ctes: [], word: '' }, [schema]).items;
	const rank = (label: string): string => {
		const item = items.find((i) => i.label === label);
		assert.ok(item, `${label} missing from the suggestions`);
		assert.ok(item.sortText, `${label} has no sortText`);
		return item.sortText;
	};

	test('an in-scope column outranks every keyword and every table', () => {
		assert.ok(rank('customer_id') < rank('WHERE'), 'a column must sort before a keyword');
		assert.ok(rank('customer_id') < rank('customers'), 'a column must sort before an out-of-scope table');
	});

	test('a keyword still outranks the table list', () => {
		// Otherwise typing `sel` on a fresh line would rank a table named `sellers` over SELECT.
		assert.ok(rank('SELECT') < rank('customers'));
	});
});

describe('ranking at a JOIN position', () => {
	const items = buildCompletions({ kind: 'table', from: [{ table: 'orders' }], ctes: [], joining: true, word: '' }, [schema]).items;

	test('a join suggestion outranks the plain table list', () => {
		const join = items.find((item) => item.kind === CompletionItemKind.Snippet);
		const table = items.find((item) => item.label === 'customers' && item.kind === CompletionItemKind.Struct);
		assert.ok(join?.sortText && table?.sortText);
		assert.ok(join.sortText < table.sortText);
	});
});

// What the ENGINE knows, beside what the database holds: ClickHouse's ~1,900 functions, its
// combinators, its settings, its formats and its engines, read from the live server.
const catalog: DialectCatalog = {
	...emptyCatalog('clickhouse'),
	functions: [
		{ name: 'count', aggregate: true, syntax: 'count()' },
		{ name: 'countIf', aggregate: true },
		{ name: 'toStartOfHour' },
		{ name: 'sum', aggregate: true },
	],
	combinators: [{ name: 'If' }, { name: 'State' }],
	tableFunctions: [{ name: 's3', description: 'Reads files from S3.' }],
	tableEngines: [{ name: 'MergeTree', supports: 'sort order, TTL' }],
	dataTypes: [{ name: 'UInt64' }, { name: 'LowCardinality' }],
	formats: [{ name: 'JSONEachRow', input: true, output: true }, { name: 'Protobuf', input: true, output: false }],
	settings: [{ name: 'max_threads', value: '8', valueType: 'MaxThreads' }],
};

function labels(answer: { items: CompletionItem[] }): string[] {
	return answer.items.map((item) => String(item.label));
}

describe('what the engine says it knows', () => {
	const options = { driverId: 'clickhouse', catalog };

	test('functions are offered in an expression, narrowed to the word typed', () => {
		const answer = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'cou' }, [schema], options);
		assert.ok(labels(answer).includes('count'));
		assert.ok(!labels(answer).includes('toStartOfHour'));
	});

	// The list is cut to the typed word server-side, so the editor MUST come back for the next
	// keystroke instead of filtering a list that was cut for the previous one.
	test('an answer carrying catalog names says it is incomplete', () => {
		assert.equal(buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'cou' }, [schema], options).isIncomplete, true);
		assert.equal(buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'cou' }, [schema]).isIncomplete, false);
	});

	// `sumIf` is in no system table: a combinator is a suffix the parser applies to any aggregate.
	test('an aggregate is offered with its combinators, and a plain function is not', () => {
		const answer = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'sum' }, [schema], options);
		assert.deepEqual(labels(answer).filter((label) => label.startsWith('sum')).sort(), ['sum', 'sumIf', 'sumState']);
		const plain = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'toStartOf' }, [schema], options);
		assert.deepEqual(labels(plain).filter((label) => label.startsWith('toStartOf')), ['toStartOfHour']);
	});

	test('a function completes with its parens, unless the buffer already has them', () => {
		const bare = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'count' }, [schema], options);
		assert.equal(bare.items.find((item) => item.label === 'count')?.insertText, 'count($0)');
		const typed = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'count', followedByParen: true }, [schema], options);
		assert.equal(typed.items.find((item) => item.label === 'count')?.insertText, undefined);
	});

	test('a table position also offers the table functions', () => {
		const answer = buildCompletions({ kind: 'table', from: [], ctes: [], joining: false, word: 's' }, [schema], options);
		assert.ok(labels(answer).includes('s3'));
	});

	test('the keywords this vendor adds are offered beside the shared ones', () => {
		const answer = buildCompletions({ kind: 'expression', from: [], ctes: [], word: '' }, [schema], options);
		assert.ok(labels(answer).includes('PREWHERE'));
		assert.ok(labels(answer).includes('SELECT'));
	});

	test('a catalog slot offers that list and nothing else', () => {
		const settings = buildCompletions({ kind: 'catalog', slot: 'setting', from: [], ctes: [], word: '' }, [schema], options);
		assert.deepEqual(labels(settings), ['max_threads']);
		const engines = buildCompletions({ kind: 'catalog', slot: 'engine', from: [], ctes: [], word: '' }, [schema], options);
		assert.deepEqual(labels(engines), ['MergeTree']);
		const types = buildCompletions({ kind: 'catalog', slot: 'dataType', from: [], ctes: [], word: 'Low' }, [schema], options);
		assert.deepEqual(labels(types), ['LowCardinality']);
	});

	// A SELECT's FORMAT has to be one the server can write; Protobuf here can only be read.
	test('a format that cannot be written is not offered as one', () => {
		const answer = buildCompletions({ kind: 'catalog', slot: 'format', from: [], ctes: [], word: '' }, [schema], options);
		assert.deepEqual(labels(answer), ['JSONEachRow']);
	});

	// A slot with nothing in it was a misreading, or the engine has no catalog at all. Either way
	// the usual suggestions are better than an empty list.
	test('a slot with nothing to offer falls back to the ordinary suggestions', () => {
		const answer = buildCompletions({ kind: 'catalog', slot: 'setting', from: [{ table: 'orders' }], ctes: [], word: '' }, [schema]);
		assert.ok(labels(answer).includes('customer_id'));
	});

	test('another vendor\'s catalog is never shown on this connection', () => {
		const answer = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'cou' }, [schema], { driverId: 'postgres', catalog });
		assert.ok(!labels(answer).includes('count'));
	});

	test('the documentation is fetched on resolve, not sent with every keystroke', () => {
		const answer = buildCompletions({ kind: 'expression', from: [], ctes: [], word: 'count' }, [schema], options);
		const item = answer.items.find((entry) => entry.label === 'count');
		assert.ok(item);
		assert.equal(item.documentation, undefined);
		const resolved = resolveCompletion({ ...item }, [schema], [catalog]);
		assert.match(String((resolved.documentation as { value: string }).value), /\*\*count\*\*/);
	});
});

// What is INSIDE a column: a Tuple's fields and a Map's keys come free from the declared type; a
// JSON column's paths were sampled from the data at introspection.
const compositeSchema: DatabaseSchema = {
	database: 'shop',
	fetchedAt: 0,
	tables: [{
		name: 'events',
		schema: 'shop',
		kind: 'table',
		columns: [
			{ name: 'id', dataType: 'UInt64', nullable: false, isPrimaryKey: false },
			{ name: 'who', dataType: 'Tuple(id UInt64, name String)', nullable: false, isPrimaryKey: false },
			{ name: 'tags', dataType: 'Map(String, UInt8)', nullable: false, isPrimaryKey: false },
			{ name: 'payload', dataType: 'JSON', nullable: false, isPrimaryKey: false, dynamicPaths: [{ name: 'user.id' }, { name: 'user.email' }, { name: 'total' }] },
		],
		primaryKey: [],
		foreignKeys: [],
	}],
};

describe('completing what is inside a column', () => {
	const from: FromRef[] = [{ table: 'events', alias: 'e' }];
	function inside(path: string[]): string[] {
		return buildCompletions({ kind: 'qualifier', qualifier: path[path.length - 1], qualifierPath: path, from, ctes: [], word: '' }, [compositeSchema])
			.items.map((item) => String(item.label));
	}

	test('a tuple offers its fields, with their types, from the type alone', () => {
		assert.deepEqual(inside(['e', 'who']), ['id', 'name']);
	});

	test('a map offers what ClickHouse can actually select off it', () => {
		assert.deepEqual(inside(['e', 'tags']), ['keys', 'values', 'size0']);
	});

	test('a JSON column offers the paths the sample held, one segment at a time', () => {
		assert.deepEqual(inside(['e', 'payload']), ['user', 'total']);
		assert.deepEqual(inside(['e', 'payload', 'user']), ['id', 'email']);
	});

	test('the column need not be qualified by its table', () => {
		assert.deepEqual(inside(['who']), ['id', 'name']);
	});

	// Everything that is not a chain into a column has to go on resolving as it always did.
	test('an alias on its own is still the table\'s columns', () => {
		assert.deepEqual(inside(['e']), ['id', 'who', 'tags', 'payload']);
	});

	// A scalar has nothing inside it, and `e.id.` is not a thing that can be completed. It resolves
	// exactly as it did before this existed: as a qualifier that names nothing.
	test('a column with nothing inside offers nothing', () => {
		assert.deepEqual(inside(['e', 'id']), []);
	});
});

// `dictGet('shop.country_names', 'name', code)` is the only place in the language where a schema
// object is addressed by a quoted STRING, which is why nothing else offered it and a name typed
// wrong there fails at runtime rather than under a red squiggle.
describe('completing a dictGet argument', () => {
	const withDictionaries: DatabaseSchema = {
		database: 'shop',
		fetchedAt: 0,
		tables: [
			{
				name: 'country_names', schema: 'shop', kind: 'dictionary', columns: [], primaryKey: [], foreignKeys: [],
				dictionary: { keyColumns: ['code'], attributes: [{ name: 'label', dataType: 'String' }, { name: 'iso3', dataType: 'FixedString(3)' }], layout: 'COMPLEX_KEY_HASHED', sourceKind: 'CLICKHOUSE' },
			},
			{ name: 'geo_ids', schema: 'other', kind: 'dictionary', columns: [], primaryKey: [], foreignKeys: [], dictionary: { keyColumns: ['id'], attributes: [{ name: 'city', dataType: 'String' }] } },
			{ name: 'events', schema: 'shop', kind: 'table', columns: [{ name: 'code', dataType: 'String', nullable: false, isPrimaryKey: false }], primaryKey: [], foreignKeys: [] },
		],
	};
	function items(context: Partial<CompletionContext> & { slot: 'name' | 'attribute' }): CompletionItem[] {
		return buildCompletions({ kind: 'dictionary', from: [], ctes: [], word: '', ...context } as CompletionContext, [withDictionaries]).items;
	}

	test('the name slot offers every dictionary, qualified, because a bare name needs the right session database', () => {
		const names = items({ slot: 'name' }).map((item) => item.insertText);
		assert.deepEqual(names, ['shop.country_names', 'other.geo_ids']);
		assert.match(String(items({ slot: 'name' })[0].detail), /keyed by code/);
	});

	test('a database already typed narrows to it and drops the prefix, so it is not written twice', () => {
		// Monaco's word range starts after the dot: inserting the qualified name there would give
		// `dictGet('shop.shop.country_names`.
		assert.deepEqual(items({ slot: 'name', word: 'shop.' }).map((item) => item.insertText), ['country_names']);
		assert.deepEqual(items({ slot: 'name', word: 'other.ge' }).map((item) => item.insertText), ['geo_ids']);
	});

	test('the attribute slot is that one dictionary\'s attributes, with their types', () => {
		const attrs = items({ slot: 'attribute', dictionary: 'shop.country_names' });
		assert.deepEqual(attrs.map((item) => item.label), ['label', 'iso3']);
		assert.equal(attrs[1].detail, 'FixedString(3)');
		// Unqualified too: that is legal when the session is already in the database.
		assert.deepEqual(items({ slot: 'attribute', dictionary: 'country_names' }).map((item) => item.label), ['label', 'iso3']);
	});

	// A name that matches nothing, or a connection with no dictionaries at all, must not leave the
	// user staring at an empty list where the ordinary suggestions would have been useful.
	test('a dictionary that is not there falls back to the ordinary suggestions', () => {
		assert.deepEqual(items({ slot: 'attribute', dictionary: 'no_such_dict' }).map((item) => item.label).includes('label'), false);
		assert.ok(items({ slot: 'attribute', dictionary: 'no_such_dict' }).length > 0);
		assert.equal(buildCompletions({ kind: 'dictionary', slot: 'name', from: [], ctes: [], word: '' }, [schema]).items.some((i) => i.detail === 'dictionary'), false);
	});
});

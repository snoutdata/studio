/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Hover over a name the schema does not know: the engine's own catalog answers instead.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyCatalog, type DialectCatalog } from '../../../shared/catalog';
import type { DatabaseSchema } from '../../../shared/schema';
import { buildHover } from './hoverProvider';

const schema: DatabaseSchema = {
	database: 'shop',
	fetchedAt: 0,
	tables: [
		{
			name: 'events',
			schema: 'shop',
			kind: 'table',
			columns: [{ name: 'ts', dataType: 'DateTime', nullable: false, isPrimaryKey: false }],
			primaryKey: [],
			foreignKeys: [],
		},
		// A table really named `sum`. The user's table outranks ClickHouse's aggregate.
		{ name: 'sum', schema: 'shop', kind: 'table', columns: [], primaryKey: [], foreignKeys: [] },
	],
};

const catalog: DialectCatalog = {
	...emptyCatalog('clickhouse'),
	functions: [
		{ name: 'sum', aggregate: true, description: 'Calculates the sum.' },
		{ name: 'toStartOfHour', description: 'Rounds a time down to the hour.' },
	],
	combinators: [{ name: 'If', description: 'Takes an extra condition argument.' }],
	dataTypes: [{ name: 'UInt64', description: 'An unsigned 64-bit integer.' }],
	tableEngines: [{ name: 'MergeTree', description: 'The one you want.' }],
	settings: [{ name: 'max_threads', value: '8', valueType: 'MaxThreads', description: 'How many threads.' }],
	formats: [{ name: 'JSONEachRow', input: true, output: true, description: 'One JSON object per line.' }],
};

function hoverText(sql: string, at: number): string {
	const hover = buildHover(sql, at, [schema], catalog);
	return hover ? String((hover.contents as { value: string }).value) : '';
}

describe('hovering a name the engine knows', () => {
	test('a function is described in the server\'s own words', () => {
		assert.match(hoverText('SELECT toStartOfHour(ts) FROM events', 10), /Rounds a time down to the hour\\\./);
	});

	// `sumIf` is in no system table: it is an aggregate wearing a combinator, built by the parser.
	test('an aggregate with a combinator is taken apart and described', () => {
		const doc = hoverText('SELECT sumIf(x, y) FROM events', 9);
		assert.match(doc, /`sum` with the `If` combinator/);
		assert.match(doc, /Takes an extra condition argument\\\./);
	});

	test('a type, an engine, a setting and a format all answer', () => {
		assert.match(hoverText('CREATE TABLE t (id UInt64) ENGINE = MergeTree', 21), /unsigned 64\\-bit integer/);
		assert.match(hoverText('CREATE TABLE t (id UInt64) ENGINE = MergeTree', 38), /The one you want\\\./);
		assert.match(hoverText('SELECT 1 SETTINGS max_threads = 4', 20), /How many threads\\\./);
		assert.match(hoverText('SELECT * FROM events FORMAT JSONEachRow', 30), /One JSON object per line\\\./);
	});

	// The schema is asked first, always: a table named `sum` is the user's table.
	test('the database wins over the engine when both know the name', () => {
		assert.match(hoverText('SELECT * FROM sum', 15), /\*\*shop\.sum\*\* _\(table\)_/);
		assert.doesNotMatch(hoverText('SELECT * FROM sum', 15), /Calculates the sum/);
	});

	test('a connection with no catalog behaves exactly as it did', () => {
		assert.equal(buildHover('SELECT toStartOfHour(ts) FROM events', 10, [schema]), null);
	});
});

// A name the DATABASE supplied, or one written in the statement, is text, never markup: Monaco
// renders hover as markdown with images, and an image URL is fetched on hover.
describe('hovering a CTE or subquery column', () => {
	const IMAGE = '![x](http://evil.example/x.png)';
	const hostile: DatabaseSchema = {
		database: 'shop',
		fetchedAt: 0,
		tables: [{
			name: 'events', schema: 'shop', kind: 'table', primaryKey: [], foreignKeys: [],
			columns: [{ name: IMAGE, dataType: 'String', nullable: false, isPrimaryKey: false }],
		}],
	};

	function text(sql: string, at: number): string {
		const hover = buildHover(sql, at, [hostile]);
		return hover ? String((hover.contents as { value: string }).value) : '';
	}

	test('a CTE lists its columns as text', () => {
		const sql = 'WITH recent AS (SELECT * FROM events) SELECT * FROM recent';
		const doc = text(sql, sql.lastIndexOf('recent') + 2);
		assert.match(doc, /recent/);
		assert.doesNotMatch(doc, /(^|[^\\])!\[x\]\(/);
		assert.ok(doc.includes('!\\[x\\]\\(http'), doc);
	});

	test('a CTE or subquery column hover escapes the names it shows', () => {
		const cte = 'WITH r_x AS (SELECT 1 AS a_b) SELECT r_x.a_b FROM r_x';
		assert.ok(text(cte, cte.indexOf('a_b FROM') + 1).startsWith('**r\\_x.a\\_b**'), text(cte, cte.indexOf('a_b FROM') + 1));
		const sub = 'SELECT s_q.a_b FROM (SELECT 1 AS a_b) s_q';
		assert.ok(text(sub, sub.indexOf('a_b') + 1).startsWith('**s\\_q.a\\_b**'), text(sub, sub.indexOf('a_b') + 1));
	});
});

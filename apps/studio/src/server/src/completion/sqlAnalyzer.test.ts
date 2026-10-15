/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeCompletionContext, dictionaryArgumentAt, parseStatement, resolveFromClause, wordAt } from './sqlAnalyzer';

describe('resolveFromClause', () => {
	test('schema-qualified table with alias, plus an aliased JOIN', () => {
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM shop.orders o JOIN customers AS c ON o.cid = c.id'), [
			{ table: 'orders', schema: 'shop', alias: 'o' },
			{ table: 'customers', schema: undefined, alias: 'c' },
		]);
	});

	test('comma-separated tables, stopping at WHERE', () => {
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM a x, b y WHERE x.id = y.id'), [
			{ table: 'a', schema: undefined, alias: 'x' },
			{ table: 'b', schema: undefined, alias: 'y' },
		]);
	});

	test('a quoted name is one identifier, whatever is inside it', () => {
		// A cloud log scope is named `/aws/lambda/checkout`. The old
		// identifier pattern stopped at the first `/`, so this FROM resolved to NOTHING — which is
		// why a WHERE on a CloudWatch connection offered keywords and no fields at all.
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM "/aws/lambda/checkout" WHERE '), [
			{ table: '/aws/lambda/checkout', schema: undefined, alias: undefined },
		]);
		// Qualified by its region, and with an alias, and with a dot INSIDE the quotes.
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM "us-west-2"."Microsoft.Web/sites" AS s'), [
			{ table: 'Microsoft.Web/sites', schema: 'us-west-2', alias: 's' },
		]);
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM `order-items` oi'), [
			{ table: 'order-items', schema: undefined, alias: 'oi' },
		]);
	});

	test('a trailing keyword is not mistaken for an alias', () => {
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM orders WHERE id = 1'), [
			{ table: 'orders', schema: undefined, alias: undefined },
		]);
	});

	test('derived table exposes its projected columns and inner FROM', () => {
		assert.deepStrictEqual(resolveFromClause('SELECT * FROM (SELECT id, name FROM users) u'), [
			{ table: 'u', alias: 'u', derived: { columns: ['id', 'name'], from: [{ table: 'users', schema: undefined, alias: undefined }] } },
		]);
	});

	test('a comma inside a subquery is not a top-level table separator', () => {
		const refs = resolveFromClause('SELECT * FROM (SELECT a, b, c FROM t) sub');
		assert.deepStrictEqual(refs.length, 1);
		assert.deepStrictEqual(refs[0].derived?.columns, ['a', 'b', 'c']);
	});
});

describe('parseStatement (CTEs)', () => {
	test('no WITH clause', () => {
		assert.deepStrictEqual(parseStatement('SELECT * FROM t'), { ctes: [], mainOffset: 0 });
	});

	test('single CTE: name, projected columns, inner FROM', () => {
		assert.deepStrictEqual(parseStatement('WITH active AS (SELECT id, name FROM users) SELECT * FROM active').ctes, [
			{ name: 'active', columns: ['id', 'name'], from: [{ table: 'users', schema: undefined, alias: undefined }] },
		]);
	});

	test('CTE projecting * has undefined columns (expanded later from its FROM)', () => {
		assert.deepStrictEqual(parseStatement('WITH everything AS (SELECT * FROM orders) SELECT * FROM everything').ctes, [
			{ name: 'everything', columns: undefined, from: [{ table: 'orders', schema: undefined, alias: undefined }] },
		]);
	});
});

describe('analyzeCompletionContext', () => {
	test('after `alias.` → qualifier context, FROM resolved across the statement', () => {
		const sql = 'SELECT * FROM orders o WHERE o.';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), {
			kind: 'qualifier',
			qualifier: 'o',
			qualifierPath: ['o'],
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: 'orders', schema: undefined, alias: 'o' }],
		});
	});

	test('a WHERE over a quoted log scope still carries the FROM, so fields are offered', () => {
		const sql = 'SELECT ts, message FROM "/aws/lambda/checkout" WHERE ';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), {
			kind: 'expression',
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: '/aws/lambda/checkout', schema: undefined, alias: undefined }],
		});
	});

	test('a half-typed quoted name is still a table position', () => {
		// `FROM "` and `FROM "/aws/la` used to fall through to the expression context, which offers
		// keywords first; the scope names are what the user is asking for there.
		for (const sql of ['SELECT * FROM "', 'SELECT * FROM "/aws/la']) {
			assert.equal(analyzeCompletionContext(sql, sql.length).kind, 'table', sql);
		}
	});

	test('after JOIN → table context with joining set', () => {
		const sql = 'SELECT * FROM orders o JOIN ';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), {
			kind: 'table',
			joining: true,
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: 'orders', schema: undefined, alias: 'o' }],
		});
	});

	test('after FROM → table context, not joining', () => {
		const sql = 'SELECT * FROM ';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), { kind: 'table', joining: false, ctes: [], from: [], word: '', followedByParen: false });
	});

	test('in the SELECT list → expression context with the statement FROM in scope', () => {
		const sql = 'SELECT  FROM orders o';
		assert.deepStrictEqual(analyzeCompletionContext(sql, 7), {
			kind: 'expression',
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: 'orders', schema: undefined, alias: 'o' }],
		});
	});

	test('UPDATE … SET → the target table is in scope (no FROM clause)', () => {
		const sql = 'UPDATE orders SET total = 1 WHERE ';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), {
			kind: 'expression',
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: 'orders', schema: undefined, alias: undefined }],
		});
	});

	test('UPDATE with an alias resolves `alias.` to the target table columns', () => {
		const sql = 'UPDATE orders o SET o.';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), {
			kind: 'qualifier',
			qualifier: 'o',
			qualifierPath: ['o'],
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: 'orders', schema: undefined, alias: 'o' }],
		});
	});

	test('a blank-line-separated prior statement (no semicolon) does not leak its FROM', () => {
		const sql = 'SELECT * FROM products\n\nSELECT * FROM orders WHERE ';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length), {
			kind: 'expression',
			ctes: [],
			word: '',
			followedByParen: false,
			from: [{ table: 'orders', schema: undefined, alias: undefined }],
		});
	});

	test('an unbalanced paren in a neighbouring statement does not hide the FROM', () => {
		const sql = 'SELECT COUNT(*\n\nSELECT * FROM orders WHERE ';
		assert.deepStrictEqual(analyzeCompletionContext(sql, sql.length).from, [
			{ table: 'orders', schema: undefined, alias: undefined },
		]);
	});
});

describe('wordAt', () => {
	test('bare identifier', () => {
		assert.deepStrictEqual(wordAt('SELECT name FROM users', 8), { word: 'name', qualifier: undefined });
	});

	test('qualified identifier carries its qualifier', () => {
		assert.deepStrictEqual(wordAt('WHERE o.total > 0', 9), { word: 'total', qualifier: 'o' });
	});
});

// The engine's own catalog is offered where nothing else can be right: after SETTINGS, after
// FORMAT, after ENGINE =, and where a column's type goes.
describe('the engine-catalog slots', () => {
	function slotOf(sql: string, at = sql.length): string | undefined {
		const context = analyzeCompletionContext(sql, at);
		return context.kind === 'catalog' ? context.slot : undefined;
	}

	test('a SETTINGS name, including after a comma, and not the value between them', () => {
		assert.equal(slotOf('SELECT 1 SETTINGS '), 'setting');
		assert.equal(slotOf('SELECT 1 SETTINGS max_th'), 'setting');
		assert.equal(slotOf('SELECT 1 SETTINGS max_threads = 4, max_b'), 'setting');
		assert.equal(slotOf('SELECT 1 SETTINGS max_threads = '), undefined);
	});

	test('a FORMAT name', () => {
		assert.equal(slotOf('SELECT * FROM t FORMAT '), 'format');
		assert.equal(slotOf('SELECT * FROM t FORMAT JSONEach'), 'format');
	});

	test('a table engine, only once the `=` says it is one', () => {
		assert.equal(slotOf('CREATE TABLE t (a UInt8) ENGINE = Mer'), 'engine');
		assert.equal(slotOf('CREATE TABLE t (a UInt8) ENGINE '), undefined);
	});

	// ClickHouse's own system tables have columns called `engine`, `format` and `name`, so a
	// statement ABOUT them must not be read as a statement USING them.
	test('a column that shares a clause name is still a column', () => {
		assert.equal(slotOf('SELECT engine FROM system.tables WHERE '), undefined);
		assert.equal(slotOf('SELECT format '), undefined);
		assert.equal(slotOf('SELECT name, engine = '), undefined);
	});

	test('a column type, in a CREATE and in an ALTER, but never the column NAME', () => {
		assert.equal(slotOf('CREATE TABLE t (id UInt64, name Str'), 'dataType');
		assert.equal(slotOf('CREATE TABLE t (id UInt64, '), undefined);
		assert.equal(slotOf('ALTER TABLE t ADD COLUMN tag Low'), 'dataType');
	});

	test('the word typed so far comes back, and whether a `(` already follows', () => {
		const sql = 'SELECT cou';
		assert.equal(analyzeCompletionContext(sql, sql.length).word, 'cou');
		const withParen = 'SELECT cou()';
		assert.equal(analyzeCompletionContext(withParen, 10).followedByParen, true);
		assert.equal(analyzeCompletionContext(sql, sql.length).followedByParen, false);
	});
});

describe('dictionaryArgumentAt', () => {
	test('the first string argument of a dictionary function is a dictionary name', () => {
		assert.deepEqual(dictionaryArgumentAt("SELECT dictGet('"), { slot: 'name', typed: '' });
		assert.deepEqual(dictionaryArgumentAt("SELECT dictGetString('coun"), { slot: 'name', typed: 'coun' });
		assert.deepEqual(dictionaryArgumentAt("SELECT dictHas( 'shop."), { slot: 'name', typed: 'shop.' });
		assert.deepEqual(dictionaryArgumentAt("SELECT dictGetUInt64OrDefault('x"), { slot: 'name', typed: 'x' });
	});

	test('the second is an attribute, except on the functions that take a key there', () => {
		assert.deepEqual(dictionaryArgumentAt("dictGet('shop.codes', 'la"), { slot: 'attribute', dictionary: 'shop.codes', typed: 'la' });
		assert.deepEqual(dictionaryArgumentAt("dictGetStringOrDefault('codes', '"), { slot: 'attribute', dictionary: 'codes', typed: '' });
		// dictGetHierarchy(dict, key) and dictHas(dict, key) take the KEY second, so offering an
		// attribute name there would be wrong in the one place someone would trust it.
		assert.equal(dictionaryArgumentAt("dictGetHierarchy('codes', '"), undefined);
		assert.equal(dictionaryArgumentAt("dictIsIn('codes', '"), undefined);
	});

	// The one that was wrong live: `dictGet('depth.` ends in a dotted chain, so the qualifier branch
	// claimed it first and offered `depth`'s TABLES. Accepting one wrote `dictGet('depth.anat')`.
	test('a database typed inside the literal is a dictionary slot, not a qualifier', () => {
		const context = analyzeCompletionContext("SELECT dictGet('depth.", 22);
		assert.equal(context.kind, 'dictionary');
		assert.equal(context.word, 'depth.');
		// And a real qualifier is untouched.
		assert.equal(analyzeCompletionContext('SELECT depth.', 13).kind, 'qualifier');
	});

	test('an ordinary function taking a string is not a dictionary call', () => {
		assert.equal(dictionaryArgumentAt("SELECT toDateTime('2026-"), undefined);
		assert.equal(dictionaryArgumentAt("SELECT concat('a', 'b"), undefined);
		assert.equal(dictionaryArgumentAt('SELECT * FROM t'), undefined);
	});

	test('the context resolves to a dictionary slot, not to an expression', () => {
		const context = analyzeCompletionContext("SELECT dictGet('shop.codes', 'la", 32);
		assert.equal(context.kind, 'dictionary');
		assert.equal(context.kind === 'dictionary' && context.dictionary, 'shop.codes');
		assert.equal(context.word, 'la');
	});
});

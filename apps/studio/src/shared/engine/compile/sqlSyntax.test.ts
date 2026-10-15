/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqlSyntaxError, sqlSyntaxDiagnostics, parseOneStatement } from './sqlAst';
import { quotedValueWarnings } from './sqlSyntax';
import { sqlToMongo } from './sqlToMongo';

// `=>` instead of `>=`, on a MongoDB connection. Raised as UnsupportedQueryError, it would tell the
// user to write a simpler SELECT and offer to spend their AI budget translating a statement that is
// not SQL.
const TYPO = "select * from orders where city = 'Lisbon' and placedAt => '2025-03-01 00:00:00'";

test('a typo is a syntax error, not an unsupported query', () => {
	assert.throws(() => sqlToMongo(TYPO), (err: Error) => {
		assert.ok(err instanceof SqlSyntaxError, `expected SqlSyntaxError, got ${err.name}`);
		assert.match(err.message, /line 1, column 57/);
		assert.match(err.message, /"=>" is not a SQL comparison/);
		assert.match(err.message, /Did you mean ">="\?/);
		return true;
	});
});

test('the fixed query compiles', () => {
	const native = sqlToMongo(TYPO.replace('=>', '>='));
	assert.equal(native.lang, 'mongo');
});

test('each near-miss is named with its fix', () => {
	const cases: [string, RegExp][] = [
		['select * from t where a =< 1', /"=<".*Did you mean "<="/s],
		['select * from t where a == 1', /"==".*single "="/s],
		['select * from t where a !< 1', /"!<".*Did you mean ">="/s],
		['select * from t where a !> 1', /"!>".*Did you mean "<="/s],
		['select a from t # note', /"#" does not start a comment/],
		['select a from t limit 10, 20', /LIMIT a, b.*OFFSET/s],
		['select top 10 a from t', /"TOP" is SQL Server/],
		['select a, from t', /trailing comma/],
		["select * from t where a = 'abc", /never closed/],
	];
	for (const [sql, expected] of cases) {
		assert.throws(() => parseOneStatement(sql), (err: Error) => {
			assert.ok(err instanceof SqlSyntaxError, `${sql} → ${err.name}`);
			assert.match(err.message, expected, sql);
			return true;
		}, sql);
	}
});

test('an unrecognised failure still says where it is', () => {
	assert.throws(() => parseOneStatement('select * from t where ((a = 1)'), (err: Error) => {
		assert.ok(err instanceof SqlSyntaxError);
		assert.match(err.message, /Syntax error at line 1, column \d+/);
		return true;
	});
});

// The editor pass. Only a RECOGNISED mistake is underlined: every half-typed statement is a syntax
// error too, and marking those would put a red line under the user's fingers as they type.
test('the editor is told about a recognised mistake', () => {
	const found = sqlSyntaxDiagnostics(TYPO);
	assert.equal(found.length, 1);
	assert.equal(found[0].severity, 'error');
	assert.equal(TYPO.slice(found[0].start, found[0].end), '=>');
});

test('the editor is NOT told about a statement that is merely unfinished', () => {
	assert.deepEqual(sqlSyntaxDiagnostics('select name, ema'), []);
	assert.deepEqual(sqlSyntaxDiagnostics('select * from users where'), []);
	assert.deepEqual(sqlSyntaxDiagnostics(''), []);
});

test('valid SQL produces nothing', () => {
	assert.deepEqual(sqlSyntaxDiagnostics("select * from t where a >= '2025-09-10' limit 10"), []);
});

test('a diagnostic is positioned in the BUFFER, not in its statement', () => {
	const buffer = "select 1;\nselect * from t where a => 1";
	const found = sqlSyntaxDiagnostics(buffer);
	assert.equal(found.length, 1);
	assert.equal(buffer.slice(found[0].start, found[0].end), '=>');
});

// Text in double quotes parses fine and returns nothing at all, which is worse than an error.
test('a double-quoted value is warned about, not failed', () => {
	const found = sqlSyntaxDiagnostics('select * from orders where city = "Lisbon"');
	assert.equal(found.length, 1);
	assert.equal(found[0].severity, 'warning');
	assert.match(found[0].message, /Double quotes name a column/);
	assert.match(found[0].suggestion ?? '', /'Lisbon'/);
});

test('single-quoted text is left alone', () => {
	assert.deepEqual(quotedValueWarnings("select * from orders where city = 'Lisbon'"), []);
	assert.deepEqual(quotedValueWarnings('select * from "orders" where a = 1'), []);
});

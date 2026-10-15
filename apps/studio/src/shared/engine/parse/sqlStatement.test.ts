/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementAt, splitStatements, splitStatementSpans } from './sqlStatement';

// Offset of the first occurrence of `needle` in `text` (where the caret would sit).
function caretAt(text: string, needle: string): number {
	const i = text.indexOf(needle);
	assert.ok(i >= 0, `needle ${needle} not in text`);
	return i;
}

test('returns the whole text when there are no delimiters', () => {
	const sql = 'SELECT * FROM user';
	assert.equal(statementAt(sql, 5), sql);
});

test('blank line splits statements; caret picks its own', () => {
	const sql = 'SELECT * FROM user\n\nSELECT * FROM user_type';
	assert.equal(statementAt(sql, caretAt(sql, 'user\n')), 'SELECT * FROM user');
	assert.equal(statementAt(sql, caretAt(sql, 'user_type')), 'SELECT * FROM user_type');
});

test('blank line with trailing whitespace still splits', () => {
	const sql = 'SELECT 1\n   \nSELECT 2';
	assert.equal(statementAt(sql, 0), 'SELECT 1');
	assert.equal(statementAt(sql, caretAt(sql, 'SELECT 2')), 'SELECT 2');
});

test('CRLF blank line splits', () => {
	const sql = 'SELECT 1\r\n\r\nSELECT 2';
	assert.equal(statementAt(sql, 0), 'SELECT 1');
	assert.equal(statementAt(sql, caretAt(sql, 'SELECT 2')), 'SELECT 2');
});

test('semicolon splits statements; the ; stays with its statement', () => {
	const sql = 'SELECT 1; SELECT 2;';
	assert.equal(statementAt(sql, 0), 'SELECT 1;');
	assert.equal(statementAt(sql, caretAt(sql, 'SELECT 2')), 'SELECT 2;');
});

test('caret right after the trailing ; runs that statement', () => {
	const sql = 'select * from user;';
	assert.equal(statementAt(sql, sql.length), 'select * from user;');
});

test('caret in trailing whitespace after the last ; runs that statement', () => {
	const sql = 'SELECT 1;\nSELECT 2;\n';
	assert.equal(statementAt(sql, sql.length), 'SELECT 2;');
});

test('nearest boundary wins when both semicolon and blank line are present', () => {
	const sql = 'SELECT a;\nSELECT b\n\nSELECT c';
	// Caret in the middle statement: bounded by the ';' above and the blank line below.
	assert.equal(statementAt(sql, caretAt(sql, 'SELECT b')), 'SELECT b');
});

test('single-line whitespace does not split', () => {
	const sql = 'SELECT a,\n       b\nFROM t';
	assert.equal(statementAt(sql, caretAt(sql, 'b')), sql);
});

test('splitStatements: single statement with no delimiter', () => {
	assert.deepEqual(splitStatements('SELECT * FROM user'), ['SELECT * FROM user']);
});

test('splitStatements: semicolons split and the ; stays with each statement', () => {
	assert.deepEqual(splitStatements('SELECT 1; SELECT 2;'), ['SELECT 1;', 'SELECT 2;']);
});

test('splitStatements: blank lines split', () => {
	assert.deepEqual(splitStatements('SELECT 1\n\nSELECT 2'), ['SELECT 1', 'SELECT 2']);
});

test('splitStatements: mixed semicolons and blank lines', () => {
	assert.deepEqual(splitStatements('SELECT a;\nSELECT b\n\nSELECT c'), ['SELECT a;', 'SELECT b', 'SELECT c']);
});

test('splitStatements: empty/whitespace pieces are dropped', () => {
	assert.deepEqual(splitStatements(';;\n\n  \nSELECT 1;\n\n'), ['SELECT 1;']);
	assert.deepEqual(splitStatements('   '), []);
	assert.deepEqual(splitStatements(''), []);
});

test('splitStatements: a multi-line statement stays whole', () => {
	assert.deepEqual(splitStatements('SELECT a,\n       b\nFROM t;'), ['SELECT a,\n       b\nFROM t;']);
});

test('splitStatementSpans: offsets bound the trimmed statement (leading whitespace excluded)', () => {
	const sql = 'SELECT 1;\n\n  SELECT 2;';
	const spans = splitStatementSpans(sql);
	assert.deepEqual(spans.map((s) => s.sql), ['SELECT 1;', 'SELECT 2;']);
	for (const s of spans) {
		assert.equal(sql.slice(s.start, s.end), s.sql);
	}
});

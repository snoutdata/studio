/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { buildXlsx } from './xlsx';

// Read back the archive we wrote. This is a test-only ZIP reader (the app never reads .xlsx):
// walking the local headers and inflating each entry also proves the CRCs and the compressed /
// uncompressed sizes we wrote are right, which is exactly what Excel checks before it will open
// the file at all.
function unzip(buf: Buffer): Map<string, string> {
	const entries = new Map<string, string>();
	let at = 0;
	while (at + 4 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
		const compressedSize = buf.readUInt32LE(at + 18);
		const uncompressedSize = buf.readUInt32LE(at + 22);
		const nameLength = buf.readUInt16LE(at + 26);
		const extraLength = buf.readUInt16LE(at + 28);
		const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf8');
		const start = at + 30 + nameLength + extraLength;
		const data = inflateRawSync(buf.subarray(start, start + compressedSize));
		assert.equal(data.length, uncompressedSize, `size mismatch for ${name}`);
		entries.set(name, data.toString('utf8'));
		at = start + compressedSize;
	}
	return entries;
}

function sheetXml(buf: Buffer): string {
	const xml = unzip(buf).get('xl/worksheets/sheet1.xml');
	assert.ok(xml, 'sheet1.xml missing');
	return xml;
}

test('writes the parts Excel requires', () => {
	const entries = unzip(buildXlsx({ name: 'orders', fields: ['id'], rows: [[1]] }));
	for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
		assert.ok(entries.has(part), `missing ${part}`);
	}
	assert.match(entries.get('xl/workbook.xml') ?? '', /name="orders"/);
});

test('is deterministic (same input, same bytes)', () => {
	const sheet = { name: 's', fields: ['a', 'b'], rows: [[1, 'x'], [2, 'y']] };
	assert.ok(buildXlsx(sheet).equals(buildXlsx(sheet)));
});

test('header row is bold and the data starts at row 2', () => {
	const xml = sheetXml(buildXlsx({ name: 's', fields: ['name'], rows: [['ada']] }));
	assert.match(xml, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">name<\/t>/);
	assert.match(xml, /<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">ada<\/t>/);
});

test('numbers and booleans are written as native types', () => {
	const xml = sheetXml(buildXlsx({ name: 's', fields: ['n', 'f', 'b'], rows: [[42, 1.5, true]] }));
	assert.match(xml, /<c r="A2"><v>42<\/v><\/c>/);
	assert.match(xml, /<c r="B2"><v>1.5<\/v><\/c>/);
	assert.match(xml, /<c r="C2" t="b"><v>1<\/v><\/c>/);
});

test('numeric-looking strings stay text (a zero-padded id must survive)', () => {
	const xml = sheetXml(buildXlsx({ name: 's', fields: ['id'], rows: [['00713']] }));
	assert.match(xml, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">00713<\/t>/);
});

test('dates become serials, with a date-only style at midnight', () => {
	const xml = sheetXml(buildXlsx({
		name: 's',
		fields: ['d', 'ts'],
		rows: [[new Date(2024, 0, 15), new Date(2024, 0, 15, 12, 0, 0)]],
	}));
	// 2024-01-15 is Excel serial 45306; noon adds half a day.
	assert.match(xml, /<c r="A2" s="3"><v>45306<\/v><\/c>/);
	assert.match(xml, /<c r="B2" s="2"><v>45306.5<\/v><\/c>/);
});

test('nulls are omitted entirely (an empty cell, not an empty string)', () => {
	const xml = sheetXml(buildXlsx({ name: 's', fields: ['a', 'b', 'c'], rows: [[1, null, 3]] }));
	assert.match(xml, /<row r="2"><c r="A2"><v>1<\/v><\/c><c r="C2"><v>3<\/v><\/c><\/row>/);
});

test('escapes XML and drops control characters Excel would reject', () => {
	const xml = sheetXml(buildXlsx({ name: 's', fields: ['x'], rows: [['a<b&c\u0007d']] }));
	assert.match(xml, /a&lt;b&amp;cd/);
	assert.ok(!xml.includes('\u0007'));
});

test('a sheet name is sanitized to what Excel accepts', () => {
	const workbook = unzip(buildXlsx({ name: 'sales/2026:Q1 [draft] with a very long tail', fields: [], rows: [] })).get('xl/workbook.xml') ?? '';
	const name = /name="([^"]*)"/.exec(workbook)?.[1] ?? '';
	assert.ok(name.length <= 31);
	assert.ok(!/[:\\/?*[\]]/.test(name));
});

test('an empty result still produces a valid workbook', () => {
	const xml = sheetXml(buildXlsx({ name: 's', fields: [], rows: [] }));
	assert.match(xml, /<dimension ref="A1:A1"\/>/);
	assert.ok(!xml.includes('<autoFilter'));
});

test('the 26th column rolls over to AA', () => {
	const fields = Array.from({ length: 27 }, (_v, i) => `c${i}`);
	const xml = sheetXml(buildXlsx({ name: 's', fields, rows: [fields.map((_f, i) => i)] }));
	assert.match(xml, /<c r="Z2"><v>25<\/v><\/c><c r="AA2"><v>26<\/v><\/c>/);
});

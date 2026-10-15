/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deflateRawSync } from 'node:zlib';
import type { XlsxSheet } from '../shared/export';

// A minimal, dependency-free .xlsx writer.
//
// An .xlsx is just a ZIP of a handful of small XML parts, and we only ever WRITE one (never
// read, never stream, never edit). The obvious library, exceljs, is 21.8 MB unpacked and pulls
// nine dependencies including THREE zip stacks (jszip, archiver, unzipper) plus a CSV parser and
// an XML parser, of which we would use essentially nothing. So the container is written here
// with node:zlib's deflateRaw and ~100 lines of ZIP headers.
//
// This lives in main (not the renderer) so none of it lands in the renderer bundle: the renderer
// hands the fields + rows over IPC (`file:exportXlsx`) and main builds + writes the file.
//
// What is deliberately NOT supported, because a result-grid export does not need it: multiple
// sheets, formulas, merged cells, images, a shared-string table (we emit inline strings, which
// costs a little size on repetitive data but keeps the writer trivial), and reading.

// ── ZIP container ────────────────────────────────────────────────────────────────────────

interface ZipEntry {
	name: string;
	data: Buffer;
}

// A fixed DOS timestamp (1980-01-01 00:00) instead of "now", so the same result always produces
// byte-identical output. Excel does not surface per-entry times, and determinism makes the
// writer testable.
const DOS_TIME = 0;
const DOS_DATE = 33;

let crcTable: Uint32Array | undefined;

function crc32(buf: Buffer): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let k = 0; k < 8; k++) {
				c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			crcTable[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Pack entries into a ZIP archive (deflate, no directory entries, no zip64). */
function zip(entries: ZipEntry[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const compressed = deflateRawSync(entry.data, { level: 9 });
		const crc = crc32(entry.data);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed to extract (2.0 = deflate)
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(8, 8); // method: deflate
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28); // extra field length
		name.copy(local, 30);
		parts.push(local, compressed);

		const header = Buffer.alloc(46 + name.length);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4); // version made by
		header.writeUInt16LE(20, 6); // version needed
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(8, 10);
		header.writeUInt16LE(DOS_TIME, 12);
		header.writeUInt16LE(DOS_DATE, 14);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(compressed.length, 20);
		header.writeUInt32LE(entry.data.length, 24);
		header.writeUInt16LE(name.length, 28);
		// bytes 30-41 (extra len, comment len, disk, attrs) stay zero from Buffer.alloc
		header.writeUInt32LE(offset, 42); // offset of the local header
		name.copy(header, 46);
		central.push(header);

		offset += local.length + compressed.length;
	}

	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

// ── XML helpers ──────────────────────────────────────────────────────────────────────────

/** Escape for XML text/attributes, and drop the C0 control characters XML 1.0 forbids
 *  (Excel rejects the whole file over a single stray 0x00 that a BLOB column can carry). */
function xml(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
function columnRef(index: number): string {
	let n = index + 1;
	let ref = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		ref = String.fromCharCode(65 + rem) + ref;
		n = Math.floor((n - 1) / 26);
	}
	return ref;
}

// ── Cell mapping ─────────────────────────────────────────────────────────────────────────

/** Excel's serial date: days since 1899-12-30 (the offset absorbs the 1900 leap-year bug).
 *  Built from the date's LOCAL components so the cell shows the same wall clock the grid
 *  does — a spreadsheet has no timezone to carry the offset in. */
function excelSerial(date: Date): number {
	const ms = Date.UTC(
		date.getFullYear(), date.getMonth(), date.getDate(),
		date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds(),
	);
	return ms / 86400000 + 25569;
}

// Style indexes into cellXfs (see STYLES below).
const STYLE_HEADER = 1;
const STYLE_DATETIME = 2;
const STYLE_DATE = 3;

// Excel's hard limit on the characters in one cell.
const MAX_CELL_TEXT = 32767;

/** Render one cell. Strings are NEVER coerced to numbers: a zero-padded id or an account
 *  number must survive the round-trip as typed. */
function cell(ref: string, value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'number') {
		// NaN/Infinity have no XLSX numeric representation; fall through to text.
		if (Number.isFinite(value)) {
			return `<c r="${ref}"><v>${value}</v></c>`;
		}
	} else if (typeof value === 'bigint') {
		if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
			return `<c r="${ref}"><v>${value}</v></c>`;
		}
	} else if (typeof value === 'boolean') {
		return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
	} else if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			return '';
		}
		const midnight = value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0;
		return `<c r="${ref}" s="${midnight ? STYLE_DATE : STYLE_DATETIME}"><v>${excelSerial(value)}</v></c>`;
	}
	const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
	// `t="inlineStr"` keeps the string in the cell instead of a shared-string table.
	return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text.slice(0, MAX_CELL_TEXT))}</t></is></c>`;
}

/** Column widths, estimated from the header and a sample of the data (scanning every row of a
 *  million-row export to size columns is not worth it). Excel's width unit is roughly one
 *  character of the default font. */
function columns(sheet: XlsxSheet): string {
	if (sheet.fields.length === 0) {
		return '';
	}
	const sample = sheet.rows.slice(0, 200);
	// Measure what the CELL will show, not the raw value: a Date stringifies to 60+ characters
	// ("Tue Jul 28 2026 14:30:00 GMT+0100 (…)") but renders in the sheet as its number format.
	const displayLength = (value: unknown): number => {
		if (value === null || value === undefined) {
			return 0;
		}
		if (value instanceof Date) {
			return 19;
		}
		return String(value).length;
	};
	const cols = sheet.fields.map((name, i) => {
		let width = name.length;
		for (const row of sample) {
			const len = displayLength(row[i]);
			if (len > width) {
				width = len;
			}
		}
		return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(width + 2, 8), 60)}" customWidth="1"/>`;
	});
	return `<cols>${cols.join('')}</cols>`;
}

// ── The fixed parts ──────────────────────────────────────────────────────────────────────

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const CONTENT_TYPES = `${DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `${DECL}
<Relationships xmlns="${NS_PKG_REL}">
<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `${DECL}
<Relationships xmlns="${NS_PKG_REL}">
<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>
</Relationships>`;

// Two custom number formats (dates) and a bold font (the header row). numFmtIds below 164 are
// Excel's builtins, so custom ones must start at 164. The cellXfs order defines the `s="…"`
// style indexes used above: 0 general, 1 bold, 2 datetime, 3 date.
const STYLES = `${DECL}
<styleSheet xmlns="${NS_MAIN}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Excel forbids : \ / ? * [ ] in a sheet name and caps it at 31 characters. */
function sheetName(name: string): string {
	const safe = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
	return safe.length > 0 ? safe : 'Sheet1';
}

// ── Public API ───────────────────────────────────────────────────────────────────────────

/** Build a single-sheet .xlsx workbook. The header row is bold and frozen, with an autofilter;
 *  numbers, booleans and dates are written as native Excel types, everything else as text. */
export function buildXlsx(sheet: XlsxSheet): Buffer {
	const width = sheet.fields.length;
	const body: string[] = [];

	if (width > 0) {
		const header = sheet.fields.map((name, i) =>
			`<c r="${columnRef(i)}1" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${xml(name)}</t></is></c>`);
		body.push(`<row r="1">${header.join('')}</row>`);
	}
	sheet.rows.forEach((row, r) => {
		const cells: string[] = [];
		for (let c = 0; c < width; c++) {
			const rendered = cell(`${columnRef(c)}${r + 2}`, row[c]);
			if (rendered !== '') {
				cells.push(rendered);
			}
		}
		body.push(`<row r="${r + 2}">${cells.join('')}</row>`);
	});

	const last = width > 0 ? `${columnRef(width - 1)}${sheet.rows.length + 1}` : 'A1';
	const range = `A1:${last}`;
	// Element order is fixed by the schema: dimension, sheetViews, sheetFormatPr, cols,
	// sheetData, then autoFilter.
	const worksheet = `${DECL}
<worksheet xmlns="${NS_MAIN}">
<dimension ref="${range}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${columns(sheet)}
<sheetData>${body.join('')}</sheetData>
${width > 0 ? `<autoFilter ref="${range}"/>` : ''}
</worksheet>`;

	const workbook = `${DECL}
<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">
<sheets><sheet name="${xml(sheetName(sheet.name))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

	return zip([
		{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
		{ name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
		{ name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
		{ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
		{ name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
		{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(worksheet, 'utf8') },
	]);
}

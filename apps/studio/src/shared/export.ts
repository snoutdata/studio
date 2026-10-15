/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Export contracts AND the text serializers, shared across the IPC boundary.
//
// The serializers live here rather than in the renderer because BOTH sides need them: the results
// grid exports what you are looking at, and a Data Flow's file sink writes the same formats from
// main on a schedule. One implementation means a flow's CSV and an exported CSV are quoted the
// same way; the export alone also neutralises formulas (`spreadsheetSafe`), since it is meant for a
// spreadsheet and a flow's file is data. Pure and DOM-free, so it stays node-testable.
//
// Text exports (CSV/JSON) are serialized in the renderer and sent as a string. Excel can't work
// that way: an .xlsx is a binary ZIP, so the renderer sends the raw sheet and MAIN builds the
// workbook (src/main/xlsx.ts) and writes it. That also keeps the writer out of the renderer
// bundle. Rows cross IPC by structured clone, so Date values arrive as Dates.

import type { QueryResult } from './query';

export interface XlsxSheet {
	/** Worksheet name (sanitized by the writer: Excel forbids []:*?/\ and caps it at 31 chars). */
	name: string;
	/** Header row. */
	fields: string[];
	/** Data rows, positionally aligned with {@link fields}. */
	rows: unknown[][];
}

/** Formats that serialize to a string and can be handed to `file:export`. */
export type TextExportFormat = 'csv' | 'json';

/** A value as export text: null/undefined empty, objects as JSON, everything else stringified. */
export function cellString(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	// A Date before the generic object branch: `JSON.stringify(date)` returns the ISO text WITH its
	// quotes, which `csvField` then has to escape again — a date exported to CSV came out as
	// """2026-08-01T00:00:00.000Z""" and no longer read back as a date. `String(date)` is no better
	// ("Sat Aug 01 2026 …", locale-shaped and unparseable). ISO is the one form that round-trips.
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? '' : value.toISOString();
	}
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** A number as text, sign and exponent included: a spreadsheet reads it as a number, not a formula. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Text a spreadsheet would read as a formula (a leading `=`, `+`, `-`, `@`, tab or carriage
 * return) gets a leading `'`, the usual defence against CSV injection: Excel, Sheets and Calc
 * show the cell as text. A plain number, negative included, is left alone. Only for files meant
 * for a spreadsheet (the grid's CSV and TSV, the clipboard, a chart's CSV); a flow's data file
 * keeps its values exactly, and JSON and SQL exports are never touched.
 */
export function spreadsheetSafe(text: string): string {
	return /^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

/** One CSV field, quoted only when it has to be (RFC 4180: quote-on-special, `""` escaping).
 *  `spreadsheet` neutralises a formula first ({@link spreadsheetSafe}). */
export function csvField(value: unknown, spreadsheet = false): string {
	const text = cellString(value);
	const s = spreadsheet ? spreadsheetSafe(text) : text;
	if (/[",\r\n]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/** One CSV row, without a line ending — what a streaming writer appends per record. Values are
 *  kept exactly unless `spreadsheet` is set. */
export function csvLine(values: readonly unknown[], spreadsheet = false): string {
	return values.map((value) => csvField(value, spreadsheet)).join(',');
}

/** RFC 4180 CSV for a spreadsheet: a header row of field names, then one row per record, with
 *  any cell that would run as a formula neutralised. */
export function toCsv(result: QueryResult): string {
	const header = csvLine(result.fields.map((f) => f.name), true);
	const lines = result.rows.map((row) => csvLine(result.fields.map((_f, i) => row[i]), true));
	return [header, ...lines].join('\r\n');
}

/** Tab-separated values for the clipboard. TSV has no escaping, so embedded tabs/newlines are
 *  flattened to spaces to keep one row per record, and a formula is neutralised as in CSV. */
export function toTsv(result: QueryResult): string {
	const cell = (value: unknown): string => spreadsheetSafe(cellString(value).replace(/[\t\r\n]+/g, ' '));
	const header = result.fields.map((f) => cell(f.name)).join('\t');
	const lines = result.rows.map((row) => result.fields.map((_f, i) => cell(row[i])).join('\t'));
	return [header, ...lines].join('\n');
}

/** One row as a plain object keyed by field name (nulls preserved). */
export function rowObject(fields: readonly { name: string }[], row: readonly unknown[]): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	fields.forEach((field, i) => {
		obj[field.name] = row[i] === undefined ? null : row[i];
	});
	return obj;
}

/** A JSON array of objects keyed by field name (nulls preserved). */
export function toJson(result: QueryResult): string {
	return JSON.stringify(result.rows.map((row) => rowObject(result.fields, row)), null, 2);
}

/** Serialize `result` in the requested text format. */
export function serializeResult(result: QueryResult, format: TextExportFormat): string {
	return format === 'csv' ? toCsv(result) : toJson(result);
}

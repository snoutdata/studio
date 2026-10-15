/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QueryResult } from '../../shared/query';
import { cellString, toCsv, toJson, type TextExportFormat, type XlsxSheet } from '../../shared/export';

// The renderer's export surface. The text serializers themselves now live in `shared/export.ts`
// (a Data Flow's file sink writes the same formats from main, and one implementation means one
// set of bytes); this file re-exports them and keeps the parts only the grid needs — the Excel
// sheet builder and the filename helpers.

export { cellString, csvField, csvLine, rowObject, serializeResult, toCsv, toJson, toTsv } from '../../shared/export';
export type { TextExportFormat } from '../../shared/export';

/** Every file-export format offered in the UI. `xlsx` is binary, so it does NOT go through
 *  `serializeResult` — the renderer sends the sheet and main builds the workbook
 *  (`src/main/xlsx.ts`), which also keeps the writer out of the renderer bundle. */
export type ExportFormat = TextExportFormat | 'xlsx';

/** The sheet payload for an Excel export: field names plus the raw row values, so main can
 *  write numbers, booleans and dates as native Excel types instead of pre-stringified text. */
export function toXlsxSheet(result: QueryResult, sql: string): XlsxSheet {
	return {
		name: tableNameFrom(sql) ?? 'Results',
		fields: result.fields.map((f) => f.name),
		rows: result.rows,
	};
}

/** The first table named after FROM, stripped to a filename-safe stem (or undefined). */
function tableNameFrom(sql: string): string | undefined {
	const match = /\bfrom\s+([^\s,;()]+)/i.exec(sql);
	if (!match) {
		return undefined;
	}
	// Drop quoting (`name`, "name", [name]), keep the last dotted segment (schema.table → table).
	const bare = match[1].replace(/[`"[\]]/g, '');
	const segment = bare.split('.').pop() ?? bare;
	const safe = segment.replace(/[^A-Za-z0-9_-]/g, '');
	return safe.length > 0 ? safe : undefined;
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** A friendly default export filename: `<table|query>-YYYY-MM-DD.<ext>`. */
export function exportFileName(sql: string, format: ExportFormat, now: Date = new Date()): string {
	const stem = tableNameFrom(sql) ?? 'query';
	const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
	return `${stem}-${date}.${format}`;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A whole FILE into a table, and a whole result back out, at the engine's own speed.
 *
 *  `insert.ts` turns rows the app is HOLDING into statements. This is the other direction: the
 *  app holds nothing, the file is the statement's body, and the server parses it. On ClickHouse
 *  that is the difference between an import that takes minutes and one that takes hours, because
 *  `INSERT ... VALUES` makes the server parse SQL for every row while `INSERT ... FORMAT Parquet`
 *  hands it a columnar file it reads at disk speed.
 *
 *  What lives here is only what a test can reason about: which formats an engine reads, which one
 *  a file NAME means, and the exact statement. Sending the bytes is the driver's half, because
 *  only it has a socket.
 *
 *  Two rules that must not be relaxed:
 *
 *    - The format in a statement is an id from this file's own list, never a string from
 *      anywhere else. It is the one part of the statement that is not an identifier and so not
 *      quoted, which makes it the one part an arbitrary string could be an injection through.
 *    - Identifiers go through the dialect's `quoteIdent`, exactly as `insert.ts` does.
 *--------------------------------------------------------------------------------------------*/

import type { BulkFormat } from './bulkFormats';
import { explainTarget } from './explain';
import { readOnlyError } from '../context/tools';
import { dialectFor } from './index';

/**
 * How a compressed file is sent.
 *
 * The file is NOT expanded on this machine. ClickHouse decompresses a request body it is told the
 * encoding of, so a 400 MB `.csv.gz` crosses the wire as 400 MB rather than as the 4 GB it holds,
 * which is the difference that matters over a link to a hosted service. It is a request HEADER and
 * not a setting, so a user who may INSERT may always do this.
 */
export type BulkEncoding = 'gzip' | 'zstd' | 'br' | 'xz' | 'deflate';

const ENCODINGS: readonly { readonly extension: string; readonly encoding: BulkEncoding }[] = [
	{ extension: '.gz', encoding: 'gzip' },
	{ extension: '.gzip', encoding: 'gzip' },
	{ extension: '.zst', encoding: 'zstd' },
	{ extension: '.zstd', encoding: 'zstd' },
	{ extension: '.br', encoding: 'br' },
	{ extension: '.xz', encoding: 'xz' },
	{ extension: '.deflate', encoding: 'deflate' },
];

/** The formats this engine can be handed a file of, or none where loading a file is not a thing
 *  the engine does over its wire protocol. A driver without them offers no Load button. */
export function bulkFormatsFor(driverId: string): readonly BulkFormat[] {
	return dialectFor(driverId).bulkFormats ?? [];
}

/** Look an id back up, so a format that arrives from outside (a saved choice, an agent's tool
 *  argument) is one of the engine's own or is nothing. */
export function bulkFormatById(driverId: string, id: string): BulkFormat | undefined {
	return bulkFormatsFor(driverId).find((format) => format.id === id);
}

/** The file's name with any compression suffix taken off: `events.csv.gz` is a `.csv`. */
export function nameWithoutEncoding(fileName: string): string {
	const lower = fileName.toLowerCase();
	const match = ENCODINGS.find((entry) => lower.endsWith(entry.extension));
	return match ? fileName.slice(0, -match.extension.length) : fileName;
}

/** How this file is compressed, by its name, or undefined for a plain one. */
export function encodingForFile(fileName: string): BulkEncoding | undefined {
	const lower = fileName.toLowerCase();
	return ENCODINGS.find((entry) => lower.endsWith(entry.extension))?.encoding;
}

/** The last dot-led extension of a name, lowercased, or '' when it has none. */
function extensionOf(fileName: string): string {
	const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * What a file of this name holds, by its extension alone.
 *
 * A GUESS, and the caller says so: the picker opens on this and the person can change it. Reading
 * the file to be sure is deliberately not done here, because the engine is pure and because the
 * answer for a 4 GB Parquet file is in its footer.
 */
export function formatForFile(driverId: string, fileName: string): BulkFormat | undefined {
	const extension = extensionOf(nameWithoutEncoding(fileName));
	if (!extension) {
		return undefined;
	}
	return bulkFormatsFor(driverId).find((format) => format.extensions.includes(extension));
}

/**
 * What a driver is handed to load one file, and what it answers with.
 *
 * The driver's whole job is the socket: it does not choose the format, build the statement or read
 * the file into memory. `filePath` is on the machine the driver runs on, which is this one.
 */
export interface BulkLoadRequest {
	/** The statement, ending in its FORMAT clause, from {@link emitBulkLoad} and nowhere else. */
	sql: string;
	filePath: string;
	/** How the file is compressed, when it is. The SERVER expands it. */
	encoding?: BulkEncoding;
}

/** A file the person has chosen, before anything has been decided about it: its size, and what
 *  its NAME says it holds. `formatId` absent means the app has no guess and the person picks. */
export interface LoadFileChoice {
	path: string;
	name: string;
	/** Absent when the file could not be stat'd, which is shown as an unknown size rather than
	 *  as a failure: the load itself is the thing that says whether the file is really there. */
	bytes?: number;
	formatId?: string;
	encoding?: BulkEncoding;
}

export interface BulkLoadResult {
	/** What the server says it wrote. Not the file's row count: a format the server had to skip
	 *  rows of reports fewer. */
	rowsWritten: number;
	/** Bytes of the file sent, which for a compressed file is its compressed size. */
	bytesSent: number;
	durationMs: number;
}

/**
 * The other direction: a whole result written straight to a file by the SERVER.
 *
 * Same list of formats, because on this engine every one of them is both a way in and a way out,
 * and the same reason for existing: an export that goes through the app holds every row in memory
 * on the way past, which is exactly what a 50-million-row export cannot do.
 */
export interface BulkExportRequest {
	/** The statement, ending in its FORMAT clause, from {@link emitBulkExport}. */
	sql: string;
	/** Where the bytes land, on the machine the driver runs on. */
	filePath: string;
}

export interface BulkExportResult {
	bytesWritten: number;
	durationMs: number;
}

/** What the app's own export call answers with: where the file went, or why it did not, or that
 *  the person closed the picker (which is not a failure and says nothing). */
export type ServerExportOutcome =
	| { ok: true; path: string; bytes: number; durationMs: number }
	| { ok: false; error?: string; cancelled?: boolean };

/**
 * The statement with the export's format on the end.
 *
 * `explainTarget` is what takes off a trailing `FORMAT` the user wrote (and the semicolon) while
 * KEEPING a trailing `SETTINGS`, which is the same masked, top-level-only reading the Explain
 * panel needs and is right here for the same reason. ClickHouse's own order is
 * `... SETTINGS ... FORMAT X`, so the format goes last.
 */
export function emitBulkExport(sql: string, format: BulkFormat): string {
	return `${explainTarget(sql)} FORMAT ${format.id}`;
}

/**
 * Why the server may not export the result of `sql`, or undefined when it may.
 *
 * An export is a READ: whatever the editor holds is sent with a format on the end, and a statement
 * that writes (`ALTER TABLE ... DELETE`, a `DROP`, an `INSERT ... SELECT`) would run first and
 * export nothing. So it gets the same check the agent's reads get, on every connection whether
 * or not it is marked read-only, and the driver also asks the server to refuse a write.
 */
export function serverExportRefusal(sql: string, driver?: string, flavor?: string): string | undefined {
	const refusal = readOnlyError(sql, driver, flavor);
	if (!refusal) {
		return undefined;
	}
	const detail = refusal
		.replace(/^Refused:\s*/, '')
		.replace(/\s*The agent may only run [^.]*\.$/, '');
	const why = /^only read-only queries/.test(detail) ? '' : ` ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
	return `Export from the server only runs a read (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN), and this statement is not one.${why}`;
}

/** The file name an export of this format suggests: its first extension, or the format's own
 *  name lowercased when it claims none (`Native` → `.native`). */
export function bulkExportExtension(format: BulkFormat): string {
	return format.extensions[0] ?? `.${format.id.toLowerCase()}`;
}

/** Every extension a load will recognise, dotless and deduplicated, for a file picker's filter:
 *  the engine's own formats plus the compressions any of them may arrive in. */
export function bulkLoadExtensions(driverId: string): string[] {
	const formats = bulkFormatsFor(driverId).flatMap((format) => format.extensions);
	const compressed = formats.length > 0 ? ENCODINGS.map((entry) => entry.extension) : [];
	return [...new Set([...formats, ...compressed])].map((extension) => extension.slice(1));
}

/** Where a file is going. `columns` is for a file whose columns are a SUBSET of the table's, or
 *  are in a known order under a format that carries no names. */
export interface BulkLoadTarget {
	schema?: string;
	table: string;
	columns?: readonly string[];
}

/** `INSERT INTO "db"."table" [(cols)] FORMAT Parquet` — the whole statement, with the file's bytes
 *  to follow as its body. */
export function emitBulkLoad(driverId: string, target: BulkLoadTarget, format: BulkFormat): string {
	const quote = dialectFor(driverId).quoteIdent;
	const name = target.schema ? `${quote(target.schema)}.${quote(target.table)}` : quote(target.table);
	const columns = target.columns && target.columns.length > 0 ? ` (${target.columns.map(quote).join(', ')})` : '';
	// The id is this file's own; see the header. Nothing else in the statement is unquoted.
	return `INSERT INTO ${name}${columns} FORMAT ${format.id}`;
}

/**
 * What the person is told BEFORE it runs, in the order it matters.
 *
 * Every one of these is a thing that cannot be undone by closing the dialog afterwards, which is
 * why they are on the confirm rather than in the result.
 */
export function bulkLoadWarnings(format: BulkFormat, encoding: BulkEncoding | undefined, guessed: boolean): string[] {
	const warnings: string[] = [];
	if (!format.named) {
		warnings.push(`${format.label} carries no column names, so the values land in the table's column ORDER. A file whose columns are in another order fills the wrong ones, and nothing about that is an error.`);
	}
	if (guessed) {
		warnings.push(`The format was read off the file's name, not its contents. If it is wrong the load refuses, usually on the first row.`);
	}
	if (encoding) {
		warnings.push(`The file is sent compressed and the server expands it as it arrives, so nothing is written to this computer.`);
	}
	warnings.push(`An INSERT is not inside a transaction. A load that fails part way through leaves the rows it had already written, and running it again adds them a second time.`);
	return warnings;
}

/** The one line above the statement on the confirm. */
export function describeBulkLoad(target: BulkLoadTarget, format: BulkFormat): string {
	const name = target.schema ? `${target.schema}.${target.table}` : target.table;
	return format.named
		? `Read as ${format.label} and matched to ${name} by column name.`
		: `Read as ${format.label} and matched to ${name} by column position.`;
}

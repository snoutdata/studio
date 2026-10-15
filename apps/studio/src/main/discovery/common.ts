/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItem, ImportItemRef, ImportScanResult, ImportSourceId } from '../../shared/forms';
import { matchesExisting, stripSecrets } from '../importCommon';

// What every discovery source has in common.
//
// A source's PARSER is pure: text in, `Found[]` out, with secrets on the values. Only its thin
// wrapper touches the disk, a socket or a child process. The scaffolding below turns `Found[]` into
// the `ImportScanResult` the picker renders (secrets stripped, duplicates marked, keys assigned) and,
// at apply time, back into full values, so a new source is a parser plus a `locate()`.

/** One connection a source found, WITH its secrets. They are stripped before the renderer sees it. */
export interface Found {
	/** Where to find it again at apply time. */
	ref: ImportItemRef;
	/** Full values, password included when the source has one. */
	values: ConnectionFormValues;
	/** Its name in the source. */
	sourceName: string;
	supported: boolean;
	/** A password was found and will be imported. */
	importsPassword: boolean;
	/** See `ImportItem.tentative`. */
	tentative?: boolean;
	note?: string;
}

/** Friendly order: supported first, then by name. */
function byFriendlyOrder(a: Found, b: Found): number {
	return (Number(b.supported) - Number(a.supported)) || (Number(a.tentative ?? false) - Number(b.tentative ?? false)) || a.sourceName.localeCompare(b.sourceName);
}

/** The picker's view of what a source found: secrets stripped, duplicates marked, keys assigned. */
export function toScanResult(sourceId: ImportSourceId, sources: string[], found: Found[], existing: ConnectionConfig[]): ImportScanResult {
	const items: ImportItem[] = [...found].sort(byFriendlyOrder).map((f, i) => ({
		key: String(i),
		values: stripSecrets(f.values),
		sourceName: f.sourceName,
		supported: f.supported,
		duplicate: f.supported && matchesExisting(existing, f.values),
		importsPassword: f.importsPassword,
		ref: f.ref,
		note: f.note,
		...(f.tentative ? { tentative: true } : {}),
	}));
	return { sourceId, sources, items, notFound: items.length === 0 };
}

/** The values to save for the chosen refs, from a fresh read. Unsupported or vanished refs are skipped. */
export function pickResolved(found: Found[], refs: ImportItemRef[]): ConnectionFormValues[] {
	const out: ConnectionFormValues[] = [];
	for (const ref of refs) {
		const hit = found.find((f) => f.ref.file === ref.file && f.ref.connId === ref.connId);
		if (hit && hit.supported) {
			out.push(hit.values);
		}
	}
	return out;
}

/** A source that is a file (or a few) some tool wrote. */
export interface FileSource {
	id: ImportSourceId;
	/** Where the tool keeps it on this machine; may list files that do not exist. */
	locate(): string[];
	/** Everything one file holds. Returns [] for a file it cannot read. */
	read(file: string): Found[];
}

/** Scan a file source: the located files that exist, or the ones the user browsed to. */
export function scanFileSource(source: FileSource, existing: ConnectionConfig[], files?: string[]): ImportScanResult {
	const candidates = files ?? source.locate().filter((f) => existsSync(f));
	const found: Found[] = [];
	const sources: string[] = [];
	for (const file of candidates) {
		const got = source.read(file);
		if (got.length > 0) {
			sources.push(file);
			found.push(...got);
		}
	}
	return toScanResult(source.id, sources, found, existing);
}

/** Re-read the files the chosen refs came from, in main, and return what to save. */
export function resolveFileSource(source: FileSource, refs: ImportItemRef[]): ConnectionFormValues[] {
	const files = [...new Set(refs.map((r) => r.file))];
	return pickResolved(files.flatMap((file) => source.read(file)), refs);
}

/** "Username not found" / "no password" notes, shared so every source says it the same way. */
export function credentialNotes(values: ConnectionFormValues, hasPassword: boolean, why?: string): string[] {
	const notes: string[] = [];
	if (!values.username) {
		notes.push("Username not found; set it after import.");
	}
	if (!hasPassword) {
		notes.push(why ?? "No saved password; set it after import.");
	}
	return notes;
}

/** Ports as the text a tool stored them, to a number, or the fallback. */
export function portFrom(value: unknown, fallback: number): number {
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** A libpq `sslmode` as our TLS settings: `require` encrypts without verifying, `verify-*` verifies. */
export function sslFromLibpqMode(mode: unknown): Pick<ConnectionFormValues, 'ssl' | 'sslMode'> {
	const m = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
	if (m === 'verify-ca' || m === 'verify-full') {
		return { ssl: true, sslMode: 'system' };
	}
	if (m === 'require') {
		return { ssl: true, sslMode: 'insecure' };
	}
	return { ssl: false };
}

/**
 * A text file as a string, honouring a byte-order mark. SSMS writes UserSettings.xml as UTF-16, and
 * Windows tools are apt to put a BOM on UTF-8, so a plain utf8 read is wrong for exactly the files
 * this folder reads. Pure over the bytes (`decodeText`); `readTextFile` is the read.
 */
export function decodeText(bytes: Buffer): string {
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		return bytes.subarray(2).toString('utf16le');
	}
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		const swapped = Buffer.from(bytes.subarray(2));
		swapped.swap16();
		return swapped.toString('utf16le');
	}
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return bytes.subarray(3).toString('utf8');
	}
	return bytes.toString('utf8');
}

export function readTextFile(file: string): string {
	return decodeText(readFileSync(file));
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';

import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionFormValues, ImportItem, ImportItemRef, ImportScanResult } from '../shared/forms';
import { readConnections } from './configStore';
import { DEFAULT_PORT, asString, findElements, mapDriver, mapFlavor, matchesExisting, stripSecrets } from './importCommon';

// Import saved connections from Navicat. Navicat keeps live connections in the OS registry /
// keychain (no discoverable config file), but it can export them to a `.ncx` XML file, which
// is the portable, cross-platform path — so this importer is Browse-driven: the user exports
// "Connections…" from Navicat and points us at the `.ncx`. Passwords in the export are
// encrypted with Navicat's own cipher, so they're never imported; the user sets them after.

/** Read an attribute by trying several spellings Navicat versions use. */
function attr(attrs: Record<string, string>, ...names: string[]): string | undefined {
	for (const name of names) {
		const v = asString(attrs[name]);
		if (v) {
			return v;
		}
	}
	return undefined;
}

interface ParsedConnection {
	connId: string;
	values: ConnectionFormValues;
	sourceName: string;
	supported: boolean;
	duplicate: boolean;
	note?: string;
}

/** Translate one `<Connection>` element into a ParsedConnection. */
function buildParsed(attrs: Record<string, string>, index: number, existing: ConnectionConfig[]): ParsedConnection {
	const sourceName = attr(attrs, 'ConnectionName', 'Name') ?? "(unnamed)";
	const connType = attr(attrs, 'ConnType', 'ConnectionType') ?? '';
	const driver = mapDriver(connType);

	const host = attr(attrs, 'Host', 'Server', 'HostName') ?? '';
	const portStr = attr(attrs, 'Port');
	const port = portStr ? Number(portStr) : (driver ? DEFAULT_PORT[driver] : 0);
	const database = attr(attrs, 'Database', 'DatabaseName', 'InitialDatabase');
	const username = attr(attrs, 'UserName', 'User') ?? '';
	const sslAttr = attr(attrs, 'SSL_mode', 'SSL_Mode', 'UseSSL', 'SSL_Authentication');
	const ssl = sslAttr !== undefined && sslAttr !== '0' && sslAttr.toLowerCase() !== 'false';

	const values: ConnectionFormValues = {
		label: sourceName,
		driver: driver ?? 'mysql-aurora',
		flavor: mapFlavor(connType),
		host,
		port: Number.isFinite(port) ? Number(port) : (driver ? DEFAULT_PORT[driver] : 0),
		database,
		username,
		ssl,
		readOnly: false,
	};

	const notes: string[] = [];
	if (!driver) {
		notes.push(`Unsupported connection type (${connType || "unknown"}).`);
	} else {
		if (!username) {
			notes.push("Username not found; set it after import.");
		}
		notes.push("Passwords aren't imported from Navicat; set it after import.");
	}

	return {
		connId: String(index),
		values,
		sourceName,
		supported: driver !== null && host !== '',
		duplicate: driver !== null && matchesExisting(existing, values),
		note: notes.length > 0 ? notes.join(' ') : undefined,
	};
}

/** Parse one `.ncx` export into ParsedConnections keyed by their position in the file. */
function parseFile(file: string, existing: ConnectionConfig[]): Map<string, ParsedConnection> {
	const map = new Map<string, ParsedConnection>();
	let xml: string;
	try {
		xml = readFileSync(file, 'utf8');
	} catch {
		return map;
	}
	findElements(xml, 'Connection').forEach((el, i) => {
		const parsed = buildParsed(el.attrs, i, existing);
		map.set(parsed.connId, parsed);
	});
	return map;
}

/**
 * Navicat has no auto-discoverable config (live connections live in the registry/keychain),
 * so the scan always reports not-found, which steers the modal to its "Browse for a config
 * file" path where the user picks an exported `.ncx`.
 */
export function scanNavicat(): ImportScanResult {
	return { sourceId: 'navicat', sources: [], items: [], notFound: true };
}

/** Parse specific `.ncx` files the user browsed to. */
export function scanNavicatFiles(files: string[]): ImportScanResult {
	const existing = readConnections();
	const items: ImportItem[] = [];
	const sources: string[] = [];
	for (const file of files) {
		const parsed = parseFile(file, existing);
		if (parsed.size === 0) {
			continue;
		}
		sources.push(file);
		for (const p of parsed.values()) {
			items.push({
				key: '',
				values: stripSecrets(p.values),
				sourceName: p.sourceName,
				supported: p.supported,
				duplicate: p.duplicate,
				importsPassword: false,
				ref: { file, connId: p.connId },
				note: p.note,
			});
		}
	}
	items.sort((a, b) => (Number(b.supported) - Number(a.supported)) || a.sourceName.localeCompare(b.sourceName));
	items.forEach((item, i) => { item.key = String(i); });
	return { sourceId: 'navicat', sources, items, notFound: items.length === 0 };
}

/** Resolve the selected refs back to full values (Navicat stores no importable secrets). */
export function resolveNavicatImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	const byFile = new Map<string, string[]>();
	for (const ref of refs) {
		const list = byFile.get(ref.file) ?? [];
		list.push(ref.connId);
		byFile.set(ref.file, list);
	}
	const out: ConnectionFormValues[] = [];
	for (const [file, connIds] of byFile) {
		const parsed = parseFile(file, []);
		for (const connId of connIds) {
			const p = parsed.get(connId);
			if (p && p.supported) {
				out.push(p.values);
			}
		}
	}
	return out;
}

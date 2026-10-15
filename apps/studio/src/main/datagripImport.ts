/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionFormValues, ImportItem, ImportItemRef, ImportScanResult } from '../shared/forms';
import { readConnections } from './configStore';
import { DEFAULT_PORT, asString, findElements, firstElementText, mapDriver, mapFlavor, matchesExisting, parseJdbcUrl, stripSecrets, walkEntry } from './importCommon';

// Import saved connections from JetBrains DataGrip (and other IntelliJ-family IDEs). Data
// sources are stored as XML: the non-secret definition (name, jdbc-url, driver) lives in
// `dataSources.xml`, and the username lives alongside in `dataSources.local.xml` (matched by
// uuid). Passwords are kept in the OS password safe / a master-password store we can't read,
// so they're never imported — the user sets them after, matching the rest of the import flow.

// Subdirs under a JetBrains config dir that never hold data sources but can be large.
const SKIP_DIRS = new Set(['caches', 'log', 'logs', 'tmp', 'index', 'plugins', 'jdbc-drivers', 'eval']);

/** JetBrains per-user config roots, where IDEs keep their `options/` (returns existing only). */
function jetBrainsConfigDirs(): string[] {
	let base: string;
	if (process.platform === 'win32') {
		base = join(app.getPath('appData'), 'JetBrains');
	} else if (process.platform === 'darwin') {
		base = join(homedir(), 'Library', 'Application Support', 'JetBrains');
	} else {
		base = join(homedir(), '.config', 'JetBrains');
	}
	return existsSync(base) ? [base] : [];
}

/** Recursively find every `dataSources.xml` under `root` (bounded; the tree is small). Links
 *  are not followed (`walkEntry`). */
function findDataSourceFiles(root: string, depth = 0, found: string[] = []): string[] {
	if (depth > 6) {
		return found;
	}
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return found;
	}
	for (const name of entries) {
		const full = join(root, name);
		const kind = walkEntry(full);
		if (kind === 'dir') {
			if (!SKIP_DIRS.has(name.toLowerCase())) {
				findDataSourceFiles(full, depth + 1, found);
			}
		} else if (kind === 'file' && name === 'dataSources.xml') {
			found.push(full);
		}
	}
	return found;
}

/** True if a JDBC URL asks for TLS (`useSSL=true`, `sslmode=require|verify-*`, `ssl=true`). */
function urlWantsSsl(url: string | undefined): boolean {
	if (!url) {
		return false;
	}
	const u = url.toLowerCase();
	return /usessl=true|ssl=true|sslmode=(require|verify|prefer|allow)/.test(u);
}

interface ParsedConnection {
	connId: string;
	values: ConnectionFormValues;
	sourceName: string;
	supported: boolean;
	duplicate: boolean;
	note?: string;
}

/** Read uuid→user-name from a sibling `dataSources.local.xml`, when present. */
function readLocalUsernames(file: string): Map<string, string> {
	const map = new Map<string, string>();
	const local = join(dirname(file), 'dataSources.local.xml');
	if (!existsSync(local)) {
		return map;
	}
	let xml: string;
	try {
		xml = readFileSync(local, 'utf8');
	} catch {
		return map;
	}
	for (const el of findElements(xml, 'data-source')) {
		const uuid = el.attrs.uuid;
		const user = firstElementText(el.inner, 'user-name');
		if (uuid && user) {
			map.set(uuid, user);
		}
	}
	return map;
}

/** Translate one `<data-source>` element into a ParsedConnection. */
function buildParsed(el: { attrs: Record<string, string>; inner: string }, usernames: Map<string, string>, existing: ConnectionConfig[]): ParsedConnection {
	const uuid = el.attrs.uuid ?? '';
	const sourceName = asString(el.attrs.name) ?? "(unnamed)";
	const driverRef = firstElementText(el.inner, 'driver-ref') ?? '';
	const jdbcDriver = firstElementText(el.inner, 'jdbc-driver') ?? '';
	const url = firstElementText(el.inner, 'jdbc-url');
	const driver = mapDriver(`${driverRef} ${jdbcDriver} ${url ?? ''}`);

	const fromUrl = parseJdbcUrl(url);
	const host = fromUrl.host ?? '';
	const port = fromUrl.port ?? (driver ? DEFAULT_PORT[driver] : 0);
	const username = usernames.get(uuid) ?? firstElementText(el.inner, 'user-name') ?? '';

	const values: ConnectionFormValues = {
		label: sourceName,
		driver: driver ?? 'mysql-aurora',
		flavor: mapFlavor(`${driverRef} ${jdbcDriver} ${url ?? ''}`),
		host,
		port: Number.isFinite(port) ? Number(port) : (driver ? DEFAULT_PORT[driver] : 0),
		database: fromUrl.database,
		username,
		ssl: urlWantsSsl(url),
		readOnly: false,
	};

	const notes: string[] = [];
	if (!driver) {
		notes.push(`Unsupported driver (${driverRef || jdbcDriver || "unknown"}).`);
	} else {
		if (!username) {
			notes.push("Username not found; set it after import.");
		}
		notes.push("Passwords aren't imported from DataGrip; set it after import.");
	}

	return {
		connId: uuid || sourceName,
		values,
		sourceName,
		supported: driver !== null && host !== '',
		duplicate: driver !== null && matchesExisting(existing, values),
		note: notes.length > 0 ? notes.join(' ') : undefined,
	};
}

/** Parse one `dataSources.xml` (+ its sibling local file) into ParsedConnections by id. */
function parseFile(file: string, existing: ConnectionConfig[]): Map<string, ParsedConnection> {
	const map = new Map<string, ParsedConnection>();
	let xml: string;
	try {
		xml = readFileSync(file, 'utf8');
	} catch {
		return map;
	}
	const usernames = readLocalUsernames(file);
	for (const el of findElements(xml, 'data-source')) {
		const parsed = buildParsed(el, usernames, existing);
		map.set(parsed.connId, parsed);
	}
	return map;
}

/** Scan the local JetBrains config for importable DataGrip data sources. */
export function scanDatagrip(): ImportScanResult {
	const files: string[] = [];
	for (const dir of jetBrainsConfigDirs()) {
		findDataSourceFiles(dir, 0, files);
	}
	if (files.length === 0) {
		return { sourceId: 'datagrip', sources: [], items: [], notFound: true };
	}
	return scanDatagripFiles(files);
}

/** Parse specific dataSources.xml files (auto-detected, or one the user browsed to). */
export function scanDatagripFiles(files: string[]): ImportScanResult {
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
	return { sourceId: 'datagrip', sources, items, notFound: items.length === 0 };
}

/** Resolve the selected refs back to full values (no secrets to resolve; DataGrip stores none). */
export function resolveDatagripImport(refs: ImportItemRef[]): ConnectionFormValues[] {
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

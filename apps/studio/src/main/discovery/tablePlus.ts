/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { DEFAULT_PORT, asRecord, asString, mapDriver, mapEnvironment, parseXmlTree, type XmlNode } from '../importCommon';
import { credentialNotes, pickResolved, portFrom, toScanResult, type Found } from './common';
import { hostEnv, tablePlusFiles } from './paths';

// TablePlus (macOS) keeps its connections in Data/Connections.plist: an array of dicts, one per
// connection. The key names were read out of the TablePlus 6 binary itself (build 802) rather than
// guessed: ConnectionName, Driver, DatabaseHost, DatabasePort, DatabaseName, DatabaseUser,
// DatabasePath (SQLite), Enviroment (sic), isOverSSH, ServerAddress, ServerPort, ServerUser,
// ServerPrivateKeyName, tLSMode, ID. Passwords are in the Keychain and are not imported.
//
// The file may be a BINARY plist; it is converted with `plutil -convert xml1 -o -` (execFile, never a
// shell) and then parsed here, purely. The Windows build's format is not known, so on Windows this
// source finds nothing and offers Browse.

/** A property list value. */
export type Plist = string | number | boolean | Date | Plist[] | { [key: string]: Plist } | null;

function plistValue(node: XmlNode): Plist {
	switch (node.name) {
		case 'dict': {
			const out: { [key: string]: Plist } = {};
			for (let i = 0; i < node.children.length; i++) {
				const k = node.children[i];
				if (k.name === 'key' && i + 1 < node.children.length) {
					out[k.text] = plistValue(node.children[++i]);
				}
			}
			return out;
		}
		case 'array': return node.children.map(plistValue);
		case 'string': return node.text;
		case 'integer': return Number.parseInt(node.text.trim(), 10);
		case 'real': return Number.parseFloat(node.text.trim());
		case 'true': return true;
		case 'false': return false;
		case 'date': return new Date(node.text.trim());
		default: return null;
	}
}

/** Parse an XML property list to its value. Pure; null for anything that is not one. */
export function parsePlistXml(xml: string): Plist {
	const plist = parseXmlTree(xml).children.find((n) => n.name === 'plist');
	const top = plist?.children[0];
	return top ? plistValue(top) : null;
}

/** TablePlus driver names the shared mapper does not know. */
const TABLEPLUS_DRIVERS: Record<string, string> = {
	sqlite: 'sqlite', duckdb: 'duckdb', mongo: 'mongodb', mongodb: 'mongodb', snowflake: 'snowflake', cockroach: 'postgres',
};

/** TablePlus's `tLSMode`: 0 off; 1 preferred; 2 required; 3 and up verify. */
function sslFrom(mode: unknown): Pick<ConnectionFormValues, 'ssl' | 'sslMode'> {
	const n = Number(mode);
	if (n >= 3) {
		return { ssl: true, sslMode: 'system' };
	}
	return n === 2 ? { ssl: true, sslMode: 'insecure' } : { ssl: false };
}

/** Map the decoded plist to what it describes. Pure. */
export function tablePlusToFound(file: string, plist: Plist): Found[] {
	if (!Array.isArray(plist)) {
		return [];
	}
	return plist.map((raw, i) => {
		const c = asRecord(raw);
		const driverText = asString(c.Driver) ?? '';
		const driver = TABLEPLUS_DRIVERS[driverText.toLowerCase()] ?? mapDriver(driverText);
		const name = asString(c.ConnectionName) ?? "TablePlus connection";
		const connId = asString(c.ID) ?? String(i);
		if (driver === 'sqlite' || driver === 'duckdb') {
			const path = asString(c.DatabasePath) ?? '';
			return {
				ref: { file, connId },
				values: { label: name, driver, host: '', port: 0, database: path, username: '', ssl: false, readOnly: false },
				sourceName: name,
				supported: path !== '',
				importsPassword: false,
			};
		}
		const values: ConnectionFormValues = {
			label: name,
			driver: driver ?? 'postgres',
			environment: mapEnvironment(c.Enviroment),
			host: asString(c.DatabaseHost) ?? '',
			port: portFrom(c.DatabasePort, DEFAULT_PORT[driver ?? ''] ?? 0),
			database: asString(c.DatabaseName),
			username: asString(c.DatabaseUser) ?? '',
			...sslFrom(c.tLSMode),
			readOnly: false,
		};
		if (c.isOverSSH === true || c.isOverSSH === 1) {
			values.ssh = {
				host: asString(c.ServerAddress) ?? '',
				port: portFrom(c.ServerPort, 22),
				username: asString(c.ServerUser) ?? '',
				privateKeyPath: asString(c.ServerPrivateKeyName),
				keepAlive: true,
			};
		}
		return {
			ref: { file, connId },
			values,
			sourceName: name,
			supported: driver !== null && values.host !== '',
			importsPassword: false,
			note: driver === null
				? `Unsupported driver (${driverText || "unknown"}).`
				: credentialNotes(values, false, "TablePlus keeps passwords in your Keychain, so set it after import.").join(' '),
		};
	});
}

/** The file as XML: read directly, or converted from binary by plutil. */
function readPlistXml(file: string): Promise<string> {
	let head: Buffer;
	try {
		head = readFileSync(file);
	} catch {
		return Promise.resolve('');
	}
	if (!head.subarray(0, 8).toString('latin1').startsWith('bplist')) {
		return Promise.resolve(head.toString('utf8'));
	}
	return new Promise((resolve) => {
		execFile('plutil', ['-convert', 'xml1', '-o', '-', file], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
	});
}

async function read(file: string): Promise<Found[]> {
	return tablePlusToFound(file, parsePlistXml(await readPlistXml(file)));
}

export async function scanTablePlus(existing: ConnectionConfig[], files?: string[]): Promise<ImportScanResult> {
	const found: Found[] = [];
	const sources: string[] = [];
	for (const file of files ?? tablePlusFiles(hostEnv())) {
		const got = await read(file);
		if (got.length > 0) {
			found.push(...got);
			sources.push(file);
		}
	}
	return toScanResult('tableplus', sources, found, existing);
}

export async function resolveTablePlusImport(refs: ImportItemRef[]): Promise<ConnectionFormValues[]> {
	const found: Found[] = [];
	for (const file of new Set(refs.map((r) => r.file))) {
		found.push(...await read(file));
	}
	return pickResolved(found, refs);
}

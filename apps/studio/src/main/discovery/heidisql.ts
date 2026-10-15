/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { pickResolved, portFrom, readTextFile, toScanResult, type Found } from './common';
import { heidisqlPortableFiles, hostEnv } from './paths';
import { parseSqlServerInstance } from './ssms';

// HeidiSQL (Windows only) keeps its sessions in the registry under HKCU\Software\HeidiSQL\Servers,
// one key per session (sessions can sit in folders, which are keys with a `Folder` value), or, for
// a portable install, in portable_settings.txt beside the executable. Its saved password is not
// encrypted, only obfuscated: hex pairs shifted by the digit at the end. So passwords ARE imported,
// decoded here in main, and never sent to the renderer.
//
// The registry is read with `reg query` (execFile, no shell), and the parsing is pure.

/** The registry key sessions live under. */
export const HEIDI_KEY = 'HKCU\\Software\\HeidiSQL\\Servers';
/** `ref.file` for a session read from the registry (a portable one carries its file's path). */
export const HEIDI_REGISTRY = 'registry';

/** Reverse HeidiSQL's password obfuscation: hex pairs, each minus the shift in the last digit. */
export function decodeHeidiPassword(encoded: string | undefined): string | undefined {
	if (!encoded) {
		return undefined;
	}
	const shift = Number(encoded[encoded.length - 1]);
	const hex = encoded.slice(0, -1);
	if (!Number.isInteger(shift) || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
		return undefined;
	}
	let out = '';
	for (let i = 0; i < hex.length; i += 2) {
		out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) - shift);
	}
	return out || undefined;
}

/** A session's values by name, keyed by its path under Servers (`Folder\Session`). */
export type HeidiSessions = Map<string, Map<string, string>>;

/** Parse `reg query <HEIDI_KEY> /s` output. Pure. */
export function parseRegQuery(output: string): HeidiSessions {
	const sessions: HeidiSessions = new Map();
	let current: Map<string, string> | null = null;
	const prefix = HEIDI_KEY.replace(/^HKCU/, 'HKEY_CURRENT_USER').toLowerCase() + '\\';
	for (const line of output.split(/\r?\n/)) {
		if (/^HKEY_/i.test(line)) {
			const key = line.trim();
			current = key.toLowerCase().startsWith(prefix) ? new Map() : null;
			if (current) {
				sessions.set(key.slice(prefix.length), current);
			}
			continue;
		}
		const m = /^\s{4}(.+?)\s{4}(REG_\w+)(?:\s{4}(.*))?$/.exec(line);
		if (m && current) {
			const data = m[3] ?? '';
			current.set(m[1], m[2] === 'REG_DWORD' ? String(parseInt(data, 16)) : data);
		}
	}
	return sessions;
}

/** Parse portable_settings.txt (`Servers\<session>\<name><|||><type><|||><value>` per line). Pure. */
export function parsePortableSettings(text: string): HeidiSessions {
	const sessions: HeidiSessions = new Map();
	for (const line of text.split(/\r?\n/)) {
		const parts = line.split('<|||>');
		if (parts.length < 3 || !/^Servers\\/i.test(parts[0])) {
			continue;
		}
		const path = parts[0].slice('Servers\\'.length);
		const cut = path.lastIndexOf('\\');
		if (cut === -1) {
			continue;
		}
		const session = path.slice(0, cut);
		const values = sessions.get(session) ?? new Map<string, string>();
		values.set(path.slice(cut + 1), parts.slice(2).join('<|||>').replace(/<\{\{\{><\}\}\}>/g, '\n'));
		sessions.set(session, values);
	}
	return sessions;
}

/** Turn sessions into what they describe. Folders (no Host and no NetType) are skipped. Pure. */
export function heidiSessionsToFound(file: string, sessions: HeidiSessions): Found[] {
	const out: Found[] = [];
	for (const [path, v] of sessions) {
		if (!v.has('Host') && !v.has('NetType')) {
			continue;
		}
		const name = path.split('\\').pop() || path;
		const netType = Number(v.get('NetType') ?? '0');
		const windowsAuth = v.get('WindowsAuth') === '1';
		const password = windowsAuth ? undefined : decodeHeidiPassword(v.get('Password'));
		const database = (v.get('Databases') ?? '').split(';').map((d) => d.trim()).find(Boolean);
		const version = v.get('ServerVersionFull') ?? '';
		const base = { label: name, username: windowsAuth ? '' : (v.get('User') ?? ''), password, readOnly: false };
		const ssl = v.get('WantSSL') === '1';
		let values: ConnectionFormValues;
		const notes: string[] = [];
		if (netType >= 0 && netType <= 2) {
			values = {
				...base,
				driver: /mariadb/i.test(version) ? 'mariadb' : 'mysql-aurora',
				host: v.get('Host') || 'localhost',
				port: portFrom(v.get('Port'), 3306),
				database,
				ssl,
				sslMode: ssl ? 'insecure' : undefined,
			};
			if (netType === 1) {
				notes.push("HeidiSQL connects over a named pipe; this imports it as TCP.");
			}
			if (netType === 2 && v.get('SSHtunnelHost')) {
				values.ssh = {
					host: v.get('SSHtunnelHost') ?? '',
					port: portFrom(v.get('SSHtunnelHostPort'), 22),
					username: v.get('SSHtunnelUser') ?? '',
					privateKeyPath: v.get('SSHtunnelPrivateKey') || undefined,
					keepAlive: true,
				};
				notes.push("The SSH password is not imported.");
			}
		} else if (netType >= 3 && netType <= 7) {
			const inst = parseSqlServerInstance(v.get('Host') ?? '');
			values = { ...base, driver: 'sqlserver', host: inst.host, port: inst.port ?? portFrom(v.get('Port'), 1433), database, ssl, sslMode: ssl ? 'insecure' : undefined };
			if (windowsAuth) {
				notes.push("Uses Windows authentication, which has no username to import; set a SQL login after import.");
			}
		} else if (netType === 8) {
			values = { ...base, driver: 'postgres', host: v.get('Host') ?? '', port: portFrom(v.get('Port'), 5432), database, ssl, sslMode: ssl ? 'insecure' : undefined };
		} else if (netType === 9) {
			// SQLite: the "host" is the database file (HeidiSQL allows several, separated by ';').
			const file0 = (v.get('Host') ?? '').split(';')[0].trim();
			values = { label: name, driver: 'sqlite', host: '', port: 0, database: file0, username: '', ssl: false, readOnly: false };
			out.push({ ref: { file, connId: path }, values, sourceName: name, supported: file0 !== '', importsPassword: false });
			continue;
		} else {
			out.push({
				ref: { file, connId: path },
				values: { label: name, driver: 'mysql-aurora', host: v.get('Host') ?? '', port: 0, username: '', ssl: false, readOnly: false },
				sourceName: name,
				supported: false,
				importsPassword: false,
				note: `Unsupported HeidiSQL network type (${netType}).`,
			});
			continue;
		}
		if (!windowsAuth && !password) {
			notes.push("No saved password; set it after import.");
		}
		out.push({
			ref: { file, connId: path },
			values,
			sourceName: name,
			supported: values.host !== '',
			importsPassword: Boolean(password),
			note: notes.length > 0 ? notes.join(' ') : undefined,
		});
	}
	return out;
}

/** Run `reg query`, resolving to its output or '' (key absent, not Windows, reg failed). */
function regQuery(): Promise<string> {
	return new Promise((resolve) => {
		if (process.platform !== 'win32') {
			resolve('');
			return;
		}
		execFile('reg', ['query', HEIDI_KEY, '/s'], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			resolve(err ? '' : stdout);
		});
	});
}

/** Every session HeidiSQL holds: the registry, then each portable settings file present. */
async function readAll(files?: string[]): Promise<{ found: Found[]; sources: string[] }> {
	const found: Found[] = [];
	const sources: string[] = [];
	if (!files) {
		const reg = heidiSessionsToFound(HEIDI_REGISTRY, parseRegQuery(await regQuery()));
		if (reg.length > 0) {
			found.push(...reg);
			sources.push(HEIDI_KEY);
		}
	}
	for (const file of files ?? heidisqlPortableFiles(hostEnv()).filter((f) => existsSync(f))) {
		try {
			const got = heidiSessionsToFound(file, parsePortableSettings(readTextFile(file)));
			if (got.length > 0) {
				found.push(...got);
				sources.push(file);
			}
		} catch {
			// unreadable: nothing from this file
		}
	}
	return { found, sources };
}

export async function scanHeidisql(existing: ConnectionConfig[], files?: string[]): Promise<ImportScanResult> {
	const { found, sources } = await readAll(files);
	return toScanResult('heidisql', sources, found, existing);
}

export async function resolveHeidisqlImport(refs: ImportItemRef[]): Promise<ConnectionFormValues[]> {
	const found: Found[] = [];
	if (refs.some((r) => r.file === HEIDI_REGISTRY)) {
		found.push(...heidiSessionsToFound(HEIDI_REGISTRY, parseRegQuery(await regQuery())));
	}
	for (const file of new Set(refs.filter((r) => r.file !== HEIDI_REGISTRY).map((r) => r.file))) {
		try {
			found.push(...heidiSessionsToFound(file, parsePortableSettings(readTextFile(file))));
		} catch {
			// gone since the scan
		}
	}
	return pickResolved(found, refs);
}

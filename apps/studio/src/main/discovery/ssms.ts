/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { parseXmlTree, xmlDescendants, xmlText, type XmlNode } from '../importCommon';
import { readTextFile, resolveFileSource, scanFileSource, type FileSource, type Found } from './common';
import { hostEnv, ssmsRoot } from './paths';

// SQL Server Management Studio (18 and later) remembers the servers in its Connect dialog in
// %APPDATA%\Microsoft\SQL Server Management Studio\<version>\UserSettings.xml: per server type, a
// list of `ServerConnectionItem`s, each an `Instance` and the logins used against it. Windows only;
// SSMS 17 and earlier kept a binary SqlStudio.bin, which is not read. Passwords are DPAPI-encrypted
// and are not imported.

/** The Database Engine's server-type id in UserSettings.xml (the others are SSAS, SSRS, SSIS). */
const DATABASE_ENGINE = '8c91a03d-f9b4-46c0-a305-b5dcc79ff907';

/**
 * An SSMS/ADO instance string to a host and port: `host`, `host,1433`, `host\NAMED`, `tcp:host,1433`,
 * `.`, `(local)`. A named instance stays in the host as `host\NAME`, which the SQL Server driver
 * resolves through the SQL Server Browser; a port given with a comma wins over it.
 */
export function parseSqlServerInstance(text: string): { host: string; port?: number; instance?: string } {
	let t = text.trim().replace(/^(tcp|np|lpc|admin):/i, '');
	let port: number | undefined;
	const comma = /^(.*),\s*(\d+)$/.exec(t);
	if (comma) {
		t = comma[1];
		port = Number(comma[2]);
	}
	const slash = t.indexOf('\\');
	let host = slash === -1 ? t : t.slice(0, slash);
	const instance = slash === -1 ? undefined : t.slice(slash + 1) || undefined;
	if (host === '.' || /^\(local(db)?\)$/i.test(host)) {
		host = 'localhost';
	}
	if (port === undefined && instance && !/^mssqlserver$/i.test(instance)) {
		return { host: `${host}\\${instance}`, instance };
	}
	return { host, port, instance };
}

/** Parse one UserSettings.xml. Pure. */
export function parseSsmsUserSettings(file: string, xml: string): Found[] {
	const tree = parseXmlTree(xml);
	// Per server type, when the file is shaped as expected; otherwise every ServerConnectionItem.
	const typed = xmlDescendants(tree, 'ServerTypes').flatMap((st) => st.children.filter((e) => e.name === 'Element'));
	const engineGroups = typed.filter((el) => (xmlText(el, 'guid') ?? xmlText(el, 'Key') ?? '').toLowerCase() === DATABASE_ENGINE);
	const scopes: XmlNode[] = typed.length > 0 ? engineGroups : [tree];
	const items = scopes.flatMap((scope) => xmlDescendants(scope, 'ServerConnectionItem'));
	const seen = new Set<string>();
	const out: Found[] = [];
	for (const item of items) {
		const instance = xmlText(item, 'Instance');
		if (!instance) {
			continue;
		}
		// One row per (instance, login): the same server used with two logins is two connections.
		const settings = xmlDescendants(item, 'ServerConnectionSettings');
		const logins = settings.length > 0 ? settings : [item];
		for (const s of logins) {
			const auth = xmlText(s, 'AuthenticationMethod') ?? xmlText(item, 'AuthenticationMethod') ?? '';
			const windowsAuth = auth === '0';
			const username = windowsAuth ? '' : (xmlText(s, 'UserName') ?? '');
			const connId = `${instance}|${username}`;
			if (seen.has(connId)) {
				continue;
			}
			seen.add(connId);
			const inst = parseSqlServerInstance(instance);
			const database = xmlText(s, 'Database');
			const values: ConnectionFormValues = {
				label: username ? `${instance} (${username})` : instance,
				driver: 'sqlserver',
				host: inst.host,
				port: inst.port ?? 1433,
				database: database && database !== '<default>' ? database : undefined,
				username,
				ssl: false,
				readOnly: false,
			};
			out.push({
				ref: { file, connId },
				values,
				sourceName: values.label,
				supported: inst.host !== '',
				importsPassword: false,
				note: windowsAuth
					? "Uses Windows authentication, which has no username to import; set a SQL login after import."
					: "SSMS encrypts saved passwords for this Windows account, so set it after import.",
			});
		}
	}
	return out;
}

/** Every UserSettings.xml under the SSMS folder, one per installed version. */
function locateSsms(): string[] {
	const root = ssmsRoot(hostEnv());
	if (!root || !existsSync(root)) {
		return [];
	}
	try {
		return readdirSync(root).map((v) => join(root, v, 'UserSettings.xml'));
	} catch {
		return [];
	}
}

export const ssmsSource: FileSource = {
	id: 'ssms',
	locate: locateSsms,
	read(file) {
		try {
			return parseSsmsUserSettings(file, readTextFile(file));
		} catch {
			return [];
		}
	},
};

export function scanSsms(existing: ConnectionConfig[], files?: string[]): ImportScanResult {
	return scanFileSource(ssmsSource, existing, files);
}

export function resolveSsmsImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	return resolveFileSource(ssmsSource, refs);
}

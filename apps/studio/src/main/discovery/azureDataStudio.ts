/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { asRecord, asString } from '../importCommon';
import { credentialNotes, portFrom, readTextFile, resolveFileSource, scanFileSource, sslFromLibpqMode, type FileSource, type Found } from './common';
import { azureDataStudioFiles, hostEnv } from './paths';
import { parseSqlServerInstance } from './ssms';

// Azure Data Studio keeps its connections in the user settings.json under `datasource.connections`,
// one object per connection with a `providerName` (MSSQL, PGSQL) and an `options` bag. The file is
// VS Code settings, i.e. JSON WITH comments and trailing commas, so it is parsed leniently. Saved
// passwords are in the OS credential store and are not imported.

/**
 * Parse JSON with comments and trailing commas (VS Code's JSONC). Strings are copied through
 * untouched, so a `//` inside a value survives. Throws on anything else, like JSON.parse.
 */
export function parseJsonc(text: string): unknown {
	let out = '';
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < n && text[j] !== '"') {
				j += text[j] === '\\' ? 2 : 1;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') {
				i++;
			}
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? n : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	// Trailing commas: a comma followed only by whitespace before a closing bracket or brace.
	// Safe after the pass above only because strings were copied whole; re-scan to skip them.
	let cleaned = '';
	for (let k = 0; k < out.length; k++) {
		const c = out[k];
		if (c === '"') {
			let j = k + 1;
			while (j < out.length && out[j] !== '"') {
				j += out[j] === '\\' ? 2 : 1;
			}
			cleaned += out.slice(k, j + 1);
			k = j;
			continue;
		}
		if (c === ',') {
			let j = k + 1;
			while (j < out.length && /\s/.test(out[j])) {
				j++;
			}
			if (out[j] === '}' || out[j] === ']') {
				continue;
			}
		}
		cleaned += c;
	}
	return JSON.parse(cleaned);
}

/** ADS's MSSQL `encrypt` option: "Mandatory"/"Strict"/true mean TLS; `trustServerCertificate` skips verifying. */
function mssqlSsl(options: Record<string, unknown>): Pick<ConnectionFormValues, 'ssl' | 'sslMode'> {
	const e = options.encrypt;
	const on = e === true || (typeof e === 'string' && /^(true|mandatory|strict)$/i.test(e));
	if (!on) {
		return { ssl: false };
	}
	return { ssl: true, sslMode: options.trustServerCertificate === true ? 'insecure' : 'system' };
}

/** Parse settings.json text. Pure. */
export function parseAzureDataStudioSettings(file: string, text: string): Found[] {
	let settings: Record<string, unknown>;
	try {
		settings = asRecord(parseJsonc(text));
	} catch {
		return [];
	}
	const list = settings['datasource.connections'];
	if (!Array.isArray(list)) {
		return [];
	}
	return list.map((raw, i) => {
		const conn = asRecord(raw);
		const options = asRecord(conn.options);
		const provider = (asString(conn.providerName) ?? '').toUpperCase();
		const auth = asString(options.authenticationType) ?? '';
		const connId = asString(conn.id) ?? String(i);
		let values: ConnectionFormValues;
		const notes: string[] = [];
		if (provider === 'MSSQL') {
			const inst = parseSqlServerInstance(asString(options.server) ?? '');
			values = {
				label: '',
				driver: 'sqlserver',
				host: inst.host,
				port: portFrom(options.port, inst.port ?? 1433),
				database: asString(options.database),
				username: asString(options.user) ?? '',
				...mssqlSsl(options),
				readOnly: false,
			};
			if (/integrated/i.test(auth)) {
				notes.push("Uses Windows authentication; set a SQL login after import.");
			} else if (/azure/i.test(auth)) {
				notes.push("Uses Microsoft Entra sign-in; set a SQL login after import.");
			}
		} else if (provider === 'PGSQL') {
			values = {
				label: '',
				driver: 'postgres',
				host: asString(options.host) ?? asString(options.server) ?? '',
				port: portFrom(options.port, 5432),
				database: asString(options.dbname) ?? asString(options.database),
				username: asString(options.user) ?? '',
				...sslFromLibpqMode(options.sslmode),
				readOnly: false,
			};
		} else {
			return {
				ref: { file, connId },
				values: { label: asString(options.connectionName) ?? "Azure Data Studio connection", driver: 'sqlserver', host: '', port: 0, username: '', ssl: false, readOnly: false },
				sourceName: asString(options.connectionName) ?? "Azure Data Studio connection",
				supported: false,
				importsPassword: false,
				note: `Unsupported provider (${provider || "unknown"}).`,
			};
		}
		const name = asString(options.connectionName) ?? (values.database ? `${values.host}/${values.database}` : values.host);
		values.label = name || "Azure Data Studio connection";
		if (notes.length === 0) {
			notes.push(...credentialNotes(values, false, "Azure Data Studio keeps passwords in your credential store, so set it after import."));
		}
		return {
			ref: { file, connId },
			values,
			sourceName: values.label,
			supported: values.host !== '',
			importsPassword: false,
			note: notes.join(' '),
		};
	});
}

export const azureDataStudioSource: FileSource = {
	id: 'azure-data-studio',
	locate: () => azureDataStudioFiles(hostEnv()),
	read(file) {
		try {
			return parseAzureDataStudioSettings(file, readTextFile(file));
		} catch {
			return [];
		}
	},
};

export function scanAzureDataStudio(existing: ConnectionConfig[], files?: string[]): ImportScanResult {
	return scanFileSource(azureDataStudioSource, existing, files);
}

export function resolveAzureDataStudioImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	return resolveFileSource(azureDataStudioSource, refs);
}

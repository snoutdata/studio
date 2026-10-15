/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { portFrom, readTextFile, resolveFileSource, scanFileSource, type FileSource, type Found } from './common';
import { hostEnv, pgpassFiles } from './paths';

// The Postgres password file: `hostname:port:database:username:password` per line, `\:` and `\\`
// escaped, `#` comments, `*` a wildcard. It is the one standard place a Postgres password is kept in
// the clear (libpq requires the file to be private), so its passwords ARE imported, resolved in main.
//
// An entry with a wildcard host or username names no one connection, so it is skipped rather than
// guessed at. A wildcard port becomes 5432, and a wildcard database leaves the database unset.

/** Split one line on unescaped colons, unescaping `\:` and `\\`. */
function splitFields(line: string): string[] {
	const fields: string[] = [];
	let cur = '';
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '\\' && i + 1 < line.length) {
			cur += line[++i];
		} else if (c === ':') {
			fields.push(cur);
			cur = '';
		} else {
			cur += c;
		}
	}
	fields.push(cur);
	return fields;
}

/** Parse a pgpass file. Pure. */
export function parsePgpass(file: string, text: string): Found[] {
	const out: Found[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const f = splitFields(line);
		if (f.length < 5) {
			continue;
		}
		const [host, port, db, user] = f;
		const password = f.slice(4).join(':');
		if (host === '*' || user === '*' || !host || !user) {
			continue;
		}
		const socket = host.startsWith('/');
		const database = db === '*' ? undefined : db;
		const name = `${user}@${host}${database ? `/${database}` : ''}`;
		const values: ConnectionFormValues = {
			label: name,
			driver: 'postgres',
			host: socket ? '' : host,
			port: port === '*' ? 5432 : portFrom(port, 5432),
			database,
			username: user,
			password: password || undefined,
			ssl: false,
			readOnly: false,
		};
		out.push({
			// Identity is the entry itself (minus the password), so a re-read finds it even if lines moved.
			ref: { file, connId: `${host}:${port}:${db}:${user}` },
			values,
			sourceName: name,
			supported: !socket,
			importsPassword: !socket && Boolean(password),
			note: socket ? "A Unix socket entry; only TCP connections can be imported." : (database ? undefined : "Any database on this server; the connection opens its default."),
		});
	}
	return out;
}

export const pgpassSource: FileSource = {
	id: 'pgpass',
	locate: () => pgpassFiles(hostEnv()),
	read(file) {
		try {
			return parsePgpass(file, readTextFile(file));
		} catch {
			return [];
		}
	},
};

export function scanPgpass(existing: ConnectionConfig[], files?: string[]): ImportScanResult {
	return scanFileSource(pgpassSource, existing, files);
}

export function resolvePgpassImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	return resolveFileSource(pgpassSource, refs);
}

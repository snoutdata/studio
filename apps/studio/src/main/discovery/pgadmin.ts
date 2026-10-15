/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { asRecord, asString } from '../importCommon';
import { openDatabase } from '../sqlite';
import { credentialNotes, portFrom, readTextFile, resolveFileSource, scanFileSource, sslFromLibpqMode, type FileSource, type Found } from './common';
import { hostEnv, pgadminFiles } from './paths';

// pgAdmin 4 keeps its servers in a SQLite database, `pgadmin4.db`, table `server`. The columns have
// moved between versions (the SSL mode went from a column into a `connection_params` JSON object in
// 7.x), so a row is read by name and anything missing is simply absent. Saved passwords are
// encrypted with the user's pgAdmin master password, so they are never imported.
//
// Browse also takes the `servers.json` pgAdmin writes from Tools → Export servers, which carries the
// same fields under different names and never a password.

const NO_PASSWORD = "pgAdmin encrypts saved passwords with its master password, so set it after import.";

function buildServer(file: string, connId: string, r: {
	name?: string; host?: string; port?: unknown; database?: string; username?: string; sslmode?: unknown;
	service?: string; tunnel?: { host?: string; port?: unknown; username?: string; keyFile?: string };
}): Found {
	const host = r.host ?? '';
	const values: ConnectionFormValues = {
		label: r.name || host || "pgAdmin server",
		driver: 'postgres',
		host,
		port: portFrom(r.port, 5432),
		database: r.database,
		username: r.username ?? '',
		...sslFromLibpqMode(r.sslmode),
		readOnly: false,
	};
	if (r.tunnel?.host) {
		values.ssh = {
			host: r.tunnel.host,
			port: portFrom(r.tunnel.port, 22),
			username: r.tunnel.username ?? '',
			privateKeyPath: r.tunnel.keyFile,
			keepAlive: true,
		};
	}
	const notes = host ? credentialNotes(values, false, NO_PASSWORD) : [r.service ? `Uses the libpq service "${r.service}", which cannot be imported.` : "No host saved."];
	return {
		ref: { file, connId },
		values,
		sourceName: values.label,
		supported: host !== '',
		importsPassword: false,
		note: notes.join(' '),
	};
}

/** Map rows of pgAdmin's `server` table (SELECT *) to what they describe. Pure. */
export function parsePgadminRows(file: string, rows: Record<string, unknown>[]): Found[] {
	return rows.map((row) => {
		let params: Record<string, unknown> = {};
		if (typeof row.connection_params === 'string') {
			try {
				params = asRecord(JSON.parse(row.connection_params));
			} catch {
				// A malformed blob only loses the SSL mode.
			}
		}
		const useTunnel = row.use_ssh_tunnel === 1 || row.use_ssh_tunnel === true;
		return buildServer(file, String(row.id ?? ''), {
			name: asString(row.name),
			host: asString(row.host) ?? asString(row.hostaddr),
			port: row.port,
			database: asString(row.maintenance_db),
			username: asString(row.username),
			sslmode: params.sslmode ?? row.ssl_mode,
			service: asString(row.service),
			tunnel: useTunnel ? {
				host: asString(row.tunnel_host),
				port: row.tunnel_port,
				username: asString(row.tunnel_username),
				keyFile: asString(row.tunnel_identity_file),
			} : undefined,
		});
	});
}

/** Parse a pgAdmin `servers.json` export. Pure; [] for anything that is not one. */
export function parsePgadminServersJson(file: string, text: string): Found[] {
	let root: Record<string, unknown>;
	try {
		root = asRecord(JSON.parse(text));
	} catch {
		return [];
	}
	return Object.entries(asRecord(root.Servers)).map(([id, raw]) => {
		const s = asRecord(raw);
		const params = asRecord(s.ConnectionParameters);
		const useTunnel = s.UseSSHTunnel === 1 || s.UseSSHTunnel === true;
		return buildServer(file, id, {
			name: asString(s.Name),
			host: asString(s.Host) ?? asString(s.HostAddr),
			port: s.Port,
			database: asString(s.MaintenanceDB),
			username: asString(s.Username),
			sslmode: params.sslmode ?? s.SSLMode,
			service: asString(s.Service),
			tunnel: useTunnel ? {
				host: asString(s.TunnelHost),
				port: s.TunnelPort,
				username: asString(s.TunnelUsername),
				keyFile: asString(s.TunnelIdentityFile),
			} : undefined,
		});
	});
}

/** Read one file: the SQLite database, or a servers.json export. */
function readPgadmin(file: string): Found[] {
	if (file.toLowerCase().endsWith('.json')) {
		try {
			return parsePgadminServersJson(file, readTextFile(file));
		} catch {
			return [];
		}
	}
	try {
		// Read-only and must-exist: this is pgAdmin's own database, and a scan must never create
		// or lock it.
		const db = openDatabase(file, "Reading pgAdmin's servers", { readonly: true, fileMustExist: true });
		try {
			return parsePgadminRows(file, db.prepare('SELECT * FROM server').all() as Record<string, unknown>[]);
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

export const pgadminSource: FileSource = {
	id: 'pgadmin',
	locate: () => pgadminFiles(hostEnv()),
	read: readPgadmin,
};

export function scanPgadmin(existing: ConnectionConfig[], files?: string[]): ImportScanResult {
	return scanFileSource(pgadminSource, existing, files);
}

export function resolvePgadminImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	return resolveFileSource(pgadminSource, refs);
}

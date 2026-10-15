/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../shared/connection';
import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import { parseXmlTree, xmlDescendants, type XmlNode } from '../importCommon';
import { credentialNotes, portFrom, readTextFile, resolveFileSource, scanFileSource, type FileSource, type Found } from './common';
import { hostEnv, workbenchFiles } from './paths';

// MySQL Workbench keeps its connections in `connections.xml`, a GRT object dump: a list of
// `db.mgmt.Connection` objects, each a `<value>` whose children are more `<value>`s keyed by a `key`
// attribute, with the interesting part in the nested `parameterValues` dict. Because every level is
// called `<value>`, this is read as a tree, never with the flat `findElements` helper.
//
// Passwords live in the OS keychain (or Workbench's own vault), so they are not imported.

const NO_PASSWORD = "MySQL Workbench keeps passwords in your keychain, so set it after import.";

/** A GRT dict's entries by key: the child `<value>`/`<link>` elements carrying a `key` attribute. */
function grtDict(node: XmlNode): Map<string, XmlNode> {
	const out = new Map<string, XmlNode>();
	for (const child of node.children) {
		if (child.attrs.key) {
			out.set(child.attrs.key, child);
		}
	}
	return out;
}

function grtString(dict: Map<string, XmlNode>, key: string): string | undefined {
	const text = dict.get(key)?.text.trim();
	return text ? text : undefined;
}

/** "host:port" (Workbench's sshHost) to its parts. */
function hostPort(text: string | undefined, fallbackPort: number): { host: string; port: number } | undefined {
	if (!text) {
		return undefined;
	}
	const m = /^(.*?)(?::(\d+))?$/.exec(text.trim());
	return m && m[1] ? { host: m[1], port: portFrom(m[2], fallbackPort) } : undefined;
}

/**
 * Workbench's `useSSL`: 0 no, 1 if available, 2 require, 3 require and verify the CA, 4 require and
 * verify the identity. "If available" is not something a client can promise, so it maps to off.
 */
function sslFrom(useSsl: string | undefined): Pick<ConnectionFormValues, 'ssl' | 'sslMode'> {
	const n = Number(useSsl);
	if (n >= 3) {
		return { ssl: true, sslMode: 'system' };
	}
	if (n === 2) {
		return { ssl: true, sslMode: 'insecure' };
	}
	return { ssl: false };
}

/** Parse connections.xml. Pure. */
export function parseWorkbenchXml(file: string, xml: string): Found[] {
	const tree = parseXmlTree(xml);
	const conns = xmlDescendants(tree, 'value').flatMap(function collect(node: XmlNode): XmlNode[] {
		// The list itself is a `<value type="list" content-struct-name="db.mgmt.Connection">`; the
		// objects are its children. Descend until we meet an object of that struct.
		if (node.attrs['struct-name'] === 'db.mgmt.Connection' && node.attrs.type === 'object') {
			return [node];
		}
		return node.children.filter((c) => c.name === 'value').flatMap(collect);
	});
	return conns.map((conn, i) => {
		const top = grtDict(conn);
		const params = top.get('parameterValues');
		const p = params ? grtDict(params) : new Map<string, XmlNode>();
		const driver = (top.get('driver')?.text ?? '').trim();
		const viaSocket = /native_socket$/.test(driver);
		const viaSsh = /sshtun$/.test(driver);
		const name = grtString(top, 'name') ?? "Workbench connection";
		const host = grtString(p, 'hostName') ?? (viaSocket ? 'localhost' : '');
		const values: ConnectionFormValues = {
			label: name,
			driver: 'mysql-aurora',
			host,
			port: portFrom(grtString(p, 'port'), 3306),
			database: grtString(p, 'schema'),
			username: grtString(p, 'userName') ?? '',
			...sslFrom(grtString(p, 'useSSL')),
			readOnly: false,
		};
		const ssh = viaSsh ? hostPort(grtString(p, 'sshHost'), 22) : undefined;
		if (ssh) {
			values.ssh = {
				host: ssh.host,
				port: ssh.port,
				username: grtString(p, 'sshUserName') ?? '',
				privateKeyPath: grtString(p, 'sshKeyFile'),
				keepAlive: true,
			};
		}
		const notes = credentialNotes(values, false, NO_PASSWORD);
		if (viaSocket) {
			notes.unshift("Workbench connects over a local socket; this imports it as TCP on port 3306.");
		}
		return {
			ref: { file, connId: conn.attrs.id || String(i) },
			values,
			sourceName: name,
			supported: host !== '',
			importsPassword: false,
			note: notes.join(' '),
		};
	});
}

export const workbenchSource: FileSource = {
	id: 'mysql-workbench',
	locate: () => workbenchFiles(hostEnv()),
	read(file) {
		try {
			return parseWorkbenchXml(file, readTextFile(file));
		} catch {
			return [];
		}
	},
};

export function scanMysqlWorkbench(existing: ConnectionConfig[], files?: string[]): ImportScanResult {
	return scanFileSource(workbenchSource, existing, files);
}

export function resolveMysqlWorkbenchImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	return resolveFileSource(workbenchSource, refs);
}

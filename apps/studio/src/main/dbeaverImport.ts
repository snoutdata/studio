/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { createDecipheriv } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ConnectionConfig } from '../shared/connection';
import type { ConnectionFormValues, ImportItem, ImportItemRef, ImportScanResult } from '../shared/forms';
import type { DbeaverScript, DbeaverScriptScan } from '../shared/workspace';
import { readConnections } from './configStore';
import { DEFAULT_PORT, asRecord, asString, mapDriver, mapFlavor, mapEnvironment, matchesExisting, parseJdbcUrl, stripSecrets, walkEntry } from './importCommon';

// Import saved connections from a local DBeaver install. Non-secret definitions (host,
// port, database, driver, SSH-tunnel host/port/key-path) live in a plain-JSON
// `data-sources.json` per workspace project. Usernames and passwords live next to it in
// an AES-encrypted `credentials-config.json`; DBeaver Community uses a fixed local key,
// so we can decrypt and import those too. The decrypted secrets are resolved on APPLY in
// the main process (resolveDbeaverImport) and never sent to the renderer — the scan that
// the picker renders carries usernames but not passwords.

// DBeaver Community's fixed local-secret key for credentials-config.json (AES-128-CBC,
// IV = the file's first 16 bytes). Decryption simply fails (→ no secrets imported) for
// DBeaver Enterprise, a user-set master password, or a future key change.
const DBEAVER_LOCAL_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');

/** Locate DBeaver's data dir per platform (returns null if it doesn't exist). */
function dbeaverDataDir(): string | null {
	let dir: string;
	if (process.platform === 'win32') {
		dir = join(app.getPath('appData'), 'DBeaverData');
	} else if (process.platform === 'darwin') {
		dir = join(homedir(), 'Library', 'DBeaverData');
	} else {
		dir = join(homedir(), '.local', 'share', 'DBeaverData');
	}
	return existsSync(dir) ? dir : null;
}

// Subdirs that never hold connection configs but can be large (driver jars, logs,
// caches) — skipped so the recursive scan stays fast.
const SKIP_DIRS = new Set(['drivers', 'logs', '.metadata', 'security', 'tray', 'cache']);

/** Recursively find every `data-sources.json` under `root` (bounded; the tree is small). Links
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
		} else if (kind === 'file' && name === 'data-sources.json') {
			found.push(full);
		}
	}
	return found;
}

// --- AWS Secrets Manager auth (best-effort) -----------------------------------------
//
// DBeaver's "Use AWS Secrets Manager" auth model ships only in its closed-source
// Ultimate/Team editions, so the exact data-sources.json keys aren't published. We map it
// best-effort: trigger on an AWS-secret-looking auth-model and pull the secret name + region
// out of whatever property bag carries them (keys vary, so we match by shape, not a fixed
// name). The AWS access key DBeaver may store is NOT imported — it lives in an enterprise
// credentials file we can't decrypt, and our awsSecret config falls back to the machine's
// default AWS credential chain anyway. Adjust the predicates below if a real sample differs.

/** Pull an AWS region out of an RDS/Redshift endpoint, e.g. `...us-west-2.rds.amazonaws.com`. */
function parseRegionFromHost(host: string): string | undefined {
	const match = /\.([a-z]{2}-[a-z]+-\d+)\.(?:rds|redshift)\.amazonaws\.com/i.exec(host);
	return match ? match[1].toLowerCase() : undefined;
}

/** Does this auth-model id denote AWS Secrets Manager? (best-effort across naming variants). */
function looksLikeAwsSecretModel(authModel: string | undefined): boolean {
	if (!authModel) {
		return false;
	}
	const m = authModel.toLowerCase();
	return m.includes('secret') && (m.includes('aws') || m.includes('rds') || m.includes('redshift'));
}

/** First string value across the bags whose key (lowercased) satisfies `keyMatch`. */
function findProp(bags: Record<string, unknown>[], keyMatch: (key: string) => boolean): string | undefined {
	for (const bag of bags) {
		for (const [key, value] of Object.entries(bag)) {
			if (keyMatch(key.toLowerCase()) && typeof value === 'string' && value.trim() !== '') {
				return value.trim();
			}
		}
	}
	return undefined;
}

/**
 * Map a DBeaver AWS-Secrets-Manager connection to our awsSecret config, or null if this
 * connection doesn't use that auth model / has no resolvable secret name.
 */
function resolveAwsSecret(config: Record<string, unknown>, host: string): { region: string; secretId: string } | undefined {
	if (!looksLikeAwsSecretModel(asString(config['auth-model']))) {
		return undefined;
	}
	// Auth-model props may sit in any of these bags depending on the DBeaver version.
	const bags = [asRecord(config['auth-properties']), asRecord(config['provider-properties']), config];
	const secretId = findProp(bags, (k) => k.includes('secret') && (k.includes('name') || k.includes('id') || k.includes('arn')));
	if (!secretId) {
		return undefined;
	}
	const region = findProp(bags, (k) => k.includes('region')) ?? parseRegionFromHost(host) ?? '';
	return { region, secretId };
}

/**
 * Decrypt a project's credentials-config.json. Shape on success:
 *   { "<connId>": { "#connection": { user, password },
 *                   "network/ssh_tunnel": { user, password } },
 *     "profile:<name>": { "network/ssh_tunnel/profile/<name>": { user, password } } }
 * Returns {} when the file is absent or can't be decrypted (EE / master password / etc.).
 */
function readCredentials(dir: string): Record<string, Record<string, Record<string, string>>> {
	const path = join(dir, 'credentials-config.json');
	if (!existsSync(path)) {
		return {};
	}
	try {
		const data = readFileSync(path);
		const iv = data.subarray(0, 16);
		const ciphertext = data.subarray(16);
		const decipher = createDecipheriv('aes-128-cbc', DBEAVER_LOCAL_KEY, iv);
		const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
		const parsed: unknown = JSON.parse(out);
		return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, Record<string, Record<string, string>>>;
	} catch {
		return {};
	}
}

interface ParsedConnection {
	connId: string;
	/** Full values INCLUDING secrets (stripped before going to the renderer). */
	values: ConnectionFormValues;
	sourceName: string;
	supported: boolean;
	duplicate: boolean;
	/** A password was found in the vault and will be imported. */
	importsPassword: boolean;
	note?: string;
}

/** Resolve a connection's SSH tunnel (inline or via a named network profile). */
function resolveTunnel(
	config: Record<string, unknown>,
	networkProfiles: Record<string, unknown>,
): { props: Record<string, unknown>; credKey: string; credSlot: string } | null {
	// Named profile: configuration.config-profile -> network-profiles[name].handlers.ssh_tunnel.
	const profileName = asString(config['config-profile']);
	if (profileName) {
		const profile = asRecord(networkProfiles[profileName]);
		const handler = asRecord(asRecord(profile.handlers).ssh_tunnel);
		if (handler.enabled === true) {
			return {
				props: asRecord(handler.properties),
				credKey: `profile:${profileName}`,
				credSlot: `network/ssh_tunnel/profile/${profileName}`,
			};
		}
	}
	// Inline handler on the connection itself.
	const inline = asRecord(asRecord(config.handlers).ssh_tunnel);
	if (inline.enabled === true && inline.properties) {
		return { props: asRecord(inline.properties), credKey: '', credSlot: 'network/ssh_tunnel' };
	}
	return null;
}

/** Translate one DBeaver connection entry into a ParsedConnection. */
function buildParsed(
	connId: string,
	entry: Record<string, unknown>,
	networkProfiles: Record<string, unknown>,
	credentials: Record<string, Record<string, Record<string, string>>>,
	existing: ConnectionConfig[],
): ParsedConnection {
	const config = asRecord(entry.configuration);
	const provider = asString(entry.provider) ?? '';
	const driverId = asString(entry.driver) ?? '';
	const sourceName = asString(entry.name) ?? "(unnamed)";
	const driver = mapDriver(`${provider} ${driverId}`);

	const fromUrl = parseJdbcUrl(config.url);
	const host = asString(config.host) ?? fromUrl.host ?? '';
	const portStr = asString(config.port);
	const port = portStr ? Number(portStr) : (fromUrl.port ?? (driver ? DEFAULT_PORT[driver] : 0));
	const database = asString(config.database) ?? fromUrl.database;

	// DB credentials from the decrypted vault (fall back to any plaintext config.user).
	const dbCred = asRecord(credentials[connId]?.['#connection']) as Record<string, string>;
	const username = asString(dbCred.user) ?? asString(config.user) ?? asString(config.username);
	const password = asString(dbCred.password);

	const handlers = asRecord(config.handlers);
	const sslHandler = asRecord(handlers.ssl);
	const providerProps = asRecord(config['provider-properties']);
	const ssl = sslHandler.enabled === true ||
		providerProps['ssl'] === true || providerProps['useSSL'] === 'true' || providerProps['useSSL'] === true;

	const values: ConnectionFormValues = {
		label: sourceName,
		driver: driver ?? 'mysql-aurora',
		flavor: mapFlavor(`${provider} ${driverId}`),
		environment: mapEnvironment(config.type),
		host,
		port: Number.isFinite(port) ? Number(port) : (driver ? DEFAULT_PORT[driver] : 0),
		database,
		username: username ?? '',
		password,
		ssl: Boolean(ssl),
		readOnly: false,
	};

	// AWS Secrets Manager auth: import the region + secret name (the access key is not
	// imported; see resolveAwsSecret). Credentials then come from the secret at connect time.
	const awsSecret = resolveAwsSecret(config, host);
	if (awsSecret) {
		values.aws = { region: awsSecret.region, secretId: awsSecret.secretId };
	}

	// SSH tunnel (inline or profile), with secrets resolved from the vault.
	const tunnel = resolveTunnel(config, networkProfiles);
	if (tunnel) {
		const props = tunnel.props;
		const sshCred = asRecord(credentials[tunnel.credKey || connId]?.[tunnel.credSlot]) as Record<string, string>;
		const sshPortStr = asString(props.port);
		const authType = (asString(props.authType) ?? '').toUpperCase();
		const sshSecret = asString(sshCred.password);
		values.ssh = {
			host: asString(props.host) ?? '',
			port: sshPortStr ? Number(sshPortStr) : undefined,
			username: asString(sshCred.user) ?? asString(props.userName) ?? asString(props.user) ?? '',
			privateKeyPath: asString(props.keyPath),
			// For key auth a saved secret is the key passphrase; otherwise it's the SSH password.
			passphrase: authType === 'PUBLIC_KEY' ? sshSecret : undefined,
			password: authType === 'PUBLIC_KEY' ? undefined : sshSecret,
			keepAlive: true,
		};
	}

	const notes: string[] = [];
	if (!driver) {
		notes.push(`Unsupported driver (${provider || driverId || "unknown"}).`);
	} else if (awsSecret) {
		// Credentials come from the secret at connect time; the AWS access key isn't imported.
		notes.push("Uses AWS Secrets Manager; set an AWS profile or rely on your default AWS credentials after import. Open it and save it once before it connects.");
		if (!awsSecret.region) {
			notes.push("AWS region not detected; set it after import.");
		}
	} else {
		if (!username) {
			notes.push("Username not found; set it after import.");
		}
		if (!password) {
			notes.push("No saved password; set it after import.");
		}
	}

	return {
		connId,
		values,
		sourceName,
		supported: driver !== null && host !== '',
		duplicate: driver !== null && matchesExisting(existing, values),
		importsPassword: Boolean(password),
		note: notes.length > 0 ? notes.join(' ') : undefined,
	};
}

/** Parse one data-sources.json (+ its sibling vault) into ParsedConnections by id. */
function parseFile(file: string, existing: ConnectionConfig[]): Map<string, ParsedConnection> {
	const map = new Map<string, ParsedConnection>();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return map;
	}
	const root = asRecord(raw);
	const connections = asRecord(root.connections);
	const networkProfiles = asRecord(root['network-profiles']);
	const credentials = readCredentials(dirname(file));
	for (const [id, entry] of Object.entries(connections)) {
		map.set(id, buildParsed(id, asRecord(entry), networkProfiles, credentials, existing));
	}
	return map;
}

/** Scan the local DBeaver install for importable connections. */
export function scanDbeaver(): ImportScanResult {
	const dir = dbeaverDataDir();
	if (!dir) {
		return { sourceId: 'dbeaver', sources: [], items: [], notFound: true };
	}
	return scanDbeaverFiles(findDataSourceFiles(dir));
}

/** Parse specific data-sources.json files (auto-detected, or one the user browsed to). */
export function scanDbeaverFiles(files: string[]): ImportScanResult {
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
				importsPassword: p.importsPassword,
				ref: { file, connId: p.connId },
				note: p.note,
			});
		}
	}
	// Stable, friendly order: supported first, then by name. Re-key by final position.
	items.sort((a, b) => (Number(b.supported) - Number(a.supported)) || a.sourceName.localeCompare(b.sourceName));
	items.forEach((item, i) => { item.key = String(i); });
	return { sourceId: 'dbeaver', sources, items, notFound: items.length === 0 };
}

// --- DBeaver SQL scripts (for the workspace "Import" modal) --------------------------
//
// DBeaver keeps editor scripts as real `.sql` files under its workspace
// (`<DBeaverData>/workspace*/<project>/Scripts/…`). We reuse the same data-dir detection
// and bounded recursive walk used for connections to surface them; the renderer copies
// the chosen ones into our own workspace folder.

const MAX_SCRIPTS = 500;

/**
 * Recursively find `.sql` files under `root` (bounded; skips the heavy/irrelevant dirs). Every one
 * it lists may be copied into the workspace, where an agent reads files without asking, so no link
 * is followed and only regular files are listed (`walkEntry`).
 */
function findSqlFiles(root: string, depth = 0, found: string[] = []): string[] {
	if (depth > 8 || found.length >= MAX_SCRIPTS) {
		return found;
	}
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return found;
	}
	for (const name of entries) {
		if (found.length >= MAX_SCRIPTS) {
			break;
		}
		const full = join(root, name);
		const kind = walkEntry(full);
		if (kind === 'dir') {
			if (!SKIP_DIRS.has(name.toLowerCase())) {
				findSqlFiles(full, depth + 1, found);
			}
		} else if (kind === 'file' && name.toLowerCase().endsWith('.sql')) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Scan a DBeaver workspace for `.sql` scripts (newest first). With no `overrideDir` it
 * auto-detects the local install; pass a folder the user browsed to when their DBeaver
 * workspace lives somewhere non-standard.
 */
export function scanDbeaverScripts(overrideDir?: string): DbeaverScriptScan {
	const dir = overrideDir ?? dbeaverDataDir();
	if (!dir || !existsSync(dir)) {
		return { dataDir: null, scripts: [] };
	}
	const scripts: DbeaverScript[] = [];
	for (const path of findSqlFiles(dir)) {
		try {
			const stat = lstatSync(path);
			scripts.push({ path, name: basename(path), folder: basename(dirname(path)), size: stat.size, modifiedAt: stat.mtimeMs });
		} catch {
			// Skip files that vanished between walk and stat.
		}
	}
	scripts.sort((a, b) => b.modifiedAt - a.modifiedAt);
	return { dataDir: dir, scripts };
}

/**
 * Resolve the selected refs back to full, ready-to-save values WITH secrets. Runs in the
 * main process at apply time so passwords never transit the renderer. Unsupported or
 * missing refs are skipped.
 */
export function resolveDbeaverImport(refs: ImportItemRef[]): ConnectionFormValues[] {
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

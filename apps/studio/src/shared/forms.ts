/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// App-shell contract (renderer <-> main) for the visual connection form. Kept out of
// the verbatim engine contracts (connection/schema/protocol/query) since the server
// never sees form values — only the resolved ConnectionConfig.

import type { ConnectionConfig, SshTunnelProfile } from './connection';

/** Snapshot the sidebar renders: the saved (non-secret) connections + which are live. */
export interface ConnectionsState {
	connections: ConnectionConfig[];
	connectedIds: string[];
}

/** The saved reusable SSH tunnel profiles (non-secret), for the picker + manager UI. */
export interface TunnelProfilesState {
	profiles: SshTunnelProfile[];
}

/**
 * Values the tunnel-profile editor collects. Secrets (passphrase/password) are optional
 * and, on edit, a blank value means "keep the currently stored secret". `id` is absent
 * when creating a new profile.
 */
export interface TunnelProfileFormValues {
	id?: string;
	name: string;
	host: string;
	port?: number;
	username: string;
	privateKeyPath?: string;
	/** Key passphrase (kept in the keychain); blank on edit means "keep the stored one". */
	passphrase?: string;
	/** SSH password (kept in the keychain); blank on edit means "keep the stored one". */
	password?: string;
	keepAlive?: boolean;
}

/**
 * How TLS verifies the server certificate:
 * - 'rds'      verify against the app-bundled Amazon RDS global CA (the default; what
 *              an RDS/Aurora endpoint needs, since its CA isn't in the system store).
 * - 'system'   verify against the OS/Node trust store (servers with a public CA cert).
 * - 'custom'   verify against a user-supplied CA .pem (`sslCaPath`).
 * - 'insecure' encrypt but don't verify the certificate (rejectUnauthorized: false).
 */
export type SslMode = 'rds' | 'system' | 'custom' | 'insecure';

/**
 * Values the connection form collects. Secrets are optional and, on edit, a blank
 * value means "keep the currently stored secret". `id` is absent when creating.
 */
export interface ConnectionFormValues {
	id?: string;
	label: string;
	driver: string;
	/** See ConnectionConfig.flavor. */
	flavor?: string;
	environment?: string;
	host: string;
	port: number;
	database?: string;
	username: string;
	password?: string;
	/** TLS on/off. The CA used for verification is chosen by `sslMode`. */
	ssl: boolean;
	/** How the server certificate is verified when `ssl` is on. Defaults to 'rds'
	 *  (verify against the bundled Amazon RDS CA) when omitted on a new connection. */
	sslMode?: SslMode;
	/** Path to a custom CA .pem, used only when `sslMode` is 'custom'. */
	sslCaPath?: string;
	readOnly: boolean;
	/** See ConnectionConfig.aiDataAccess. Absent: the Settings → AI default applies. */
	aiDataAccess?: ConnectionConfig['aiDataAccess'];
	/** "Connection pool size": max simultaneous connections the driver opens to this database.
	 *  Absent = the driver default. Clamped to [MIN_POOL_MAX, MAX_POOL_MAX] on save. */
	poolMax?: number;
	/** Inline (connection-private) SSH tunnel. Mutually exclusive with `sshTunnelRef`. */
	ssh?: {
		host: string;
		port?: number;
		username: string;
		privateKeyPath?: string;
		passphrase?: string;
		password?: string;
		localPort?: number;
		keepAlive?: boolean;
	};
	/** Id of a saved SshTunnelProfile to use instead of an inline `ssh` tunnel. */
	sshTunnelRef?: string;
	/** When set with an inline `ssh` tunnel, save those details as a reusable tunnel profile
	 *  (reusing one with matching settings if it exists) and reference it, so a tunnel typed
	 *  while creating/editing a connection becomes shareable instead of staying connection-private. */
	saveTunnelAsProfile?: boolean;
	/** Forget the SSH host key remembered for this connection's tunnel host (the server was
	 *  rebuilt), so the next connect trusts the key it sees. An action, never stored. */
	forgetSshHostKey?: boolean;
	/**
	 * TELEMETRY connections: the saved cloud account this connection authenticates as, and the
	 * container within it (an AWS region, an Azure workspace ID, a GCP project). Both non-secret —
	 * the credential itself lives on the account, in the keychain, and is never part of a
	 * connection.
	 */
	cloudAccountId?: string;
	cloudScope?: string;
	/** The scopes to expose as tables, named by hand. Empty/undefined means "every scope in the
	 *  container", which needs a permission to ENUMERATE that many credentials do not have. */
	cloudScopes?: string[];
	/** Set on a connection imported from SnoutData Cloud, so a re-import updates it rather
	 *  than adding a second one. Non-secret; see ConnectionConfig.cloudProjectRef. */
	cloudProjectRef?: string;
	/** Set on a local project's database; see ConnectionConfig.localProjectId. */
	localProjectId?: string;
	/** Snowflake: the virtual warehouse to run queries on (non-secret). */
	warehouse?: string;
	/** Snowflake: the session role (non-secret). */
	role?: string;
	/** Set when credentials should be fetched from AWS Secrets Manager (in place of a
	 *  locally stored password). Not secret itself, so it persists with the connection. */
	aws?: {
		region: string;
		secretId: string;
		profile?: string;
		accessKeyId?: string;
		/** Secret (stored in the keychain); blank on edit means "keep the stored one". */
		secretAccessKey?: string;
	};
}

// --- Importing connections from other database tools -------------------------------
//
// The import flow is source-agnostic: a pre-screen lets the user pick which tool to
// import from (DBeaver / DataGrip / Navicat today; others can be added by appending to
// IMPORT_SOURCES and adding a case in the main-process dispatch). Each source resolves to
// the same ImportItem shape so the bulk picker UI never special-cases a tool. Secrets are
// only imported when a source stores them readably (DBeaver Community); otherwise the user
// fills passwords in after, matching how the connection form treats secrets.

export type ImportSourceId =
	| 'dbeaver' | 'datagrip' | 'navicat' | 'snoutdata-cloud'
	// Other tools' saved connections, read from where each keeps them.
	| 'pgadmin' | 'mysql-workbench' | 'azure-data-studio' | 'ssms' | 'heidisql' | 'pgpass' | 'tableplus'
	// Not a tool: databases found RUNNING, in a container, on this computer, or on the local network.
	// Only first-run discovery ("Find databases") reads these; the import pre-screen does not list them.
	| 'docker' | 'local' | 'network';

/** An operating system, as `process.platform` names it. */
export type ImportPlatform = 'win32' | 'darwin' | 'linux';

/** A tool the user can import connections from (shown on the import pre-screen). */
export interface ImportSource {
	id: ImportSourceId;
	/** Display name, e.g. "DBeaver". */
	label: string;
	/** One-line description shown under the label. */
	description: string;
	/** The systems the tool exists on. Absent means all three. */
	platforms?: ImportPlatform[];
}

/** The tools offered on the import pre-screen, in display order. */
export const IMPORT_SOURCES: ImportSource[] = [
	// First, because it is the only one that needs nothing but being signed in: no file to
	// find, no export to make, and the password comes with it.
	{ id: 'snoutdata-cloud', label: "SnoutData Cloud", description: "Your hosted databases. Being signed in is enough: no connection string to paste." },
	{ id: 'dbeaver', label: "DBeaver", description: "Import saved connections from your local DBeaver workspace." },
	{ id: 'datagrip', label: "DataGrip", description: "Import data sources from JetBrains DataGrip or another IntelliJ IDE." },
	{ id: 'navicat', label: "Navicat", description: "Import connections from a Navicat .ncx export file." },
	{ id: 'pgadmin', label: "pgAdmin", description: "Import servers from pgAdmin 4, or from a servers.json it exported." },
	{ id: 'mysql-workbench', label: "MySQL Workbench", description: "Import saved connections from MySQL Workbench." },
	{ id: 'azure-data-studio', label: "Azure Data Studio", description: "Import SQL Server and PostgreSQL connections from Azure Data Studio." },
	{ id: 'ssms', label: "SQL Server Management Studio", description: "Import the servers SSMS remembers.", platforms: ['win32'] },
	{ id: 'heidisql', label: "HeidiSQL", description: "Import HeidiSQL sessions, passwords included.", platforms: ['win32'] },
	{ id: 'tableplus', label: "TablePlus", description: "Import saved connections from TablePlus.", platforms: ['darwin'] },
	{ id: 'pgpass', label: "Postgres password file", description: "Import the entries in your .pgpass (pgpass.conf on Windows), passwords included." },
];

/** What each source is called as a group heading in the discovery results. */
export const DISCOVERY_SOURCE_LABELS: Record<ImportSourceId, string> = {
	'snoutdata-cloud': "SnoutData Cloud",
	dbeaver: "DBeaver",
	datagrip: "DataGrip",
	navicat: "Navicat",
	pgadmin: "pgAdmin",
	'mysql-workbench': "MySQL Workbench",
	'azure-data-studio': "Azure Data Studio",
	ssms: "SQL Server Management Studio",
	heidisql: "HeidiSQL",
	pgpass: "Postgres password file",
	tableplus: "TablePlus",
	docker: "Docker and Podman containers",
	local: "Running on this computer",
	network: "On your local network",
};

/**
 * The sources one discovery run asks, in display order. Shared so the popup can list them the
 * instant the run starts, before main has said a word, and main runs exactly this list.
 */
export function discoverySourceIds(platform: ImportPlatform, network: boolean): ImportSourceId[] {
	return [
		'snoutdata-cloud', 'docker', 'local', 'dbeaver', 'datagrip', 'pgadmin', 'mysql-workbench', 'azure-data-studio', 'pgpass', 'navicat',
		...(platform === 'win32' ? ['ssms', 'heidisql'] as const : []),
		...(platform === 'darwin' ? ['tableplus'] as const : []),
		...(network ? ['network'] as const : []),
	];
}

/** Options for one discovery run (`discover:run`). */
export interface DiscoveryOptions {
	/** Also look at the other machines on the local network. Off unless the user turns it on. */
	network: boolean;
}

/** One source's progress during a discovery run, pushed as it happens. */
export interface DiscoveryProgress {
	sourceId: ImportSourceId;
	state: 'scanning' | 'done';
	/** How many connections it found (set on 'done'). */
	found?: number;
}

/** Locates a scanned connection so the main process can re-resolve its secrets on apply. */
export interface ImportItemRef {
	/** Where to look again: the source file for the tools that have one, and the source's
	 *  own id for one that does not (SnoutData Cloud reads an API, not a file). Kept
	 *  required rather than optional so the file importers, which cannot work without a
	 *  path, are not handed an `undefined` to guess at. */
	file: string;
	/** The source's internal id for the connection: a tool's connection id, or a cloud
	 *  project's ref. Whatever the main process needs to find the credential again. */
	connId: string;
}

/**
 * One importable connection, ready to review/save. The `values` carried to the renderer
 * include the username but NOT the password/SSH secrets — those stay in the main process
 * and are resolved from `ref` at apply time (so passwords never transit the renderer).
 */
export interface ImportItem {
	/** Stable selection key (not persisted). */
	key: string;
	/** Preview values: username included, password/SSH secrets stripped. */
	values: ConnectionFormValues;
	/** The connection's name in the source tool. */
	sourceName: string;
	/** False when the source driver has no SnoutData equivalent (shown disabled). */
	supported: boolean;
	/** True when a saved connection already matches host/port/database/username/driver. */
	duplicate: boolean;
	/** A saved password was found and will be imported into the keychain on apply. */
	importsPassword: boolean;
	/** Where to re-resolve this connection's secrets at apply time. */
	ref: ImportItemRef;
	/** Optional hint shown beside the item (why it's unsupported, what was inferred). */
	note?: string;
	/**
	 * Supported, but a guess: a port that answered without saying what it is. Offered, never
	 * selected by default, so importing everything does not bring in a stray service.
	 */
	tentative?: boolean;
}

/** Result of scanning a source for importable connections. */
export interface ImportScanResult {
	sourceId: ImportSourceId;
	/** Where the connections were read from (shown so the user knows the origin): a file
	 *  path for the tools, the signed-in account for SnoutData Cloud. */
	sources: string[];
	items: ImportItem[];
	/** Set when the source's data could not be located (offer manual Browse). */
	notFound?: boolean;
	/**
	 * A sentence to show INSTEAD of the list, when the source cannot be read for a reason
	 * the user can act on: not signed in, offline, the account has no projects yet.
	 *
	 * Distinct from `notFound`, which means "we looked in the usual places and found no
	 * file" and whose answer is Browse. This one has no Browse to offer, so an empty list
	 * with a Browse button would be the wrong screen — the user needs the sentence.
	 */
	unavailable?: string;
}

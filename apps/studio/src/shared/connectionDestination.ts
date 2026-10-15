/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig, SshTunnelProfile } from './connection';
import { dialectFor, flavorFor } from './engine';
import type { SslMode } from './forms';
import { maskUriPasswords } from './connectionUri';

/*
 * WHERE a saved connection sends its credentials, and whether an edit moved it.
 *
 * A saved connection keeps its password in the keychain, and an edit that leaves the password
 * blank keeps the stored one. That is right for a rename and wrong for a new host: the next
 * connect would hand the stored password to whatever the host now names. So the fields that decide
 * where a credential travels (the driver, the host and port, TLS and its verification, the SSH
 * tunnel's endpoint, the user name the credentials are presented as, and, for the drivers where it
 * says where the connection goes, the database field) are listed here once, and main drops the
 * stored secrets when any of them changes and no new secret came with the edit. The renderer reads the same list to show the user
 * what an agent's edit would change before they approve it.
 */

/** The TLS settings the connection form shows, derived from a saved connection's `ssl`. A legacy
 *  `ssl: true` (pre-mode connections) means "verify against the system store". */
export interface SslSetting {
	on: boolean;
	mode: SslMode;
	caPath: string;
}

export function sslSettingOf(ssl: ConnectionConfig['ssl']): SslSetting {
	if (!ssl) {
		return { on: false, mode: 'rds', caPath: '' };
	}
	if (ssl === true) {
		return { on: true, mode: 'system', caPath: '' };
	}
	if (ssl.rejectUnauthorized === false) {
		return { on: true, mode: 'insecure', caPath: '' };
	}
	if (ssl.caBundle === 'rds') {
		return { on: true, mode: 'rds', caPath: '' };
	}
	if (ssl.caPath) {
		return { on: true, mode: 'custom', caPath: ssl.caPath };
	}
	return { on: true, mode: 'system', caPath: '' };
}

/** TLS as a person reads it, for a before/after line. */
export function describeSsl(ssl: ConnectionConfig['ssl']): string {
	const setting = sslSettingOf(ssl);
	if (!setting.on) {
		return 'off';
	}
	switch (setting.mode) {
		case 'insecure': return 'on, certificate not verified';
		case 'rds': return 'on, verified against the RDS CA';
		case 'custom': return `on, verified against ${setting.caPath}`;
		default: return 'on, verified against the system CAs';
	}
}

/** An SSH tunnel's far end: where its own credentials go, and the path a database password takes. */
export interface TunnelEndpoint {
	host: string;
	port: number;
	username: string;
}

/** The part of a connection that decides where its credentials are sent. */
export interface ConnectionDestination {
	driver: string;
	/** The wire-compatible engine, which only matters here for its default port. */
	flavor?: string;
	host: string;
	port: number;
	ssl?: ConnectionConfig['ssl'];
	/** The tunnel's endpoint, resolved whether it is inline or a saved profile. */
	tunnel?: TunnelEndpoint;
	/** The user the credentials are presented as: a new one means the password is typed again. */
	username?: string;
	/** The database field. It only counts where {@link databaseRoutes} says it decides where the
	 *  connection goes; elsewhere it is a database on the same server. */
	database?: string;
}

/**
 * The drivers whose database field takes part in WHERE the connection goes, not only in what it
 * opens once there: the file a file driver opens (SQLite, DuckDB), the DATABASE of Db2's connection
 * string, Oracle's service name in its connect string, and HANA's tenant, which the system database
 * redirects the client to. A change there is a change of destination like a new host.
 */
const DATABASE_ROUTES: ReadonlySet<string> = new Set(['sqlite', 'duckdb', 'db2', 'oracle', 'hana']);

/** Whether a driver's database field decides where its connection (and its credentials) go. */
export function databaseRoutes(driver: string): boolean {
	return DATABASE_ROUTES.has(driver);
}

/** One field of a destination that differs, as `field: before → after`. `ssh` is true for the
 *  tunnel's own fields, whose change also moves the tunnel's stored secrets. */
export interface DestinationChange {
	field: string;
	before: string;
	after: string;
	ssh: boolean;
}

const DEFAULT_SSH_PORT = 22;

/** A tunnel's endpoint from its saved shape; the port defaults the way the tunnel does. */
export function tunnelEndpoint(tunnel: { host: string; port?: number; username: string } | undefined): TunnelEndpoint | undefined {
	if (!tunnel) {
		return undefined;
	}
	return { host: tunnel.host.trim(), port: tunnel.port ?? DEFAULT_SSH_PORT, username: tunnel.username.trim() };
}

/** A port of 0 (or none) connects to the engine's default, so it reads as that port: a saved
 *  connection with port 0 opened and saved again in the form, which fills in the default, has
 *  not moved. */
function effectivePort(destination: ConnectionDestination): number {
	return destination.port || flavorFor(destination.driver, destination.flavor)?.defaultPort || dialectFor(destination.driver).defaultPort || 0;
}

/** What differs between two destinations. Empty means every credential still goes where it went. */
export function destinationChanges(before: ConnectionDestination, after: ConnectionDestination): DestinationChange[] {
	const changes: DestinationChange[] = [];
	const add = (field: string, was: string, now: string, ssh = false): void => {
		if (was !== now) {
			changes.push({ field, before: was, after: now, ssh });
		}
	};
	add('driver', before.driver, after.driver);
	add('host', before.host.trim(), after.host.trim());
	add('port', String(effectivePort(before)), String(effectivePort(after)));
	add('ssl', describeSsl(before.ssl), describeSsl(after.ssl));
	add('username', (before.username ?? '').trim(), (after.username ?? '').trim());
	if (databaseRoutes(before.driver) || databaseRoutes(after.driver)) {
		add('database', (before.database ?? '').trim(), (after.database ?? '').trim());
	}
	const a = before.tunnel;
	const b = after.tunnel;
	if (a && b) {
		add('ssh host', a.host, b.host, true);
		add('ssh port', String(a.port), String(b.port), true);
		add('ssh user', a.username, b.username, true);
	} else if (a || b) {
		const show = (t: TunnelEndpoint | undefined): string => (t ? `${t.username}@${t.host}:${t.port}` : 'none');
		add('ssh tunnel', show(a), show(b), true);
	}
	return changes;
}

/** One line per change, the way an approval card lists them. */
export function formatChange(change: { field: string; before: string; after: string }): string {
	const show = (value: string): string => (value === '' ? '(empty)' : value);
	return `${change.field}: ${show(change.before)} → ${show(change.after)}`;
}

/** A field an `edit_connection` call would change. `destination` marks the ones that move where
 *  the connection's credentials go (or who they are presented as), so its saved password is removed. `safety` marks the ones that
 *  decide how carefully the app treats the database (its environment, which is what makes it
 *  production, and read-only), so the change is asked about every time. */
export interface ConnectionEditChange {
	field: string;
	before: string;
	after: string;
	destination: boolean;
	safety?: boolean;
}

/**
 * What an `edit_connection` call would change on a saved connection, read from its arguments the
 * same way the capability reads them (trimmed strings, empty ignored), and only where the value
 * differs. This is what the approval card shows, so the user approves the change itself rather
 * than "edit connection (an id)".
 */
export function describeConnectionEdit(existing: ConnectionConfig, args: Record<string, unknown>): ConnectionEditChange[] {
	const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
	const changes: ConnectionEditChange[] = [];
	const add = (field: string, before: string, after: string | undefined, destination: boolean, safety = false): void => {
		if (after !== undefined && after !== before) {
			changes.push(safety ? { field, before, after, destination, safety } : { field, before, after, destination });
		}
	};
	add('driver', existing.driver, str(args.driver), true);
	// A connection string's password is never written into a card, a transcript or the audit log.
	const host = str(args.host);
	if (host !== undefined && host !== existing.host) {
		changes.push({ field: 'host', before: maskUriPasswords(existing.host), after: maskUriPasswords(host), destination: true });
	}
	add('port', String(existing.port), typeof args.port === 'number' ? String(args.port) : undefined, true);
	if (typeof args.ssl === 'boolean' && args.ssl !== Boolean(existing.ssl)) {
		add('ssl', describeSsl(existing.ssl), args.ssl ? 'on' : 'off', true);
	}
	add('label', existing.label, str(args.label), false);
	const driver = str(args.driver) ?? existing.driver;
	add('database', existing.database ?? '', str(args.database), databaseRoutes(existing.driver) || databaseRoutes(driver));
	add('username', existing.username, str(args.username), true);
	add('environment', existing.environment ?? '', str(args.environment), false, true);
	if (typeof args.readOnly === 'boolean') {
		add('read-only', existing.readOnly ? 'on' : 'off', args.readOnly ? 'on' : 'off', false, true);
	}
	return changes;
}

/** The sentence an approval card carries when an edit changes a connection's environment or read-only. */
export const SAFETY_CHANGE_NOTE = 'This changes how carefully the app treats this database (whether it is production, or read-only), so it is asked every time.';

/** The sentence an approval card and a capability result carry when an edit moves a connection. */
export const DESTINATION_CHANGE_NOTE = 'This changes where the connection goes or who it signs in as, so its saved password is removed and has to be typed again in the connection form.';

/** The assistant's approval line for an `edit_connection` call: "edit connection "x" (host: a → b)". */
export function editConnectionApproval(existing: ConnectionConfig, args: Record<string, unknown>): string {
	const changes = describeConnectionEdit(existing, args);
	const list = changes.length > 0 ? ` (${changes.map(formatChange).join('; ')})` : '';
	const moves = changes.some((change) => change.destination) ? `. ${DESTINATION_CHANGE_NOTE}` : '';
	const safety = changes.some((change) => change.safety) ? `. ${SAFETY_CHANGE_NOTE}` : '';
	return `edit connection "${existing.label}"${list}${moves}${safety}`;
}

/**
 * What moved between a saved SSH tunnel profile and its edit: its host, port or SSH user, which is
 * where its own SSH secrets go and the path every database password through it takes. Empty when
 * the profile still reaches the same server as the same user.
 */
export function tunnelProfileMoves(before: TunnelEndpoint | undefined, after: TunnelEndpoint | undefined): DestinationChange[] {
	if (!before || !after) {
		return [];
	}
	const changes: DestinationChange[] = [];
	const add = (field: string, was: string, now: string): void => {
		if (was !== now) {
			changes.push({ field, before: was, after: now, ssh: true });
		}
	};
	add('ssh host', before.host, after.host);
	add('ssh port', String(before.port), String(after.port));
	add('ssh user', before.username, after.username);
	return changes;
}

/** A field an `edit_tunnel` call would change; `destination` marks host, port and user. */
export interface TunnelEditChange {
	field: string;
	before: string;
	after: string;
	destination: boolean;
}

/**
 * What an `edit_tunnel` call would change on a saved tunnel profile, read from its arguments the
 * way the capability reads them (trimmed strings, empty ignored, a number port), only where the
 * value differs. This is what the approval card shows.
 */
export function describeTunnelEdit(existing: SshTunnelProfile, args: Record<string, unknown>): TunnelEditChange[] {
	const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
	const changes: TunnelEditChange[] = [];
	const add = (field: string, before: string, after: string | undefined, destination: boolean): void => {
		if (after !== undefined && after !== before) {
			changes.push({ field, before, after, destination });
		}
	};
	add('ssh host', existing.host, str(args.host), true);
	add('ssh port', String(existing.port ?? DEFAULT_SSH_PORT), typeof args.port === 'number' ? String(args.port) : undefined, true);
	add('ssh user', existing.username, str(args.username), true);
	add('name', existing.name, str(args.name), false);
	add('private key', existing.privateKeyPath ?? '', str(args.privateKeyPath), false);
	if (typeof args.keepAlive === 'boolean') {
		add('keep alive', existing.keepAlive === false ? 'off' : 'on', args.keepAlive ? 'on' : 'off', false);
	}
	return changes;
}

/** The sentence an approval card and a capability result carry when an edit moves a tunnel profile. */
export const TUNNEL_MOVE_NOTE = 'This points the tunnel at a different SSH server or user, so its saved SSH password and key passphrase, and the saved database password of every connection that uses it, are removed and have to be typed again. The new server\'s host key is trusted the first time it is reached, so check the address.';

/** The assistant's approval line for an `edit_tunnel` call: "edit tunnel "x" (ssh host: a → b)". */
export function editTunnelApproval(existing: SshTunnelProfile, args: Record<string, unknown>): string {
	const changes = describeTunnelEdit(existing, args);
	const list = changes.length > 0 ? ` (${changes.map(formatChange).join('; ')})` : '';
	const moves = changes.some((change) => change.destination) ? `. ${TUNNEL_MOVE_NOTE}` : '';
	return `edit tunnel "${existing.name}"${list}${moves}`;
}

/** The drivers whose "destination" is a file on this computer (its path rides in `database`). */
export function isFileDriver(driver: string): boolean {
	return driver === 'sqlite' || driver === 'duckdb';
}

/**
 * Where a `test_connection_settings` call would connect and what it would send, one line each, for
 * the approval card. Every value is shown WHOLE: a model can spell data into a hostname
 * (`<rows>.attacker.example`, which leaks on the DNS lookup alone), so cutting a long one short
 * would hide exactly the part that says where it goes. The password is shown as present, never
 * printed.
 */
export function describeTestDestination(args: Record<string, unknown>): string[] {
	const str = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
	const driver = str(args.driver) || '(none)';
	const show = (value: string): string => value || '(empty)';
	if (isFileDriver(driver)) {
		return [`driver: ${driver}`, `file: ${show(str(args.database) || str(args.host))}`];
	}
	const host = str(args.host);
	const port = typeof args.port === 'number' ? `:${args.port}` : '';
	const lines = [`driver: ${driver}`, `address: ${show(host)}${port}`, `username: ${show(str(args.username))}`];
	const database = str(args.database);
	if (database) {
		lines.push(`database: ${database}`);
	}
	lines.push(`password: ${typeof args.password === 'string' && args.password !== '' ? '(given, hidden)' : '(none)'}`);
	if (typeof args.ssl === 'boolean') {
		lines.push(`ssl: ${args.ssl ? 'on' : 'off'}`);
	}
	return lines;
}

/** What an approval card for testing new settings says before anyone answers. */
export function testDestinationNote(args: Record<string, unknown>): string {
	return isFileDriver(typeof args.driver === 'string' ? args.driver.trim() : '')
		? 'This opens that file on this computer, read-only, if it exists. A test never creates a file.'
		: 'This connects to an address that is not one of your saved connections and sends it the username and password above. Allow it only if you recognise the address.';
}

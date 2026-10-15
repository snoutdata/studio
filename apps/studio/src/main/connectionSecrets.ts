/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig, SshTunnelProfile } from '../shared/connection';
import { splitUriPassword } from '../shared/connectionUri';
import { destinationChanges, tunnelEndpoint, tunnelProfileMoves, type ConnectionDestination, type DestinationChange, type TunnelEndpoint } from '../shared/connectionDestination';
import type { SecretKind } from './secretStore';

/*
 * A stored secret never follows a connection somewhere new.
 *
 * Editing a saved connection with the password left blank keeps the stored password. When the edit
 * moves the connection (driver, host, port, TLS, the SSH tunnel's endpoint, the user name, or the
 * database where that field says where the connection goes: a file, a Db2 or Oracle connect
 * string, a HANA tenant), keeping it would
 * send that password to the new destination on the next connect, which is how a prompt-injected
 * agent or a hostile page could collect it: change the host, then connect. So main, which holds the
 * secrets, drops them on such an edit and the user types them again. A secret typed in the same
 * edit is the user's answer for the new destination and is kept.
 *
 * Pure apart from the store it is handed, so the rule is tested without Electron.
 */

/** The secrets a saved connection keeps in the keychain under its own id. */
export type ConnectionSecret = Extract<SecretKind, 'password' | 'sshPassword' | 'sshPassphrase' | 'awsSecretAccessKey'>;

/** Look up a saved tunnel profile's endpoint by id; undefined when it no longer exists. */
export type ProfileEndpoint = (ref: string) => TunnelEndpoint | undefined;

/** Where a saved (or about to be saved) connection sends its credentials. */
export function destinationOf(config: ConnectionConfig, profileEndpoint: ProfileEndpoint): ConnectionDestination {
	let tunnel: TunnelEndpoint | undefined;
	if (config.sshTunnel) {
		tunnel = tunnelEndpoint(config.sshTunnel);
	} else if (config.sshTunnelRef) {
		// A profile that is gone has no endpoint to compare; name it by its id so two references
		// to the same missing profile still read as the same tunnel, and a different one does not.
		tunnel = profileEndpoint(config.sshTunnelRef) ?? { host: `profile ${config.sshTunnelRef}`, port: 0, username: '' };
	}
	return { driver: config.driver, flavor: config.flavor, host: config.host, port: config.port, ssl: config.ssl, tunnel, username: config.username, database: config.database };
}

/** What moved between the saved connection and its edit. */
export function connectionMoves(before: ConnectionConfig, after: ConnectionConfig, profileEndpoint: ProfileEndpoint): DestinationChange[] {
	return destinationChanges(destinationOf(before, profileEndpoint), destinationOf(after, profileEndpoint));
}

/**
 * The stored secrets an edit must drop. Any move drops the database password (and the AWS key that
 * fetches one), since the password travels to the database through the tunnel as well; a move of
 * the tunnel's own endpoint also drops the SSH secrets. Secrets typed in this edit are kept.
 */
export function secretsToDrop(changes: DestinationChange[], typed: Partial<Record<ConnectionSecret, boolean>>): ConnectionSecret[] {
	if (changes.length === 0) {
		return [];
	}
	const drop: ConnectionSecret[] = ['password', 'awsSecretAccessKey'];
	if (changes.some((change) => change.ssh)) {
		drop.push('sshPassword', 'sshPassphrase');
	}
	return drop.filter((kind) => !typed[kind]);
}

/**
 * Apply the rule to a save: compare the saved connection with what replaces it and delete the
 * secrets that may not follow. Returns what moved and what was dropped, for the caller to report.
 */
export function dropMovedSecrets(
	secrets: { delete(id: string, kind: SecretKind): void },
	before: ConnectionConfig | undefined,
	after: ConnectionConfig,
	typed: Partial<Record<ConnectionSecret, boolean>>,
	profileEndpoint: ProfileEndpoint,
): { changes: DestinationChange[]; dropped: ConnectionSecret[] } {
	if (!before) {
		return { changes: [], dropped: [] };
	}
	const changes = connectionMoves(before, after, profileEndpoint);
	const dropped = secretsToDrop(changes, typed);
	for (const kind of dropped) {
		secrets.delete(after.id, kind);
	}
	return { changes, dropped };
}

/** What a saved tunnel profile's move touches outside the profile: the keychain and the pinned host keys. */
export interface TunnelMoveStores {
	secrets: { delete(id: string, kind: SecretKind): void };
	forgetHostKey(host: string, port: number): void;
}

/** The SSH server a host key is pinned under (sshKnownHosts.ts): lower-case host and port. */
function sameServer(a: TunnelEndpoint, b: TunnelEndpoint): boolean {
	return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

/**
 * The same rule for a saved SSH tunnel profile, which several connections share. An edit that moves
 * it (host, port or SSH user) drops the profile's stored SSH password and key passphrase unless
 * this edit typed them, forgets the host key pinned for the server it used to reach unless another
 * profile or connection still goes there, and drops the stored database password (and the AWS key
 * that fetches one) of every connection that uses the profile, since each would otherwise travel
 * through the new server on its next connect. Nothing is dropped when it did not move.
 */
export function dropMovedTunnelSecrets(
	stores: TunnelMoveStores,
	before: SshTunnelProfile | undefined,
	after: SshTunnelProfile,
	typed: { sshPassword?: boolean; sshPassphrase?: boolean },
	context: { profileSecretId: string; connections: readonly ConnectionConfig[]; profiles: readonly SshTunnelProfile[] },
): { changes: DestinationChange[]; dropped: ConnectionSecret[]; connections: string[]; forgotHostKey: boolean } {
	const was = tunnelEndpoint(before);
	const now = tunnelEndpoint(after);
	const changes = tunnelProfileMoves(was, now);
	if (!was || changes.length === 0) {
		return { changes, dropped: [], connections: [], forgotHostKey: false };
	}
	const dropped = (['sshPassword', 'sshPassphrase'] as const).filter((kind) => !typed[kind]);
	for (const kind of dropped) {
		stores.secrets.delete(context.profileSecretId, kind);
	}
	const users = context.connections.filter((connection) => connection.sshTunnelRef === after.id && !connection.sshTunnel);
	for (const connection of users) {
		stores.secrets.delete(connection.id, 'password');
		stores.secrets.delete(connection.id, 'awsSecretAccessKey');
	}
	let forgotHostKey = false;
	if (!sameServer(was, now!)) {
		const stillUsed = context.profiles.some((profile) => profile.id !== after.id && sameServer(tunnelEndpoint(profile)!, was))
			|| context.connections.some((connection) => connection.sshTunnel !== undefined && sameServer(tunnelEndpoint(connection.sshTunnel)!, was));
		if (!stillUsed) {
			stores.forgetHostKey(was.host, was.port);
			forgotHostKey = true;
		}
	}
	return { changes, dropped, connections: users.map((connection) => connection.id), forgotHostKey };
}

/**
 * Move the password out of every saved connection string that still holds one: into the keychain
 * under the connection's id (replacing a stored password, which the URI's own credentials always
 * overrode), then the connection is rewritten with the URI minus its password. The secret is
 * stored BEFORE the rewrite, so a keychain that refuses leaves that connection as it was, working,
 * for the next launch to try again. Returns the ids moved.
 */
export function moveUriPasswords(
	connections: readonly ConnectionConfig[],
	secrets: { store(id: string, kind: SecretKind, value: string): void },
	write: (config: ConnectionConfig) => void,
): string[] {
	const moved: string[] = [];
	for (const connection of connections) {
		const split = splitUriPassword(typeof connection.host === 'string' ? connection.host : '');
		if (split.password === undefined) {
			continue;
		}
		try {
			secrets.store(connection.id, 'password', split.password);
		} catch {
			continue;
		}
		write({ ...connection, host: split.host });
		moved.push(connection.id);
	}
	return moved;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../../shared/connection';
import { describeConnectionEdit, DESTINATION_CHANGE_NOTE, sslSettingOf } from '../../../shared/connectionDestination';
import { listDialects } from '../../../shared/engine';
import { maskUriPasswords } from '../../../shared/connectionUri';
import type { ConnectionFormValues } from '../../../shared/forms';
import type { CapabilityHandler } from './registry';

/**
 * Connection-management capabilities. The destructive ones (open the form, connect, disconnect)
 * are `mutates` so they go through the approval gate; creating a connection only ever *opens a
 * prefilled form* the user reviews and saves — the assistant never writes credentials directly.
 */

// The valid driver ids, derived from the shipped dialects (the same source the connection form's
// driver dropdown uses) so this description never goes stale as we add backends. Drop the generic
// fallback dialect, which has an empty driverId.
const DRIVER_DESC = `Driver id. One of: ${listDialects().map((d) => d.driverId).filter(Boolean).join(', ')}.`;

/** Build a partial form draft from loosely-typed args. Only the safe, non-secret fields. */
function draftFromArgs(args: Record<string, unknown>): Partial<ConnectionFormValues> {
	const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	const draft: Partial<ConnectionFormValues> = {};
	const label = str(args.label);
	const driver = str(args.driver);
	const host = str(args.host);
	const database = str(args.database);
	const username = str(args.username);
	const environment = str(args.environment);
	if (label) { draft.label = label; }
	if (driver) { draft.driver = driver; }
	if (host) { draft.host = host; }
	if (database) { draft.database = database; }
	if (username) { draft.username = username; }
	if (environment) { draft.environment = environment; }
	if (typeof args.port === 'number') { draft.port = args.port; }
	if (typeof args.ssl === 'boolean') { draft.ssl = args.ssl; }
	if (typeof args.readOnly === 'boolean') { draft.readOnly = args.readOnly; }
	return draft;
}

/**
 * Reconstruct the (non-secret) form values of an existing saved connection, so an edit can
 * round-trip everything it doesn't touch. Secrets stay blank: `saveConnection` only (re)stores
 * a secret the form actually carries, so blank password/passphrase keep the stored ones.
 */
function formFromConfig(config: ConnectionConfig): ConnectionFormValues {
	// TLS round-trips exactly, mode and CA included: an edit that only renames a connection must not
	// change how it verifies the server (which would also count as moving it, and drop its password).
	const ssl = sslSettingOf(config.ssl);
	const values: ConnectionFormValues = {
		id: config.id,
		label: config.label,
		driver: config.driver,
		flavor: config.flavor,
		environment: config.environment,
		host: config.host,
		port: config.port,
		database: config.database,
		username: config.username,
		ssl: ssl.on,
		sslMode: ssl.on ? ssl.mode : undefined,
		sslCaPath: ssl.on && ssl.mode === 'custom' ? ssl.caPath : undefined,
		readOnly: Boolean(config.readOnly),
		// Carried through so an edit by the AI keeps it. Deliberately NOT one of edit_connection's
		// arguments: what the AI may see of a database is never something the AI can change.
		aiDataAccess: config.aiDataAccess,
	};
	const tunnel = config.sshTunnel;
	if (tunnel) {
		values.ssh = {
			host: tunnel.host,
			port: tunnel.port,
			username: tunnel.username,
			privateKeyPath: tunnel.privateKeyPath,
			localPort: tunnel.localPort,
			keepAlive: tunnel.keepAlive,
		};
	}
	if (config.sshTunnelRef) {
		values.sshTunnelRef = config.sshTunnelRef;
	}
	const aws = config.awsSecret;
	if (aws) {
		values.aws = { region: aws.region, secretId: aws.secretId, profile: aws.profile, accessKeyId: aws.accessKeyId };
	}
	return values;
}

/** A connection's non-secret settings, safe to show the assistant. Passwords/passphrases and
 *  the AWS secret access key are never included (those live in the keychain, not here anyway), and
 *  a connection string's password is masked, in case one was saved before main lifted it out. */
function redactConnection(config: ConnectionConfig): Record<string, unknown> {
	const tunnel = config.sshTunnel;
	const aws = config.awsSecret;
	return {
		id: config.id,
		label: config.label,
		driver: config.driver,
		flavor: config.flavor,
		host: maskUriPasswords(config.host),
		port: config.port,
		database: config.database,
		username: config.username,
		ssl: Boolean(config.ssl),
		environment: config.environment,
		readOnly: Boolean(config.readOnly),
		ssh: tunnel ? { host: tunnel.host, port: tunnel.port, username: tunnel.username, privateKeyPath: tunnel.privateKeyPath, localPort: tunnel.localPort } : undefined,
		aws: aws ? { region: aws.region, secretId: aws.secretId, profile: aws.profile } : undefined,
	};
}

/** Resolve a connection the model referred to by id OR label (case-insensitive). Models almost
 *  always have the human label ("shop_prod") from the ambient roster, not the opaque id, so
 *  accept either rather than rejecting a reasonable call with "No connection with id …". */
function resolveConn<T extends { id: string; label: string }>(conns: T[], ref: string): T | undefined {
	const want = ref.trim().toLowerCase();
	return conns.find((c) => c.id === ref) ?? conns.find((c) => c.label.toLowerCase() === want);
}

/** The arguments that would say WHERE a test connects or what it sends. `test_connection` takes none
 *  of them: it tests a saved connection as saved. */
const DESTINATION_ARGS = ['driver', 'host', 'port', 'database', 'username', 'user', 'password', 'ssl', 'path', 'file', 'url', 'connectionString'] as const;

export const connectionCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'list_connections',
			description: 'List the saved database connections (id, label, driver, environment, and whether each is currently connected).',
			parameters: { type: 'object', properties: {} },
			domain: 'connections',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: (_args, ctx) => {
			const conns = ctx.snapshot().connections;
			return { ok: true, summary: `${conns.length} connections`, data: conns };
		},
	},
	{
		// Tests a SAVED connection, as saved. No address, driver, user, password or file path is
		// accepted, so a model cannot use a test to send anything to a destination of its choosing
		// (a hostname is a DNS lookup, a "password" a login attempt): that is what made this a
		// zero-click way out before. New settings go through test_connection_settings, which asks.
		spec: {
			name: 'test_connection',
			description: 'Test whether a SAVED connection can connect, using its saved settings and password. Takes only the connection\'s id or label (from list_connections). To try settings that are not saved, use test_connection_settings, which asks the user first.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The id or label of a saved connection (from list_connections).' },
				},
				required: ['id'],
			},
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'connections',
			connectionArg: 'id',
		},
		run: async (args, ctx) => {
			const given = DESTINATION_ARGS.filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== '');
			if (given.length > 0) {
				return {
					ok: false,
					summary: '',
					refused: true,
					error: `test_connection only tests a saved connection by its id, with its saved settings; it does not take ${given.join(', ')}. To try settings that are not saved, call test_connection_settings (the user is asked first).`,
				};
			}
			const ref = typeof args.id === 'string' ? args.id : '';
			const conn = resolveConn((await ctx.api.state()).connections, ref);
			if (!conn) {
				return { ok: false, summary: '', error: `No saved connection "${ref}". Call list_connections for the ids.` };
			}
			const result = await ctx.api.testSavedConnection(conn.id);
			return result.ok
				? { ok: true, summary: `"${conn.label}" connects`, data: { ok: true } }
				: { ok: false, summary: `"${conn.label}" did not connect`, error: result.error ?? 'Could not connect.' };
		},
	},
	{
		// Settings that are not saved: a destination the model chose. Asked every time (main and the
		// assistant both raise the card, showing the full address, the user and whether a password
		// is sent), and never "Always allow". Nothing is saved.
		spec: {
			name: 'test_connection_settings',
			title: 'Test new connection settings',
			consentLabel: 'Try connecting to a database that is not saved, at the address shown.',
			description: 'Test whether connection settings that are NOT saved can connect, without saving anything. The user is asked first, every time, and sees the full address. Useful before opening the form to create a connection. For a saved connection, use test_connection with its id.',
			parameters: {
				type: 'object',
				properties: {
					driver: { type: 'string', description: DRIVER_DESC },
					host: { type: 'string' },
					port: { type: 'number' },
					database: { type: 'string', description: 'The database name, or for sqlite/duckdb the path of an EXISTING database file (a test never creates one).' },
					username: { type: 'string' },
					password: { type: 'string' },
					ssl: { type: 'boolean' },
				},
				required: ['driver'],
			},
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			destructive: true,
			domain: 'connections',
		},
		run: async (args, ctx) => {
			const draft = draftFromArgs(args);
			const values: ConnectionFormValues = {
				label: draft.label ?? `${draft.host ?? 'host'}`,
				driver: draft.driver ?? 'mysql-aurora',
				host: draft.host ?? '',
				port: draft.port ?? 0,
				database: draft.database,
				username: draft.username ?? '',
				password: typeof args.password === 'string' ? args.password : undefined,
				ssl: draft.ssl ?? false,
				readOnly: draft.readOnly ?? false,
			};
			const result = await ctx.api.testConnection(values);
			return result.ok
				? { ok: true, summary: 'Connection settings work', data: { ok: true } }
				: { ok: false, summary: 'Connection test failed', error: result.error ?? 'Could not connect.' };
		},
	},
	{
		spec: {
			name: 'open_connection_form',
			consentLabel: 'Open the new-connection form, filled in for you to check and save.',
			description: 'Open the new-connection form prefilled with the given details for the user to review and save. Use this to help the user create a connection (you never save credentials directly).',
			parameters: {
				type: 'object',
				properties: {
					label: { type: 'string', description: 'A friendly name for the connection.' },
					driver: { type: 'string', description: DRIVER_DESC },
					host: { type: 'string' },
					port: { type: 'number' },
					database: { type: 'string' },
					username: { type: 'string' },
					environment: { type: 'string', description: 'e.g. dev, staging, prod.' },
					ssl: { type: 'boolean' },
					readOnly: { type: 'boolean' },
				},
			},
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'connections',
		},
		run: (args, ctx) => {
			const draft = draftFromArgs(args);
			ctx.app.openConnectionForm(draft);
			return { ok: true, summary: `Opened the connection form${draft.label ? ` for "${draft.label}"` : ''}` };
		},
	},
	{
		spec: {
			name: 'get_connection',
			consentLabel: "Read one saved connection's settings (never its password).",
			title: "Read a connection's settings",
			description: 'Read one saved connection\'s settings by id (host, port, database, username, ssl, environment, read-only, and SSH/AWS host info). Passwords and other secrets are never returned. Use this to inspect or confirm a connection before editing it. This needs the user\'s approval because connection details are shared with the assistant.',
			parameters: { type: 'object', properties: { id: { type: 'string', description: 'The id of the saved connection (from list_connections).' } }, required: ['id'] },
			// A read, but approval-gated: connection infrastructure details (hosts, usernames) would
			// otherwise leave the app for the model silently. The bridge gates on `mutates`.
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'connections',
			connectionArg: 'id',
		},
		run: async (args, ctx) => {
			const id = String(args.id ?? '');
			const existing = (await ctx.api.state()).connections.find((c) => c.id === id);
			if (!existing) {
				return { ok: false, summary: '', error: `No connection with id "${id}".` };
			}
			return { ok: true, summary: `Read connection "${existing.label}"`, data: redactConnection(existing) };
		},
	},
	{
		spec: {
			name: 'edit_connection',
			consentLabel: 'Change the settings of a saved connection.',
			description: 'Update a saved connection in place by its id (see list_connections): fix a wrong host or port, rename it, change the database/username, or toggle read-only. Only the fields you pass change. A change to where the connection goes (driver, host, port or ssl) removes its saved password, and the user types it again in the connection form; any other change keeps it. Use this to correct an existing connection instead of opening a new-connection form. Secrets cannot be set this way.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The id of the saved connection to edit (from list_connections).' },
					label: { type: 'string', description: 'A new friendly name.' },
					driver: { type: 'string', description: DRIVER_DESC },
					host: { type: 'string' },
					port: { type: 'number' },
					database: { type: 'string' },
					username: { type: 'string' },
					environment: { type: 'string', description: 'e.g. dev, staging, prod.' },
					ssl: { type: 'boolean' },
					readOnly: { type: 'boolean' },
				},
				required: ['id'],
			},
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'connections',
			connectionArg: 'id',
		},
		run: async (args, ctx) => {
			const id = String(args.id ?? '');
			const state = await ctx.api.state();
			const existing = state.connections.find((c) => c.id === id);
			if (!existing) {
				return { ok: false, summary: '', error: `No connection with id "${id}".` };
			}
			const overrides = draftFromArgs(args);
			const changed = Object.keys(overrides);
			if (changed.length === 0) {
				return { ok: false, summary: '', error: 'Nothing to change. Pass at least one field to update (e.g. host, port, label).' };
			}
			const values: ConnectionFormValues = { ...formFromConfig(existing), ...overrides, id };
			// Main decides (it drops the stored secrets); this only says so, from the same rule.
			const moved = describeConnectionEdit(existing, args).some((change) => change.destination);
			const saved = await ctx.api.saveConnection(values);
			const reconnect = state.connectedIds.includes(id) ? ' Reconnect to apply the changes.' : '';
			const password = moved ? ` ${DESTINATION_CHANGE_NOTE}` : '';
			return { ok: true, summary: `Updated "${saved.label}" (changed ${changed.join(', ')}).${reconnect}${password}` };
		},
	},
	{
		spec: {
			name: 'connect',
			description: 'Connect a saved connection by its id or label (see list_connections).',
			parameters: { type: 'object', properties: { id: { type: 'string', description: 'The connection id or its label, e.g. "shop_prod".' } }, required: ['id'] },
			consentLabel: "Connect to one of your saved databases.",
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'connections',
			connectionArg: 'id',
		},
		run: async (args, ctx) => {
			const ref = String(args.id ?? '');
			const conn = resolveConn(ctx.snapshot().connections, ref);
			if (!conn) {
				return { ok: false, summary: '', error: `No connection matching "${ref}". Call list_connections to see the available ids and labels.` };
			}
			const ok = await ctx.app.connect(conn.id);
			return ok
				? { ok: true, summary: `Connected to "${conn.label}"` }
				: { ok: false, summary: '', error: `Failed to connect to "${conn.label}".` };
		},
	},
	{
		spec: {
			name: 'disconnect',
			description: 'Disconnect a connected database by its id or label.',
			parameters: { type: 'object', properties: { id: { type: 'string', description: 'The connection id or its label.' } }, required: ['id'] },
			consentLabel: "Disconnect one of your databases.",
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			domain: 'connections',
			connectionArg: 'id',
		},
		run: async (args, ctx) => {
			const ref = String(args.id ?? '');
			const conn = resolveConn(ctx.snapshot().connections, ref);
			await ctx.app.disconnect(conn?.id ?? ref);
			return { ok: true, summary: `Disconnected${conn ? ` from "${conn.label}"` : ''}` };
		},
	},
];

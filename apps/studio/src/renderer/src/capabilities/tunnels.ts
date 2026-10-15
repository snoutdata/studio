/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SshTunnelProfile } from '../../../shared/connection';
import type { TunnelProfileFormValues } from '../../../shared/forms';
import { describeTunnelEdit, TUNNEL_MOVE_NOTE } from '../../../shared/connectionDestination';
import type { CapabilityHandler } from './registry';

/**
 * Reusable SSH tunnel profile capabilities. The assistant can list, create, edit, and
 * delete the shared tunnels connections reference. Mirroring edit_connection, only
 * non-secret fields are set this way: the key passphrase / SSH password live in the
 * keychain and the user adds them in the tunnel manager (saveTunnel keeps any stored
 * secret when the form carries none).
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A tunnel profile's settings, safe to show the assistant (no secrets are stored here). */
function redactTunnel(profile: SshTunnelProfile): Record<string, unknown> {
	return {
		id: profile.id,
		name: profile.name,
		host: profile.host,
		port: profile.port,
		username: profile.username,
		privateKeyPath: profile.privateKeyPath,
		keepAlive: profile.keepAlive,
	};
}

/** Apply loosely-typed overrides onto a tunnel form draft. Only the safe, non-secret fields. */
function applyOverrides(base: TunnelProfileFormValues, args: Record<string, unknown>): { values: TunnelProfileFormValues; changed: string[] } {
	const values = { ...base };
	const changed: string[] = [];
	const name = str(args.name);
	const host = str(args.host);
	const username = str(args.username);
	const privateKeyPath = str(args.privateKeyPath);
	if (name) { values.name = name; changed.push('name'); }
	if (host) { values.host = host; changed.push('host'); }
	if (username) { values.username = username; changed.push('username'); }
	if (privateKeyPath) { values.privateKeyPath = privateKeyPath; changed.push('privateKeyPath'); }
	if (typeof args.port === 'number') { values.port = args.port; changed.push('port'); }
	if (typeof args.keepAlive === 'boolean') { values.keepAlive = args.keepAlive; changed.push('keepAlive'); }
	return { values, changed };
}

export const tunnelCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'list_tunnels',
			description: 'List the saved reusable SSH tunnels (id, name, host, port, username) that connections can share. Use this to find a tunnel id before editing or deleting it, or to point a connection at one.',
			parameters: { type: 'object', properties: {} },
			domain: 'tunnels',
			mutates: false,
			implicitConnection: 'none',
			returnsData: 'none',
		},
		run: async (_args, ctx) => {
			const { profiles } = await ctx.api.tunnelsState();
			return { ok: true, summary: `${profiles.length} saved tunnels`, data: profiles.map(redactTunnel) };
		},
	},
	{
		spec: {
			name: 'create_tunnel',
			consentLabel: 'Create a saved SSH tunnel (without its password or passphrase).',
			description: 'Create a new reusable SSH tunnel that connections can share. Sets only non-secret fields; the user adds the key passphrase / SSH password in the tunnel manager afterwards. Returns the new tunnel id.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'A friendly name for the tunnel, e.g. "prod bastion".' },
					host: { type: 'string', description: 'The SSH (bastion) host.' },
					port: { type: 'number', description: 'SSH port (default 22).' },
					username: { type: 'string', description: 'SSH username.' },
					privateKeyPath: { type: 'string', description: 'Path to the SSH private key file.' },
					keepAlive: { type: 'boolean', description: 'Send SSH keepalives (default true).' },
				},
				required: ['name', 'host', 'username'],
			},
			domain: 'tunnels',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			destructive: true,
		},
		run: async (args, ctx) => {
			const name = str(args.name);
			const host = str(args.host);
			const username = str(args.username);
			if (!name || !host || !username) {
				return { ok: false, summary: '', error: 'name, host and username are required.' };
			}
			const { values } = applyOverrides({ name, host, username }, args);
			const saved = await ctx.api.saveTunnel(values);
			return { ok: true, summary: `Created tunnel "${saved.name}"`, data: { id: saved.id } };
		},
	},
	{
		spec: {
			name: 'edit_tunnel',
			consentLabel: 'Change a saved SSH tunnel, which affects every connection using it.',
			description: 'Update a saved SSH tunnel in place by its id (see list_tunnels). Only the fields you pass change. Every connection that references the tunnel picks up the change. A rename, key path or keepalive change keeps the stored key passphrase / SSH password. Changing host, port or username points the tunnel at a different SSH server: the user is asked every time, the tunnel\'s stored SSH password and passphrase and the stored database password of every connection using it are removed, and the user types them again.',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The id of the tunnel to edit (from list_tunnels).' },
					name: { type: 'string', description: 'A new friendly name.' },
					host: { type: 'string', description: 'The SSH (bastion) host.' },
					port: { type: 'number', description: 'SSH port.' },
					username: { type: 'string', description: 'SSH username.' },
					privateKeyPath: { type: 'string', description: 'Path to the SSH private key file.' },
					keepAlive: { type: 'boolean' },
				},
				required: ['id'],
			},
			domain: 'tunnels',
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			destructive: true,
		},
		run: async (args, ctx) => {
			const id = String(args.id ?? '');
			const existing = (await ctx.api.tunnelsState()).profiles.find((p) => p.id === id);
			if (!existing) {
				return { ok: false, summary: '', error: `No tunnel with id "${id}".` };
			}
			const base: TunnelProfileFormValues = {
				id: existing.id,
				name: existing.name,
				host: existing.host,
				port: existing.port,
				username: existing.username,
				privateKeyPath: existing.privateKeyPath,
				keepAlive: existing.keepAlive,
			};
			const { values, changed } = applyOverrides(base, args);
			if (changed.length === 0) {
				return { ok: false, summary: '', error: 'Nothing to change. Pass at least one field to update (e.g. host, port, name).' };
			}
			const moved = describeTunnelEdit(existing, args).some((change) => change.destination);
			const saved = await ctx.api.saveTunnel(values);
			return { ok: true, summary: `Updated tunnel "${saved.name}" (changed ${changed.join(', ')}).${moved ? ` ${TUNNEL_MOVE_NOTE}` : ''}` };
		},
	},
	{
		spec: {
			name: 'delete_tunnel',
			description: 'Delete a saved SSH tunnel by its id. Connections that reference it will stop connecting until pointed at another tunnel, so confirm with the user first.',
			parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
			domain: 'tunnels',
			consentLabel: "Delete a saved SSH tunnel.",
			mutates: true,
			implicitConnection: 'none',
			returnsData: 'none',
			destructive: true,
		},
		run: async (args, ctx) => {
			const id = String(args.id ?? '');
			const existing = (await ctx.api.tunnelsState()).profiles.find((p) => p.id === id);
			if (!existing) {
				return { ok: false, summary: '', error: `No tunnel with id "${id}".` };
			}
			await ctx.api.deleteTunnel(id);
			return { ok: true, summary: `Deleted tunnel "${existing.name}"` };
		},
	},
];

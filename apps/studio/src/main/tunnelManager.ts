/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';

import type { SshTunnelProfile } from '../shared/connection';
import type { TunnelProfileFormValues, TunnelProfilesState } from '../shared/forms';
import { readConnections } from './configStore';
import { dropMovedTunnelSecrets } from './connectionSecrets';
import { forgetHostKey } from './sshKnownHosts';
import { getTunnel, readTunnels, removeTunnel, tunnelSecretId, writeTunnel } from './tunnelStore';
import type { SecretStore } from './secretStore';

/**
 * CRUD for reusable SSH tunnel profiles. Non-secret fields go to tunnelStore
 * (userData/tunnels.json); the key passphrase / SSH password go to the keychain keyed by
 * the profile id. Connections reference a profile by id; {@link ConnectionManager} expands
 * the reference (with these secrets) into a concrete tunnel at connect time.
 */
export class TunnelManager {
	constructor(
		private readonly secrets: SecretStore,
		private readonly onChange: () => void,
	) {}

	state(): TunnelProfilesState {
		return { profiles: readTunnels() };
	}

	/** Persist a profile; (re)store only the secrets the user actually entered (blank on
	 *  edit leaves the stored secret untouched, matching the connection form). An edit that moves
	 *  the profile to another SSH server or user drops what may not follow it: its own SSH secrets
	 *  not typed in this edit, the stored database passwords of the connections using it, and the
	 *  old server's pinned host key when nothing else goes there (connectionSecrets.ts). */
	save(form: TunnelProfileFormValues): SshTunnelProfile {
		const id = form.id ?? randomUUID();
		const before = form.id ? getTunnel(form.id) : undefined;
		const profile: SshTunnelProfile = {
			id,
			name: form.name.trim(),
			host: form.host.trim(),
			port: form.port,
			username: form.username.trim(),
			privateKeyPath: form.privateKeyPath?.trim() || undefined,
			keepAlive: form.keepAlive,
		};
		writeTunnel(profile);
		const secretId = tunnelSecretId(id);
		dropMovedTunnelSecrets(
			{ secrets: this.secrets, forgetHostKey },
			before,
			profile,
			{ sshPassword: Boolean(form.password), sshPassphrase: Boolean(form.passphrase) },
			{ profileSecretId: secretId, connections: readConnections(), profiles: readTunnels() },
		);
		if (form.passphrase) {
			this.secrets.store(secretId, 'sshPassphrase', form.passphrase);
		}
		if (form.password) {
			this.secrets.store(secretId, 'sshPassword', form.password);
		}
		this.onChange();
		return profile;
	}

	remove(id: string): void {
		removeTunnel(id);
		this.secrets.deleteAll(tunnelSecretId(id));
		this.onChange();
	}
}

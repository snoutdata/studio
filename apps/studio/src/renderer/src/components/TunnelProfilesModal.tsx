/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import type { SshTunnelProfile } from '../../../shared/connection';
import type { TunnelProfileFormValues } from '../../../shared/forms';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { errorMessage } from '../errors';

interface TunnelProfilesModalProps {
	onClose(): void;
}

/**
 * Manage the reusable SSH tunnel profiles that connections can share. Lists the saved
 * profiles and embeds an editor for creating/updating one. Secrets (key passphrase / SSH
 * password) are stored in main; a blank value on edit keeps the stored secret.
 */
export function TunnelProfilesModal({ onClose }: TunnelProfilesModalProps): JSX.Element {
	const [profiles, setProfiles] = useState<SshTunnelProfile[]>([]);
	// null = showing the list; an object = editing that profile (no id = creating).
	const [editing, setEditing] = useState<SshTunnelProfile | { create: true } | null>(null);
	const [confirm, confirmDialog] = useConfirm();

	async function reload(): Promise<void> {
		const state = await window.sqlApi.tunnelsState();
		setProfiles(state.profiles);
	}

	useEffect(() => {
		void reload();
	}, []);

	async function remove(profile: SshTunnelProfile): Promise<void> {
		if (!(await confirm({ title: `Delete "${profile.name}"?`, body: "Connections that use this tunnel will stop connecting until you point them at another one.", confirmLabel: "Delete", danger: true }))) {
			return;
		}
		await window.sqlApi.deleteTunnel(profile.id);
		await reload();
	}

	if (editing) {
		const profile = 'create' in editing ? undefined : editing;
		return (
			<TunnelProfileEditor
				existing={profile}
				onCancel={() => setEditing(null)}
				onSaved={async () => { await reload(); setEditing(null); }}
			/>
		);
	}

	return (
		<>
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>SSH Tunnels</h2>
				<p className="field-hint">Reusable tunnels you can point many connections at. Editing one updates every connection that uses it.</p>
				{profiles.length === 0 ? (
					<p className="field-hint">No saved tunnels yet.</p>
				) : (
					<ul className="tunnel-list">
						{profiles.map((profile) => (
							<li key={profile.id}>
								<div className="tunnel-list-main">
									<span className="tunnel-list-name">{profile.name}</span>
									<span className="tunnel-list-sub">{profile.username}@{profile.host}{profile.port ? `:${profile.port}` : ''}</span>
								</div>
								<button type="button" className="secondary" onClick={() => setEditing(profile)}><Icon name="edit" /> Edit</button>
								<button type="button" className="secondary danger" onClick={() => void remove(profile)} title="Delete tunnel"><Icon name="trash" /></button>
							</li>
						))}
					</ul>
				)}
				<div className="modal-actions">
					<button type="button" onClick={() => setEditing({ create: true })}><Icon name="add" /> New tunnel</button>
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onClose}><Icon name="close" /> Close</button>
				</div>
			</div>
		</div>
		{confirmDialog}
		</>
	);
}

interface TunnelProfileEditorProps {
	existing?: SshTunnelProfile;
	onCancel(): void;
	onSaved(): void;
}

/** Create/edit a single tunnel profile. */
function TunnelProfileEditor({ existing, onCancel, onSaved }: TunnelProfileEditorProps): JSX.Element {
	const isEdit = existing !== undefined;
	const [name, setName] = useState(existing?.name ?? '');
	const [host, setHost] = useState(existing?.host ?? '');
	const [port, setPort] = useState(existing?.port ? String(existing.port) : '');
	const [username, setUsername] = useState(existing?.username ?? '');
	const [key, setKey] = useState(existing?.privateKeyPath ?? '');
	const [passphrase, setPassphrase] = useState('');
	const [password, setPassword] = useState('');
	const [keepAlive, setKeepAlive] = useState(existing?.keepAlive ?? true);
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function pickKey(): Promise<void> {
		const path = await window.sqlApi.pickFilePath();
		if (path) {
			setKey(path);
		}
	}

	async function save(): Promise<void> {
		if (!name.trim() || !host.trim() || !username.trim()) {
			setStatus("Name, host and username are required.");
			return;
		}
		const values: TunnelProfileFormValues = {
			id: existing?.id,
			name: name.trim(),
			host: host.trim(),
			port: port.trim() === '' ? undefined : Number(port),
			username: username.trim(),
			privateKeyPath: key.trim() || undefined,
			passphrase: passphrase || undefined,
			password: password || undefined,
			keepAlive,
		};
		setBusy(true);
		try {
			await window.sqlApi.saveTunnel(values);
			onSaved();
		} catch (err) {
			setStatus(errorMessage(err));
			setBusy(false);
		}
	}

	const keep = isEdit ? "leave blank to keep current" : undefined;

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>{isEdit ? `Edit Tunnel: ${existing.name}` : "New Tunnel"}</h2>
				<label>Name<input value={name} autoFocus onChange={(e) => setName(e.target.value)} /></label>
				<div className="row">
					<label className="grow">SSH host<input value={host} onChange={(e) => setHost(e.target.value)} /></label>
					<label className="port">Port<input type="number" placeholder="22" value={port} onChange={(e) => setPort(e.target.value)} /></label>
				</div>
				<label>SSH username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
				<label>Private key file
					<div className="key-picker">
						<input placeholder="~/.ssh/id_rsa" value={key} onChange={(e) => setKey(e.target.value)} />
						<button type="button" className="secondary" onClick={() => void pickKey()} title="Choose a private key file"><Icon name="folder-opened" /> Browse</button>
					</div>
				</label>
				<label>Key passphrase<input type="password" placeholder={keep} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></label>
				<label>SSH password<input type="password" placeholder={keep} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
				<label className="check" title="Send SSH keepalives so the bastion doesn't idle-out the tunnel. Leave on unless a bastion rejects keepalive traffic."><input type="checkbox" checked={keepAlive} onChange={(e) => setKeepAlive(e.target.checked)} /> Keep tunnel alive (recommended)</label>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel} disabled={busy}><Icon name="close" /> Cancel</button>
					<button type="button" onClick={() => void save()} disabled={busy}><Icon name="save" /> Save</button>
				</div>
				{status && <div className="form-status error">{status}</div>}
			</div>
		</div>
	);
}

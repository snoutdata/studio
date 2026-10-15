/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { Icon } from './Icon';
import { CloudKeyArt } from '../art/Illustrations';
import { SettingsIntro } from './SettingsIntro';
import { errorMessage } from '../errors';
import type {
	CloudAccount,
	CloudAccountView,
	CloudAuth,
	CloudTestResult,
	CloudVendor,
	CloudVendorInfo,
	ImportableCredential,
} from '../../../shared/cloud';

/*
 * Settings → Cloud accounts: the CREDENTIALS a data flow can read a cloud with.
 *
 * What this page is for, and what it deliberately is not. It holds one credential per VENDOR, and
 * it does not know what that credential will be pointed at. Which SERVICE (files in S3, events in
 * CloudWatch) and which bucket or log group are decided while designing a flow, where they are
 * tuned, from lists the account can fetch. Asking for either here would be asking for something the
 * account already knows, and it would mean one saved entry per bucket for an account that has
 * forty.
 *
 * That is a reversal, and it is worth knowing why. This page used to ask for the SERVICE, which
 * meant it had to list every service, one credential was entered twice to reach two of them, and
 * the day CloudWatch shipped the page had no option for it — so the log source could not be reached
 * from the GUI at all. Adding a service must not mean touching this file.
 *
 * Nothing here names a service. The vendor list, what each one can do, and the importable
 * credentials all come from `main/cloud/vendors.ts`, so Azure and GCS are a driver each rather than
 * a second copy of this screen.
 *
 * The one rule the surface is built around: **a secret goes in and never comes out.** There is no
 * IPC that returns a stored key; this page knows only `hasSecret`, which is what it needs to offer
 * Remove. So the key field is empty on an existing account and says why, rather than showing dots
 * that imply a value it does not have.
 */

function blankAccount(vendor: CloudVendor): CloudAccount {
	return {
		id: `cloud-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
		name: '',
		vendor,
		auth: { mode: 'named', name: '' },
	};
}

/** What an account can be pointed at, in one phrase, for the list and the picker. */
function serviceWords(info: CloudVendorInfo | undefined): string {
	if (!info || info.services.length === 0) {
		return 'nothing built yet';
	}
	const words = info.services.map((service) => (service === 'objectStore' ? 'files' : 'log events'));
	return words.join(' and ');
}

/** How to sign in, in the order most people already have one. */
const AUTH_LABELS: Record<CloudAuth['mode'], string> = {
	named: 'A credential already on this computer',
	key: 'A key I will paste',
	document: 'A key file I will paste (Google service account)',
	chain: 'However this computer already signs in',
};

export function CloudAccountsSection(): JSX.Element {
	const [vendors, setVendors] = useState<CloudVendorInfo[]>([]);
	const [accounts, setAccounts] = useState<CloudAccountView[]>([]);
	const [editing, setEditing] = useState<CloudAccount | null>(null);
	/** `undefined` leaves a stored key alone, `null` deletes it, a string replaces it. The three are
	 *  three different intentions and collapsing any two loses a working credential. */
	const [secret, setSecret] = useState<string | undefined>(undefined);
	const [hasStoredSecret, setHasStoredSecret] = useState(false);
	const [importable, setImportable] = useState<ImportableCredential[]>([]);
	const [result, setResult] = useState<CloudTestResult | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		setAccounts(await window.sqlApi.cloud.list());
	}, []);

	useEffect(() => {
		void refresh();
		void window.sqlApi.cloud.vendors().then(setVendors);
	}, [refresh]);

	const vendor = editing?.vendor;
	const info = useMemo(() => vendors.find((entry) => entry.vendor === vendor), [vendors, vendor]);
	const storage = info?.services.includes('objectStore') ?? false;

	// What this computer already has, re-asked whenever the vendor changes: an AWS profile is not an
	// Azure account, and offering one under the other's heading is worse than offering none. It is
	// asked per VENDOR rather than per service, because that is what a credential belongs to: the
	// same AWS profile reaches S3 and CloudWatch, and none reaches somebody else's S3-compatible
	// endpoint.
	useEffect(() => {
		if (!vendor) {
			setImportable([]);
			return;
		}
		void window.sqlApi.cloud.importable(vendor).then(setImportable);
	}, [vendor]);

	const edit = (account: CloudAccountView | null): void => {
		setEditing(account ? { ...account } : blankAccount(vendors.find((entry) => entry.services.length > 0)?.vendor ?? 'aws'));
		setHasStoredSecret(account?.hasSecret ?? false);
		setSecret(undefined);
		setResult(null);
	};

	const form = editing ? { account: editing, secret } : null;

	const run = async (what: 'test' | 'save'): Promise<void> => {
		if (!form) {
			return;
		}
		setBusy(true);
		if (what === 'test') {
			setResult(null);
		}
		try {
			if (what === 'test') {
				setResult(await window.sqlApi.cloud.test(form));
			} else {
				await window.sqlApi.cloud.save(form);
				await refresh();
				setEditing(null);
				setSecret(undefined);
				setResult(null);
			}
		} catch (err) {
			setResult({ ok: false, message: errorMessage(err) });
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string): Promise<void> => {
		await window.sqlApi.cloud.remove(id);
		await refresh();
		if (editing?.id === id) {
			setEditing(null);
		}
	};

	const set = (patch: Partial<CloudAccount>): void => {
		setEditing((current) => (current ? { ...current, ...patch } : current));
		// Any edit invalidates a result: a green tick beside a credential that has since changed is
		// the app stating something it has not checked.
		setResult(null);
	};

	/** Adopt a credential the machine already has. Nothing of theirs is copied: this stores a NAME. */
	const adopt = (credential: ImportableCredential): void => {
		set({ auth: credential.auth, region: credential.region ?? editing?.region });
		setSecret(undefined);
		setHasStoredSecret(false);
	};

	// An account with nothing to identify it cannot be tested and must not be saved, so Save says so
	// by being disabled rather than by failing afterwards.
	const complete = Boolean(editing && editing.name.trim()
		&& (editing.auth.mode !== 'key' || editing.auth.keyId.trim())
		&& (editing.auth.mode !== 'named' || editing.auth.name.trim())
		&& (editing.auth.mode !== 'document' || (editing.auth.label.trim() && (hasStoredSecret || Boolean(secret?.trim())))));

	return (
		<>
			<SettingsIntro art={CloudKeyArt}>
				<p>
					The clouds a data flow can read. Set an account up here once, and any flow can point it at that cloud's
					files or its log events.
				</p>
				<p className="muted">
					This page holds the credential and nothing else: which service a flow uses, and which bucket or log group,
					are chosen while you build it, from the lists the account can see. Requests go to your cloud from this
					computer, and a key you paste is kept in this computer's keychain rather than in the file beside it.
				</p>
			</SettingsIntro>

			<fieldset className="cloud-card">
				<legend>Your accounts</legend>
				{accounts.length === 0 ? (
					<div className="muted">Nothing set up yet.</div>
				) : (
					<ul className="cloud-profiles">
						{accounts.map((account) => (
							<li key={account.id}>
								<button type="button" className="link-btn" onClick={() => edit(account)}>
									<Icon name="cloud" /> {account.name}
								</button>
								<span className="muted">
									{vendors.find((entry) => entry.vendor === account.vendor)?.label ?? account.vendor}
									{` · ${serviceWords(vendors.find((entry) => entry.vendor === account.vendor))}`}
									{account.auth.mode === 'named' ? ` · ${account.auth.name}` : ''}
									{account.region ? ` · ${account.region}` : ''}
								</span>
								<button type="button" className="link-btn" data-test="cloud-remove" onClick={() => void remove(account.id)}>Remove</button>
							</li>
						))}
					</ul>
				)}
				<button type="button" data-test="cloud-add" onClick={() => edit(null)} disabled={busy}><Icon name="add" /> Add an account</button>
			</fieldset>

			{editing && (
				<fieldset className="cloud-card" data-test="cloud-editor">
					<legend>{accounts.some((a) => a.id === editing.id) ? 'Edit this account' : 'A new account'}</legend>

					<label>Cloud
						<select data-test="cloud-vendor" value={editing.vendor} onChange={(e) => set({ vendor: e.target.value as CloudVendor })}>
							{vendors.map((entry) => (
								<option key={entry.vendor} value={entry.vendor} disabled={entry.services.length === 0}>
									{entry.label}{entry.services.length === 0 ? ' (not built yet)' : ''}
								</option>
							))}
						</select>
					</label>
					{/* What this credential can be pointed at, said here rather than left to be discovered in
					    the flow wizard: it is the answer to "have I set up the right thing", and it is the
					    line that stops this page ever needing a service picker again. */}
					<span className="muted" data-test="cloud-vendor-what">{info?.what}</span>

					<label>Name
						<input value={editing.name} onChange={(e) => set({ name: e.target.value })} placeholder="acme production" />
					</label>

					<label>How to sign in
						<select
							value={editing.auth.mode}
							onChange={(e) => {
								const mode = e.target.value as CloudAuth['mode'];
								set({ auth: mode === 'key' ? { mode, keyId: '' } : mode === 'named' ? { mode, name: '' } : mode === 'document' ? { mode, label: '' } : { mode } });
								setSecret(undefined);
							}}
						>
							{(Object.keys(AUTH_LABELS) as CloudAuth['mode'][]).map((mode) => (
								<option key={mode} value={mode}>{AUTH_LABELS[mode]}</option>
							))}
						</select>
					</label>

					{editing.auth.mode === 'named' && (
						<>
							{importable.length > 0 ? (
								<>
									<span className="muted">
										Found on this computer{info?.importsFrom ? `, from ${info.importsFrom}` : ''}. Nothing is copied:
										picking one stores its NAME, and the credential is read when a flow runs, so it stays where you
										manage it and keeps working when you rotate it.
									</span>
									<ul className="cloud-importable" data-test="cloud-importable">
										{importable.map((credential) => (
											<li key={credential.id} className={editing.auth.mode === 'named' && editing.auth.name === credential.id ? 'chosen' : undefined}>
												<button type="button" onClick={() => adopt(credential)}>
													<span className="cloud-importable-name">{credential.label}</span>
													<span className="muted">{credential.kind}{credential.region ? ` · ${credential.region}` : ''}</span>
													{credential.note && <span className="cloud-importable-note">{credential.note}</span>}
												</button>
											</li>
										))}
									</ul>
								</>
							) : (
								<span className="muted">
									Nothing found on this computer{info?.importsFrom ? ` from ${info.importsFrom}` : ''}. Type a name if you
									have one, or paste a key instead.
								</span>
							)}
							<label>Profile name
								<input
									value={editing.auth.name}
									onChange={(e) => set({ auth: { mode: 'named', name: e.target.value } })}
									placeholder="default"
								/>
							</label>
						</>
					)}

					{editing.auth.mode === 'key' && (
						<>
							<label>Key ID
								<input
									value={editing.auth.keyId}
									onChange={(e) => set({ auth: { mode: 'key', keyId: e.target.value } })}
									placeholder="AKIA…"
								/>
							</label>
							<label>Secret key
								<input
									type="password"
									value={secret ?? ''}
									onChange={(e) => setSecret(e.target.value)}
									placeholder={hasStoredSecret ? 'Stored. Type to replace it.' : ''}
								/>
							</label>
							{hasStoredSecret && (
								<div className="flow-wizard-row">
									<span className="muted">
										The stored key is not shown, here or anywhere: nothing in the app can read it back out.
									</span>
									<button type="button" className="link-btn" data-test="cloud-forget" onClick={() => { setSecret(null as unknown as string); setHasStoredSecret(false); }}>
										Forget it
									</button>
								</div>
							)}
						</>
					)}

					{/*
					  * A whole credential DOCUMENT. Google's service account is issued as one JSON file
					  * and rotated as one, so it is pasted and kept as one: splitting it into an id and
					  * a secret would mean parsing somebody's credential to store it and reassembling
					  * it to use it, and getting that wrong is an auth failure nobody can debug.
					  */}
					{editing.auth.mode === 'document' && (
						<>
							<label>What to call it
								<input
									value={editing.auth.label}
									onChange={(e) => set({ auth: { mode: 'document', label: e.target.value } })}
									placeholder="flows@my-project.iam.gserviceaccount.com"
								/>
							</label>
							<label>The key file
								<textarea
									rows={5}
									value={secret ?? ''}
									onChange={(e) => setSecret(e.target.value)}
									// Placeholder text in an empty box, so somebody pasting a GCP service-account
									// JSON can see they are in the right field. It is the shape of the thing, not
									// one of them. The suppression has to sit on the line ABOVE the match.
									// nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account
									placeholder={hasStoredSecret ? 'Stored. Paste again to replace it.' : '{ "type": "service_account", … }'}
									spellCheck={false}
								/>
							</label>
							<span className="muted">
								Paste the whole file. It goes straight to this computer's keychain, is never written beside the
								account, and nothing in the app can read it back out.
							</span>
							{hasStoredSecret && (
								<div className="flow-wizard-row">
									<span className="muted">A key file is stored.</span>
									<button type="button" className="link-btn" onClick={() => { setSecret(null as unknown as string); setHasStoredSecret(false); }}>
										Forget it
									</button>
								</div>
							)}
						</>
					)}

					{editing.auth.mode === 'chain' && (
						<span className="muted">
							Uses whatever this computer already has: environment variables, a signed-in session, or the role a
							machine is running as. Nothing is stored by the app.
						</span>
					)}

					<label>Region
						<input value={editing.region ?? ''} onChange={(e) => set({ region: e.target.value })} placeholder="eu-west-1" />
					</label>
					<span className="muted">
						{storage
							? 'A starting point, not a constraint: listing your buckets does not depend on it, each one carries its own region, and a log group asks for one on the flow.'
							: 'A starting point, not a constraint: a flow chooses the region it reads.'}
					</span>

					{/* Only where it means something. The endpoint is what tells one S3-compatible service
					    from another, and on a vendor's own cloud it is a field that can only be wrong. */}
					{editing.vendor === 's3compat' && (
						<>
							<label>Endpoint
								<input value={editing.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://…" />
							</label>
							<span className="muted">
								The address of your storage: Cloudflare R2, MinIO, Backblaze B2, Wasabi, Ceph, or anything else
								that speaks the S3 API.
							</span>
							<label className="check">
								<input
									type="checkbox"
									checked={Boolean(editing.forcePathStyle)}
									onChange={(e) => set({ forcePathStyle: e.target.checked })}
								/>
								Address buckets by path
							</label>
							<span className="muted">
								What most self-hosted storage needs. Without it the name goes in the host name, and a server that
								does not do that fails as a name-not-found, which reads as a broken network.
							</span>
						</>
					)}

					{result && (
						<div className={result.ok ? 'flow-wizard-note' : 'flow-wizard-error'} data-test="cloud-result">
							<Icon name={result.ok ? 'check' : 'error'} /> {result.message}
							{result.sample && result.sample.length > 0 && (
								<ul className="muted">{result.sample.map((name) => <li key={name}>{name}</li>)}</ul>
							)}
						</div>
					)}

					<div className="flow-wizard-row">
						<button type="button" data-test="cloud-test" onClick={() => void run('test')} disabled={busy || !complete}>
							<Icon name="beaker" /> {busy ? 'Checking…' : 'Test it'}
						</button>
						<button type="button" data-test="cloud-save" onClick={() => void run('save')} disabled={busy || !complete}><Icon name="save" /> Save</button>
						<button type="button" className="link-btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
					</div>
				</fieldset>
			)}
		</>
	);
}

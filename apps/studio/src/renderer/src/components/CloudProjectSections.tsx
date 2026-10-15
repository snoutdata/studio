/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { CLOUD_VOCABULARY, prefix } from '../../../shared/ownLayout';
import {
	type CloudActionOutcome, type CloudBackups, type CloudConnectionFacts, type CloudCopyTarget, type CloudDomain,
	type CloudFunctions, type CloudProjectOp, type CloudProjectOps, type CloudProjectRow,
	type CloudServices, type CloudUsage,
} from '../../../shared/cloudProjects';

// What only a CLOUD project has: the control plane's side of it, each one the Snout Function the
// dashboard and the CLI call, made in main. Running, usage, the keys and the password, backups, the
// product switches, functions with their sizing and secrets, and custom domains. Everything a cloud
// project shares with a local one is in ProjectSections.tsx.
//
// A password or an API key never arrives here. Copy puts it on the clipboard from main, and this
// screen only ever learns that it was copied.

/** What the last action said: quiet when asked for, amber when refused, red when it failed. */
type Said = CloudActionOutcome | null;

function Status({ said }: { said: Said }): JSX.Element | null {
	if (!said) {
		return null;
	}
	return <div className={said.ok ? 'field-hint' : said.refused ? 'form-status warn' : 'form-status error'}>{said.message}</div>;
}

function bytes(n: number | null | undefined): string {
	if (n === null || n === undefined) {
		return "not measured yet";
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function when(iso: string | null | undefined): string {
	return iso ? new Date(iso).toLocaleString() : "never";
}

/** Run one operation; answers the data, or puts the refusal in `said` and answers null. */
async function run<K extends CloudProjectOp>(op: K, args: CloudProjectOps[K]['args'], said: (s: Said) => void): Promise<CloudProjectOps[K]['result'] | null> {
	const outcome = await window.sqlApi.cloudProject(op, args);
	if (outcome.ok) {
		return outcome.data;
	}
	said({ ok: false, refused: outcome.refused, message: outcome.message });
	return null;
}

/** Load a section's data when it opens, with a reload for after an action. */
function useLoad<T>(load: () => Promise<T | null>): { data: T | null; loading: boolean; reload(): Promise<void> } {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const reload = useCallback(async () => {
		setLoading(true);
		try {
			setData(await load());
		} finally {
			setLoading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, loading, reload };
}

/** A cloud project's state and Start and Stop: the top of its Overview. */
export function CloudStatus(props: { row: CloudProjectRow | null; projectRef: string; onChanged(): Promise<void> }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const row = props.row;

	if (!row) {
		return <div className="field-hint">Loading…</div>;
	}

	async function ask(action: 'pause' | 'resume'): Promise<void> {
		setBusy(true);
		try {
			setSaid(await window.sqlApi.cloudAsk(action, props.projectRef));
			await props.onChanged();
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Status</legend>
			<div className="cloud-facts">
				<span className="muted">State</span><span>{row.state}{row.desiredState ? ` → ${row.desiredState}` : ''}{row.busy ? " (working)" : ''}</span>
				<span className="muted">Region</span><span>{row.region}</span>
				<span className="muted">Size</span><span>{bytes(row.sizeBytes)}{row.readOnly ? " (over the plan's limit, refusing writes)" : ''}</span>
				<span className="muted">Last connection</span><span>{when(row.lastConnectionAt)}</span>
				<span className="muted">Created</span><span>{when(row.createdAt)}</span>
				<span className="muted">Production</span><span>{row.production ? "Yes, never paused" : "No"}</span>
			</div>
			{!row.wakesInstantly && <p className="field-hint">Its data is in the bucket rather than on a host, so the next start is a restore and takes longer.</p>}
			<div className="cloud-actions">
				<button type="button" disabled={!row.canResume || busy} onClick={() => void ask('resume')}><Icon name="play" /> Start</button>
				<button type="button" disabled={!row.canPause || busy} title={row.pauseRefusal} onClick={() => void ask('pause')}><Icon name="debug-stop" /> Stop</button>
			</div>
			{row.pauseRefusal && !row.canPause && <p className="field-hint">{row.pauseRefusal}</p>}
			<Status said={said} />
		</fieldset>
	);
}

/** Delete a cloud project: in Settings, where the dashboard keeps it. */
export function CloudDelete(props: { row: CloudProjectRow | null; onDeleted(): void }): JSX.Element | null {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	const row = props.row;
	if (!row) {
		return null;
	}

	async function remove(): Promise<void> {
		if (!row) {
			return;
		}
		const ok = await confirm({
			title: `Delete ${row.name}?`,
			body: `The project ${row.ref} and its data are deleted. It can be restored for your plan's grace period. Its connection is removed from your list.`,
			confirmLabel: "Delete",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			const outcome = await window.sqlApi.cloudDelete(row.ref);
			setSaid(outcome);
			if (outcome.ok) {
				props.onDeleted();
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Delete this project</legend>
			<p className="field-hint">The project and its data are deleted. It can be restored for your plan's grace period.</p>
			<div className="cloud-actions">
				<button type="button" className="danger" disabled={!row.canDelete || busy} onClick={() => void remove()}><Icon name="trash" /> Delete project</button>
			</div>
			<Status said={said} />
			{confirmDialog}
		</fieldset>
	);
}

function Connection({ projectRef, part, onOpenDatabase }: { projectRef: string; part: 'database' | 'keys'; onOpenDatabase?(): void }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	// The connection facts are only read where they are shown: reading them is not free on the audit log.
	const { data } = useLoad<CloudConnectionFacts>(() => (part === 'database' ? run('connection', { ref: projectRef }, setSaid) : Promise.resolve(null)));

	async function copy(what: CloudCopyTarget, label: string): Promise<void> {
		setBusy(true);
		try {
			if (await run('copy', { ref: projectRef, what }, setSaid)) {
				setSaid({ ok: true, message: `${label} copied. Reading it is recorded on the project's activity log.` });
			}
		} finally {
			setBusy(false);
		}
	}

	async function reset(): Promise<void> {
		const ok = await confirm({
			title: "Reset the password?",
			body: "Anything connected with the current password is disconnected when it reconnects. Your connections in this app are updated to the new one.",
			confirmLabel: "Reset password",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			const result = await run('resetPassword', { ref: projectRef }, setSaid);
			if (result) {
				setSaid({ ok: true, message: `New password set. It applies ${result.appliesIn}. ${result.updatedConnections === 1 ? "Your connection was updated." : `${result.updatedConnections} connections were updated.`}` });
			}
		} finally {
			setBusy(false);
		}
	}

	async function rotate(): Promise<void> {
		const ok = await confirm({
			title: "Rotate the API keys?",
			body: "Both keys are replaced. Every key already pasted into an app, a deployment or a CI secret stops working.",
			confirmLabel: "Rotate keys",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			const result = await run('rotateKeys', { ref: projectRef }, setSaid);
			if (result) {
				setSaid({ ok: true, message: `New keys issued. ${result.breaks}` });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			{part === 'database' && onOpenDatabase && (
				<fieldset>
					<legend>Tables and SQL</legend>
					<p className="field-hint">The database is a connection in your Connections list, marked with the SnoutData butterfly: browse its tables there and open a SQL editor on it.</p>
					<div className="cloud-actions">
						<button type="button" onClick={onOpenDatabase}><Icon name="plug" /> Open in Connections</button>
					</div>
				</fieldset>
			)}
			{part === 'database' && <fieldset>
				<legend>Connection</legend>
				<label>Host<input readOnly value={data?.host ?? ''} /></label>
				<label>Port<input readOnly value={data ? String(data.port) : ''} /></label>
				<label>Database<input readOnly value={data?.database ?? ''} /></label>
				<label>User<input readOnly value={data?.user ?? ''} /></label>
				<p className="field-hint">TLS is required. The password is stored for you and goes straight to the clipboard.</p>
				<div className="cloud-actions">
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('uri', "Connection string")}><Icon name="copy" /> Copy connection string</button>
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('password', "Password")}><Icon name="copy" /> Copy password</button>
					<span className="spacer" />
					<button type="button" className="danger" disabled={busy} onClick={() => void reset()}><Icon name="key" /> Reset password</button>
				</div>
			</fieldset>}
			{part === 'keys' && <fieldset>
				<legend>API keys</legend>
				<p className="field-hint">For <span className="mono">@snoutdata/client</span> and the data API, at <span className="mono">https://{projectRef}.api.snoutdata.com</span>. The server key bypasses row-level security: keep it on a server.</p>
				<div className="cloud-actions">
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('appKey', "App key")}><Icon name="copy" /> Copy app key</button>
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('serverKey', "Server key")}><Icon name="copy" /> Copy server key</button>
					<span className="spacer" />
					<button type="button" className="danger" disabled={busy} onClick={() => void rotate()}><Icon name="key" /> Rotate keys</button>
				</div>
			</fieldset>}
			<Status said={said} />
			{confirmDialog}
		</>
	);
}

export function CloudBackupsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [at, setAt] = useState('');
	const [name, setName] = useState('');
	const { data, loading, reload } = useLoad<CloudBackups>(() => run('backups', { ref: projectRef }, setSaid));
	const exported = data?.export ?? null;
	const restore = data?.restore ?? null;

	async function exportNow(): Promise<void> {
		setBusy(true);
		try {
			if (await run('requestExport', { ref: projectRef }, setSaid)) {
				setSaid({ ok: true, message: "Export asked for. It is taken on the host's next tick; refresh to see it." });
				await reload();
			}
		} finally {
			setBusy(false);
		}
	}

	async function restoreNow(): Promise<void> {
		if (!at) {
			return;
		}
		setBusy(true);
		try {
			const made = await run('restore', { ref: projectRef, at: new Date(at).toISOString(), ...(name.trim() ? { name: name.trim() } : {}) }, setSaid);
			if (made) {
				setSaid({ ok: true, message: `Restoring into a new project, ${made.name} (${made.ref}). It is added to your connections.` });
			}
		} finally {
			setBusy(false);
		}
	}

	function toLocal(iso: string | null): string | undefined {
		if (!iso) {
			return undefined;
		}
		const d = new Date(iso);
		return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
	}

	return (
		<>
			<fieldset>
				<legend>Export</legend>
				<p className="field-hint">A <span className="mono">pg_dump</span> of the whole database, as a download link that lasts a few hours.</p>
				{loading && <div className="field-hint">Loading…</div>}
				{exported && (
					<div className="cloud-facts">
						<span className="muted">Latest</span>
						<span>{exported.pending ? "Being taken now" : exported.completedAt ? when(exported.completedAt) : "None yet"}</span>
						{exported.bytes !== undefined && exported.bytes !== null && <><span className="muted">Size</span><span>{bytes(exported.bytes)}</span></>}
						{exported.error && <><span className="muted">Error</span><span>{exported.error}</span></>}
					</div>
				)}
				<div className="cloud-actions">
					<button type="button" disabled={busy || exported?.pending === true} onClick={() => void exportNow()}><Icon name="export" /> Export now</button>
					{exported?.url && <button type="button" className="secondary" onClick={() => void window.sqlApi.openExternal(exported.url!)}><Icon name="cloud-download" /> Download</button>}
					<span className="spacer" />
					<button type="button" className="secondary" disabled={loading} onClick={() => void reload()}><Icon name="refresh" /> Refresh</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>Restore to a point in time</legend>
				{!restore && !loading && <p className="field-hint">The restore window could not be read.</p>}
				{restore && !restore.available && (
					<p className="field-hint">
						{restore.pitrEnabled
							? "There is no backup to restore from yet. The first one is taken shortly after the project is created."
							: `Point-in-time restore is part of the Pro and Business plans, and this project is on ${restore.tier}.`}
					</p>
				)}
				{restore?.available && (
					<>
						<p className="field-hint">The restore goes into a NEW project beside this one, never over it, so a wrong guess costs nothing. It uses one of your plan's project slots.</p>
						<label>
							Moment
							<input type="datetime-local" value={at} min={toLocal(restore.earliest)} max={toLocal(restore.latest)} onChange={(e) => setAt(e.target.value)} />
						</label>
						<p className="field-hint">Between {when(restore.earliest)} and {when(restore.latest)}.</p>
						<label>
							New project name
							<input value={name} placeholder="Optional" maxLength={60} onChange={(e) => setName(e.target.value)} />
						</label>
						<div className="cloud-actions">
							<button type="button" disabled={busy || !at} onClick={() => void restoreNow()}><Icon name="history" /> Restore</button>
						</div>
					</>
				)}
			</fieldset>
			<Status said={said} />
		</>
	);
}

export function CloudUsageSection({ projectRef }: { projectRef: string }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const { data, loading } = useLoad<CloudUsage>(() => run('usage', { ref: projectRef }, setSaid));
	const days = [...(data?.days ?? [])].reverse();
	const latest = days.find((d) => d.dbBytes !== null);
	const limit = data?.limit?.maxStorageBytes ?? null;
	const share = latest?.dbBytes && limit ? Math.min(1, latest.dbBytes / limit) : null;

	return (
		<>
			<fieldset>
				<legend>Storage</legend>
				{loading && <div className="field-hint">Loading…</div>}
				{!loading && (
					<>
						<div className="cloud-facts">
							<span className="muted">Database</span><span>{bytes(latest?.dbBytes)}</span>
							<span className="muted">Plan limit</span><span>{limit ? `${bytes(limit)} (${data?.limit?.tier})` : "unknown"}</span>
						</div>
						{share !== null && (
							<div className="cloud-meter" title={`${Math.round(share * 100)}% of the plan's storage`}>
								<div className={`cloud-meter-fill${share > 0.9 ? ' warn' : ''}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
							</div>
						)}
					</>
				)}
			</fieldset>
			<fieldset>
				<legend>Last 30 days</legend>
				{!loading && days.length === 0 && <p className="field-hint">Nothing measured yet. The host samples every 15 minutes.</p>}
				{days.length > 0 && (
					<table className="cloud-table">
						<thead>
							<tr><th>Day</th><th>Database</th><th>Backups</th><th>Connections</th><th>Compute</th></tr>
						</thead>
						<tbody>
							{days.map((d) => (
								<tr key={d.day}>
									<td>{d.day}</td>
									<td>{bytes(d.dbBytes)}</td>
									<td>{bytes(d.repoBytes)}</td>
									<td>{d.connections}</td>
									<td>{Math.round(d.computeSeconds / 60)} min</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</fieldset>
			<Status said={said} />
		</>
	);
}

// Each service's path, as a cloud project's door serves it (shared/ownLayout.ts).
const SERVICE_COPY: Record<'auth' | 'storage' | 'dataApi' | 'push', { legend: string; hint: string; path: string }> = {
	auth: { legend: "Auth", hint: "Sign-up and sign-in for your app's users, with the project's own keys. Your users live in the auth schema of your database.", path: prefix('identity', CLOUD_VOCABULARY) },
	storage: { legend: "Storage", hint: "Files for your app, stored in your project's storage.", path: prefix('files', CLOUD_VOCABULARY) },
	dataApi: { legend: "Data API", hint: "REST and GraphQL over your tables (PostgREST and pg_graphql), for @snoutdata/client or any client that speaks PostgREST.", path: prefix('data', CLOUD_VOCABULARY) },
	push: { legend: "Push", hint: "Notifications to iPhone, Android and the web. It runs beside your database, and its devices, log and keys stay in your database's push schema. Turning it on restarts the database once.", path: '/push/v1' },
};

/** A product's switch on the control plane (auth, storage, the data API, push), with what the plan says. */
export function CloudService({ projectRef, service, onState }: { projectRef: string; service: 'auth' | 'storage' | 'dataApi' | 'push'; onState?(enabled: boolean): void }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const { data, loading, reload } = useLoad<CloudServices>(() => run('services', { ref: projectRef }, setSaid));
	const copy = SERVICE_COPY[service];
	const state = data?.[service] ?? null;
	const enabled = state?.enabled === true;
	const refusedByPlan = service === 'dataApi' && data?.dataApi !== null && data?.dataApi?.allowed === false && !enabled;
	const readError = data?.errors[service];

	// The section around this switch shows the product's own screens only while it is on.
	useEffect(() => {
		if (!loading && data) {
			onState?.(enabled);
		}
	}, [loading, data, enabled, onState]);

	async function flip(enable: boolean): Promise<void> {
		setBusy(true);
		try {
			const result = await run('setService', { ref: projectRef, service, enable }, setSaid);
			if (result) {
				setSaid({ ok: true, message: result.note ?? (enable ? "Turned on. It starts on the project's next restart, within a minute." : "Turned off.") });
				await reload();
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<fieldset>
				<legend>{copy.legend}</legend>
				<p className="field-hint">{copy.hint}</p>
				{loading && <div className="field-hint">Loading…</div>}
				{readError && <div className="form-status warn">{readError}</div>}
				{!loading && !readError && (
					<label className="check">
						<input type="checkbox" checked={enabled} disabled={busy || refusedByPlan} onChange={(e) => void flip(e.target.checked)} />
						{enabled ? "On" : "Off"}
					</label>
				)}
				{refusedByPlan && <p className="field-hint">The data API is not included in this project&apos;s plan.</p>}
				{enabled && <p className="field-hint">Served at <span className="mono">https://{projectRef}.api.snoutdata.com{copy.path}</span>.</p>}
				{service === 'storage' && data?.storage && (
					<div className="cloud-facts">
						{data.storage.pending && <><span className="muted">State</span><span>Waiting for the host to register it</span></>}
						<span className="muted">Files</span><span>{data.storage.files ?? "not measured yet"}</span>
						<span className="muted">Size</span><span>{data.storage.bytes === null ? "not measured yet" : `${bytes(data.storage.bytes)}${data.storage.maxFilesBytes ? ` of ${bytes(data.storage.maxFilesBytes)}` : ''}`}</span>
							{data.storage.bytes === null && data.storage.maxFilesBytes ? <><span className="muted">Plan limit</span><span>{bytes(data.storage.maxFilesBytes)}</span></> : null}
						{data.storage.lastError && <><span className="muted">Last error</span><span>{data.storage.lastError}</span></>}
					</div>
				)}
				{service === 'auth' && data?.auth && enabled && (
					<div className="cloud-facts">
						<span className="muted">Google sign-in</span><span>{data.auth.googleEnabled ? "On" : "Off"}</span>
						<span className="muted">SAML SSO</span><span>{data.auth.samlEnabled ? "On" : "Off"}</span>
					</div>
				)}
				{service === 'auth' && enabled && <p className="field-hint">Providers are set up in the dashboard.</p>}
				{service === 'push' && data?.push && enabled && (
					<div className="cloud-facts">
						<span className="muted">Scheduled sends</span><span>{data.push.scheduling ? "Included in this plan" : "On paid plans"}</span>
					</div>
				)}
				{service === 'push' && enabled && <p className="field-hint">Apple and Firebase keys are set in the dashboard, or with <span className="mono">snoutdata push credentials</span>. They are checked, then kept in your own database.</p>}
			</fieldset>
			<Status said={said} />
		</>
	);
}

export function CloudFunctionsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const { data: loaded, loading, reload } = useLoad<CloudFunctions>(() => run('functions', { ref: projectRef }, setSaid));
	const [sized, setSized] = useState<CloudFunctions | null>(null);
	const data = sized ?? loaded;
	const [secrets, setSecrets] = useState<CloudFunctions['secrets'] | null>(null);
	const shown = secrets ?? data?.secrets ?? [];

	async function setSecret(): Promise<void> {
		setBusy(true);
		try {
			const rows = await run('setSecret', { ref: projectRef, name: name.trim(), value }, setSaid);
			if (rows) {
				setSecrets(rows);
				setSaid({ ok: true, message: `${name.trim()} set. Functions see it on their next start.` });
				setName('');
				setValue('');
			}
		} finally {
			setBusy(false);
		}
	}

	async function unset(secret: string): Promise<void> {
		setBusy(true);
		try {
			const rows = await run('unsetSecret', { ref: projectRef, name: secret }, setSaid);
			if (rows) {
				setSecrets(rows);
				setSaid({ ok: true, message: `${secret} removed.` });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<fieldset>
				<legend>Deployed functions</legend>
				{loading && <div className="field-hint">Loading…</div>}
				{/* Only an ANSWER that is empty is "none deployed": a read that failed says so in its
				    own words below, and used to sit under this sentence. */}
				{!loading && data && data.functions.length === 0 && (
					<p className="field-hint">No functions deployed. Deploy one with <span className="mono">snoutdata functions deploy &lt;name&gt;</span>.</p>
				)}
				{(data?.functions.length ?? 0) > 0 && (
					<table className="cloud-table">
						<thead><tr><th>Name</th><th>JWT</th><th>Size</th><th>Memory</th><th>Workers</th><th>Updated</th></tr></thead>
						<tbody>
							{data!.functions.map((f) => (
								<tr key={f.name}>
									<td className="mono">{f.name}</td>
									<td>{f.verifyJwt ? "Required" : "Public"}</td>
									<td>{bytes(f.bytes)}</td>
									<td>{f.memoryMb == null ? '-' : `${f.memoryMb} MB`}</td>
									<td>{f.concurrency ?? '-'}</td>
									<td>{when(f.updatedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{!loading && (data?.functions.length ?? 0) > 0 && <p className="field-hint">Served at <span className="mono">https://{projectRef}.api.snoutdata.com{prefix('fn', CLOUD_VOCABULARY)}/&lt;name&gt;</span>. Deploy with the CLI.</p>}
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" className="secondary" disabled={loading} onClick={() => { setSecrets(null); setSized(null); void reload(); }}><Icon name="refresh" /> Refresh</button>
				</div>
			</fieldset>
			{data && <FunctionSizing projectRef={projectRef} view={data} onSized={setSized} setSaid={setSaid} />}
			<fieldset>
				<legend>Secrets</legend>
				<p className="field-hint">Environment variables for your functions. A value goes in and never comes back out: only the names are listed.</p>
				{shown.length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>Name</th><th>Updated</th><th /></tr></thead>
						<tbody>
							{shown.map((s) => (
								<tr key={s.name}>
									<td className="mono">{s.name}</td>
									<td>{when(s.updatedAt)}</td>
									<td className="cloud-table-action">
										<button type="button" className="icon-btn" aria-label={`Remove ${s.name}`} disabled={busy} onClick={() => void unset(s.name)}><Icon name="trash" /></button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<label>Name<input value={name} placeholder="STRIPE_KEY" onChange={(e) => setName(e.target.value.toUpperCase())} /></label>
				<label>Value<input type="password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
				<div className="cloud-actions">
					<button type="button" disabled={busy || !name.trim() || !value} onClick={() => void setSecret()}><Icon name="lock" /> Set secret</button>
				</div>
			</fieldset>
			<Status said={said} />
		</>
	);
}

/** The memory steps offered for one worker; the plan's cap bounds them. */
const MEMORY_STEPS = [32, 64, 128, 256, 512, 1024];

/**
 * One function's memory and workers, within the plan: memory × workers may not exceed the
 * project's memory, the RAM its database gets. Options that would not fit beside the other number
 * are disabled; the control plane judges again and refuses in its own words.
 */
function FunctionSizing({ projectRef, view, onSized, setSaid }: {
	projectRef: string;
	view: CloudFunctions;
	onSized: (next: CloudFunctions) => void;
	setSaid: (s: Said) => void;
}): JSX.Element | null {
	const plan = view.plan;
	const sized = view.functions.filter((f) => f.memoryMb != null && f.concurrency != null);
	const [name, setName] = useState(sized[0]?.name ?? '');
	const current = sized.find((f) => f.name === name) ?? sized[0];
	const [memoryMb, setMemoryMb] = useState<number>(current?.memoryMb ?? 128);
	const [concurrency, setConcurrency] = useState<number>(current?.concurrency ?? 1);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		setMemoryMb(current?.memoryMb ?? 128);
		setConcurrency(current?.concurrency ?? 1);
	}, [current?.name, current?.memoryMb, current?.concurrency]);
	if (!plan || !current) {
		return null;
	}
	const steps = [...new Set([...MEMORY_STEPS.filter((mb) => mb <= plan.functionMemoryMb), memoryMb])].sort((a, b) => a - b);
	const total = memoryMb * concurrency;
	const fits = total <= plan.podMemoryMb;
	const changed = memoryMb !== current.memoryMb || concurrency !== current.concurrency;

	async function save(reset: boolean): Promise<void> {
		setBusy(true);
		try {
			const next = await run('sizeFunction', reset ? { ref: projectRef, name: current!.name, reset: true } : { ref: projectRef, name: current!.name, memoryMb, concurrency }, setSaid);
			if (next) {
				onSized(next);
				const now = next.functions.find((f) => f.name === current!.name);
				setSaid({ ok: true, message: `${current!.name} runs at ${now?.memoryMb} MB × ${now?.concurrency} from its next request.` });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Memory and concurrency</legend>
			<p className="field-hint">
				On the {plan.tier} plan a worker may use up to {plan.functionMemoryMb} MB and a function may run up to {plan.concurrencyMax} workers at once.
				Memory × workers may not exceed this project&apos;s {plan.podMemoryMb} MB, the RAM its database gets. A function gets a second worker only
				while every worker it has is busy on CPU; requests that wait on the network share one.
			</p>
			{sized.length > 1 && (
				<label>Function
					<select value={current.name} disabled={busy} onChange={(e) => setName(e.target.value)}>
						{sized.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
					</select>
				</label>
			)}
			<label>Memory a worker
				<select value={memoryMb} disabled={busy} onChange={(e) => setMemoryMb(Number(e.target.value))}>
					{steps.map((mb) => <option key={mb} value={mb} disabled={mb * concurrency > plan.podMemoryMb}>{mb} MB</option>)}
				</select>
			</label>
			<label>Workers
				<select value={concurrency} disabled={busy} onChange={(e) => setConcurrency(Number(e.target.value))}>
					{Array.from({ length: plan.concurrencyMax }, (_, i) => i + 1).map((n) => <option key={n} value={n} disabled={n * memoryMb > plan.podMemoryMb}>{n}</option>)}
				</select>
			</label>
			<p className={fits ? 'field-hint' : 'form-status error'}>{memoryMb} MB × {concurrency} = {total} MB of {plan.podMemoryMb} MB</p>
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={() => void save(true)}><Icon name="discard" /> Plan default</button>
				<button type="button" disabled={busy || !changed || !fits} onClick={() => void save(false)}><Icon name="save" /> Save</button>
			</div>
		</fieldset>
	);
}

export function CloudDomainsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [hostname, setHostname] = useState('');
	const { data, loading, reload } = useLoad<CloudDomain[]>(() => run('domains', { ref: projectRef }, setSaid));

	async function act(action: 'add' | 'verify' | 'remove', host: string): Promise<void> {
		setBusy(true);
		try {
			const result = await run('domain', { ref: projectRef, action, hostname: host }, setSaid);
			if (result) {
				setSaid({
					ok: true,
					message: action === 'add'
						? (result.next ?? `${host} added. Publish its records, then verify.`)
						: action === 'verify'
							? (result.domain?.verified ? `${host} is verified.` : (result.domain?.verificationError ?? `${host} is not verified yet.`))
							: `${host} removed.`,
				});
				if (action === 'add') {
					setHostname('');
				}
				await reload();
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<fieldset>
				<legend>Your domains</legend>
				<p className="field-hint">Serve this project's API at your own domain, with a certificate we obtain and renew. Paid plans only.</p>
				{loading && <div className="field-hint">Loading…</div>}
				{!loading && data && data.length === 0 && <p className="field-hint">No domains yet.</p>}
				{(data ?? []).map((d) => (
					<div key={d.hostname} className="cloud-domain">
						<div className="cloud-actions">
							<span className="mono">{d.hostname}</span>
							<span className={`env${d.verified ? '' : ' warn'}`}>{d.verified ? "verified" : "not verified"}</span>
							{d.certificate?.state && <span className="muted small">certificate {d.certificate.state}</span>}
							<span className="spacer" />
							{!d.verified && <button type="button" className="table-action" disabled={busy} onClick={() => void act('verify', d.hostname)}><Icon name="verified" /> Verify</button>}
							<button type="button" className="icon-btn" aria-label={`Remove ${d.hostname}`} disabled={busy} onClick={() => void act('remove', d.hostname)}><Icon name="trash" /></button>
						</div>
						{(d.record || d.certificateRecord) && (
							<table className="cloud-table">
								<thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
								<tbody>
									{d.record && <tr><td>{d.record.type}</td><td className="mono">{d.record.name}</td><td className="mono">{d.record.value}</td></tr>}
									{d.certificateRecord && <tr><td>{d.certificateRecord.type}</td><td className="mono">{d.certificateRecord.name}</td><td className="mono">{d.certificateRecord.value}</td></tr>}
									<tr><td>CNAME</td><td className="mono">{d.hostname}</td><td className="mono">{projectRef}.api.snoutdata.com</td></tr>
								</tbody>
							</table>
						)}
						{d.verificationError && !d.verified && <div className="form-status warn">{d.verificationError}</div>}
						{d.certificate?.error && <div className="form-status warn">{d.certificate.error}</div>}
					</div>
				))}
			</fieldset>
			<fieldset>
				<legend>Add a domain</legend>
				<label>Hostname<input value={hostname} placeholder="api.yourcompany.com" onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} /></label>
				<div className="cloud-actions">
					<button type="button" disabled={busy || !hostname} onClick={() => void act('add', hostname)}><Icon name="globe" /> Add domain</button>
				</div>
			</fieldset>
			<Status said={said} />
		</>
	);
}

/** The Database section of a cloud project: the connection in this app, and how to connect from anywhere else. */
export function CloudDatabase({ projectRef, onOpenDatabase }: { projectRef: string; onOpenDatabase(): void }): JSX.Element {
	return <Connection projectRef={projectRef} part="database" onOpenDatabase={onOpenDatabase} />;
}

/** The API keys, on Overview where the cloud dashboard keeps them. */
export function CloudKeys({ projectRef }: { projectRef: string }): JSX.Element {
	return <Connection projectRef={projectRef} part="keys" />;
}

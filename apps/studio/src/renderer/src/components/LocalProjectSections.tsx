/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { localStateLabel } from '../localProjects';
import { prefix, wirePath, type Vocabulary } from '../../../shared/ownLayout';
import { Log, Status, useLoad, useProgressLines, type Said } from './projectUi';
import { PostgresStatements } from './ProjectSections';
import { bytes, platformQuery, query, when } from '../projectSql';
import type {
	LocalActivity, LocalConnectionFacts, LocalCopyTarget, LocalExport, LocalFunctionRow, LocalMailKind, LocalMailTemplate, LocalProjectRow,
	LocalSettings, LocalSettingsChange,
} from '../../../shared/localStack';

// What only a LOCAL project has: Docker and its logs, the folder and its functions, the .env that
// holds its settings, and the gateway's address on this machine. Everything a local project
// shares with a cloud one is in ProjectSections.tsx.
//
// There is no dashboard for a local project: this tab IS its dashboard, so everything the cloud
// dashboard offers a hosted project is here too (custom domains aside), done to the folder and the
// containers rather than through the control plane: the password, the keys, production, exports
// and restores, sign-in providers and redirect addresses, auth's emails, function limits and
// secrets, and an activity log of what was done.

interface SectionProps {
	row: LocalProjectRow;
}

/** The Overview of a local project: state, the numbers, the services, the keys, and what just happened. */
export function LocalOverview(props: { row: LocalProjectRow; onChanged(): Promise<void>; workOnIt: JSX.Element }): JSX.Element {
	const { row } = props;
	return (
		<>
			<LocalRunning row={row} onChanged={props.onChanged} />
			{row.state === 'running' && <AtAGlance row={row} />}
			{row.services.length > 0 && (
				<fieldset>
					<legend>Services</legend>
					<div className="local-services">
						{row.services.map((s) => (
							<div key={s.name} className="local-service static" title={s.oneShot ? "Runs once when the project starts" : undefined}>
								<span className={`cloud-dot ${serviceTone(s)}`} aria-hidden="true" />
								<span className="mono">{s.name}</span>
								<span className="muted small">{s.oneShot ? (s.exitCode === 0 ? "done" : s.state) : s.health || s.state}</span>
							</div>
						))}
					</div>
				</fieldset>
			)}
			{props.workOnIt}
			<ApiAndKeys row={row} />
			<ActivityList projectId={row.id} limit={25} heading="Recent activity" />
		</>
	);
}

/** State with Start and Stop: on Overview, and again under Settings where the cloud keeps "Running". */
function LocalRunning(props: { row: LocalProjectRow; onChanged(): Promise<void> }): JSX.Element {
	const { row } = props;
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	const progress = useProgressLines(row.id);

	async function act(action: 'start' | 'stop'): Promise<void> {
		if (action === 'stop' && row.production) {
			const ok = await confirm({
				title: "Stop a production project?",
				body: "It is marked production. Everything connected to it loses it until it is started again.",
				confirmLabel: "Stop it",
				danger: true,
			});
			if (!ok) {
				return;
			}
		}
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			setSaid(action === 'start' ? await window.sqlApi.local.start(row.id) : await window.sqlApi.local.stop(row.id));
		} finally {
			setBusy(false);
			await props.onChanged();
		}
	}

	const up = row.services.filter((s) => !s.oneShot && s.state === 'running').length;
	const total = row.services.filter((s) => !s.oneShot).length;

	return (
		<fieldset>
			<legend>Status</legend>
			<div className="cloud-facts">
				<span className="muted">State</span><span>{busy ? "working" : localStateLabel(row.state)}{row.production ? ", production" : ''}</span>
				<span className="muted">Services</span><span>{total > 0 ? `${up} of ${total} running` : "not created yet"}</span>
				<span className="muted">API</span><span className="mono">{row.apiUrl}</span>
				<span className="muted">Database</span><span className="mono">127.0.0.1:{row.dbPort}</span>
				<span className="muted">Folder</span><span className="mono">{row.folder}</span>
				<span className="muted">Created</span><span>{new Date(row.createdAt).toLocaleString()}</span>
			</div>
			{row.state === 'missing' && <p className="form-status warn">The folder is gone. Restore it (with its .env) to run this project again, or remove it from the list.</p>}
			{row.state === 'unknown' && <p className="field-hint">Docker is not running, so the state cannot be read. Start Docker, then Start.</p>}
			<div className="cloud-actions">
				<button type="button" disabled={busy || row.state === 'running' || row.state === 'missing'} onClick={() => void act('start')}><Icon name="play" /> Start</button>
				<button type="button" disabled={busy || row.state === 'stopped' || row.state === 'missing' || row.state === 'unknown'} onClick={() => void act('stop')}><Icon name="debug-stop" /> Stop</button>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={row.state === 'missing'} onClick={() => void window.sqlApi.local.openFolder(row.id)}><Icon name="folder-opened" /> Open folder</button>
			</div>
			<Status said={said} />
			<Log lines={progress.lines} />
			{confirmDialog}
		</fieldset>
	);
}

interface Glance {
	dbBytes: string;
	connections: number;
	startedAt: string;
	files: number | null;
	fileBytes: string | null;
}

/** Overview's four numbers, read from the project's own database as the owner. */
function AtAGlance({ row }: SectionProps): JSX.Element | null {
	const target = { kind: 'local' as const, id: row.id };
	const glance = useLoad(async () => {
		const [base] = await query<Omit<Glance, 'files' | 'fileBytes'>>(target, `select pg_database_size(current_database())::text as "dbBytes",
			(select count(*) from pg_stat_activity where datname = current_database())::int as connections,
			pg_postmaster_start_time()::text as "startedAt"`);
		// Storage's table, when there is one: the files' count and size, as the cloud's Storage card shows.
		const files = await platformQuery<{ files: number; fileBytes: string }>(target, `select count(*)::int as files, coalesce(sum((metadata->>'size')::bigint), 0)::text as "fileBytes" from snout_files.files`).catch(() => []);
		return { ...base, files: files[0]?.files ?? null, fileBytes: files[0]?.fileBytes ?? null } as Glance;
	}, [row.id]);
	if (glance.error) {
		return <div className="form-status warn">{glance.error}</div>;
	}
	if (!glance.data) {
		return null;
	}
	const g = glance.data;
	return (
		<div className="local-stats">
			<div className="local-stat"><span className="muted small">Size</span><strong>{bytes(g.dbBytes)}</strong><span className="muted small">the database</span></div>
			<div className="local-stat"><span className="muted small">Connections</span><strong>{g.connections}</strong><span className="muted small">open now</span></div>
			<div className="local-stat"><span className="muted small">Files</span><strong>{g.files === null ? "--" : g.files}</strong><span className="muted small">{g.fileBytes === null ? "storage is not set up" : `${bytes(g.fileBytes)} in storage`}</span></div>
			<div className="local-stat"><span className="muted small">Up since</span><strong>{new Date(g.startedAt).toLocaleDateString()}</strong><span className="muted small">{new Date(g.startedAt).toLocaleTimeString()}</span></div>
		</div>
	);
}

/** The address and the two keys, where the cloud dashboard keeps them: on the project's Overview, with Rotate. */
function ApiAndKeys({ row }: SectionProps): JSX.Element {
	const projectId = row.id;
	const [facts, setFacts] = useState<LocalConnectionFacts | null>(null);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	const progress = useProgressLines(projectId);

	useEffect(() => {
		window.sqlApi.local.facts(projectId).then(setFacts, (e: unknown) => setSaid({ ok: false, message: e instanceof Error ? e.message : String(e) }));
	}, [projectId]);

	async function copy(target: LocalCopyTarget): Promise<void> {
		setSaid(await window.sqlApi.local.copy(projectId, target));
	}

	async function rotate(): Promise<void> {
		const ok = await confirm({
			title: "Rotate the API keys?",
			body: "Both keys are replaced and the services restart with them. Every key already pasted into an app or a secret stops working, and signed-in users sign in again.",
			confirmLabel: "Rotate keys",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			setSaid(await window.sqlApi.local.rotateKeys(projectId));
		} finally {
			setBusy(false);
		}
	}

	if (!facts) {
		return <Status said={said} />;
	}
	return (
		<fieldset>
			<legend>API and keys</legend>
			<div className="cloud-facts">
				<span className="muted">URL</span>
				<span className="cloud-actions"><span className="mono">{facts.apiUrl}</span><span className="spacer" /><button type="button" className="secondary small" onClick={() => void copy('apiUrl')}><Icon name="copy" /> Copy</button></span>
				<span className="muted">App key</span>
				<span className="cloud-actions"><span>Ships in your application. It reaches what your row-level security grants.</span><span className="spacer" /><button type="button" className="secondary small" onClick={() => void copy('appKey')}><Icon name="copy" /> Copy</button></span>
				<span className="muted">Server key</span>
				<span className="cloud-actions"><span>Bypasses row-level security. Keep it on your servers.</span><span className="spacer" /><button type="button" className="secondary small" onClick={() => void copy('serverKey')}><Icon name="copy" /> Copy</button></span>
			</div>
			<table className="cloud-table">
				<tbody>
					{facts.paths.map((p) => (
						<tr key={p.path}><td className="mono">{p.path}</td><td className="muted">{p.what}</td></tr>
					))}
				</tbody>
			</table>
			<div className="cloud-actions">
				<span className="spacer" />
				<button type="button" className="danger" disabled={busy || row.state !== 'running'} title={row.state !== 'running' ? "Start the project first" : undefined} onClick={() => void rotate()}>
					<Icon name="key" /> {busy ? "Rotating…" : "Rotate keys"}
				</button>
			</div>
			<Status said={said} />
			<Log lines={progress.lines} />
			{confirmDialog}
		</fieldset>
	);
}

/** What the app did to the project, newest first: the local stand-in for the cloud's activity log. */
function ActivityList({ projectId, limit, heading }: { projectId: string; limit?: number; heading: string }): JSX.Element {
	const activity = useLoad<LocalActivity[]>(() => window.sqlApi.local.activity(projectId), [projectId]);
	const rows = (activity.data ?? []).slice(0, limit ?? 200);
	// What is done on the same screen (a key copied, a restart) lands here without a click: the log
	// is one small file in main, read again every few seconds while the tab is in view.
	const { reload } = activity;
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void reload();
			}
		}, 4000);
		return () => clearInterval(timer);
	}, [reload]);
	return (
		<fieldset>
			<legend>{heading}</legend>
			{activity.error && <div className="form-status error">{activity.error}</div>}
			{activity.data && rows.length === 0 && <p className="field-hint">Nothing yet. Starting, stopping, settings, keys, exports and deploys are recorded here.</p>}
			{rows.length > 0 && (
				<table className="cloud-table">
					<tbody>
						{rows.map((a, i) => (
							<tr key={`${a.at}-${i}`}>
								<td className="local-nowrap muted">{when(a.at)}</td>
								<td>{a.what}</td>
								<td className="cloud-table-action">{!a.ok && <span className="cloud-dot error" title="It did not finish" />}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="cloud-actions">
				<span className="field-hint">What this app did to the project, on this computer.</span>
				<span className="spacer" />
				<button type="button" className="secondary small" disabled={activity.loading} onClick={() => void activity.reload()}><Icon name="refresh" /> Refresh</button>
			</div>
		</fieldset>
	);
}

/** The project's Postgres: how to reach it, and the connection it already is in this app. */
export function LocalDatabase({ row, onOpenDatabase }: { row: LocalProjectRow; onOpenDatabase(): void }): JSX.Element {
	const [facts, setFacts] = useState<LocalConnectionFacts | null>(null);
	const [said, setSaid] = useState<Said>(null);

	useEffect(() => {
		window.sqlApi.local.facts(row.id).then(setFacts, (e: unknown) => setSaid({ ok: false, message: e instanceof Error ? e.message : String(e) }));
	}, [row.id]);

	async function copy(target: LocalCopyTarget): Promise<void> {
		setSaid(await window.sqlApi.local.copy(row.id, target));
	}

	return (
		<>
			<fieldset>
				<legend>Tables and SQL</legend>
				<p className="field-hint">The database is a connection in your Connections list, marked with the SnoutData butterfly: browse its tables there and open a SQL editor on it.</p>
				<div className="cloud-actions">
					<button type="button" onClick={onOpenDatabase}><Icon name="plug" /> Open in Connections</button>
				</div>
			</fieldset>
			{facts && (
				<fieldset>
					<legend>Connect from anywhere else</legend>
					<div className="cloud-facts">
						<span className="muted">Host</span><span className="mono">{facts.host}</span>
						<span className="muted">Port</span><span className="mono">{facts.port}</span>
						<span className="muted">Database</span><span className="mono">{facts.database}</span>
						<span className="muted">User</span><span className="mono">{facts.user}</span>
					</div>
					<p className="field-hint">This computer only. The owner can do everything in its database, including creating the extensions the image offers, and is not a superuser. A new password is under Settings.</p>
					<div className="cloud-actions">
						<button type="button" className="secondary" onClick={() => void copy('dbPassword')}><Icon name="copy" /> Copy password</button>
						<button type="button" className="secondary" onClick={() => void copy('dbUrl')}><Icon name="copy" /> Copy connection string</button>
					</div>
				</fieldset>
			)}
			<Status said={said} />
		</>
	);
}

function serviceTone(s: LocalProjectRow['services'][number]): string {
	if (s.oneShot) {
		return s.exitCode === 0 ? 'ok' : s.state === 'running' ? 'warn' : 'error';
	}
	if (s.state !== 'running' || s.health === 'unhealthy') {
		return 'error';
	}
	return s.health === 'starting' ? 'warn' : 'ok';
}

// --- the settings in .env, as forms --------------------------------------------------------------

/** The cards a settings form can show; each section of the tab shows the ones that belong to it. */
type SettingsPart = 'network' | 'storage' | 'providers' | 'redirects' | 'signups' | 'mail' | 'functions';

const SECRET_FIELDS = { smtpPass: '', googleSecret: '', githubSecret: '' };

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The project's .env settings as the connection form's kind of form: one card per part, one Save.
 * Saving writes only what changed and `up` recreates only the services it touched.
 */
function LocalSettingsForm({ projectId, vocabulary, parts, onChanged, note }: { projectId: string; vocabulary: Vocabulary; parts: SettingsPart[]; onChanged?(): Promise<void>; note?: string }): JSX.Element {
	const [loaded, setLoaded] = useState<LocalSettings | null>(null);
	const [draft, setDraft] = useState<LocalSettings | null>(null);
	const [secrets, setSecrets] = useState(SECRET_FIELDS);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(projectId);

	const reload = useCallback(async () => {
		try {
			const s = await window.sqlApi.local.settings(projectId);
			setLoaded(s);
			setDraft(s);
		} catch (e) {
			setSaid({ ok: false, message: e instanceof Error ? e.message : String(e) });
		}
	}, [projectId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	if (!draft || !loaded) {
		return <Status said={said} />;
	}

	function set(change: Partial<LocalSettings>): void {
		setDraft((d) => (d ? { ...d, ...change } : d));
	}

	/** Only what differs from what was read, so saving one switch does not rewrite the rest. */
	function changes(): LocalSettingsChange {
		const out: LocalSettingsChange = {};
		if (!draft || !loaded) {
			return out;
		}
		for (const key of Object.keys(draft) as Array<keyof LocalSettings>) {
			if (key !== 'smtpPassSet' && !same(draft[key], loaded[key])) {
				(out as Record<string, unknown>)[key] = draft[key];
			}
		}
		for (const key of Object.keys(secrets) as Array<keyof typeof SECRET_FIELDS>) {
			if (secrets[key]) {
				out[key] = secrets[key];
			}
		}
		return out;
	}

	const pending = Object.keys(changes()).length > 0;

	async function save(): Promise<void> {
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			const outcome = await window.sqlApi.local.saveSettings(projectId, changes());
			setSaid(outcome);
			if (outcome.ok) {
				setSecrets(SECRET_FIELDS);
			}
			await reload();
			await onChanged?.();
		} finally {
			setBusy(false);
		}
	}

	const secretField = (key: keyof typeof SECRET_FIELDS, placeholder: string): JSX.Element => (
		<input type="password" value={secrets[key]} onChange={(e) => setSecrets((s) => ({ ...s, [key]: e.target.value }))} placeholder={placeholder} autoComplete="new-password" />
	);
	// Where a provider sends a person back, in the names this project's gateway serves (shared/ownLayout.ts).
	const callback = `${draft.publicUrl.replace(/\/+$/, '')}${wirePath('/v1/identity/provider/return', vocabulary)}`;

	return (
		<>
			{parts.includes('network') && (
				<fieldset>
					<legend>Network</legend>
					<div className="local-port-grid">
						<label>
							API port
							<input type="number" value={draft.apiPort} onChange={(e) => set({ apiPort: Number(e.target.value) })} />
						</label>
						<label>
							Database port
							<input type="number" value={draft.dbPort} onChange={(e) => set({ dbPort: Number(e.target.value) })} />
						</label>
					</div>
					<label className="check">
						<input type="checkbox" checked={draft.exposeApi} onChange={(e) => set({ exposeApi: e.target.checked })} /> Reachable from other devices on my network
					</label>
					<p className="field-hint">Changing the API port changes the URL your app must use; the keys stay the same.</p>
				</fieldset>
			)}
			{parts.includes('providers') && (
				<fieldset>
					<legend>Sign in with</legend>
					<p className="field-hint">Your own OAuth client from each provider. Register this callback with it, exactly: <span className="mono">{callback}</span></p>
					<label className="check">
						<input type="checkbox" checked={draft.googleEnabled} onChange={(e) => set({ googleEnabled: e.target.checked })} /> Google
					</label>
					{draft.googleEnabled && (
						<>
							<ol className="field-hint local-steps">
								<li>In Google Cloud console, APIs and Services, Credentials: create an OAuth client ID of type Web application.</li>
								<li>Add the callback above to its authorised redirect URIs.</li>
								<li>Paste its client ID and secret here, and save.</li>
							</ol>
							<label>
								Client ID
								<input value={draft.googleClientId} onChange={(e) => set({ googleClientId: e.target.value })} placeholder="1234567890-abc.apps.googleusercontent.com" />
							</label>
							<label>
								Client secret
								{secretField('googleSecret', "Stored when set. Type to set or replace it.")}
							</label>
						</>
					)}
					<label className="check">
						<input type="checkbox" checked={draft.githubEnabled} onChange={(e) => set({ githubEnabled: e.target.checked })} /> GitHub
					</label>
					{draft.githubEnabled && (
						<>
							<p className="field-hint">In GitHub, Settings, Developer settings, OAuth Apps: a new app with the callback above as its authorization callback URL.</p>
							<label>
								Client ID
								<input value={draft.githubClientId} onChange={(e) => set({ githubClientId: e.target.value })} />
							</label>
							<label>
								Client secret
								{secretField('githubSecret', "Stored when set. Type to set or replace it.")}
							</label>
						</>
					)}
				</fieldset>
			)}
			{parts.includes('redirects') && (
				<fieldset>
					<legend>Redirect addresses</legend>
					<label>
						Site URL
						<input value={draft.siteUrl} onChange={(e) => set({ siteUrl: e.target.value })} placeholder="http://localhost:3000" />
					</label>
					<p className="field-hint">Where users land after signing in, confirming their email or resetting a password, when no other address is asked for.</p>
					<label>
						Additional redirect addresses
						<textarea rows={4} value={draft.redirectUrls.join('\n')} onChange={(e) => set({ redirectUrls: e.target.value.split('\n') })} placeholder={'http://localhost:5173\nhttps://staging.example.com'} spellCheck={false} />
					</label>
					<p className="field-hint">One per line. Only these, and the site URL, are allowed as a sign-in's destination.</p>
				</fieldset>
			)}
			{parts.includes('signups') && (
				<fieldset>
					<legend>Sign-ups</legend>
					<label className="check">
						<input type="checkbox" checked={draft.autoconfirm} onChange={(e) => set({ autoconfirm: e.target.checked })} /> Confirm new users without an email
					</label>
					<label className="check">
						<input type="checkbox" checked={draft.disableSignup} onChange={(e) => set({ disableSignup: e.target.checked })} /> Refuse new sign-ups
					</label>
				</fieldset>
			)}
			{parts.includes('mail') && (
				<fieldset>
					<legend>Mail server</legend>
					<p className="field-hint">The server auth sends its emails through. A hosted project has one already; a local one uses yours.</p>
					<div className="local-port-grid">
						<label>
							Server
							<input value={draft.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} placeholder="smtp.example.com" />
						</label>
						<label>
							Port
							<input type="number" value={draft.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) })} />
						</label>
					</div>
					<label>
						User
						<input value={draft.smtpUser} onChange={(e) => set({ smtpUser: e.target.value })} autoComplete="off" />
					</label>
					<label>
						Password
						{secretField('smtpPass', loaded.smtpPassSet ? "Set. Type to replace it." : '')}
					</label>
					<label>
						Send from
						<input value={draft.smtpAdminEmail} onChange={(e) => set({ smtpAdminEmail: e.target.value })} />
					</label>
					<label>
						Sender name
						<input value={draft.smtpSenderName} onChange={(e) => set({ smtpSenderName: e.target.value })} />
					</label>
				</fieldset>
			)}
			{parts.includes('storage') && (
				<fieldset>
					<legend>Storage</legend>
					<label>
						Largest upload, in MB
						<input type="number" min={1} value={draft.fileSizeLimitMb} onChange={(e) => set({ fileSizeLimitMb: Number(e.target.value) })} />
					</label>
				</fieldset>
			)}
			{parts.includes('functions') && (
				<fieldset>
					<legend>Memory and time</legend>
					<div className="local-port-grid">
						<label>
							Memory per function, MB
							<input type="number" min={64} max={4096} value={draft.functionsMemoryMb} onChange={(e) => set({ functionsMemoryMb: Number(e.target.value) })} />
						</label>
						<label>
							Shared by all of them, MB
							<input type="number" min={256} value={draft.functionsContainerMb} onChange={(e) => set({ functionsContainerMb: Number(e.target.value) })} />
						</label>
						<label>
							Longest call, seconds
							<input type="number" min={1} max={3600} value={Math.round(draft.functionsWallMs / 1000)} onChange={(e) => set({ functionsWallMs: Number(e.target.value) * 1000 })} />
						</label>
						<label>
							CPU time per call, ms
							<input type="number" min={100} max={600000} value={draft.functionsCpuMs} onChange={(e) => set({ functionsCpuMs: Number(e.target.value) })} />
						</label>
					</div>
					<p className="field-hint">
						Each request runs in its own isolate with the memory above. They share the functions container's memory, so about{' '}
						{Math.max(1, Math.floor(draft.functionsContainerMb / Math.max(1, draft.functionsMemoryMb)))} run at full size at once; past 85% of it the runtime stops idle ones first.
					</p>
				</fieldset>
			)}
			{note && <p className="field-hint">{note}</p>}
			<Status said={said} />
			<Log lines={progress.lines} />
			<div className="modal-actions">
				<button type="button" className="secondary" disabled={busy || !pending} onClick={() => { setDraft(loaded); setSecrets(SECRET_FIELDS); }}><Icon name="discard" /> Discard</button>
				<span className="spacer" />
				<button type="button" disabled={busy || !pending} onClick={() => void save()}><Icon name="save" /> {busy ? "Applying…" : "Save and restart"}</button>
			</div>
		</>
	);
}

// --- Settings ------------------------------------------------------------------------------------

/** Settings, as the cloud dashboard has them: password, production, running, export, put it back, network, remove. */
export function LocalSettingsSection({ row, onChanged, onRemoved }: { row: LocalProjectRow; onChanged(): Promise<void>; onRemoved(): void }): JSX.Element {
	return (
		<>
			<LocalPassword row={row} />
			<LocalProduction row={row} onChanged={onChanged} />
			<LocalRunning row={row} onChanged={onChanged} />
			<LocalBackups row={row} />
			<LocalSettingsForm projectId={row.id} vocabulary={row.vocabulary} parts={['network', 'storage']} onChanged={onChanged} note="Saving writes the project's .env and restarts only the services the change touches." />
			<LocalRemove row={row} onRemoved={onRemoved} />
		</>
	);
}

function LocalPassword({ row }: SectionProps): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();

	async function reset(): Promise<void> {
		const ok = await confirm({
			title: "Reset the password?",
			body: "A new password is set for the database's owner and written into .env. Your connections in this app are updated; anything else that connects needs the new one.",
			confirmLabel: "Reset password",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			setSaid(await window.sqlApi.local.resetPassword(row.id));
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Password</legend>
			<p className="field-hint">A reset draws a new password for <span className="mono">{row.ref}_owner</span> and stores it in the project's .env, its only copy. Sessions already open keep going.</p>
			<div className="cloud-actions">
				<button type="button" disabled={busy || row.state !== 'running'} title={row.state !== 'running' ? "Start the project first" : undefined} onClick={() => void reset()}>
					<Icon name="key" /> {busy ? "Resetting…" : "Reset the password"}
				</button>
				<button type="button" className="secondary" onClick={() => void window.sqlApi.local.copy(row.id, 'dbPassword').then(setSaid)}><Icon name="copy" /> Copy password</button>
			</div>
			<Status said={said} />
			{confirmDialog}
		</fieldset>
	);
}

function LocalProduction({ row, onChanged }: { row: LocalProjectRow; onChanged(): Promise<void> }): JSX.Element {
	const [said, setSaid] = useState<Said>(null);
	const [confirm, confirmDialog] = useConfirm();

	async function change(on: boolean): Promise<void> {
		if (!on) {
			const ok = await confirm({
				title: "Stop treating this as production?",
				body: "Statements that change its data run without asking first, and Stop no longer asks.",
				confirmLabel: "Not production",
			});
			if (!ok) {
				return;
			}
		}
		setSaid(await window.sqlApi.local.setProduction(row.id, on));
		await onChanged();
	}

	return (
		<fieldset>
			<legend>Production</legend>
			<p className="field-hint">A production project's connection carries the production guard, so anything run on it that changes it asks you to confirm first, and stopping it asks too.</p>
			<label className="check">
				<input type="checkbox" checked={row.production} onChange={(e) => void change(e.target.checked)} /> Treat this as production
			</label>
			<Status said={said} />
			{confirmDialog}
		</fieldset>
	);
}

/** Export, and Put it back: the cloud's backups, as files in the project's own backups folder. */
function LocalBackups({ row }: SectionProps): JSX.Element {
	const list = useLoad<LocalExport[]>(() => window.sqlApi.local.exports(row.id), [row.id]);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState<'export' | 'restore' | null>(null);
	const [chosen, setChosen] = useState('');
	const [confirm, confirmDialog] = useConfirm();
	const progress = useProgressLines(row.id);
	const running = row.state === 'running';
	const exports = list.data ?? [];
	const pick = chosen || exports[0]?.name || '';

	async function exportNow(): Promise<void> {
		setBusy('export');
		setSaid(null);
		try {
			setSaid(await window.sqlApi.local.exportNow(row.id));
			await list.reload();
		} finally {
			setBusy(null);
		}
	}

	async function restore(): Promise<void> {
		const ok = await confirm({
			title: "Put the database back?",
			body: `The database is replaced by ${pick}: everything written since it was taken is gone. The services stop while it runs. Files in storage are not touched.`,
			confirmLabel: "Put it back",
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy('restore');
		setSaid(null);
		progress.clear();
		try {
			setSaid(await window.sqlApi.local.restore(row.id, pick));
		} finally {
			setBusy(null);
		}
	}

	return (
		<>
			<fieldset>
				<legend>Export</legend>
				<p className="field-hint">A <span className="mono">pg_dump</span> of the whole database in the custom format, which <span className="mono">pg_restore</span> reads, kept in the project's backups folder. It is taken from the running database, so nothing stops while it runs.</p>
				{list.error && <div className="form-status error">{list.error}</div>}
				{exports.length > 0 && (
					<table className="cloud-table">
						<tbody>
							{exports.map((e) => (
								<tr key={e.name}>
									<td className="mono">{e.name}</td>
									<td>{bytes(e.bytes)}</td>
									<td className="muted cloud-when">{when(e.at)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="cloud-actions">
					<button type="button" disabled={busy !== null || !running} title={running ? undefined : "Start the project first"} onClick={() => void exportNow()}>
						<Icon name="export" /> {busy === 'export' ? "Exporting…" : exports.length > 0 ? "Export again" : "Export"}
					</button>
					<button type="button" className="secondary" onClick={() => void window.sqlApi.local.openExports(row.id)}><Icon name="folder-opened" /> Show in folder</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>Put it back</legend>
				{exports.length === 0 && <p className="field-hint">Nothing to put back to yet. Take an export first; each one is a moment this project can return to.</p>}
				{exports.length > 0 && (
					<>
						<p className="field-hint">Replaces this project's database with an export. A local project has no room beside it, so unlike a hosted restore this goes over the original: take an export first if you may want today back.</p>
						<label>
							Export
							<select value={pick} onChange={(e) => setChosen(e.target.value)}>
								{exports.map((e) => <option key={e.name} value={e.name}>{e.name} ({when(e.at)})</option>)}
							</select>
						</label>
						<div className="cloud-actions">
							<button type="button" className="danger" disabled={busy !== null || !running || !pick} title={running ? undefined : "Start the project first"} onClick={() => void restore()}>
								<Icon name="history" /> {busy === 'restore' ? "Putting it back…" : "Put it back"}
							</button>
						</div>
					</>
				)}
				<Log lines={progress.lines} />
			</fieldset>
			<Status said={said} />
			{confirmDialog}
		</>
	);
}

/** Take a local project off the list, and its data and folder only when asked for. Settings, like the dashboard's Delete. */
function LocalRemove(props: { row: LocalProjectRow; onRemoved(): void }): JSX.Element {
	const { row } = props;
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [deleteData, setDeleteData] = useState(false);
	const [deleteFolder, setDeleteFolder] = useState(false);

	async function remove(): Promise<void> {
		setBusy(true);
		try {
			const outcome = await window.sqlApi.local.remove(row.id, { deleteData, deleteFolder: deleteData && deleteFolder });
			setSaid(outcome);
			if (outcome.ok) {
				props.onRemoved();
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<fieldset>
				<legend>Remove</legend>
				{!removing && (
					<>
						<p className="field-hint">Stops the project and takes it off the list. Its data and folder are kept unless you say otherwise.</p>
						<div className="cloud-actions">
							<button type="button" className="danger" disabled={busy} onClick={() => setRemoving(true)}><Icon name="trash" /> Remove project…</button>
						</div>
					</>
				)}
				{removing && (
					<>
						<label className="check">
							<input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /> Also delete its data (the database and the files)
						</label>
						<p className="field-hint">This cannot be undone. Without it, the Docker volumes stay, and setting the folder up again brings the data back.</p>
						{deleteData && (
							<label className="check">
								<input type="checkbox" checked={deleteFolder} onChange={(e) => setDeleteFolder(e.target.checked)} /> And delete the folder, .env, exports and functions included
							</label>
						)}
						<div className="cloud-actions">
							<button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(false)}><Icon name="close" /> Cancel</button>
							<span className="spacer" />
							<button type="button" className="danger" disabled={busy} onClick={() => void remove()}><Icon name="trash" /> {deleteData ? "Remove and delete data" : "Remove from the list"}</button>
						</div>
					</>
				)}
			</fieldset>
			<Status said={said} />
		</>
	);
}

// --- Auth ----------------------------------------------------------------------------------------

/** Auth's settings, as the dashboard's Auth tab has them: providers, redirects, sign-ups, mail and its templates. */
export function LocalAuthSettings({ row }: SectionProps): JSX.Element {
	return (
		<>
			<LocalSettingsForm projectId={row.id} vocabulary={row.vocabulary} parts={['providers', 'redirects', 'signups', 'mail']} note="Saving writes the project's .env and restarts auth." />
			<LocalMailTemplates row={row} />
		</>
	);
}

const MAIL_NAMES: Record<LocalMailKind, string> = {
	confirmation: "Email confirmation",
	invite: "Invitation",
	magic_link: "Magic link",
	email_change: "Email change",
	recovery: "Password reset",
};

const MAIL_SAMPLES: Record<string, string> = {
	ConfirmationURL: 'https://example.com/confirm',
	Token: '123456',
	TokenHash: 'a1b2c3',
	SiteURL: 'https://app.example.com',
	Email: 'ada@example.com',
	NewEmail: 'ada@new.example.com',
	RedirectTo: 'https://app.example.com/welcome',
};

/** The email as a mail client shows it: the sample values filled in, on a mail client's own white page. */
function previewDoc(body: string): string {
	const filled = body.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (whole, name: string) => MAIL_SAMPLES[name] ?? whole);
	return `<!doctype html><meta charset="utf-8"><style>html{color-scheme:light}body{font-family:system-ui,sans-serif}</style>${filled}`;
}

function LocalMailTemplates({ row }: SectionProps): JSX.Element {
	const list = useLoad<LocalMailTemplate[]>(() => window.sqlApi.local.mailTemplates(row.id), [row.id]);
	const [editing, setEditing] = useState<LocalMailTemplate | null>(null);
	const [subject, setSubject] = useState('');
	const [body, setBody] = useState('');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(row.id);
	const own = (list.data ?? []).filter((t) => t.custom).length;

	function open(t: LocalMailTemplate): void {
		setEditing(t);
		setSubject(t.subject);
		setBody(t.body);
		setSaid(null);
	}

	async function save(template: { subject: string; body: string } | null): Promise<void> {
		if (!editing) {
			return;
		}
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			const outcome = await window.sqlApi.local.saveMailTemplate(row.id, editing.kind, template);
			setSaid(outcome);
			if (outcome.ok) {
				setEditing(null);
				await list.reload();
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Email templates</legend>
			<p className="field-hint">The account emails auth sends. {own === 0 ? "All five are auth's own." : `${own} of 5 are your own.`} They go out through the mail server above.</p>
			{list.error && <div className="form-status error">{list.error}</div>}
			{!editing && list.data && (
				<table className="cloud-table">
					<tbody>
						{list.data.map((t) => (
							<tr key={t.kind}>
								<td>{MAIL_NAMES[t.kind]}</td>
								<td className="muted">{t.subject}</td>
								<td className="muted">{t.custom ? "Yours" : ''}</td>
								<td className="cloud-table-action"><button type="button" className="table-action" onClick={() => open(t)}><Icon name="edit" /> Edit</button></td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{editing && (
				<>
					<h4 className="local-subhead">{MAIL_NAMES[editing.kind]}</h4>
					<label>
						Subject
						<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
					</label>
					<div className="local-mail-panes">
						<label>
							HTML
							<textarea className="mono local-mail-body" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
						</label>
						<label>
							Preview
							<iframe className="local-mail-preview" title="Preview" sandbox="" srcDoc={previewDoc(body)} />
						</label>
					</div>
					<p className="field-hint">
						Variables: <span className="mono">{'{{ .ConfirmationURL }}'}</span> (required: the link your user clicks), <span className="mono">{'{{ .Token }}'}</span>, <span className="mono">{'{{ .SiteURL }}'}</span>, <span className="mono">{'{{ .Email }}'}</span>
						{editing.kind === 'email_change' && <>, <span className="mono">{'{{ .NewEmail }}'}</span></>}. Saving restarts auth.
					</p>
					<div className="cloud-actions">
						{editing.custom && <button type="button" className="secondary" disabled={busy} onClick={() => void save(null)}><Icon name="discard" /> Go back to auth's own</button>}
						<span className="spacer" />
						<button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}><Icon name="close" /> Cancel</button>
						<button type="button" disabled={busy || !subject.trim() || !body.trim()} onClick={() => void save({ subject, body })}><Icon name="save" /> {busy ? "Saving…" : "Save"}</button>
					</div>
				</>
			)}
			<Status said={said} />
			<Log lines={progress.lines} />
		</fieldset>
	);
}

// --- Functions -----------------------------------------------------------------------------------

export function LocalFunctions({ row }: SectionProps): JSX.Element {
	const [list, setList] = useState<LocalFunctionRow[] | null>(null);
	const settings = useLoad<LocalSettings>(() => window.sqlApi.local.settings(row.id), [row.id]);
	const [name, setName] = useState('');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(row.id);

	const reload = useCallback(async () => {
		setList(await window.sqlApi.local.functions(row.id));
	}, [row.id]);

	useEffect(() => {
		void reload();
	}, [reload]);

	async function create(): Promise<void> {
		const outcome = await window.sqlApi.local.newFunction(row.id, name.trim());
		setSaid(outcome);
		if (outcome.ok) {
			setName('');
			await reload();
		}
	}

	async function deploy(): Promise<void> {
		setBusy(true);
		progress.clear();
		try {
			setSaid(await window.sqlApi.local.deployFunctions(row.id));
		} finally {
			setBusy(false);
		}
	}

	/** Callable with no API key: the gateway's list, so a webhook's receiver can be reached. */
	async function setKeyless(fn: string, keyless: boolean): Promise<void> {
		const current = settings.data?.functionsNoVerify ?? [];
		const next = keyless ? [...current.filter((n) => n !== fn), fn] : current.filter((n) => n !== fn);
		setBusy(true);
		progress.clear();
		try {
			setSaid(await window.sqlApi.local.saveSettings(row.id, { functionsNoVerify: next }));
			await settings.reload();
		} finally {
			setBusy(false);
		}
	}

	const keyless = new Set(settings.data?.functionsNoVerify ?? []);

	return (
		<>
			<fieldset>
				<legend>Your functions</legend>
				<p className="field-hint">A function is a folder: functions/&lt;name&gt;/index.ts in the project's folder, served at {prefix('fn', row.vocabulary)}/&lt;name&gt;. Edit them in your own editor, then deploy.</p>
				{list && list.length === 0 && <p className="field-hint">None yet.</p>}
				{list && list.length > 0 && (
					<table className="cloud-table">
						<tbody>
							{list.map((f) => (
								<tr key={f.name}>
									<td className="mono">{f.name}</td>
									<td className="mono muted">{f.url}</td>
									<td>
										<label className="check local-inline-check" title="Callable with no API key, for a webhook's receiver. The function checks its caller itself.">
											<input type="checkbox" checked={keyless.has(f.name)} disabled={busy || !settings.data} onChange={(e) => void setKeyless(f.name, e.target.checked)} /> No key needed
										</label>
									</td>
									<td className="cloud-table-action">
										<button type="button" className="table-action" onClick={() => void window.sqlApi.local.openFolder(row.id, f.name)}><Icon name="folder-opened" /> Open</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="cloud-actions">
					<button type="button" disabled={busy || row.state !== 'running'} title={row.state !== 'running' ? "Start the project first" : undefined} onClick={() => void deploy()}>
						<Icon name="cloud-upload" /> {busy ? "Working…" : "Deploy functions"}
					</button>
					<button type="button" className="secondary" onClick={() => void window.sqlApi.local.openFolder(row.id)}><Icon name="folder-opened" /> Open folder</button>
				</div>
				<Status said={said} />
				<Log lines={progress.lines} />
			</fieldset>
			<fieldset>
				<legend>New function</legend>
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="send-welcome" maxLength={63} />
				</label>
				<p className="field-hint">Creates functions/{name.trim() || "<name>"}/index.ts from a template.</p>
				<div className="cloud-actions">
					<button type="button" disabled={!name.trim()} onClick={() => void create()}><Icon name="add" /> Create</button>
				</div>
			</fieldset>
			<FunctionSecrets row={row} />
			<LocalSettingsForm projectId={row.id} vocabulary={row.vocabulary} parts={['functions']} note="Saving restarts the functions runtime with the new limits." />
		</>
	);
}

/** Secrets for functions: functions/.env, names listed, values never read back. */
function FunctionSecrets({ row }: SectionProps): JSX.Element {
	const names = useLoad<string[]>(() => window.sqlApi.local.functionSecrets(row.id), [row.id]);
	const [name, setName] = useState('');
	const [value, setValue] = useState('');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(row.id);
	const running = row.state === 'running';

	async function set(target: string, next: string | null): Promise<void> {
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			const outcome = await window.sqlApi.local.setFunctionSecret(row.id, target, next);
			setSaid(outcome);
			if (outcome.ok && next !== null) {
				setName('');
				setValue('');
			}
			await names.reload();
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Secrets</legend>
			<p className="field-hint">Environment variables for every function, kept in functions/.env (not in git). Values are never shown again; setting one deploys the functions with it.</p>
			{names.data && names.data.length > 0 && (
				<table className="cloud-table">
					<tbody>
						{names.data.map((n) => (
							<tr key={n}>
								<td className="mono">{n}</td>
								<td className="cloud-table-action"><button type="button" className="table-action is-danger" disabled={busy || !running} onClick={() => void set(n, null)}><Icon name="trash" /> Remove</button></td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="local-port-grid">
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="STRIPE_KEY" spellCheck={false} />
				</label>
				<label>
					Value
					<input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
				</label>
			</div>
			<div className="cloud-actions">
				<button type="button" disabled={busy || !running || !name.trim() || !value} title={running ? undefined : "Start the project first"} onClick={() => void set(name.trim(), value)}><Icon name="lock" /> {busy ? "Saving…" : "Set secret"}</button>
			</div>
			<Status said={said} />
			<Log lines={progress.lines} />
		</fieldset>
	);
}

/** Push is a SnoutData Cloud service the self-hosted stack does not run, and the section says so plainly. */
export function LocalPush(): JSX.Element {
	return (
		<fieldset>
			<legend>Push notifications</legend>
			<p>Snout Push sends notifications to iPhone, Android and the web from one API, with the device registry and delivery log in your own database.</p>
			<p className="field-hint">
				It is not part of the self-hosted stack yet: the local gateway has no /push/v1 and no sender runs beside it. Push runs on
				SnoutData Cloud projects today.
			</p>
		</fieldset>
	);
}

// --- Logs ----------------------------------------------------------------------------------------

/** Logs, locally: every service's own Docker log, Postgres's statements like a cloud project's, and the activity log. */
export function LocalLogs({ row }: SectionProps): JSX.Element {
	const services = row.services.map((s) => s.name);
	const [source, setSource] = useState<string>('all');
	const [text, setText] = useState('');
	const [loading, setLoading] = useState(false);
	const [follow, setFollow] = useState(false);
	const ref = useRef<HTMLPreElement | null>(null);
	const special = source === 'postgres' || source === 'activity';

	async function load(): Promise<void> {
		if (special) {
			return;
		}
		setLoading(true);
		try {
			setText(await window.sqlApi.local.logs(row.id, source === 'all' ? null : source));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, row.id]);

	useEffect(() => {
		if (!follow || special) {
			return;
		}
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [follow, source]);

	useEffect(() => {
		ref.current?.scrollTo({ top: ref.current.scrollHeight });
	}, [text]);

	return (
		<>
			<fieldset>
				<legend>Source</legend>
				<div className="local-chips">
					{[['activity', "Activity"], ['all', "Every service"], ...services.map((s) => [s, s]), ['postgres', "Postgres statements"]].map(([id, label]) => (
						<button key={id} type="button" className={`local-chip${source === id ? ' selected' : ''}`} onClick={() => setSource(id)}>{label}</button>
					))}
				</div>
			</fieldset>
			{source === 'activity' && <ActivityList projectId={row.id} heading="Activity" />}
			{source === 'postgres' && <PostgresStatements target={{ kind: 'local', id: row.id }} />}
			{!special && (
				<fieldset>
					<legend>{source === 'all' ? "Every service" : source}</legend>
					<div className="cloud-actions">
						<span className="field-hint">The last 300 lines, straight from Docker.</span>
						<span className="spacer" />
						<label className="check local-inline-check">
							<input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
						</label>
						<button type="button" className="secondary" disabled={loading} onClick={() => void load()}>
							<Icon name={loading ? 'loading' : 'refresh'} className={loading ? 'codicon-modifier-spin' : ''} /> Refresh
						</button>
					</div>
					<pre className="local-log tall" ref={ref}>{text || (loading ? "Reading…" : "Nothing logged.")}</pre>
				</fieldset>
			)}
		</>
	);
}

/** The data API switch, locally: the `rest` container's compose profile (main/localStack/plan.ts). */
export function LocalDataApiSwitch({ row }: SectionProps): JSX.Element {
	const state = useLoad(() => window.sqlApi.local.dataApi(row.id), [row.id]);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(row.id);

	async function change(on: boolean): Promise<void> {
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			setSaid(await window.sqlApi.local.setDataApi(row.id, on));
			await state.reload();
		} finally {
			setBusy(false);
		}
	}

	if (state.error) {
		return <div className="form-status error">{state.error}</div>;
	}
	if (!state.data) {
		return <div className="field-hint">Loading…</div>;
	}
	const restUp = row.services.some((s) => s.name === 'rest' && s.state === 'running');
	return (
		<fieldset>
			<legend>Data API</legend>
			<label className="check">
				<input type="checkbox" checked={state.data.on} disabled={busy || !state.data.switchable} onChange={(e) => void change(e.target.checked)} /> {state.data.on ? "On" : "Off"}
			</label>
			<p className="field-hint">
				{state.data.on
					? `Your tables are served over HTTP${row.state === 'running' && !restUp ? " once the project is started" : ''}, with row-level security deciding what each key and user can reach. Off, ${prefix('data', row.vocabulary)} and ${prefix('graph', row.vocabulary)} refuse, and the database, auth, storage and the rest keep running.`
					: `Off: ${prefix('data', row.vocabulary)} and ${prefix('graph', row.vocabulary)} refuse. Switch it on to call your tables over HTTP from an app.`}
			</p>
			{!state.data.switchable && <p className="form-status warn">This project has a compose.override.yaml of your own, so the app leaves the data API to it.</p>}
			<Status said={said} />
			<Log lines={progress.lines} />
		</fieldset>
	);
}

const ADDRESS_HEADERS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: '', label: "None (the gateway is reached directly)" },
	{ value: 'x-real-ip', label: "x-real-ip (nginx, Caddy)" },
	{ value: 'x-forwarded-for', label: "x-forwarded-for" },
	{ value: 'cf-connecting-ip', label: "cf-connecting-ip (Cloudflare)" },
];

export function LocalDomains({ row }: SectionProps): JSX.Element {
	const settings = useLoad(() => window.sqlApi.local.settings(row.id), [row.id]);
	const [url, setUrl] = useState<string | null>(null);
	const [header, setHeader] = useState<string | null>(null);
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(row.id);

	if (settings.error) {
		return <div className="form-status error">{settings.error}</div>;
	}
	if (!settings.data) {
		return <div className="field-hint">Loading…</div>;
	}
	const s = settings.data;
	const address = url ?? s.publicUrl;
	const proxyHeader = header ?? s.clientAddressHeader;
	const changed = address.trim() !== s.publicUrl || proxyHeader !== s.clientAddressHeader;
	// The snippet names the domain being set up; until one is typed, an example rather than localhost.
	const typed = /^https?:\/\/([^/:]+)/.exec(address.trim())?.[1] ?? '';
	const host = !typed || /^(localhost|[\d.]+)$/.test(typed) ? 'api.example.com' : typed;

	async function save(): Promise<void> {
		setBusy(true);
		setSaid(null);
		progress.clear();
		try {
			setSaid(await window.sqlApi.local.saveSettings(row.id, { publicUrl: address.trim(), clientAddressHeader: proxyHeader }));
			setUrl(null);
			setHeader(null);
			await settings.reload();
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<fieldset>
				<legend>Public address</legend>
				<p className="field-hint">Where clients reach this project. Auth puts it in every sign-in, confirmation and OAuth link, so it must be the address your users' browsers can open.</p>
				<label>
					Address
					<input value={address} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com" />
				</label>
				<p className="field-hint">http://localhost:{s.apiPort} on this computer, http://&lt;this computer's IP&gt;:{s.apiPort} for a phone on your network (switch on "Reachable from other devices" in Settings), or an https:// domain with a TLS proxy in front.</p>
				<label>
					The proxy writes the caller's address into
					<select value={proxyHeader} onChange={(e) => setHeader(e.target.value)}>
						{ADDRESS_HEADERS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
					</select>
				</label>
				<p className="field-hint">Behind a proxy, auth's per-caller limits must see callers and not the proxy.</p>
				<Status said={said} />
				<Log lines={progress.lines} />
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" disabled={busy || !changed} onClick={() => void save()}><Icon name="save" /> {busy ? "Applying…" : "Save and restart"}</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>Serving it from your own domain</legend>
				<p className="field-hint">Point the domain's DNS at this machine, run a TLS proxy on 443 in front of the gateway, and set the address above. With Caddy, which fetches the certificate itself, the whole configuration is:</p>
				<pre className="local-snippet">{`${host} {
	reverse_proxy 127.0.0.1:${s.apiPort} {
		header_up X-Real-IP {remote_host}
	}
}`}</pre>
				<p className="field-hint">Then choose x-real-ip above, and keep "Reachable from other devices" off in Settings so only the proxy reaches the gateway. Realtime needs the proxy to pass WebSocket upgrades, which Caddy does by default.</p>
			</fieldset>
		</>
	);
}

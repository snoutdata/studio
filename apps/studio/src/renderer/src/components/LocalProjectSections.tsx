/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { localStateLabel } from '../localProjects';
import { prefix, wirePath, type Vocabulary } from '../../../shared/ownLayout';
import { Log, Status, useLoad, useProgressLines, type Said, mono } from './projectUi';
import { PostgresStatements } from './ProjectSections';
import { bytes, platformQuery, query, when } from '../projectSql';
import { formatLocale, t, useT } from '../i18n';
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
	const t = useT();
	const { row } = props;
	return (
		<>
			<LocalRunning row={row} onChanged={props.onChanged} />
			{row.state === 'running' && <AtAGlance row={row} />}
			{row.services.length > 0 && (
				<fieldset>
					<legend>{t('localProjects.overview.services')}</legend>
					<div className="local-services">
						{row.services.map((s) => (
							<div key={s.name} className="local-service static" title={s.oneShot ? t('localProjects.overview.runsOnce') : undefined}>
								<span className={`cloud-dot ${serviceTone(s)}`} aria-hidden="true" />
								<span className="mono">{s.name}</span>
								<span className="muted small">{s.oneShot ? (s.exitCode === 0 ? t('localProjects.overview.done') : s.state) : s.health || s.state}</span>
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
	const t = useT();
	const { row } = props;
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	const progress = useProgressLines(row.id);

	async function act(action: 'start' | 'stop'): Promise<void> {
		if (action === 'stop' && row.production) {
			const ok = await confirm({
				title: t('localProjects.prod.stopTitle'),
				body: t('localProjects.prod.stopBody'),
				confirmLabel: t('localProjects.prod.stopIt'),
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
			<legend>{t('projects.common.status')}</legend>
			<div className="cloud-facts">
				<span className="muted">{t('localProjects.running.state')}</span><span>{busy ? t('localProjects.running.working') : localStateLabel(row.state)}{row.production ? t('localProjects.running.prodSuffix') : ''}</span>
				<span className="muted">{t('localProjects.overview.services')}</span><span>{total > 0 ? t('localProjects.running.servicesUp', { up, total }) : t('localProjects.running.notCreated')}</span>
				<span className="muted">API</span><span className="mono">{row.apiUrl}</span>
				<span className="muted">{t('localProjects.common.database')}</span><span className="mono">127.0.0.1:{row.dbPort}</span>
				<span className="muted">{t('localProjects.common.folder')}</span><span className="mono">{row.folder}</span>
				<span className="muted">{t('projects.common.created')}</span><span>{new Date(row.createdAt).toLocaleString(formatLocale())}</span>
			</div>
			{row.state === 'missing' && <p className="form-status warn">{t('localProjects.running.folderGone')}</p>}
			{row.state === 'unknown' && <p className="field-hint">{t('localProjects.running.dockerDown')}</p>}
			<div className="cloud-actions">
				<button type="button" disabled={busy || row.state === 'running' || row.state === 'missing'} onClick={() => void act('start')}><Icon name="play" /> {t('localProjects.common.start')}</button>
				<button type="button" disabled={busy || row.state === 'stopped' || row.state === 'missing' || row.state === 'unknown'} onClick={() => void act('stop')}><Icon name="debug-stop" /> {t('localProjects.common.stop')}</button>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={row.state === 'missing'} onClick={() => void window.sqlApi.local.openFolder(row.id)}><Icon name="folder-opened" /> {t('localProjects.running.openFolder')}</button>
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
	const t = useT();
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
			<div className="local-stat"><span className="muted small">{t('projects.common.size')}</span><strong>{bytes(g.dbBytes)}</strong><span className="muted small">{t('localProjects.glance.theDatabase')}</span></div>
			<div className="local-stat"><span className="muted small">{t('localProjects.glance.connections')}</span><strong>{g.connections}</strong><span className="muted small">{t('localProjects.glance.openNow')}</span></div>
			<div className="local-stat"><span className="muted small">{t('localProjects.common.files')}</span><strong>{g.files === null ? "--" : g.files}</strong><span className="muted small">{g.fileBytes === null ? t('localProjects.glance.storageNotSet') : t('localProjects.glance.inStorage', { size: bytes(g.fileBytes) })}</span></div>
			<div className="local-stat"><span className="muted small">{t('localProjects.glance.upSince')}</span><strong>{new Date(g.startedAt).toLocaleDateString(formatLocale())}</strong><span className="muted small">{new Date(g.startedAt).toLocaleTimeString(formatLocale())}</span></div>
		</div>
	);
}

/** The address and the two keys, where the cloud dashboard keeps them: on the project's Overview, with Rotate. */
function ApiAndKeys({ row }: SectionProps): JSX.Element {
	const t = useT();
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
			title: t('localProjects.keys.rotateTitle'),
			body: t('localProjects.keys.rotateBody'),
			confirmLabel: t('projects.common.rotateKeys'),
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
			<legend>{t('localProjects.keys.title')}</legend>
			<div className="cloud-facts">
				<span className="muted">URL</span>
				<span className="cloud-actions"><span className="mono">{facts.apiUrl}</span><span className="spacer" /><button type="button" className="secondary small" onClick={() => void copy('apiUrl')}><Icon name="copy" /> {t('projects.common.copy')}</button></span>
				<span className="muted">{t('projects.common.appKey')}</span>
				<span className="cloud-actions"><span>{t('localProjects.keys.appHint')}</span><span className="spacer" /><button type="button" className="secondary small" onClick={() => void copy('appKey')}><Icon name="copy" /> {t('projects.common.copy')}</button></span>
				<span className="muted">{t('projects.common.serverKey')}</span>
				<span className="cloud-actions"><span>{t('localProjects.keys.serverHint')}</span><span className="spacer" /><button type="button" className="secondary small" onClick={() => void copy('serverKey')}><Icon name="copy" /> {t('projects.common.copy')}</button></span>
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
				<button type="button" className="danger" disabled={busy || row.state !== 'running'} title={row.state !== 'running' ? t('localProjects.common.startFirst') : undefined} onClick={() => void rotate()}>
					<Icon name="key" /> {busy ? t('localProjects.keys.rotating') : t('projects.common.rotateKeys')}
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
	const t = useT();
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
			{activity.data && rows.length === 0 && <p className="field-hint">{t('localProjects.activity.none')}</p>}
			{rows.length > 0 && (
				<table className="cloud-table">
					<tbody>
						{rows.map((a, i) => (
							<tr key={`${a.at}-${i}`}>
								<td className="local-nowrap muted">{when(a.at)}</td>
								<td>{a.what}</td>
								<td className="cloud-table-action">{!a.ok && <span className="cloud-dot error" title={t('localProjects.activity.failed')} />}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="cloud-actions">
				<span className="field-hint">{t('localProjects.activity.hint')}</span>
				<span className="spacer" />
				<button type="button" className="secondary small" disabled={activity.loading} onClick={() => void activity.reload()}><Icon name="refresh" /> {t('projects.common.refresh')}</button>
			</div>
		</fieldset>
	);
}

/** The project's Postgres: how to reach it, and the connection it already is in this app. */
export function LocalDatabase({ row, onOpenDatabase }: { row: LocalProjectRow; onOpenDatabase(): void }): JSX.Element {
	const t = useT();
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
				<legend>{t('localProjects.db.title')}</legend>
				<p className="field-hint">{t('localProjects.db.intro')}</p>
				<div className="cloud-actions">
					<button type="button" onClick={onOpenDatabase}><Icon name="plug" /> {t('projects.common.openInConnections')}</button>
				</div>
			</fieldset>
			{facts && (
				<fieldset>
					<legend>{t('localProjects.db.connectElsewhere')}</legend>
					<div className="cloud-facts">
						<span className="muted">{t('localProjects.db.host')}</span><span className="mono">{facts.host}</span>
						<span className="muted">{t('projects.common.port')}</span><span className="mono">{facts.port}</span>
						<span className="muted">{t('localProjects.common.database')}</span><span className="mono">{facts.database}</span>
						<span className="muted">{t('projects.common.user')}</span><span className="mono">{facts.user}</span>
					</div>
					<p className="field-hint">{t('localProjects.db.thisComputer')}</p>
					<div className="cloud-actions">
						<button type="button" className="secondary" onClick={() => void copy('dbPassword')}><Icon name="copy" /> {t('localProjects.db.copyPassword')}</button>
						<button type="button" className="secondary" onClick={() => void copy('dbUrl')}><Icon name="copy" /> {t('localProjects.db.copyString')}</button>
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
	const t = useT();
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
					<legend>{t('localProjects.setup.network')}</legend>
					<div className="local-port-grid">
						<label>
							{t('localProjects.setup.apiPort')}
							<input type="number" value={draft.apiPort} onChange={(e) => set({ apiPort: Number(e.target.value) })} />
						</label>
						<label>
							{t('localProjects.setup.dbPort')}
							<input type="number" value={draft.dbPort} onChange={(e) => set({ dbPort: Number(e.target.value) })} />
						</label>
					</div>
					<label className="check">
						<input type="checkbox" checked={draft.exposeApi} onChange={(e) => set({ exposeApi: e.target.checked })} /> {t('localProjects.setup.lanAccess')}
					</label>
					<p className="field-hint">{t('localProjects.settings.portHint')}</p>
				</fieldset>
			)}
			{parts.includes('providers') && (
				<fieldset>
					<legend>{t('localProjects.settings.signIn')}</legend>
					<p className="field-hint">{mono(t('localProjects.settings.oauthIntro', { callback }))}</p>
					<label className="check">
						<input type="checkbox" checked={draft.googleEnabled} onChange={(e) => set({ googleEnabled: e.target.checked })} /> Google
					</label>
					{draft.googleEnabled && (
						<>
							<ol className="field-hint local-steps">
								<li>{t('localProjects.settings.google1')}</li>
								<li>{t('localProjects.settings.google2')}</li>
								<li>{t('localProjects.settings.google3')}</li>
							</ol>
							<label>
								{t('localProjects.settings.clientId')}
								<input value={draft.googleClientId} onChange={(e) => set({ googleClientId: e.target.value })} placeholder="1234567890-abc.apps.googleusercontent.com" />
							</label>
							<label>
								{t('localProjects.settings.clientSecret')}
								{secretField('googleSecret', t('localProjects.settings.storedHint'))}
							</label>
						</>
					)}
					<label className="check">
						<input type="checkbox" checked={draft.githubEnabled} onChange={(e) => set({ githubEnabled: e.target.checked })} /> GitHub
					</label>
					{draft.githubEnabled && (
						<>
							<p className="field-hint">{t('localProjects.settings.github')}</p>
							<label>
								{t('localProjects.settings.clientId')}
								<input value={draft.githubClientId} onChange={(e) => set({ githubClientId: e.target.value })} />
							</label>
							<label>
								{t('localProjects.settings.clientSecret')}
								{secretField('githubSecret', t('localProjects.settings.storedHint'))}
							</label>
						</>
					)}
				</fieldset>
			)}
			{parts.includes('redirects') && (
				<fieldset>
					<legend>{t('localProjects.settings.redirects')}</legend>
					<label>
						{t('localProjects.setup.siteUrl')}
						<input value={draft.siteUrl} onChange={(e) => set({ siteUrl: e.target.value })} placeholder="http://localhost:3000" />
					</label>
					<p className="field-hint">{t('localProjects.settings.siteHint')}</p>
					<label>
						{t('localProjects.settings.additional')}
						<textarea rows={4} value={draft.redirectUrls.join('\n')} onChange={(e) => set({ redirectUrls: e.target.value.split('\n') })} placeholder={'http://localhost:5173\nhttps://staging.example.com'} spellCheck={false} />
					</label>
					<p className="field-hint">{t('localProjects.settings.onePerLine')}</p>
				</fieldset>
			)}
			{parts.includes('signups') && (
				<fieldset>
					<legend>{t('localProjects.setup.signups')}</legend>
					<label className="check">
						<input type="checkbox" checked={draft.autoconfirm} onChange={(e) => set({ autoconfirm: e.target.checked })} /> {t('localProjects.setup.autoconfirm')}
					</label>
					<label className="check">
						<input type="checkbox" checked={draft.disableSignup} onChange={(e) => set({ disableSignup: e.target.checked })} /> {t('localProjects.setup.disableSignup')}
					</label>
				</fieldset>
			)}
			{parts.includes('mail') && (
				<fieldset>
					<legend>{t('localProjects.settings.mail')}</legend>
					<p className="field-hint">{t('localProjects.settings.mailHint')}</p>
					<div className="local-port-grid">
						<label>
							{t('localProjects.common.server')}
							<input value={draft.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} placeholder="smtp.example.com" />
						</label>
						<label>
							{t('projects.common.port')}
							<input type="number" value={draft.smtpPort} onChange={(e) => set({ smtpPort: Number(e.target.value) })} />
						</label>
					</div>
					<label>
						{t('projects.common.user')}
						<input value={draft.smtpUser} onChange={(e) => set({ smtpUser: e.target.value })} autoComplete="off" />
					</label>
					<label>
						{t('projects.common.password')}
						{secretField('smtpPass', loaded.smtpPassSet ? t('localProjects.settings.setReplace') : '')}
					</label>
					<label>
						{t('localProjects.setup.sendFrom')}
						<input value={draft.smtpAdminEmail} onChange={(e) => set({ smtpAdminEmail: e.target.value })} />
					</label>
					<label>
						{t('localProjects.setup.senderName')}
						<input value={draft.smtpSenderName} onChange={(e) => set({ smtpSenderName: e.target.value })} />
					</label>
				</fieldset>
			)}
			{parts.includes('storage') && (
				<fieldset>
					<legend>{t('localProjects.settings.storage')}</legend>
					<label>
						{t('localProjects.settings.maxUpload')}
						<input type="number" min={1} value={draft.fileSizeLimitMb} onChange={(e) => set({ fileSizeLimitMb: Number(e.target.value) })} />
					</label>
				</fieldset>
			)}
			{parts.includes('functions') && (
				<fieldset>
					<legend>{t('localProjects.settings.memoryTime')}</legend>
					<div className="local-port-grid">
						<label>
							{t('localProjects.settings.memPerFn')}
							<input type="number" min={64} max={4096} value={draft.functionsMemoryMb} onChange={(e) => set({ functionsMemoryMb: Number(e.target.value) })} />
						</label>
						<label>
							{t('localProjects.settings.sharedMb')}
							<input type="number" min={256} value={draft.functionsContainerMb} onChange={(e) => set({ functionsContainerMb: Number(e.target.value) })} />
						</label>
						<label>
							{t('localProjects.settings.longestCall')}
							<input type="number" min={1} max={3600} value={Math.round(draft.functionsWallMs / 1000)} onChange={(e) => set({ functionsWallMs: Number(e.target.value) * 1000 })} />
						</label>
						<label>
							{t('localProjects.settings.cpu')}
							<input type="number" min={100} max={600000} value={draft.functionsCpuMs} onChange={(e) => set({ functionsCpuMs: Number(e.target.value) })} />
						</label>
					</div>
					<p className="field-hint">
						{t('localProjects.settings.isolates', { count: Math.max(1, Math.floor(draft.functionsContainerMb / Math.max(1, draft.functionsMemoryMb))) })}
					</p>
				</fieldset>
			)}
			{note && <p className="field-hint">{note}</p>}
			<Status said={said} />
			<Log lines={progress.lines} />
			<div className="modal-actions">
				<button type="button" className="secondary" disabled={busy || !pending} onClick={() => { setDraft(loaded); setSecrets(SECRET_FIELDS); }}><Icon name="discard" /> {t('localProjects.settings.discard')}</button>
				<span className="spacer" />
				<button type="button" disabled={busy || !pending} onClick={() => void save()}><Icon name="save" /> {busy ? t('projects.common.applying') : t('projects.common.saveRestart')}</button>
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
	const t = useT();
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [confirm, confirmDialog] = useConfirm();

	async function reset(): Promise<void> {
		const ok = await confirm({
			title: t('localProjects.password.title'),
			body: t('localProjects.password.body'),
			confirmLabel: t('projects.common.resetPassword'),
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
			<legend>{t('projects.common.password')}</legend>
			<p className="field-hint">{mono(t('localProjects.password.intro', { ref: row.ref }))}</p>
			<div className="cloud-actions">
				<button type="button" disabled={busy || row.state !== 'running'} title={row.state !== 'running' ? t('localProjects.common.startFirst') : undefined} onClick={() => void reset()}>
					<Icon name="key" /> {busy ? t('localProjects.password.resetting') : t('localProjects.password.reset')}
				</button>
				<button type="button" className="secondary" onClick={() => void window.sqlApi.local.copy(row.id, 'dbPassword').then(setSaid)}><Icon name="copy" /> {t('localProjects.db.copyPassword')}</button>
			</div>
			<Status said={said} />
			{confirmDialog}
		</fieldset>
	);
}

function LocalProduction({ row, onChanged }: { row: LocalProjectRow; onChanged(): Promise<void> }): JSX.Element {
	const t = useT();
	const [said, setSaid] = useState<Said>(null);
	const [confirm, confirmDialog] = useConfirm();

	async function change(on: boolean): Promise<void> {
		if (!on) {
			const ok = await confirm({
				title: t('localProjects.prod.offTitle'),
				body: t('localProjects.prod.offBody'),
				confirmLabel: t('localProjects.prod.notProd'),
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
			<legend>{t('localProjects.prod.title')}</legend>
			<p className="field-hint">{t('localProjects.prod.intro')}</p>
			<label className="check">
				<input type="checkbox" checked={row.production} onChange={(e) => void change(e.target.checked)} /> {t('projects.common.treatProd')}
			</label>
			<Status said={said} />
			{confirmDialog}
		</fieldset>
	);
}

/** Export, and Put it back: the cloud's backups, as files in the project's own backups folder. */
function LocalBackups({ row }: SectionProps): JSX.Element {
	const t = useT();
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
			title: t('localProjects.backups.restoreTitle'),
			body: t('localProjects.backups.restoreBody', { pick }),
			confirmLabel: t('localProjects.backups.putBack'),
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
				<legend>{t('localProjects.backups.export')}</legend>
				<p className="field-hint">{mono(t('localProjects.backups.intro'))}</p>
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
					<button type="button" disabled={busy !== null || !running} title={running ? undefined : t('localProjects.common.startFirst')} onClick={() => void exportNow()}>
						<Icon name="export" /> {busy === 'export' ? t('localProjects.backups.exporting') : exports.length > 0 ? t('localProjects.backups.exportAgain') : t('localProjects.backups.export')}
					</button>
					<button type="button" className="secondary" onClick={() => void window.sqlApi.local.openExports(row.id)}><Icon name="folder-opened" /> {t('localProjects.backups.showInFolder')}</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>{t('localProjects.backups.putBack')}</legend>
				{exports.length === 0 && <p className="field-hint">{t('localProjects.backups.nothing')}</p>}
				{exports.length > 0 && (
					<>
						<p className="field-hint">{t('localProjects.backups.warn')}</p>
						<label>
							{t('localProjects.backups.export')}
							<select value={pick} onChange={(e) => setChosen(e.target.value)}>
								{exports.map((e) => <option key={e.name} value={e.name}>{e.name} ({when(e.at)})</option>)}
							</select>
						</label>
						<div className="cloud-actions">
							<button type="button" className="danger" disabled={busy !== null || !running || !pick} title={running ? undefined : t('localProjects.common.startFirst')} onClick={() => void restore()}>
								<Icon name="history" /> {busy === 'restore' ? t('localProjects.backups.putting') : t('localProjects.backups.putBack')}
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
	const t = useT();
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
				<legend>{t('projects.common.remove')}</legend>
				{!removing && (
					<>
						<p className="field-hint">{t('localProjects.remove.intro')}</p>
						<div className="cloud-actions">
							<button type="button" className="danger" disabled={busy} onClick={() => setRemoving(true)}><Icon name="trash" /> {t('localProjects.remove.button')}</button>
						</div>
					</>
				)}
				{removing && (
					<>
						<label className="check">
							<input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /> {t('localProjects.remove.alsoData')}
						</label>
						<p className="field-hint">{t('localProjects.remove.alsoDataHint')}</p>
						{deleteData && (
							<label className="check">
								<input type="checkbox" checked={deleteFolder} onChange={(e) => setDeleteFolder(e.target.checked)} /> {t('localProjects.remove.alsoFolder')}
							</label>
						)}
						<div className="cloud-actions">
							<button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(false)}><Icon name="close" /> {t('projects.common.cancel')}</button>
							<span className="spacer" />
							<button type="button" className="danger" disabled={busy} onClick={() => void remove()}><Icon name="trash" /> {deleteData ? t('localProjects.remove.removeDelete') : t('localProjects.remove.fromList')}</button>
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
	get confirmation() { return t('localProjects.mail.confirmation'); },
	get invite() { return t('localProjects.mail.invite'); },
	get magic_link() { return t('localProjects.mail.magicLink'); },
	get email_change() { return t('localProjects.mail.emailChange'); },
	get recovery() { return t('localProjects.mail.recovery'); },
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
	const t = useT();
	const list = useLoad<LocalMailTemplate[]>(() => window.sqlApi.local.mailTemplates(row.id), [row.id]);
	const [editing, setEditing] = useState<LocalMailTemplate | null>(null);
	const [subject, setSubject] = useState('');
	const [body, setBody] = useState('');
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const progress = useProgressLines(row.id);
	const own = (list.data ?? []).filter((tpl) => tpl.custom).length;

	function open(tpl: LocalMailTemplate): void {
		setEditing(tpl);
		setSubject(tpl.subject);
		setBody(tpl.body);
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
			<legend>{t('localProjects.mail.title')}</legend>
			<p className="field-hint">{t('localProjects.mail.lead')} {own === 0 ? t('localProjects.mail.allAuth') : t('localProjects.mail.ownCount', { own })} {t('localProjects.mail.tail')}</p>
			{list.error && <div className="form-status error">{list.error}</div>}
			{!editing && list.data && (
				<table className="cloud-table">
					<tbody>
						{list.data.map((tpl) => (
							<tr key={tpl.kind}>
								<td>{MAIL_NAMES[tpl.kind]}</td>
								<td className="muted">{tpl.subject}</td>
								<td className="muted">{tpl.custom ? t('localProjects.mail.yours') : ''}</td>
								<td className="cloud-table-action"><button type="button" className="table-action" onClick={() => open(tpl)}><Icon name="edit" /> {t('projects.common.edit')}</button></td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{editing && (
				<>
					<h4 className="local-subhead">{MAIL_NAMES[editing.kind]}</h4>
					<label>
						{t('localProjects.mail.subject')}
						<input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
					</label>
					<div className="local-mail-panes">
						<label>
							HTML
							<textarea className="mono local-mail-body" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
						</label>
						<label>
							{t('localProjects.mail.preview')}
							<iframe className="local-mail-preview" title={t('localProjects.mail.preview')} sandbox="" srcDoc={previewDoc(body)} />
						</label>
					</div>
					<p className="field-hint">
						{t('localProjects.mail.varsLead')} <span className="mono">{'{{ .ConfirmationURL }}'}</span> {t('localProjects.mail.varsRequired')} <span className="mono">{'{{ .Token }}'}</span>, <span className="mono">{'{{ .SiteURL }}'}</span>, <span className="mono">{'{{ .Email }}'}</span>
						{editing.kind === 'email_change' && <>, <span className="mono">{'{{ .NewEmail }}'}</span></>}. {t('localProjects.mail.varsTail')}
					</p>
					<div className="cloud-actions">
						{editing.custom && <button type="button" className="secondary" disabled={busy} onClick={() => void save(null)}><Icon name="discard" /> {t('localProjects.mail.reset')}</button>}
						<span className="spacer" />
						<button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}><Icon name="close" /> {t('projects.common.cancel')}</button>
						<button type="button" disabled={busy || !subject.trim() || !body.trim()} onClick={() => void save({ subject, body })}><Icon name="save" /> {busy ? t('projects.common.saving') : t('projects.common.save')}</button>
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
	const t = useT();
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
				<legend>{t('localProjects.fn.title')}</legend>
				<p className="field-hint">{t('localProjects.fn.intro', { prefix: prefix('fn', row.vocabulary) })}</p>
				{list && list.length === 0 && <p className="field-hint">{t('localProjects.fn.none')}</p>}
				{list && list.length > 0 && (
					<table className="cloud-table">
						<tbody>
							{list.map((f) => (
								<tr key={f.name}>
									<td className="mono">{f.name}</td>
									<td className="mono muted">{f.url}</td>
									<td>
										<label className="check local-inline-check" title={t('localProjects.fn.noKeyHint')}>
											<input type="checkbox" checked={keyless.has(f.name)} disabled={busy || !settings.data} onChange={(e) => void setKeyless(f.name, e.target.checked)} /> {t('localProjects.fn.noKey')}
										</label>
									</td>
									<td className="cloud-table-action">
										<button type="button" className="table-action" onClick={() => void window.sqlApi.local.openFolder(row.id, f.name)}><Icon name="folder-opened" /> {t('localProjects.fn.open')}</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div className="cloud-actions">
					<button type="button" disabled={busy || row.state !== 'running'} title={row.state !== 'running' ? t('localProjects.common.startFirst') : undefined} onClick={() => void deploy()}>
						<Icon name="cloud-upload" /> {busy ? t('localProjects.fn.working') : t('localProjects.fn.deploy')}
					</button>
					<button type="button" className="secondary" onClick={() => void window.sqlApi.local.openFolder(row.id)}><Icon name="folder-opened" /> {t('localProjects.running.openFolder')}</button>
				</div>
				<Status said={said} />
				<Log lines={progress.lines} />
			</fieldset>
			<fieldset>
				<legend>{t('localProjects.fn.new')}</legend>
				<label>
					{t('projects.common.name')}
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="send-welcome" maxLength={63} />
				</label>
				<p className="field-hint">{t('localProjects.fn.creates', { name: name.trim() || "<name>" })}</p>
				<div className="cloud-actions">
					<button type="button" disabled={!name.trim()} onClick={() => void create()}><Icon name="add" /> {t('projects.common.create')}</button>
				</div>
			</fieldset>
			<FunctionSecrets row={row} />
			<LocalSettingsForm projectId={row.id} vocabulary={row.vocabulary} parts={['functions']} note="Saving restarts the functions runtime with the new limits." />
		</>
	);
}

/** Secrets for functions: functions/.env, names listed, values never read back. */
function FunctionSecrets({ row }: SectionProps): JSX.Element {
	const t = useT();
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
			<legend>{t('projects.common.secrets')}</legend>
			<p className="field-hint">{t('localProjects.fn.secretsIntro')}</p>
			{names.data && names.data.length > 0 && (
				<table className="cloud-table">
					<tbody>
						{names.data.map((n) => (
							<tr key={n}>
								<td className="mono">{n}</td>
								<td className="cloud-table-action"><button type="button" className="table-action is-danger" disabled={busy || !running} onClick={() => void set(n, null)}><Icon name="trash" /> {t('projects.common.remove')}</button></td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<div className="local-port-grid">
				<label>
					{t('projects.common.name')}
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="STRIPE_KEY" spellCheck={false} />
				</label>
				<label>
					{t('localProjects.fn.value')}
					<input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
				</label>
			</div>
			<div className="cloud-actions">
				<button type="button" disabled={busy || !running || !name.trim() || !value} title={running ? undefined : t('localProjects.common.startFirst')} onClick={() => void set(name.trim(), value)}><Icon name="lock" /> {busy ? t('projects.common.saving') : t('cloudProjects.fn.setSecret')}</button>
			</div>
			<Status said={said} />
			<Log lines={progress.lines} />
		</fieldset>
	);
}

/** Push is a SnoutData Cloud service the self-hosted stack does not run, and the section says so plainly. */
export function LocalPush(): JSX.Element {
	const t = useT();
	return (
		<fieldset>
			<legend>{t('localProjects.push.title')}</legend>
			<p>{t('localProjects.push.intro')}</p>
			<p className="field-hint">
				{t('localProjects.push.notYet')}
			</p>
		</fieldset>
	);
}

// --- Logs ----------------------------------------------------------------------------------------

/** Logs, locally: every service's own Docker log, Postgres's statements like a cloud project's, and the activity log. */
export function LocalLogs({ row }: SectionProps): JSX.Element {
	const t = useT();
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
				<legend>{t('localProjects.logs.source')}</legend>
				<div className="local-chips">
					{[['activity', t('localProjects.logs.activity')], ['all', t('localProjects.logs.every')], ...services.map((s) => [s, s]), ['postgres', t('projects.statements.title')]].map(([id, label]) => (
						<button key={id} type="button" className={`local-chip${source === id ? ' selected' : ''}`} onClick={() => setSource(id)}>{label}</button>
					))}
				</div>
			</fieldset>
			{source === 'activity' && <ActivityList projectId={row.id} heading="Activity" />}
			{source === 'postgres' && <PostgresStatements target={{ kind: 'local', id: row.id }} />}
			{!special && (
				<fieldset>
					<legend>{source === 'all' ? t('localProjects.logs.every') : source}</legend>
					<div className="cloud-actions">
						<span className="field-hint">{t('localProjects.logs.last300')}</span>
						<span className="spacer" />
						<label className="check local-inline-check">
							<input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t('localProjects.logs.follow')}
						</label>
						<button type="button" className="secondary" disabled={loading} onClick={() => void load()}>
							<Icon name={loading ? 'loading' : 'refresh'} className={loading ? 'codicon-modifier-spin' : ''} /> {t('projects.common.refresh')}
						</button>
					</div>
					<pre className="local-log tall" ref={ref}>{text || (loading ? t('localProjects.logs.reading') : t('localProjects.logs.nothing'))}</pre>
				</fieldset>
			)}
		</>
	);
}

/** The data API switch, locally: the `rest` container's compose profile (main/localStack/plan.ts). */
export function LocalDataApiSwitch({ row }: SectionProps): JSX.Element {
	const t = useT();
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
		return <div className="field-hint">{t('projects.common.loading')}</div>;
	}
	const restUp = row.services.some((s) => s.name === 'rest' && s.state === 'running');
	return (
		<fieldset>
			<legend>{t('projects.common.dataApi')}</legend>
			<label className="check">
				<input type="checkbox" checked={state.data.on} disabled={busy || !state.data.switchable} onChange={(e) => void change(e.target.checked)} /> {state.data.on ? t('projects.common.on') : t('projects.common.off')}
			</label>
			<p className="field-hint">
				{state.data.on
					? t(row.state === 'running' && !restUp ? 'localProjects.dataApi.onHintPending' : 'localProjects.dataApi.onHint', { data: prefix('data', row.vocabulary), graph: prefix('graph', row.vocabulary) })
					: t('localProjects.dataApi.offHint', { data: prefix('data', row.vocabulary), graph: prefix('graph', row.vocabulary) })}
			</p>
			{!state.data.switchable && <p className="form-status warn">{t('localProjects.dataApi.override')}</p>}
			<Status said={said} />
			<Log lines={progress.lines} />
		</fieldset>
	);
}

const ADDRESS_HEADERS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: '', get label() { return t('localProjects.domains.none'); } },
	{ value: 'x-real-ip', label: "x-real-ip (nginx, Caddy)" },
	{ value: 'x-forwarded-for', label: "x-forwarded-for" },
	{ value: 'cf-connecting-ip', label: "cf-connecting-ip (Cloudflare)" },
];

export function LocalDomains({ row }: SectionProps): JSX.Element {
	const t = useT();
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
		return <div className="field-hint">{t('projects.common.loading')}</div>;
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
				<legend>{t('localProjects.domains.title')}</legend>
				<p className="field-hint">{t('localProjects.domains.intro')}</p>
				<label>
					{t('projects.common.address')}
					<input value={address} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com" />
				</label>
				<p className="field-hint">{t('localProjects.domains.examples', { port: s.apiPort })}</p>
				<label>
					{t('localProjects.domains.proxyWrites')}
					<select value={proxyHeader} onChange={(e) => setHeader(e.target.value)}>
						{ADDRESS_HEADERS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
					</select>
				</label>
				<p className="field-hint">{t('localProjects.domains.proxyHint')}</p>
				<Status said={said} />
				<Log lines={progress.lines} />
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" disabled={busy || !changed} onClick={() => void save()}><Icon name="save" /> {busy ? t('projects.common.applying') : t('projects.common.saveRestart')}</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>{t('localProjects.domains.ownDomain')}</legend>
				<p className="field-hint">{t('localProjects.domains.ownDomainIntro')}</p>
				<pre className="local-snippet">{`${host} {
	reverse_proxy 127.0.0.1:${s.apiPort} {
		header_up X-Real-IP {remote_host}
	}
}`}</pre>
				<p className="field-hint">{t('localProjects.domains.thenChoose')}</p>
			</fieldset>
		</>
	);
}

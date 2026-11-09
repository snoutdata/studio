/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { CLOUD_VOCABULARY, prefix } from '../../../shared/ownLayout';
import { formatLocale, t, useT } from '../i18n';
import { mono } from './projectUi';
import {
	type CloudActionOutcome, type CloudBackups, type CloudConnectionFacts, type CloudCopyTarget, type CloudDomain,
	type CloudFunctions, type CloudMaintenanceWindow, type CloudProjectOp, type CloudProjectOps, type CloudProjectRow,
	type CloudServices, type CloudUsage,
} from '../../../shared/cloudProjects';

// What only a CLOUD project has: the control plane's side of it, each one the Snout Function the
// dashboard and the CLI call, made in main. Running, usage, the keys and the password, backups, the
// maintenance window, the product switches, functions with their sizing and secrets, and custom domains. Everything a cloud
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
		return t('projects.common.notMeasured');
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
	return iso ? new Date(iso).toLocaleString(formatLocale()) : t('projects.common.neverL');
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
	const t = useT();
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const row = props.row;

	if (!row) {
		return <div className="field-hint">{t('projects.common.loading')}</div>;
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
			<legend>{t('projects.common.status')}</legend>
			<div className="cloud-facts">
				<span className="muted">{t('localProjects.running.state')}</span><span>{row.state}{row.desiredState ? ` → ${row.desiredState}` : ''}{row.busy ? t('cloudProjects.status.working') : ''}</span>
				<span className="muted">{t('cloudProjects.status.region')}</span><span>{row.region}</span>
				<span className="muted">{t('projects.common.size')}</span><span>{bytes(row.sizeBytes)}{row.readOnly ? t('cloudProjects.status.overLimit') : ''}</span>
				<span className="muted">{t('cloudProjects.status.lastConn')}</span><span>{when(row.lastConnectionAt)}</span>
				<span className="muted">{t('projects.common.created')}</span><span>{when(row.createdAt)}</span>
				<span className="muted">{t('localProjects.prod.title')}</span><span>{row.production ? t('cloudProjects.status.neverPaused') : t('cloudProjects.status.no')}</span>
			</div>
			{row.serverSilent && <p className="field-hint">{t('cloudProjects.status.silent')}</p>}
			{!row.wakesInstantly && <p className="field-hint">{t('cloudProjects.status.cold')}</p>}
			<div className="cloud-actions">
				<button type="button" disabled={!row.canResume || busy} onClick={() => void ask('resume')}><Icon name="play" /> {t('localProjects.common.start')}</button>
				<button type="button" disabled={!row.canPause || busy} title={row.pauseRefusal} onClick={() => void ask('pause')}><Icon name="debug-stop" /> {t('localProjects.common.stop')}</button>
			</div>
			{row.pauseRefusal && !row.canPause && <p className="field-hint">{row.pauseRefusal}</p>}
			<Status said={said} />
		</fieldset>
	);
}

/** Delete a cloud project: in Settings, where the dashboard keeps it. */
export function CloudDelete(props: { row: CloudProjectRow | null; onDeleted(): void }): JSX.Element | null {
	const t = useT();
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
			body: t('cloudProjects.delete.confirm', { ref: row.ref }),
			confirmLabel: t('projects.common.delete'),
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
			<legend>{t('cloudProjects.delete.title')}</legend>
			<p className="field-hint">{t('cloudProjects.delete.body')}</p>
			<div className="cloud-actions">
				<button type="button" className="danger" disabled={!row.canDelete || busy} onClick={() => void remove()}><Icon name="trash" /> {t('cloudProjects.delete.button')}</button>
			</div>
			<Status said={said} />
			{confirmDialog}
		</fieldset>
	);
}

/** How long the old password keeps working after a reset (361), in minutes; an hour by default. */
const GRACE_CHOICES: { minutes: number; label: string }[] = [
	{ minutes: 60, get label() { return t('cloudProjects.grace.hour'); } },
	{ minutes: 15, get label() { return t('cloudProjects.grace.m15'); } },
	{ minutes: 240, get label() { return t('cloudProjects.grace.h4'); } },
	{ minutes: 1440, get label() { return t('cloudProjects.grace.h24'); } },
	{ minutes: 0, get label() { return t('cloudProjects.grace.now'); } },
];

function Connection({ projectRef, part, onOpenDatabase }: { projectRef: string; part: 'database' | 'keys'; onOpenDatabase?(): void }): JSX.Element {
	const t = useT();
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [grace, setGrace] = useState(60);
	const [confirm, confirmDialog] = useConfirm();
	// The connection facts are only read where they are shown: reading them is not free on the audit log.
	const { data } = useLoad<CloudConnectionFacts>(() => (part === 'database' ? run('connection', { ref: projectRef }, setSaid) : Promise.resolve(null)));

	async function copy(what: CloudCopyTarget, label: string): Promise<void> {
		setBusy(true);
		try {
			if (await run('copy', { ref: projectRef, what }, setSaid)) {
				setSaid({ ok: true, message: t('cloudProjects.conn.copied', { label }) });
			}
		} finally {
			setBusy(false);
		}
	}

	async function reset(): Promise<void> {
		const ok = await confirm({
			title: t('localProjects.password.title'),
			body: grace === 0
				? t('cloudProjects.conn.resetNow')
				: t('cloudProjects.conn.resetGrace', { grace: GRACE_CHOICES.find((c) => c.minutes === grace)?.label.toLowerCase() ?? t('cloudProjects.conn.graceMinutes', { minutes: grace }) }),
			confirmLabel: t('projects.common.resetPassword'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			const result = await run('resetPassword', { ref: projectRef, graceMinutes: grace }, setSaid);
			if (result) {
				setSaid({ ok: true, message: `${t('cloudProjects.conn.newSet', { applies: result.appliesIn })} ${result.updatedConnections === 1 ? t('cloudProjects.conn.updatedOne') : t('cloudProjects.conn.updatedMany', { count: result.updatedConnections })}${result.oldPassword ? ` ${result.oldPassword}` : ''}` });
			}
		} finally {
			setBusy(false);
		}
	}

	async function rotate(): Promise<void> {
		const ok = await confirm({
			title: t('localProjects.keys.rotateTitle'),
			body: t('cloudProjects.conn.keysBody'),
			confirmLabel: t('projects.common.rotateKeys'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		setBusy(true);
		try {
			const result = await run('rotateKeys', { ref: projectRef }, setSaid);
			if (result) {
				setSaid({ ok: true, message: t('cloudProjects.conn.newKeys', { breaks: result.breaks }) });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			{part === 'database' && onOpenDatabase && (
				<fieldset>
					<legend>{t('localProjects.db.title')}</legend>
					<p className="field-hint">{t('localProjects.db.intro')}</p>
					<div className="cloud-actions">
						<button type="button" onClick={onOpenDatabase}><Icon name="plug" /> {t('projects.common.openInConnections')}</button>
					</div>
				</fieldset>
			)}
			{part === 'database' && <fieldset>
				<legend>{t('cloudProjects.conn.title')}</legend>
				<label>{t('localProjects.db.host')}<input readOnly value={data?.host ?? ''} /></label>
				<label>{t('projects.common.port')}<input readOnly value={data ? String(data.port) : ''} /></label>
				<label>{t('localProjects.common.database')}<input readOnly value={data?.database ?? ''} /></label>
				<label>{t('projects.common.user')}<input readOnly value={data?.user ?? ''} /></label>
				<p className="field-hint">{t('cloudProjects.conn.tls')}</p>
				<label>{t('cloudProjects.conn.afterReset')}
					<select value={grace} disabled={busy} onChange={(e) => setGrace(Number(e.target.value))}>
						{GRACE_CHOICES.map((choice) => <option key={choice.minutes} value={choice.minutes}>{choice.label}</option>)}
					</select>
				</label>
				<p className="field-hint">{t('cloudProjects.conn.resetHint')}</p>
				<div className="cloud-actions">
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('uri', t('cloudProjects.conn.string'))}><Icon name="copy" /> {t('localProjects.db.copyString')}</button>
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('password', t('projects.common.password'))}><Icon name="copy" /> {t('localProjects.db.copyPassword')}</button>
					<span className="spacer" />
					<button type="button" className="danger" disabled={busy} onClick={() => void reset()}><Icon name="key" /> {t('projects.common.resetPassword')}</button>
				</div>
			</fieldset>}
			{part === 'keys' && <fieldset>
				<legend>{t('cloudProjects.conn.apiKeys')}</legend>
				<p className="field-hint">{mono(t('cloudProjects.conn.apiIntro', { ref: projectRef }))}</p>
				<div className="cloud-actions">
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('appKey', t('projects.common.appKey'))}><Icon name="copy" /> {t('cloudProjects.conn.copyApp')}</button>
					<button type="button" className="secondary" disabled={busy} onClick={() => void copy('serverKey', t('projects.common.serverKey'))}><Icon name="copy" /> {t('cloudProjects.conn.copyServer')}</button>
					<span className="spacer" />
					<button type="button" className="danger" disabled={busy} onClick={() => void rotate()}><Icon name="key" /> {t('projects.common.rotateKeys')}</button>
				</div>
			</fieldset>}
			<Status said={said} />
			{confirmDialog}
		</>
	);
}

export function CloudBackupsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const t = useT();
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
				setSaid({ ok: true, message: t('cloudProjects.backups.asked') });
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
				setSaid({ ok: true, message: t('cloudProjects.backups.restoring', { name: made.name, ref: made.ref }) });
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
				<legend>{t('localProjects.backups.export')}</legend>
				<p className="field-hint">{mono(t('cloudProjects.backups.intro'))}</p>
				{loading && <div className="field-hint">{t('projects.common.loading')}</div>}
				{exported && (
					<div className="cloud-facts">
						<span className="muted">{t('cloudProjects.backups.latest')}</span>
						<span>{exported.pending ? t('cloudProjects.backups.beingTaken') : exported.completedAt ? when(exported.completedAt) : t('cloudProjects.backups.noneYet')}</span>
						{exported.bytes !== undefined && exported.bytes !== null && <><span className="muted">{t('projects.common.size')}</span><span>{bytes(exported.bytes)}</span></>}
						{exported.error && <><span className="muted">{t('cloudProjects.backups.error')}</span><span>{exported.error}</span></>}
					</div>
				)}
				<div className="cloud-actions">
					<button type="button" disabled={busy || exported?.pending === true} onClick={() => void exportNow()}><Icon name="export" /> {t('cloudProjects.backups.exportNow')}</button>
					{exported?.url && <button type="button" className="secondary" onClick={() => void window.sqlApi.openExternal(exported.url!)}><Icon name="cloud-download" /> {t('projects.common.download')}</button>}
					<span className="spacer" />
					<button type="button" className="secondary" disabled={loading} onClick={() => void reload()}><Icon name="refresh" /> {t('projects.common.refresh')}</button>
				</div>
			</fieldset>
			<fieldset>
				<legend>{t('cloudProjects.backups.pitr')}</legend>
				{!restore && !loading && <p className="field-hint">{t('cloudProjects.backups.windowFail')}</p>}
				{restore && !restore.available && (
					<p className="field-hint">
						{restore.pitrEnabled
							? t('cloudProjects.backups.noBackup')
							: t('cloudProjects.backups.pitrPlan', { tier: restore.tier })}
					</p>
				)}
				{restore?.available && (
					<>
						<p className="field-hint">{t('cloudProjects.backups.newProject')}</p>
						<label>
							{t('cloudProjects.backups.moment')}
							<input type="datetime-local" value={at} min={toLocal(restore.earliest)} max={toLocal(restore.latest)} onChange={(e) => setAt(e.target.value)} />
						</label>
						<p className="field-hint">{t('cloudProjects.backups.between', { from: when(restore.earliest), to: when(restore.latest) })}</p>
						<label>
							{t('cloudProjects.backups.newName')}
							<input value={name} placeholder={t('cloudProjects.backups.optional')} maxLength={60} onChange={(e) => setName(e.target.value)} />
						</label>
						<div className="cloud-actions">
							<button type="button" disabled={busy || !at} onClick={() => void restoreNow()}><Icon name="history" /> {t('cloudProjects.backups.restore')}</button>
						</div>
					</>
				)}
			</fieldset>
			<Status said={said} />
		</>
	);
}

export function CloudUsageSection({ projectRef }: { projectRef: string }): JSX.Element {
	const t = useT();
	const [said, setSaid] = useState<Said>(null);
	const { data, loading } = useLoad<CloudUsage>(() => run('usage', { ref: projectRef }, setSaid));
	const days = [...(data?.days ?? [])].reverse();
	const latest = days.find((d) => d.dbBytes !== null);
	const limit = data?.limit?.maxStorageBytes ?? null;
	const share = latest?.dbBytes && limit ? Math.min(1, latest.dbBytes / limit) : null;

	return (
		<>
			<fieldset>
				<legend>{t('localProjects.settings.storage')}</legend>
				{loading && <div className="field-hint">{t('projects.common.loading')}</div>}
				{!loading && (
					<>
						<div className="cloud-facts">
							<span className="muted">{t('localProjects.common.database')}</span><span>{bytes(latest?.dbBytes)}</span>
							<span className="muted">{t('cloudProjects.usage.planLimit')}</span><span>{limit ? `${bytes(limit)} (${data?.limit?.tier})` : t('projects.common.unknownL')}</span>
						</div>
						{share !== null && (
							<div className="cloud-meter" title={t('cloudProjects.usage.share', { percent: Math.round(share * 100) })}>
								<div className={`cloud-meter-fill${share > 0.9 ? ' warn' : ''}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
							</div>
						)}
					</>
				)}
			</fieldset>
			<fieldset>
				<legend>{t('cloudProjects.usage.last30')}</legend>
				{!loading && days.length === 0 && <p className="field-hint">{t('cloudProjects.usage.none')}</p>}
				{days.length > 0 && (
					<table className="cloud-table">
						<thead>
							<tr><th>{t('cloudProjects.usage.day')}</th><th>{t('localProjects.common.database')}</th><th>{t('cloudProjects.usage.backups')}</th><th>{t('localProjects.glance.connections')}</th><th>{t('cloudProjects.usage.compute')}</th></tr>
						</thead>
						<tbody>
							{days.map((d) => (
								<tr key={d.day}>
									<td className="cloud-when">{d.day}</td>
									<td className="cloud-nowrap">{bytes(d.dbBytes)}</td>
									<td className="cloud-nowrap">{bytes(d.repoBytes)}</td>
									<td>{d.connections}</td>
									<td className="cloud-nowrap">{Math.round(d.computeSeconds / 60)} min</td>
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
	auth: { legend: "Auth", get hint() { return t('cloudProjects.svc.authHint'); }, path: prefix('identity', CLOUD_VOCABULARY) },
	storage: { get legend() { return t('localProjects.settings.storage'); }, get hint() { return t('cloudProjects.svc.storageHint'); }, path: prefix('files', CLOUD_VOCABULARY) },
	dataApi: { get legend() { return t('projects.common.dataApi'); }, get hint() { return t('cloudProjects.svc.dataHint'); }, path: prefix('data', CLOUD_VOCABULARY) },
	push: { legend: "Push", get hint() { return t('cloudProjects.svc.pushHint'); }, path: '/push/v1' },
};

/** A product's switch on the control plane (auth, storage, the data API, push), with what the plan says. */
export function CloudService({ projectRef, service, onState }: { projectRef: string; service: 'auth' | 'storage' | 'dataApi' | 'push'; onState?(enabled: boolean): void }): JSX.Element {
	const t = useT();
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
				setSaid({ ok: true, message: result.note ?? (enable ? t('cloudProjects.svc.turnedOn') : t('cloudProjects.svc.turnedOff')) });
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
				{loading && <div className="field-hint">{t('projects.common.loading')}</div>}
				{readError && <div className="form-status warn">{readError}</div>}
				{!loading && !readError && (
					<label className="check">
						<input type="checkbox" checked={enabled} disabled={busy || refusedByPlan} onChange={(e) => void flip(e.target.checked)} />
						{enabled ? t('projects.common.on') : t('projects.common.off')}
					</label>
				)}
				{refusedByPlan && <p className="field-hint">{t('cloudProjects.svc.dataNotPlan')}</p>}
				{enabled && <p className="field-hint">{mono(t('cloudProjects.svc.servedAt', { ref: projectRef, path: copy.path }))}</p>}
				{service === 'storage' && data?.storage && (
					<div className="cloud-facts">
						{data.storage.pending && <><span className="muted">{t('localProjects.running.state')}</span><span>{t('cloudProjects.svc.waitingHost')}</span></>}
						<span className="muted">{t('localProjects.common.files')}</span><span>{data.storage.files ?? t('projects.common.notMeasured')}</span>
						<span className="muted">{t('projects.common.size')}</span><span>{data.storage.bytes === null ? t('projects.common.notMeasured') : `${bytes(data.storage.bytes)}${data.storage.maxFilesBytes ? ` of ${bytes(data.storage.maxFilesBytes)}` : ''}`}</span>
							{data.storage.bytes === null && data.storage.maxFilesBytes ? <><span className="muted">{t('cloudProjects.usage.planLimit')}</span><span>{bytes(data.storage.maxFilesBytes)}</span></> : null}
						{data.storage.lastError && <><span className="muted">{t('cloudProjects.svc.lastError')}</span><span>{data.storage.lastError}</span></>}
					</div>
				)}
				{service === 'auth' && data?.auth && enabled && (
					<div className="cloud-facts">
						<span className="muted">{t('cloudProjects.svc.google')}</span><span>{data.auth.googleEnabled ? t('projects.common.on') : t('projects.common.off')}</span>
						<span className="muted">SAML SSO</span><span>{data.auth.samlEnabled ? t('projects.common.on') : t('projects.common.off')}</span>
					</div>
				)}
				{service === 'auth' && enabled && <p className="field-hint">{t('cloudProjects.svc.providers')}</p>}
				{service === 'push' && data?.push && enabled && (
					<div className="cloud-facts">
						<span className="muted">{t('cloudProjects.svc.scheduled')}</span><span>{data.push.scheduling ? t('cloudProjects.svc.included') : t('cloudProjects.svc.onPaid')}</span>
					</div>
				)}
				{service === 'push' && enabled && <p className="field-hint">{mono(t('cloudProjects.svc.pushKeys'))}</p>}
			</fieldset>
			<Status said={said} />
		</>
	);
}

export function CloudFunctionsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const t = useT();
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
				setSaid({ ok: true, message: t('cloudProjects.fn.secretSet', { name: name.trim() }) });
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
				<legend>{t('cloudProjects.fn.deployed')}</legend>
				{loading && <div className="field-hint">{t('projects.common.loading')}</div>}
				{/* Only an ANSWER that is empty is "none deployed": a read that failed says so in its
				    own words below, and used to sit under this sentence. */}
				{!loading && data && data.functions.length === 0 && (
					<p className="field-hint">{mono(t('cloudProjects.fn.none'))}</p>
				)}
				{(data?.functions.length ?? 0) > 0 && (
					<table className="cloud-table">
						<thead><tr><th>{t('projects.common.name')}</th><th>JWT</th><th>{t('projects.common.size')}</th><th>{t('cloudProjects.fn.memory')}</th><th>{t('cloudProjects.fn.workers')}</th><th>{t('projects.common.updated')}</th></tr></thead>
						<tbody>
							{data!.functions.map((f) => (
								<tr key={f.name}>
									<td className="mono cloud-word">{f.name}</td>
									<td className="cloud-nowrap">{f.verifyJwt ? t('cloudProjects.fn.required') : t('projects.common.public')}</td>
									<td className="cloud-nowrap">{bytes(f.bytes)}</td>
									<td className="cloud-nowrap">{f.memoryMb == null ? '-' : `${f.memoryMb} MB`}</td>
									<td className="cloud-nowrap">{f.concurrency ?? '-'}</td>
									<td className="cloud-when">{when(f.updatedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{!loading && (data?.functions.length ?? 0) > 0 && <p className="field-hint">{mono(t('cloudProjects.fn.servedAt', { ref: projectRef, prefix: prefix('fn', CLOUD_VOCABULARY) }))}</p>}
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" className="secondary" disabled={loading} onClick={() => { setSecrets(null); setSized(null); void reload(); }}><Icon name="refresh" /> {t('projects.common.refresh')}</button>
				</div>
			</fieldset>
			{data && <FunctionSizing projectRef={projectRef} view={data} onSized={setSized} setSaid={setSaid} />}
			<fieldset>
				<legend>{t('projects.common.secrets')}</legend>
				<p className="field-hint">{t('cloudProjects.fn.secretsIntro')}</p>
				{shown.length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>{t('projects.common.name')}</th><th>{t('projects.common.updated')}</th><th /></tr></thead>
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
				<label>{t('projects.common.name')}<input value={name} placeholder="STRIPE_KEY" onChange={(e) => setName(e.target.value.toUpperCase())} /></label>
				<label>{t('localProjects.fn.value')}<input type="password" value={value} onChange={(e) => setValue(e.target.value)} /></label>
				<div className="cloud-actions">
					<button type="button" disabled={busy || !name.trim() || !value} onClick={() => void setSecret()}><Icon name="lock" /> {t('cloudProjects.fn.setSecret')}</button>
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
	const t = useT();
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
				setSaid({ ok: true, message: t('cloudProjects.fn.sized', { name: current!.name, mb: String(now?.memoryMb), workers: String(now?.concurrency) }) });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>{t('cloudProjects.fn.sizing')}</legend>
			<p className="field-hint">
				{t('cloudProjects.fn.sizingIntro', { tier: plan.tier, memory: plan.functionMemoryMb, max: plan.concurrencyMax, pod: plan.podMemoryMb })}
			</p>
			{sized.length > 1 && (
				<label>{t('cloudProjects.fn.function')}
					<select value={current.name} disabled={busy} onChange={(e) => setName(e.target.value)}>
						{sized.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
					</select>
				</label>
			)}
			<label>{t('cloudProjects.fn.memoryWorker')}
				<select value={memoryMb} disabled={busy} onChange={(e) => setMemoryMb(Number(e.target.value))}>
					{steps.map((mb) => <option key={mb} value={mb} disabled={mb * concurrency > plan.podMemoryMb}>{mb} MB</option>)}
				</select>
			</label>
			<label>{t('cloudProjects.fn.workers')}
				<select value={concurrency} disabled={busy} onChange={(e) => setConcurrency(Number(e.target.value))}>
					{Array.from({ length: plan.concurrencyMax }, (_, i) => i + 1).map((n) => <option key={n} value={n} disabled={n * memoryMb > plan.podMemoryMb}>{n}</option>)}
				</select>
			</label>
			<p className={fits ? 'field-hint' : 'form-status error'}>{t('cloudProjects.fn.total', { mem: memoryMb, conc: concurrency, total, pod: plan.podMemoryMb })}</p>
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={() => void save(true)}><Icon name="discard" /> {t('cloudProjects.fn.planDefault')}</button>
				<button type="button" disabled={busy || !changed || !fits} onClick={() => void save(false)}><Icon name="save" /> {t('projects.common.save')}</button>
			</div>
		</fieldset>
	);
}

export function CloudDomainsSection({ projectRef }: { projectRef: string }): JSX.Element {
	const t = useT();
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
						? (result.next ?? t('cloudProjects.domains.added', { host }))
						: action === 'verify'
							? (result.domain?.verified ? t('cloudProjects.domains.verified', { host }) : (result.domain?.verificationError ?? t('cloudProjects.domains.notVerifiedYet', { host })))
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
				<legend>{t('cloudProjects.domains.title')}</legend>
				<p className="field-hint">{t('cloudProjects.domains.intro')}</p>
				{loading && <div className="field-hint">{t('projects.common.loading')}</div>}
				{!loading && data && data.length === 0 && <p className="field-hint">{t('cloudProjects.domains.none')}</p>}
				{(data ?? []).map((d) => (
					<div key={d.hostname} className="cloud-domain">
						<div className="cloud-actions">
							<span className="mono">{d.hostname}</span>
							<span className={`env${d.verified ? '' : ' warn'}`}>{d.verified ? t('cloudProjects.domains.verifiedL') : t('cloudProjects.domains.notVerified')}</span>
							{d.certificate?.state && <span className="muted small">certificate {d.certificate.state}</span>}
							<span className="spacer" />
							{!d.verified && <button type="button" className="table-action" disabled={busy} onClick={() => void act('verify', d.hostname)}><Icon name="verified" /> {t('cloudProjects.domains.verify')}</button>}
							<button type="button" className="icon-btn" aria-label={`Remove ${d.hostname}`} disabled={busy} onClick={() => void act('remove', d.hostname)}><Icon name="trash" /></button>
						</div>
						{(d.record || d.certificateRecord) && (
							<table className="cloud-table">
								<thead><tr><th>{t('projects.common.type')}</th><th>{t('projects.common.name')}</th><th>{t('localProjects.fn.value')}</th></tr></thead>
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
				<legend>{t('cloudProjects.domains.add')}</legend>
				<label>{t('cloudProjects.domains.hostname')}<input value={hostname} placeholder="api.yourcompany.com" onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} /></label>
				<div className="cloud-actions">
					<button type="button" disabled={busy || !hostname} onClick={() => void act('add', hostname)}><Icon name="globe" /> {t('cloudProjects.domains.addBtn')}</button>
				</div>
			</fieldset>
			<Status said={said} />
		</>
	);
}

/** The Database section of a cloud project: the connection in this app, and how to connect from anywhere else. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(hour: number): string {
	return `${String(hour).padStart(2, '0')}:00`;
}

/** Every IANA timezone this window knows, for the picker. */
function timezoneNames(): string[] {
	try {
		const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
		return intl.supportedValuesOf?.('timeZone') ?? [];
	} catch {
		return [];
	}
}

/** Where the window's timezone came from, in the dashboard's words. */
function timezoneSource(from: NonNullable<CloudMaintenanceWindow['window']>['timezoneFrom'], region: string | undefined): string {
	switch (from) {
		case 'project':
			return t('cloudProjects.tz.projectOwn');
		case 'owner-owner':
			return t('cloudProjects.tz.ownerAccount');
		case 'owner-signin':
			return t('cloudProjects.tz.ownerSignIn');
		case 'region':
			return region ? t('cloudProjects.tz.regionOf', { region }) : t('cloudProjects.tz.region');
		default:
			return t('localProjects.setup.none');
	}
}

/** The next window, or the one it is in, in this computer's local time. */
function nextWindow(next: NonNullable<CloudMaintenanceWindow['next']>): string {
	const starts = new Date(next.startsAt);
	const ends = new Date(next.endsAt);
	const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
	const until = ends.toLocaleTimeString(formatLocale(), { ...time, timeZoneName: 'short' });
	if (starts.getTime() <= Date.now()) {
		return t('cloudProjects.maint.now', { until });
	}
	return t('cloudProjects.maint.range', { from: starts.toLocaleString(formatLocale(), { weekday: 'short', day: 'numeric', month: 'short', ...time }), to: until });
}

/**
 * The maintenance window: the hours when this running database may be moved to another server.
 * In Settings, as on the dashboard; the same Snout Function, which decides who may change it.
 */
export function CloudMaintenanceWindow({ projectRef, region }: { projectRef: string; region?: string }): JSX.Element {
	const t = useT();
	const [said, setSaid] = useState<Said>(null);
	const [busy, setBusy] = useState(false);
	const [start, setStart] = useState(2);
	const [end, setEnd] = useState(6);
	const [timezone, setTimezone] = useState('');
	const [zones] = useState(timezoneNames);
	const [answer, setAnswer] = useState<CloudMaintenanceWindow | null>(null);
	const [loading, setLoading] = useState(true);

	function take(loaded: CloudMaintenanceWindow): void {
		setAnswer(loaded);
		if (loaded.window) {
			setStart(loaded.window.startHour);
			setEnd(loaded.window.endHour);
			setTimezone(loaded.window.timezoneFrom === 'project' ? loaded.window.timezone ?? '' : '');
		}
	}

	useEffect(() => {
		let live = true;
		void run('maintenanceWindow', { ref: projectRef }, setSaid).then((loaded) => {
			if (live) {
				if (loaded) {
					take(loaded);
				}
				setLoading(false);
			}
		});
		return () => {
			live = false;
		};
	}, [projectRef]);

	async function save(reset: boolean): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			const args = reset ? { ref: projectRef, reset: true } : { ref: projectRef, startHour: start, endHour: end, timezone: timezone || null };
			const saved = await run('setMaintenanceWindow', args, setSaid);
			if (saved) {
				take(saved);
				setSaid({ ok: true, message: reset ? t('cloudProjects.maint.backDefault') : t('cloudProjects.maint.saved') });
			}
		} finally {
			setBusy(false);
		}
	}

	const w = answer?.window ?? null;
	const own = w?.hoursFrom === 'project';
	const unchanged = w !== null && own && start === w.startHour && end === w.endHour && timezone === (w.timezoneFrom === 'project' ? w.timezone ?? '' : '');
	const choices = timezone && !zones.includes(timezone) ? [timezone, ...zones] : zones;

	return (
		<fieldset>
			<legend>{t('cloudProjects.maint.title')}</legend>
			<p className="field-hint">{t('cloudProjects.maint.intro')}</p>
			{loading && <div className="field-hint">{t('projects.common.loading')}</div>}
			{w && (
				<div className="cloud-facts">
					<span className="muted">{t('cloudProjects.maint.window')}</span><span>{t('cloudProjects.maint.range', { from: hourLabel(w.startHour), to: hourLabel(w.endHour) })}{w.timezone ? `, ${w.timezone}` : ''}</span>
					<span className="muted">{t('cloudProjects.maint.hours')}</span><span>{own ? t('cloudProjects.tz.projectOwn') : t('cloudProjects.maint.theDefault')}</span>
					<span className="muted">{t('cloudProjects.maint.timezone')}</span><span>{timezoneSource(w.timezoneFrom, region)}</span>
					{answer?.next && <><span className="muted">{t('cloudProjects.maint.next')}</span><span>{nextWindow(answer.next)}</span></>}
				</div>
			)}
			<label>
				{t('cloudProjects.maint.startsAt')}
				<select value={start} disabled={!answer || busy} onChange={(e) => setStart(Number(e.target.value))}>
					{HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
				</select>
			</label>
			<label>
				{t('cloudProjects.maint.endsAt')}
				<select value={end} disabled={!answer || busy} onChange={(e) => setEnd(Number(e.target.value))}>
					{HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
				</select>
			</label>
			<p className="field-hint">
				{start === end
					? t('cloudProjects.maint.pickEnd')
					: end < start
						? t('cloudProjects.maint.crossMidnight', { start: hourLabel(start), end: hourLabel(end) })
						: `${end - start} hours a day.`}
			</p>
			<label>
				{t('cloudProjects.maint.timezone')}
				<select value={timezone} disabled={!answer || busy} onChange={(e) => setTimezone(e.target.value)}>
					<option value="">{t('cloudProjects.maint.ownerTz')}</option>
					{choices.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
				</select>
			</label>
			<div className="cloud-actions">
				<button type="button" disabled={!answer || busy || start === end || unchanged} onClick={() => void save(false)}><Icon name="check" /> {t('projects.common.save')}</button>
				{own && <button type="button" className="secondary" disabled={busy} onClick={() => void save(true)}><Icon name="history" /> {t('cloudProjects.maint.useDefault')}</button>}
			</div>
			<Status said={said} />
		</fieldset>
	);
}

export function CloudDatabase({ projectRef, onOpenDatabase }: { projectRef: string; onOpenDatabase(): void }): JSX.Element {
	return <Connection projectRef={projectRef} part="database" onOpenDatabase={onOpenDatabase} />;
}

/** The API keys, on Overview where the cloud dashboard keeps them. */
export function CloudKeys({ projectRef }: { projectRef: string }): JSX.Element {
	return <Connection projectRef={projectRef} part="keys" />;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Log, Status, type Said, mono } from './projectUi';
import {
	gigabytes, isMoving, parsePort, redeployArgs, shortDigest,
	type CloudContainer, type CloudContainerLogLine, type CloudContainers, type ContainerStatus,
} from '../../../shared/cloudContainers';
import type { CloudProjectOp, CloudProjectOps } from '../../../shared/cloudProjects';
import { formatLocale, t, useT } from '../i18n';

// A cloud project's Snout Containers: its own image, running for as long as the project does, at
// `/containers/v1/<name>/` on the project's API address. The dashboard's Containers page, plus
// what only a desktop can do: build a folder's Dockerfile with the user's own Docker and run it.
//
// Every call is `cloud-project-containers`, made in main with the user's own sign-in. A registry
// token typed here crosses to main once, for the deploy, and is cleared from the form; nothing
// secret comes back. The status is the host's own report; while a container is on its way the
// list is re-read every five seconds.

/** Run one operation; answers the data, or puts the refusal in `said` and answers null. */
async function run<K extends CloudProjectOp>(op: K, args: CloudProjectOps[K]['args'], said: (s: Said) => void): Promise<CloudProjectOps[K]['result'] | null> {
	const outcome = await window.sqlApi.cloudProject(op, args);
	if (outcome.ok) {
		return outcome.data;
	}
	said({ ok: false, refused: outcome.refused, message: outcome.message });
	return null;
}

function tone(container: CloudContainer): string {
	if (!container.allowed || container.status === 'stopped') {
		return 'warn';
	}
	if (container.status === 'running') {
		return 'ok';
	}
	return container.status === 'failed' ? 'error' : 'warn';
}

const STATUS_LABEL: Record<ContainerStatus, string> = {
	get pending() { return t('cloudProjects.ctr.pending'); },
	get pulling() { return t('cloudProjects.ctr.pulling'); },
	get starting() { return t('cloudProjects.ctr.starting'); },
	get running() { return t('cloudProjects.ctr.running'); },
	get restarting() { return t('cloudProjects.ctr.restarting'); },
	get failed() { return t('cloudProjects.ctr.failed'); },
	get stopped() { return t('cloudProjects.ctr.stopped'); },
};

function when(iso: string | null): string {
	return iso ? new Date(iso).toLocaleString(formatLocale()) : t('projects.common.unknownL');
}

export function ContainersSection({ projectRef }: { projectRef: string }): JSX.Element {
	const t = useT();
	const [listing, setListing] = useState<CloudContainers | null>(null);
	const [loading, setLoading] = useState(true);
	const [said, setSaid] = useState<Said>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			const next = await run('containers', { ref: projectRef }, setSaid);
			if (next) {
				setListing(next);
			}
		} finally {
			setLoading(false);
		}
	}, [projectRef]);

	useEffect(() => {
		void reload();
	}, [reload]);

	// Re-read while something is on its way, and stop as soon as nothing is.
	const moving = isMoving(listing?.containers ?? []);
	useEffect(() => {
		if (!moving) {
			return;
		}
		const timer = setInterval(() => {
			void window.sqlApi.cloudProject('containers', { ref: projectRef }).then((outcome) => {
				if (outcome.ok) {
					setListing(outcome.data);
				}
			});
		}, 5000);
		return () => clearInterval(timer);
	}, [moving, projectRef]);

	const allowance = listing?.allowance ?? null;
	const containers = listing?.containers ?? [];
	const noPlan = allowance !== null && allowance.maxContainers === 0;

	return (
		<>
			<fieldset>
				<legend>{t('projects.common.containers')}</legend>
				<p className="field-hint">
					{mono(t('cloudProjects.ctr.intro'))}
				</p>
				{allowance && allowance.maxContainers > 0 && (
					<div className="cloud-facts">
						<span className="muted">{t('projects.common.plan')}</span>
						<span>{allowance.cpuPercent ? t('cloudProjects.ctr.allowanceCpu', { deployed: allowance.deployed, max: allowance.maxContainers, mb: allowance.memoryMb, cpu: allowance.cpuPercent }) : t('cloudProjects.ctr.allowance', { deployed: allowance.deployed, max: allowance.maxContainers, mb: allowance.memoryMb })}</span>
						{allowance.egress && allowance.egress.allowanceBytes > 0 && (
							<>
								<span className="muted">{t('cloudProjects.ctr.sent')}</span>
								<span>{gigabytes(allowance.egress.usedBytes)} of {gigabytes(allowance.egress.allowanceBytes)}{allowance.egress.held ? t('cloudProjects.ctr.stoppedUntil') : ''}</span>
							</>
						)}
					</div>
				)}
				{loading && !listing && <div className="field-hint">{t('projects.common.loading')}</div>}
				{noPlan && (
					<p className="field-hint">{t('cloudProjects.ctr.paidOnly')}</p>
				)}
				{!noPlan && listing && containers.length === 0 && <p className="field-hint">{t('cloudProjects.ctr.none')}</p>}
				{containers.length > 0 && (
					<div className="cloud-containers">
						{containers.map((container) => (
							<ContainerCard key={container.name} projectRef={projectRef} container={container} onChanged={setListing} />
						))}
					</div>
				)}
				<p className="field-hint">{t('cloudProjects.ctr.ephemeral')}</p>
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" className="secondary" disabled={loading} onClick={() => void reload()}><Icon name="refresh" /> {t('projects.common.refresh')}</button>
				</div>
				<Status said={said} />
			</fieldset>
			{!noPlan && listing && (
				<>
					<DeployImage projectRef={projectRef} onDeployed={setListing} />
					<DeployFolder projectRef={projectRef} onDeployed={setListing} />
				</>
			)}
		</>
	);
}

function ContainerCard({ projectRef, container, onChanged }: { projectRef: string; container: CloudContainer; onChanged(listing: CloudContainers): void }): JSX.Element {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const [confirming, setConfirming] = useState(false);
	const [showLogs, setShowLogs] = useState(false);

	async function act(what: 'restart' | 'redeploy' | 'remove'): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			const next = what === 'restart'
				? await run('restartContainer', { ref: projectRef, name: container.name }, setSaid)
				: what === 'redeploy'
					? await run('deployContainer', { ref: projectRef, ...redeployArgs(container) }, setSaid)
					: await run('removeContainer', { ref: projectRef, name: container.name }, setSaid);
			if (next) {
				onChanged(next);
				setConfirming(false);
			}
		} finally {
			setBusy(false);
		}
	}

	async function copyUrl(): Promise<void> {
		try {
			await navigator.clipboard.writeText(container.url);
			setSaid({ ok: true, message: t('cloudProjects.ctr.copied') });
		} catch {
			setSaid({ ok: false, message: t('cloudProjects.ctr.notCopied') });
		}
	}

	return (
		<div className="cloud-container">
			<div className="cloud-actions cloud-container-head">
				<span className={`cloud-dot ${tone(container)}`} aria-hidden="true" />
				<span className="mono">{container.name}</span>
				<span className="muted small" title={container.statusAt ? when(container.statusAt) : undefined}>
					{container.allowed ? STATUS_LABEL[container.status] ?? container.status : t('cloudProjects.ctr.notCovered')}
				</span>
				{container.restarts > 0 && <span className="muted small">{t('cloudProjects.ctr.restarted', { count: container.restarts })}</span>}
			</div>
			{container.statusDetail && <div className={container.status === 'failed' ? 'form-status error' : 'field-hint'}>{container.statusDetail}</div>}
			{!container.allowed && <p className="field-hint">{t('cloudProjects.ctr.overPlan')}</p>}
			<div className="cloud-facts">
				<span className="muted">{t('cloudProjects.ctr.image')}</span>
				<span className="mono" title={container.digest}>{container.built ? t('cloudProjects.ctr.builtDockerfile') : container.image} @ {shortDigest(container.digest)}</span>
				<span className="muted">{t('projects.common.port')}</span>
				<span>{container.port}</span>
				<span className="muted">{t('projects.common.address')}</span>
				<span className="mono">{container.url}</span>
				{container.privateRegistry && <><span className="muted">{t('cloudProjects.ctr.registry')}</span><span>{t('cloudProjects.ctr.privateLogin')}</span></>}
				{container.updatedAt && <><span className="muted">{t('cloudProjects.ctr.deployed')}</span><span>{when(container.updatedAt)}</span></>}
			</div>
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={() => void act('restart')}><Icon name="debug-restart" /> {t('cloudProjects.ctr.restart')}</button>
				<button
					type="button"
					className="secondary"
					disabled={busy}
					title={container.built ? t('cloudProjects.ctr.rebuildHint') : t('cloudProjects.ctr.reresolveHint')}
					onClick={() => void act('redeploy')}
				>
					<Icon name="cloud-upload" /> {t('cloudProjects.ctr.redeploy')}
				</button>
				<button type="button" className="secondary" aria-pressed={showLogs} onClick={() => setShowLogs((on) => !on)}><Icon name="output" /> {showLogs ? t('cloudProjects.ctr.hideLogs') : t('cloudProjects.ctr.logs')}</button>
				<button type="button" className="secondary" onClick={() => void copyUrl()}><Icon name="copy" /> {t('cloudProjects.ctr.copyAddress')}</button>
				<span className="spacer" />
				{confirming ? (
					<>
						<span className="small cloud-container-confirm">{t('cloudProjects.ctr.removeConfirm', { name: container.name })}</span>
						<button type="button" className="danger" disabled={busy} onClick={() => void act('remove')}><Icon name="trash" /> {t('projects.common.remove')}</button>
						<button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>{t('projects.common.cancel')}</button>
					</>
				) : (
					<button type="button" className="danger" disabled={busy} onClick={() => setConfirming(true)}><Icon name="trash" /> {t('projects.common.remove')}</button>
				)}
			</div>
			<Status said={said} />
			{showLogs && <ContainerLogs projectRef={projectRef} name={container.name} />}
		</div>
	);
}

function ContainerLogs({ projectRef, name }: { projectRef: string; name: string }): JSX.Element {
	const t = useT();
	const [lines, setLines] = useState<CloudContainerLogLine[] | null>(null);
	const [errorsOnly, setErrorsOnly] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const read = await run('containerLogs', { ref: projectRef, name, errorsOnly, limit: 200 }, setSaid);
			if (read) {
				setLines([...read].reverse());
				setSaid(null);
			}
		} finally {
			setLoading(false);
		}
	}, [projectRef, name, errorsOnly]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="cloud-container-logs">
			<div className="cloud-actions">
				<label className="check">
					<input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
					{t('cloudProjects.ctr.onlyStderr')}
				</label>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={loading} onClick={() => void load()}><Icon name="refresh" /> {t('cloudProjects.ctr.reload')}</button>
			</div>
			<Status said={said} />
			{lines === null && !said && <div className="field-hint">{t('cloudProjects.ctr.readingLog')}</div>}
			{lines !== null && lines.length === 0 && <p className="field-hint">{t('cloudProjects.ctr.noLog')}</p>}
			{lines !== null && lines.length > 0 && (
				<pre className="local-log">
					{lines.map((line) => `${line.at.slice(11, 19)} ${line.stream === 'stderr' ? '!' : ' '} ${line.message}`).join('\n')}
				</pre>
			)}
		</div>
	);
}

function DeployImage({ projectRef, onDeployed }: { projectRef: string; onDeployed(listing: CloudContainers): void }): JSX.Element {
	const t = useT();
	const [name, setName] = useState('');
	const [image, setImage] = useState('');
	const [port, setPort] = useState('8080');
	const [registryUser, setRegistryUser] = useState('');
	const [registryToken, setRegistryToken] = useState('');
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const parsed = parsePort(port);

	async function deploy(): Promise<void> {
		setBusy(true);
		setSaid(null);
		try {
			const user = registryUser.trim();
			const next = await run('deployContainer', {
				ref: projectRef,
				name: name.trim(),
				image: image.trim(),
				...(parsed.port === undefined ? {} : { port: parsed.port }),
				...(user ? { registryUser: user, registryPassword: registryToken } : {}),
			}, setSaid);
			if (next) {
				onDeployed(next);
				setSaid({ ok: true, message: t('cloudProjects.ctr.deployedMsg', { name: name.trim() }) });
				setRegistryToken('');
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>{t('cloudProjects.ctr.deployImage')}</legend>
			<label>{t('projects.common.name')}<input value={name} placeholder="whatsapp" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
			<label>{t('cloudProjects.ctr.image')}<input value={image} placeholder="ghcr.io/acme/whatsapp:1.2" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setImage(e.target.value)} /></label>
			<p className="field-hint">{t('cloudProjects.ctr.builtFor')}</p>
			<label>{t('cloudProjects.ctr.port')}<input value={port} inputMode="numeric" disabled={busy} onChange={(e) => setPort(e.target.value)} /></label>
			{parsed.problem && <div className="form-status error">{parsed.problem}</div>}
			<label>{t('cloudProjects.ctr.regUser')}<input value={registryUser} placeholder={t('cloudProjects.ctr.privateOnly')} spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setRegistryUser(e.target.value)} /></label>
			<label>{t('cloudProjects.ctr.regToken')}<input type="password" value={registryToken} autoComplete="new-password" disabled={busy} onChange={(e) => setRegistryToken(e.target.value)} /></label>
			<p className="field-hint">{t('cloudProjects.ctr.tokenHint')}</p>
			<div className="cloud-actions">
				<button type="button" disabled={busy || !name.trim() || !image.trim() || Boolean(parsed.problem)} onClick={() => void deploy()}>
					<Icon name="cloud-upload" /> {busy ? t('cloudProjects.ctr.deploying') : t('cloudProjects.ctr.deploy')}
				</button>
			</div>
			<Status said={said} />
		</fieldset>
	);
}

/** "Deploy from a folder": the folder's Dockerfile, built by the Docker on this computer. */
function DeployFolder({ projectRef, onDeployed }: { projectRef: string; onDeployed(listing: CloudContainers): void }): JSX.Element {
	const t = useT();
	const [folder, setFolder] = useState('');
	const [name, setName] = useState('');
	const [port, setPort] = useState('8080');
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const [lines, setLines] = useState<string[]>([]);
	const buildId = useRef('');
	const parsed = parsePort(port);

	useEffect(() => window.sqlApi.cloudContainers.onProgress((progress) => {
		if (progress.buildId === buildId.current) {
			setLines((prev) => [...prev, progress.line].slice(-400));
		}
	}), []);

	async function choose(): Promise<void> {
		const picked = await window.sqlApi.cloudContainers.pickFolder();
		if (picked) {
			setFolder(picked);
			if (!name) {
				const base = picked.split(/[\\/]/).filter(Boolean).pop() ?? '';
				setName(base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 32));
			}
		}
	}

	async function build(): Promise<void> {
		setBusy(true);
		setSaid(null);
		setLines([]);
		buildId.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			const outcome = await window.sqlApi.cloudContainers.build(projectRef, {
				name: name.trim(),
				folder,
				...(parsed.port === undefined ? {} : { port: parsed.port }),
			}, buildId.current);
			if (outcome.ok) {
				onDeployed(outcome.data);
				setSaid({ ok: true, message: t('cloudProjects.ctr.builtMsg', { name: name.trim() }) });
			} else {
				setSaid({ ok: false, refused: outcome.refused, message: outcome.message });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>{t('cloudProjects.ctr.fromFolder')}</legend>
			<p className="field-hint">
				{t('cloudProjects.ctr.folderIntro')}
			</p>
			<label>
				{t('localProjects.common.folder')}
				<span className="cloud-folder-pick">
					<input readOnly value={folder} placeholder={t('cloudProjects.ctr.noFolder')} />
					<button type="button" className="secondary" disabled={busy} onClick={() => void choose()}><Icon name="folder-opened" /> {t('cloudProjects.ctr.chooseFolder')}</button>
				</span>
			</label>
			<label>{t('projects.common.name')}<input value={name} placeholder="api" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
			<label>{t('cloudProjects.ctr.port')}<input value={port} inputMode="numeric" disabled={busy} onChange={(e) => setPort(e.target.value)} /></label>
			{parsed.problem && <div className="form-status error">{parsed.problem}</div>}
			<div className="cloud-actions">
				<button type="button" disabled={busy || !folder || !name.trim() || Boolean(parsed.problem)} onClick={() => void build()}>
					<Icon name="package" /> {busy ? t('cloudProjects.ctr.building') : t('cloudProjects.ctr.buildDeploy')}
				</button>
			</div>
			<Log lines={lines} />
			<Status said={said} />
		</fieldset>
	);
}

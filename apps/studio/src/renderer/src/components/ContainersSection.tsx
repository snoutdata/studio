/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Log, Status, type Said } from './projectUi';
import {
	gigabytes, isMoving, parsePort, redeployArgs, shortDigest,
	type CloudContainer, type CloudContainerLogLine, type CloudContainers, type ContainerStatus,
} from '../../../shared/cloudContainers';
import type { CloudProjectOp, CloudProjectOps } from '../../../shared/cloudProjects';

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
	pending: "Waiting for the host",
	pulling: "Pulling the image",
	starting: "Starting",
	running: "Running",
	restarting: "Restarting",
	failed: "Failed",
	stopped: "Stopped",
};

function when(iso: string | null): string {
	return iso ? new Date(iso).toLocaleString() : "unknown";
}

export function ContainersSection({ projectRef }: { projectRef: string }): JSX.Element {
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
				<legend>Containers</legend>
				<p className="field-hint">
					Your own image, running beside this project for as long as it runs, with <span className="mono">DATABASE_URL</span>, <span className="mono">PORT</span> and the project&apos;s secrets in its environment.
				</p>
				{allowance && allowance.maxContainers > 0 && (
					<div className="cloud-facts">
						<span className="muted">Plan</span>
						<span>{allowance.deployed} of {allowance.maxContainers} deployed, {allowance.memoryMb} MB{allowance.cpuPercent ? ` and ${allowance.cpuPercent}% of a core` : ''} each</span>
						{allowance.egress && allowance.egress.allowanceBytes > 0 && (
							<>
								<span className="muted">Sent this month</span>
								<span>{gigabytes(allowance.egress.usedBytes)} of {gigabytes(allowance.egress.allowanceBytes)}{allowance.egress.held ? " (stopped until the 1st)" : ''}</span>
							</>
						)}
					</div>
				)}
				{loading && !listing && <div className="field-hint">Loading…</div>}
				{noPlan && (
					<p className="field-hint">Containers run on the Plus and Pro plans, because a container runs all the time. Change this project&apos;s plan on the dashboard to deploy one.</p>
				)}
				{!noPlan && listing && containers.length === 0 && <p className="field-hint">This project runs no container yet. Deploy one below.</p>}
				{containers.length > 0 && (
					<div className="cloud-containers">
						{containers.map((container) => (
							<ContainerCard key={container.name} projectRef={projectRef} container={container} onChanged={setListing} />
						))}
					</div>
				)}
				<p className="field-hint">Anything written inside a container is lost when it restarts or is redeployed. Keep what matters in your database.</p>
				<div className="cloud-actions">
					<span className="spacer" />
					<button type="button" className="secondary" disabled={loading} onClick={() => void reload()}><Icon name="refresh" /> Refresh</button>
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
			setSaid({ ok: true, message: "Address copied." });
		} catch {
			setSaid({ ok: false, message: "The address could not be copied." });
		}
	}

	return (
		<div className="cloud-container">
			<div className="cloud-actions cloud-container-head">
				<span className={`cloud-dot ${tone(container)}`} aria-hidden="true" />
				<span className="mono">{container.name}</span>
				<span className="muted small" title={container.statusAt ? when(container.statusAt) : undefined}>
					{container.allowed ? STATUS_LABEL[container.status] ?? container.status : "Not covered by your plan"}
				</span>
				{container.restarts > 0 && <span className="muted small">restarted {container.restarts} {container.restarts === 1 ? "time" : "times"}</span>}
			</div>
			{container.statusDetail && <div className={container.status === 'failed' ? 'form-status error' : 'field-hint'}>{container.statusDetail}</div>}
			{!container.allowed && <p className="field-hint">This project&apos;s plan runs fewer containers than it has, so this one is stopped. It is kept as it was, and runs again if the plan allows it.</p>}
			<div className="cloud-facts">
				<span className="muted">Image</span>
				<span className="mono" title={container.digest}>{container.built ? "Built from a Dockerfile" : container.image} @ {shortDigest(container.digest)}</span>
				<span className="muted">Port</span>
				<span>{container.port}</span>
				<span className="muted">Address</span>
				<span className="mono">{container.url}</span>
				{container.privateRegistry && <><span className="muted">Registry</span><span>Private, with a stored login</span></>}
				{container.updatedAt && <><span className="muted">Deployed</span><span>{when(container.updatedAt)}</span></>}
			</div>
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={() => void act('restart')}><Icon name="debug-restart" /> Restart</button>
				<button
					type="button"
					className="secondary"
					disabled={busy}
					title={container.built ? "Start this build again from scratch" : "Resolve the tag again and run what it points at now"}
					onClick={() => void act('redeploy')}
				>
					<Icon name="cloud-upload" /> Redeploy
				</button>
				<button type="button" className="secondary" aria-pressed={showLogs} onClick={() => setShowLogs((on) => !on)}><Icon name="output" /> {showLogs ? "Hide logs" : "Logs"}</button>
				<button type="button" className="secondary" onClick={() => void copyUrl()}><Icon name="copy" /> Copy address</button>
				<span className="spacer" />
				{confirming ? (
					<>
						<span className="small cloud-container-confirm">Remove {container.name}? It stops at once.</span>
						<button type="button" className="danger" disabled={busy} onClick={() => void act('remove')}><Icon name="trash" /> Remove</button>
						<button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
					</>
				) : (
					<button type="button" className="danger" disabled={busy} onClick={() => setConfirming(true)}><Icon name="trash" /> Remove</button>
				)}
			</div>
			<Status said={said} />
			{showLogs && <ContainerLogs projectRef={projectRef} name={container.name} />}
		</div>
	);
}

function ContainerLogs({ projectRef, name }: { projectRef: string; name: string }): JSX.Element {
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
					Only stderr
				</label>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={loading} onClick={() => void load()}><Icon name="refresh" /> Reload</button>
			</div>
			<Status said={said} />
			{lines === null && !said && <div className="field-hint">Reading the log…</div>}
			{lines !== null && lines.length === 0 && <p className="field-hint">Nothing printed yet. Lines arrive about once a minute.</p>}
			{lines !== null && lines.length > 0 && (
				<pre className="local-log">
					{lines.map((line) => `${line.at.slice(11, 19)} ${line.stream === 'stderr' ? '!' : ' '} ${line.message}`).join('\n')}
				</pre>
			)}
		</div>
	);
}

function DeployImage({ projectRef, onDeployed }: { projectRef: string; onDeployed(listing: CloudContainers): void }): JSX.Element {
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
				setSaid({ ok: true, message: `${name.trim()} is deployed. The host pulls it and starts it within a minute.` });
				setRegistryToken('');
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Deploy an image</legend>
			<label>Name<input value={name} placeholder="whatsapp" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
			<label>Image<input value={image} placeholder="ghcr.io/acme/whatsapp:1.2" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setImage(e.target.value)} /></label>
			<p className="field-hint">Built for linux/arm64. The tag is resolved once, now, and that exact image runs until the next deploy.</p>
			<label>Port it listens on<input value={port} inputMode="numeric" disabled={busy} onChange={(e) => setPort(e.target.value)} /></label>
			{parsed.problem && <div className="form-status error">{parsed.problem}</div>}
			<label>Registry user<input value={registryUser} placeholder="Private images only" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setRegistryUser(e.target.value)} /></label>
			<label>Registry token<input type="password" value={registryToken} autoComplete="new-password" disabled={busy} onChange={(e) => setRegistryToken(e.target.value)} /></label>
			<p className="field-hint">The token is stored sealed and used only to pull. A redeploy of the same image reuses it.</p>
			<div className="cloud-actions">
				<button type="button" disabled={busy || !name.trim() || !image.trim() || Boolean(parsed.problem)} onClick={() => void deploy()}>
					<Icon name="cloud-upload" /> {busy ? "Deploying…" : "Deploy"}
				</button>
			</div>
			<Status said={said} />
		</fieldset>
	);
}

/** "Deploy from a folder": the folder's Dockerfile, built by the Docker on this computer. */
function DeployFolder({ projectRef, onDeployed }: { projectRef: string; onDeployed(listing: CloudContainers): void }): JSX.Element {
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
				setSaid({ ok: true, message: `${name.trim()} is built and deployed. The host starts it within a minute.` });
			} else {
				setSaid({ ok: false, refused: outcome.refused, message: outcome.message });
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<fieldset>
			<legend>Deploy from a folder</legend>
			<p className="field-hint">
				Builds the folder&apos;s Dockerfile for linux/arm64 with the Docker on this computer, uploads it to this project, and runs it. Nothing is built on our side, so Docker must be running here.
			</p>
			<label>
				Folder
				<span className="cloud-folder-pick">
					<input readOnly value={folder} placeholder="No folder chosen" />
					<button type="button" className="secondary" disabled={busy} onClick={() => void choose()}><Icon name="folder-opened" /> Choose folder…</button>
				</span>
			</label>
			<label>Name<input value={name} placeholder="api" spellCheck={false} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
			<label>Port it listens on<input value={port} inputMode="numeric" disabled={busy} onChange={(e) => setPort(e.target.value)} /></label>
			{parsed.problem && <div className="form-status error">{parsed.problem}</div>}
			<div className="cloud-actions">
				<button type="button" disabled={busy || !folder || !name.trim() || Boolean(parsed.problem)} onClick={() => void build()}>
					<Icon name="package" /> {busy ? "Building…" : "Build and deploy"}
				</button>
			</div>
			<Log lines={lines} />
			<Status said={said} />
		</fieldset>
	);
}

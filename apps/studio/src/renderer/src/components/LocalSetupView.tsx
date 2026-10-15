/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { LocalInstallOutcome, LocalProgress, LocalRequirements, LocalSetupForm } from '../../../shared/localStack';

/**
 * Set up a local project: the whole SnoutData stack in the user's own Docker, the way
 * github.com/snoutdata/snout-stack's README does it by hand, asked as a few questions instead of an
 * `.env` to edit.
 *
 * The settings page's shape: the steps down the left, one step's cards on the right. The first
 * step is the requirements, checked at once and checked again on request, each one that is not met
 * saying what to do about it; nothing past it opens until they pass.
 *
 * **It survives the tab being switched away.** The state lives at module level, and so does the
 * progress listener, so an install that takes minutes (the first image pull is about 670 MB, 1.9 GB on disk) is still
 * on screen when the user comes back to the tab.
 */
interface LocalSetupViewProps {
	onOpenProject(id: string, name: string): void;
	onOpenDatabase(id: string): void;
}

type Step = 'check' | 'project' | 'auth' | 'storage' | 'review' | 'install';

const STEPS: ReadonlyArray<{ id: Step; label: string; icon: string }> = [
	{ id: 'check', label: "Requirements", icon: 'checklist' },
	{ id: 'project', label: "Project", icon: 'folder' },
	{ id: 'auth', label: "Sign-in and mail", icon: 'shield' },
	{ id: 'storage', label: "Files", icon: 'files' },
	{ id: 'review', label: "Review", icon: 'eye' },
	{ id: 'install', label: "Install", icon: 'rocket' },
];

const INSTALL_STEPS: ReadonlyArray<{ id: LocalProgress['step']; label: string }> = [
	{ id: 'download', label: "Download the stack" },
	{ id: 'keys', label: "Make the keys and passwords" },
	{ id: 'pull', label: "Download the images" },
	{ id: 'start', label: "Start the services" },
];

interface WizardState {
	step: Step;
	form: LocalSetupForm;
	/** The folder was typed or picked, so a new name no longer moves it. */
	folderTouched: boolean;
	smtpOn: boolean;
	installId: string | null;
	/** The install steps reached, and the one that failed. */
	reached: Set<LocalProgress['step']>;
	failedAt: LocalProgress['step'] | null;
	lines: string[];
	outcome: LocalInstallOutcome | null;
}

function freshState(): WizardState {
	return {
		step: 'check',
		form: {
			name: '',
			folder: '',
			apiPort: 8000,
			dbPort: 54322,
			exposeApi: false,
			siteUrl: 'http://localhost:3000',
			autoconfirm: true,
			disableSignup: false,
			bundledStorage: true,
			images: true,
			addConnection: true,
			smtp: { host: '', port: 587, user: '', pass: '', adminEmail: '', senderName: '' },
			s3: { endpoint: '', bucket: '', region: 'us-east-1', accessKey: '', secretKey: '' },
		},
		folderTouched: false,
		smtpOn: false,
		installId: null,
		reached: new Set(),
		failedAt: null,
		lines: [],
		outcome: null,
	};
}

/** The wizard outlives its tab's component: see the doc comment above. */
let saved: WizardState = freshState();
const listeners = new Set<() => void>();
let progressHooked = false;

function hookProgress(): void {
	if (progressHooked) {
		return;
	}
	progressHooked = true;
	window.sqlApi.local.onProgress((p) => {
		if (!saved.installId || p.installId !== saved.installId) {
			return;
		}
		const reached = new Set(saved.reached);
		let failedAt = saved.failedAt;
		let lines = saved.lines;
		if (p.line) {
			lines = [...lines, p.line].slice(-400);
		} else if (p.step === 'failed') {
			failedAt = [...INSTALL_STEPS].reverse().find((s) => reached.has(s.id))?.id ?? 'download';
		} else {
			reached.add(p.step);
		}
		saved = { ...saved, reached, failedAt, lines };
		listeners.forEach((l) => l());
	});
}

const MAX_LOG_LINES = 400;

export function LocalSetupView(props: LocalSetupViewProps): JSX.Element {
	const [state, setStateRaw] = useState<WizardState>(saved);
	const [requirements, setRequirements] = useState<LocalRequirements | null>(null);
	const [checking, setChecking] = useState(false);
	const [engineNote, setEngineNote] = useState<string | null>(null);
	const [portsBusy, setPortsBusy] = useState<number[]>([]);
	const [problem, setProblem] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const logRef = useRef<HTMLPreElement | null>(null);

	const setState = useCallback((change: Partial<WizardState> | ((s: WizardState) => Partial<WizardState>)) => {
		saved = { ...saved, ...(typeof change === 'function' ? change(saved) : change) };
		setStateRaw(saved);
	}, []);

	useEffect(() => {
		hookProgress();
		const sync = (): void => setStateRaw(saved);
		listeners.add(sync);
		return () => {
			listeners.delete(sync);
		};
	}, []);

	const check = useCallback(async () => {
		setChecking(true);
		try {
			const result = await window.sqlApi.local.requirements();
			setRequirements(result);
			if (result.ready && pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
				setEngineNote(null);
			}
			return result;
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void check();
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
			}
		};
	}, [check]);

	// The folder and the ports, once: a default folder under the home folder, and ports nobody holds.
	useEffect(() => {
		if (saved.form.folder) {
			return;
		}
		void window.sqlApi.local.defaults(saved.form.name).then((d) => {
			setState((s) => ({ form: { ...s.form, folder: s.folderTouched ? s.form.folder : d.folder, apiPort: d.apiPort, dbPort: d.dbPort } }));
		});
	}, [setState]);

	// A new name moves the default folder with it, until the user chose one.
	useEffect(() => {
		if (state.folderTouched || !state.form.name.trim()) {
			return;
		}
		const timer = setTimeout(() => {
			void window.sqlApi.local.defaults(state.form.name).then((d) => {
				setState((s) => (s.folderTouched ? {} : { form: { ...s.form, folder: d.folder } }));
			});
		}, 300);
		return () => clearTimeout(timer);
	}, [state.form.name, state.folderTouched, setState]);

	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [state.lines.length]);

	function setForm(change: Partial<LocalSetupForm>): void {
		setState((s) => ({ form: { ...s.form, ...change } }));
	}

	async function startEngine(): Promise<void> {
		const outcome = await window.sqlApi.local.startEngine();
		setEngineNote(outcome.message);
		if (!outcome.ok || pollRef.current) {
			return;
		}
		const started = Date.now();
		pollRef.current = setInterval(() => {
			if (Date.now() - started > 3 * 60 * 1000) {
				if (pollRef.current) {
					clearInterval(pollRef.current);
					pollRef.current = null;
				}
				setEngineNote("Docker has not answered after three minutes. When it says it is running, check again.");
				return;
			}
			void check();
		}, 4000);
	}

	async function checkPorts(): Promise<void> {
		setPortsBusy(await window.sqlApi.local.portsInUse([state.form.apiPort, state.form.dbPort]));
	}

	async function install(): Promise<void> {
		const installId = crypto.randomUUID();
		setState({ step: 'install', installId, reached: new Set(), failedAt: null, lines: [], outcome: null });
		const form: LocalSetupForm = {
			...state.form,
			smtp: state.smtpOn ? state.form.smtp : undefined,
			s3: state.form.bundledStorage ? undefined : state.form.s3,
		};
		let outcome: LocalInstallOutcome;
		try {
			outcome = await window.sqlApi.local.install(form, installId);
		} catch (error) {
			outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
		setState((s) => ({ outcome, failedAt: outcome.ok ? null : s.failedAt ?? 'download' }));
	}

	const form = state.form;
	const ready = requirements?.ready === true;
	const installing = state.step === 'install' && state.installId !== null && state.outcome === null;
	const done = state.outcome?.ok === true;

	/** What stops "Next" on the current step, or null. */
	function blocker(step: Step): string | null {
		switch (step) {
			case 'check': return ready ? null : "Every requirement must pass first.";
			case 'project':
				if (!form.name.trim()) {
					return "Give the project a name.";
				}
				if (!form.folder.trim()) {
					return "Choose a folder.";
				}
				if (form.apiPort === form.dbPort) {
					return "The API and the database need different ports.";
				}
				if (portsBusy.includes(form.apiPort) || portsBusy.includes(form.dbPort)) {
					return "A port is in use. Choose another.";
				}
				return /^https?:\/\/\S+$/.test(form.siteUrl.trim()) ? null : "Site URL must start with http:// or https://.";
			case 'auth':
				return state.smtpOn && (!form.smtp?.host.trim() || !form.smtp.adminEmail.trim()) ? "Give the mail server and the address mail is sent from." : null;
			case 'storage': {
				const s3 = form.s3;
				return !form.bundledStorage && (!s3 || !s3.endpoint.trim() || !s3.bucket.trim() || !s3.accessKey || !s3.secretKey) ? "Give your S3 endpoint, bucket and keys." : null;
			}
			default: return null;
		}
	}

	const order = STEPS.map((s) => s.id);
	const index = order.indexOf(state.step);
	/** A step can be visited when every step before it is clear, and never during an install. */
	function reachable(step: Step): boolean {
		if (installing || done) {
			return step === 'install';
		}
		if (step === 'install') {
			return state.installId !== null;
		}
		const i = order.indexOf(step);
		return order.slice(0, i).every((s) => s === 'install' || blocker(s) === null);
	}

	async function next(): Promise<void> {
		setProblem(null);
		if (state.step === 'project') {
			const busy = await window.sqlApi.local.portsInUse([form.apiPort, form.dbPort]);
			setPortsBusy(busy);
			if (busy.length > 0) {
				setProblem(`Port ${busy.join(" and ")} is in use on this computer. Choose another.`);
				return;
			}
		}
		const why = blocker(state.step);
		if (why) {
			setProblem(why);
			return;
		}
		setState({ step: order[index + 1] });
	}

	function restart(): void {
		saved = freshState();
		setStateRaw(saved);
		setProblem(null);
		void window.sqlApi.local.defaults('').then((d) => setState((s) => ({ form: { ...s.form, folder: d.folder, apiPort: d.apiPort, dbPort: d.dbPort } })));
		void check();
	}

	return (
		<div className="cloud-project-view">
			<div className="settings-main">
				<nav className="settings-nav">
					<div className="cloud-project-nav-head">
						<Icon name="device-desktop" />
						<span className="cloud-project-nav-name">{form.name.trim() || "New local project"}</span>
					</div>
					{STEPS.map((s, i) => (
						<button
							key={s.id}
							type="button"
							className={`settings-nav-item${s.id === state.step ? ' active' : ''}`}
							disabled={!reachable(s.id)}
							onClick={() => { setProblem(null); setState({ step: s.id }); }}
						>
							<Icon name={s.icon} className="settings-nav-icon" />
							<span>{i + 1}. {s.label}</span>
						</button>
					))}
				</nav>
				<div className="settings-content local-setup">
					<h3 className="settings-section-title">{STEPS[index].label}</h3>

					{state.step === 'check' && (
						<>
							<p className="field-hint">
								A local project is the whole SnoutData stack on this computer: Postgres, auth, the data API, storage,
								Realtime and functions behind one port. It runs in Docker, so that comes first.
							</p>
							<fieldset>
								<legend>This computer</legend>
								{!requirements && <div className="field-hint">Checking…</div>}
								{requirements?.items.map((item) => (
									<div key={item.id} className="local-requirement">
										<Icon
											name={item.status === 'ok' ? 'pass-filled' : item.status === 'warn' ? 'warning' : 'error'}
											className={`local-requirement-icon ${item.status}`}
										/>
										<div className="local-requirement-body">
											<div><strong>{item.label}</strong> <span className="muted">{item.detail}</span></div>
											{item.advice && <div className="field-hint">{item.advice}</div>}
											{(item.link || item.canStartEngine) && (
												<div className="cloud-actions">
													{item.canStartEngine && <button type="button" onClick={() => void startEngine()}><Icon name="play" /> Start Docker Desktop</button>}
													{item.link && <button type="button" className="secondary" onClick={() => void window.sqlApi.local.openUrl(item.link?.url ?? '')}>{item.link.label}</button>}
												</div>
											)}
										</div>
									</div>
								))}
								{engineNote && <div className="field-hint">{engineNote}</div>}
								<div className="cloud-actions">
									<button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
										<Icon name={checking ? 'loading' : 'refresh'} className={checking ? 'codicon-modifier-spin' : ''} /> Check again
									</button>
								</div>
							</fieldset>
						</>
					)}

					{state.step === 'project' && (
						<>
							<fieldset>
								<legend>Project</legend>
								<label>
									Name
									<input value={form.name} onChange={(e) => setForm({ name: e.target.value })} placeholder="my-app" maxLength={60} autoFocus />
								</label>
								<label>
									Folder
									<div className="local-folder-row">
										<input
											value={form.folder}
											onChange={(e) => { setState({ folderTouched: true }); setForm({ folder: e.target.value }); }}
										/>
										<button
											type="button"
											className="secondary"
											onClick={async () => {
												const picked = await window.sqlApi.local.pickFolder(form.folder);
												if (picked) {
													setState({ folderTouched: true });
													setForm({ folder: picked });
												}
											}}
										>
											<Icon name="folder-opened" /> Browse…
										</button>
									</div>
								</label>
								<p className="field-hint">A new or empty folder. It gets the stack's compose.yaml, a .env with this project's keys, and functions/ for your code. Back up .env with your data: it is the only copy of the keys.</p>
								<label className="check">
									<input type="checkbox" checked={form.addConnection} onChange={(e) => setForm({ addConnection: e.target.checked })} /> Add the database to Connections
								</label>
							</fieldset>
							<fieldset>
								<legend>Network</legend>
								<div className="local-port-grid">
									<label>
										API port
										<input type="number" min={1024} max={65535} value={form.apiPort} onChange={(e) => setForm({ apiPort: Number(e.target.value) })} onBlur={() => void checkPorts()} />
									</label>
									<label>
										Database port
										<input type="number" min={1024} max={65535} value={form.dbPort} onChange={(e) => setForm({ dbPort: Number(e.target.value) })} onBlur={() => void checkPorts()} />
									</label>
								</div>
								{portsBusy.length > 0 && <div className="form-status warn">Port {portsBusy.join(" and ")} is in use on this computer.</div>}
								<p className="field-hint">Your app talks to http://localhost:{form.apiPort || "…"}. The database is on this computer only, at 127.0.0.1:{form.dbPort || "…"}.</p>
								<label className="check">
									<input type="checkbox" checked={form.exposeApi} onChange={(e) => setForm({ exposeApi: e.target.checked })} /> Reachable from other devices on my network
								</label>
								<p className="field-hint">Off, only this computer can call the API. On, a phone or another machine on the same network can, which is what testing a mobile app needs.</p>
								<label>
									Site URL
									<input value={form.siteUrl} onChange={(e) => setForm({ siteUrl: e.target.value })} placeholder="http://localhost:3000" />
								</label>
								<p className="field-hint">Where your app runs: where a user lands after a sign-in or confirmation link.</p>
							</fieldset>
						</>
					)}

					{state.step === 'auth' && (
						<>
							<fieldset>
								<legend>Sign-ups</legend>
								<label className="check">
									<input type="checkbox" checked={form.autoconfirm} onChange={(e) => setForm({ autoconfirm: e.target.checked })} /> Confirm new users without an email
								</label>
								<p className="field-hint">Recommended on this computer: without a mail server nobody can click a confirmation link, so nobody could sign in.</p>
								<label className="check">
									<input type="checkbox" checked={form.disableSignup} onChange={(e) => setForm({ disableSignup: e.target.checked })} /> Refuse new sign-ups
								</label>
								<p className="field-hint">Only users you invite or create can sign in.</p>
							</fieldset>
							<fieldset>
								<legend>Mail</legend>
								<label className="check">
									<input type="checkbox" checked={state.smtpOn} onChange={(e) => setState({ smtpOn: e.target.checked })} /> Send mail through a mail server
								</label>
								<p className="field-hint">For confirmation links, password resets and one-time codes. You can add this later in the project's settings.</p>
								{state.smtpOn && form.smtp && (
									<>
										<div className="local-port-grid">
											<label>
												Server
												<input value={form.smtp.host} onChange={(e) => setForm({ smtp: { ...form.smtp!, host: e.target.value } })} placeholder="smtp.example.com" />
											</label>
											<label>
												Port
												<input type="number" value={form.smtp.port} onChange={(e) => setForm({ smtp: { ...form.smtp!, port: Number(e.target.value) } })} />
											</label>
										</div>
										<label>
											User
											<input value={form.smtp.user} onChange={(e) => setForm({ smtp: { ...form.smtp!, user: e.target.value } })} autoComplete="off" />
										</label>
										<label>
											Password
											<input type="password" value={form.smtp.pass} onChange={(e) => setForm({ smtp: { ...form.smtp!, pass: e.target.value } })} autoComplete="new-password" />
										</label>
										<label>
											Send from
											<input value={form.smtp.adminEmail} onChange={(e) => setForm({ smtp: { ...form.smtp!, adminEmail: e.target.value } })} placeholder="no-reply@example.com" />
										</label>
										<label>
											Sender name
											<input value={form.smtp.senderName} onChange={(e) => setForm({ smtp: { ...form.smtp!, senderName: e.target.value } })} placeholder="My App" />
										</label>
									</>
								)}
							</fieldset>
						</>
					)}

					{state.step === 'storage' && (
						<fieldset>
							<legend>Where files are kept</legend>
							<label className="check">
								<input type="checkbox" checked={form.bundledStorage} onChange={(e) => setForm({ bundledStorage: e.target.checked })} /> Keep files on this computer
							</label>
							<p className="field-hint">The stack brings its own object store, in a Docker volume. Off, files go to an S3 bucket of yours (AWS, R2, MinIO, …), which must exist already.</p>
							{!form.bundledStorage && form.s3 && (
								<>
									<label>
										Endpoint
										<input value={form.s3.endpoint} onChange={(e) => setForm({ s3: { ...form.s3!, endpoint: e.target.value } })} placeholder="https://s3.us-east-1.amazonaws.com" />
									</label>
									<div className="local-port-grid">
										<label>
											Bucket
											<input value={form.s3.bucket} onChange={(e) => setForm({ s3: { ...form.s3!, bucket: e.target.value } })} />
										</label>
										<label>
											Region
											<input value={form.s3.region} onChange={(e) => setForm({ s3: { ...form.s3!, region: e.target.value } })} />
										</label>
									</div>
									<label>
										Access key
										<input value={form.s3.accessKey} onChange={(e) => setForm({ s3: { ...form.s3!, accessKey: e.target.value } })} autoComplete="off" />
									</label>
									<label>
										Secret key
										<input type="password" value={form.s3.secretKey} onChange={(e) => setForm({ s3: { ...form.s3!, secretKey: e.target.value } })} autoComplete="new-password" />
									</label>
								</>
							)}
							<label className="check">
								<input type="checkbox" checked={form.images} onChange={(e) => setForm({ images: e.target.checked })} /> Resize images
							</label>
							<p className="field-hint">Storage's image transformations (thumbnails, format conversion). Off saves one container.</p>
						</fieldset>
					)}

					{state.step === 'review' && (
						<>
							<fieldset>
								<legend>What will be set up</legend>
								<div className="cloud-facts">
									<span className="muted">Name</span><span>{form.name}</span>
									<span className="muted">Folder</span><span className="mono">{form.folder}</span>
									<span className="muted">API</span><span className="mono">http://localhost:{form.apiPort}{form.exposeApi ? " (and your network)" : ''}</span>
									<span className="muted">Database</span><span className="mono">127.0.0.1:{form.dbPort}</span>
									<span className="muted">Site URL</span><span className="mono">{form.siteUrl}</span>
									<span className="muted">Sign-ups</span><span>{form.disableSignup ? "Refused" : form.autoconfirm ? "Confirmed without email" : "Confirmed by email"}</span>
									<span className="muted">Mail</span><span>{state.smtpOn ? form.smtp?.host : "None"}</span>
									<span className="muted">Files</span><span>{form.bundledStorage ? "On this computer" : `${form.s3?.bucket} at ${form.s3?.endpoint}`}{form.images ? ", images resized" : ''}</span>
									<span className="muted">Connection</span><span>{form.addConnection ? "Added to Connections" : "Not added"}</span>
								</div>
							</fieldset>
							<p className="field-hint">
								The first setup downloads about 670 MB of images (1.9 GB on disk), which takes a few minutes. Once started it uses about 170 MB of memory idle, and about 360 MB under load.
								Every key and password is made for this project alone and written to {form.folder}{form.folder.includes('\\') ? '\\' : '/'}.env.
							</p>
						</>
					)}

					{state.step === 'install' && (
						<>
							<fieldset>
								<legend>{done ? "Ready" : state.outcome && !state.outcome.ok ? "It stopped" : "Setting up"}</legend>
								<div className="local-install-steps">
									{INSTALL_STEPS.map((s) => {
										const failed = state.failedAt === s.id;
										const reachedIt = state.reached.has(s.id);
										const later = INSTALL_STEPS.slice(INSTALL_STEPS.findIndex((x) => x.id === s.id) + 1).some((x) => state.reached.has(x.id));
										const finished = done || later;
										const icon = failed ? 'error' : finished ? 'pass-filled' : reachedIt ? 'loading' : 'circle-large-outline';
										return (
											<div key={s.id} className={`local-install-step${reachedIt ? ' reached' : ''}`}>
												<Icon name={icon} className={`local-requirement-icon ${failed ? 'fail' : finished ? 'ok' : ''} ${icon === 'loading' ? 'codicon-modifier-spin' : ''}`} />
												<span>{s.label}</span>
											</div>
										);
									})}
								</div>
								{state.outcome && <div className={state.outcome.ok ? 'field-hint' : 'form-status error'}>{state.outcome.message}</div>}
								<div className="cloud-actions">
									{state.outcome?.id && (
										<button type="button" onClick={() => props.onOpenProject(state.outcome!.id!, form.name.trim())}><Icon name="arrow-right" /> Open project</button>
									)}
									{done && form.addConnection && state.outcome?.id && (
										<button type="button" className="secondary" onClick={() => props.onOpenDatabase(state.outcome!.id!)}><Icon name="database" /> Open in Connections</button>
									)}
									<span className="spacer" />
									{state.outcome && !state.outcome.ok && !state.outcome.id && (
										<button type="button" className="secondary" onClick={() => setState({ step: 'review', installId: null, outcome: null })}><Icon name="arrow-left" /> Back</button>
									)}
									{state.outcome && <button type="button" className="secondary" onClick={restart}><Icon name="add" /> Set up another</button>}
								</div>
								{state.outcome && !state.outcome.ok && state.outcome.id && (
									<p className="field-hint">The project is set up in its folder and listed under Local. Start it from there once the problem is fixed.</p>
								)}
							</fieldset>
							{state.lines.length > 0 && (
								<fieldset>
									<legend>Docker's output</legend>
									<pre className="local-log" ref={logRef}>{state.lines.slice(-MAX_LOG_LINES).join('\n')}</pre>
								</fieldset>
							)}
						</>
					)}

					{state.step !== 'install' && (
						<>
							{problem && <div className="form-status warn">{problem}</div>}
							<div className="modal-actions">
								{index > 0 && <button type="button" className="secondary" onClick={() => { setProblem(null); setState({ step: order[index - 1] }); }}><Icon name="arrow-left" /> Back</button>}
								<span className="spacer" />
								{state.step === 'review'
									? <button type="button" onClick={() => void install()}><Icon name="rocket" /> Set up and start</button>
									: <button type="button" disabled={state.step === 'check' && !ready} onClick={() => void next()}><Icon name="chevron-right" /> Next</button>}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

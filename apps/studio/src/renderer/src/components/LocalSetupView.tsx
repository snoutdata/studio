/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { LocalInstallOutcome, LocalProgress, LocalRequirements, LocalSetupForm } from '../../../shared/localStack';
import { t, useT } from '../i18n';

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
	{ id: 'check', get label() { return t('localProjects.setup.stepRequirements'); }, icon: 'checklist' },
	{ id: 'project', get label() { return t('projects.common.project'); }, icon: 'folder' },
	{ id: 'auth', get label() { return t('localProjects.setup.stepAuth'); }, icon: 'shield' },
	{ id: 'storage', get label() { return t('localProjects.common.files'); }, icon: 'files' },
	{ id: 'review', get label() { return t('localProjects.setup.stepReview'); }, icon: 'eye' },
	{ id: 'install', get label() { return t('localProjects.setup.stepInstall'); }, icon: 'rocket' },
];

const INSTALL_STEPS: ReadonlyArray<{ id: LocalProgress['step']; label: string }> = [
	{ id: 'download', get label() { return t('localProjects.setup.downloadStack'); } },
	{ id: 'keys', get label() { return t('localProjects.setup.makeKeys'); } },
	{ id: 'pull', get label() { return t('localProjects.setup.downloadImages'); } },
	{ id: 'start', get label() { return t('localProjects.setup.startServices'); } },
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
	const t = useT();
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
				setEngineNote(t('localProjects.setup.dockerTimeout'));
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
			case 'check': return ready ? null : t('localProjects.setup.mustPass');
			case 'project':
				if (!form.name.trim()) {
					return t('localProjects.setup.giveName');
				}
				if (!form.folder.trim()) {
					return t('localProjects.setup.chooseFolder');
				}
				if (form.apiPort === form.dbPort) {
					return t('localProjects.setup.diffPorts');
				}
				if (portsBusy.includes(form.apiPort) || portsBusy.includes(form.dbPort)) {
					return t('localProjects.setup.portBusy');
				}
				return /^https?:\/\/\S+$/.test(form.siteUrl.trim()) ? null : t('localProjects.setup.siteUrlBad');
			case 'auth':
				return state.smtpOn && (!form.smtp?.host.trim() || !form.smtp.adminEmail.trim()) ? t('localProjects.setup.mailNeeded') : null;
			case 'storage': {
				const s3 = form.s3;
				return !form.bundledStorage && (!s3 || !s3.endpoint.trim() || !s3.bucket.trim() || !s3.accessKey || !s3.secretKey) ? t('localProjects.setup.s3Needed') : null;
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
				setProblem(t('localProjects.setup.portBusyLong', { ports: busy.join(t('localProjects.setup.and')) }));
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
						<span className="cloud-project-nav-name">{form.name.trim() || t('localProjects.setup.newTitle')}</span>
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
								{t('localProjects.setup.intro')}
							</p>
							<fieldset>
								<legend>{t('localProjects.setup.thisComputer')}</legend>
								{!requirements && <div className="field-hint">{t('localProjects.setup.checking')}</div>}
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
													{item.canStartEngine && <button type="button" onClick={() => void startEngine()}><Icon name="play" /> {t('localProjects.setup.startDocker')}</button>}
													{item.link && <button type="button" className="secondary" onClick={() => void window.sqlApi.local.openUrl(item.link?.url ?? '')}>{item.link.label}</button>}
												</div>
											)}
										</div>
									</div>
								))}
								{engineNote && <div className="field-hint">{engineNote}</div>}
								<div className="cloud-actions">
									<button type="button" className="secondary" disabled={checking} onClick={() => void check()}>
										<Icon name={checking ? 'loading' : 'refresh'} className={checking ? 'codicon-modifier-spin' : ''} /> {t('localProjects.setup.checkAgain')}
									</button>
								</div>
							</fieldset>
						</>
					)}

					{state.step === 'project' && (
						<>
							<fieldset>
								<legend>{t('projects.common.project')}</legend>
								<label>
									{t('projects.common.name')}
									<input value={form.name} onChange={(e) => setForm({ name: e.target.value })} placeholder="my-app" maxLength={60} autoFocus />
								</label>
								<label>
									{t('localProjects.common.folder')}
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
											<Icon name="folder-opened" /> {t('localProjects.setup.browse')}
										</button>
									</div>
								</label>
								<p className="field-hint">{t('localProjects.setup.folderHint')}</p>
								<label className="check">
									<input type="checkbox" checked={form.addConnection} onChange={(e) => setForm({ addConnection: e.target.checked })} /> {t('localProjects.setup.addConnection')}
								</label>
							</fieldset>
							<fieldset>
								<legend>{t('localProjects.setup.network')}</legend>
								<div className="local-port-grid">
									<label>
										{t('localProjects.setup.apiPort')}
										<input type="number" min={1024} max={65535} value={form.apiPort} onChange={(e) => setForm({ apiPort: Number(e.target.value) })} onBlur={() => void checkPorts()} />
									</label>
									<label>
										{t('localProjects.setup.dbPort')}
										<input type="number" min={1024} max={65535} value={form.dbPort} onChange={(e) => setForm({ dbPort: Number(e.target.value) })} onBlur={() => void checkPorts()} />
									</label>
								</div>
								{portsBusy.length > 0 && <div className="form-status warn">{t('localProjects.setup.portBusyShort', { ports: portsBusy.join(t('localProjects.setup.and')) })}</div>}
								<p className="field-hint">{t('localProjects.setup.portsTalk', { api: form.apiPort || "…", db: form.dbPort || "…" })}</p>
								<label className="check">
									<input type="checkbox" checked={form.exposeApi} onChange={(e) => setForm({ exposeApi: e.target.checked })} /> {t('localProjects.setup.lanAccess')}
								</label>
								<p className="field-hint">{t('localProjects.setup.lanHint')}</p>
								<label>
									{t('localProjects.setup.siteUrl')}
									<input value={form.siteUrl} onChange={(e) => setForm({ siteUrl: e.target.value })} placeholder="http://localhost:3000" />
								</label>
								<p className="field-hint">{t('localProjects.setup.siteHint')}</p>
							</fieldset>
						</>
					)}

					{state.step === 'auth' && (
						<>
							<fieldset>
								<legend>{t('localProjects.setup.signups')}</legend>
								<label className="check">
									<input type="checkbox" checked={form.autoconfirm} onChange={(e) => setForm({ autoconfirm: e.target.checked })} /> {t('localProjects.setup.autoconfirm')}
								</label>
								<p className="field-hint">{t('localProjects.setup.autoHint')}</p>
								<label className="check">
									<input type="checkbox" checked={form.disableSignup} onChange={(e) => setForm({ disableSignup: e.target.checked })} /> {t('localProjects.setup.disableSignup')}
								</label>
								<p className="field-hint">{t('localProjects.setup.inviteOnly')}</p>
							</fieldset>
							<fieldset>
								<legend>{t('localProjects.setup.mail')}</legend>
								<label className="check">
									<input type="checkbox" checked={state.smtpOn} onChange={(e) => setState({ smtpOn: e.target.checked })} /> {t('localProjects.setup.sendMail')}
								</label>
								<p className="field-hint">{t('localProjects.setup.mailHint')}</p>
								{state.smtpOn && form.smtp && (
									<>
										<div className="local-port-grid">
											<label>
												{t('localProjects.common.server')}
												<input value={form.smtp.host} onChange={(e) => setForm({ smtp: { ...form.smtp!, host: e.target.value } })} placeholder="smtp.example.com" />
											</label>
											<label>
												{t('projects.common.port')}
												<input type="number" value={form.smtp.port} onChange={(e) => setForm({ smtp: { ...form.smtp!, port: Number(e.target.value) } })} />
											</label>
										</div>
										<label>
											{t('projects.common.user')}
											<input value={form.smtp.user} onChange={(e) => setForm({ smtp: { ...form.smtp!, user: e.target.value } })} autoComplete="off" />
										</label>
										<label>
											{t('projects.common.password')}
											<input type="password" value={form.smtp.pass} onChange={(e) => setForm({ smtp: { ...form.smtp!, pass: e.target.value } })} autoComplete="new-password" />
										</label>
										<label>
											{t('localProjects.setup.sendFrom')}
											<input value={form.smtp.adminEmail} onChange={(e) => setForm({ smtp: { ...form.smtp!, adminEmail: e.target.value } })} placeholder="no-reply@example.com" />
										</label>
										<label>
											{t('localProjects.setup.senderName')}
											<input value={form.smtp.senderName} onChange={(e) => setForm({ smtp: { ...form.smtp!, senderName: e.target.value } })} placeholder={t('localProjects.setup.myApp')} />
										</label>
									</>
								)}
							</fieldset>
						</>
					)}

					{state.step === 'storage' && (
						<fieldset>
							<legend>{t('localProjects.setup.filesWhere')}</legend>
							<label className="check">
								<input type="checkbox" checked={form.bundledStorage} onChange={(e) => setForm({ bundledStorage: e.target.checked })} /> {t('localProjects.setup.bundled')}
							</label>
							<p className="field-hint">{t('localProjects.setup.bundledHint')}</p>
							{!form.bundledStorage && form.s3 && (
								<>
									<label>
										{t('projects.dataApi.endpoint')}
										<input value={form.s3.endpoint} onChange={(e) => setForm({ s3: { ...form.s3!, endpoint: e.target.value } })} placeholder="https://s3.us-east-1.amazonaws.com" />
									</label>
									<div className="local-port-grid">
										<label>
											{t('projects.ts.bucket')}
											<input value={form.s3.bucket} onChange={(e) => setForm({ s3: { ...form.s3!, bucket: e.target.value } })} />
										</label>
										<label>
											{t('cloudProjects.status.region')}
											<input value={form.s3.region} onChange={(e) => setForm({ s3: { ...form.s3!, region: e.target.value } })} />
										</label>
									</div>
									<label>
										{t('localProjects.setup.accessKey')}
										<input value={form.s3.accessKey} onChange={(e) => setForm({ s3: { ...form.s3!, accessKey: e.target.value } })} autoComplete="off" />
									</label>
									<label>
										{t('localProjects.setup.secretKey')}
										<input type="password" value={form.s3.secretKey} onChange={(e) => setForm({ s3: { ...form.s3!, secretKey: e.target.value } })} autoComplete="new-password" />
									</label>
								</>
							)}
							<label className="check">
								<input type="checkbox" checked={form.images} onChange={(e) => setForm({ images: e.target.checked })} /> {t('localProjects.setup.resize')}
							</label>
							<p className="field-hint">{t('localProjects.setup.resizeHint')}</p>
						</fieldset>
					)}

					{state.step === 'review' && (
						<>
							<fieldset>
								<legend>{t('localProjects.setup.whatSetUp')}</legend>
								<div className="cloud-facts">
									<span className="muted">{t('projects.common.name')}</span><span>{form.name}</span>
									<span className="muted">{t('localProjects.common.folder')}</span><span className="mono">{form.folder}</span>
									<span className="muted">API</span><span className="mono">http://localhost:{form.apiPort}{form.exposeApi ? t('localProjects.setup.andNetwork') : ''}</span>
									<span className="muted">{t('localProjects.common.database')}</span><span className="mono">127.0.0.1:{form.dbPort}</span>
									<span className="muted">{t('localProjects.setup.siteUrl')}</span><span className="mono">{form.siteUrl}</span>
									<span className="muted">{t('localProjects.setup.signups')}</span><span>{form.disableSignup ? t('localProjects.setup.refused') : form.autoconfirm ? t('localProjects.setup.confirmedNoEmail') : t('localProjects.setup.confirmedByEmail')}</span>
									<span className="muted">{t('localProjects.setup.mail')}</span><span>{state.smtpOn ? form.smtp?.host : t('localProjects.setup.none')}</span>
									<span className="muted">{t('localProjects.common.files')}</span><span>{form.bundledStorage ? t('localProjects.setup.onComputer') : t('localProjects.setup.s3At', { bucket: form.s3?.bucket ?? '', endpoint: form.s3?.endpoint ?? '' })}{form.images ? t('localProjects.setup.imagesResized') : ''}</span>
									<span className="muted">{t('cloudProjects.conn.title')}</span><span>{form.addConnection ? t('localProjects.setup.addedConn') : t('localProjects.setup.notAdded')}</span>
								</div>
							</fieldset>
							<p className="field-hint">
								{t('localProjects.setup.size', { folder: form.folder, sep: form.folder.includes('\\') ? '\\' : '/' })}
							</p>
						</>
					)}

					{state.step === 'install' && (
						<>
							<fieldset>
								<legend>{done ? t('localProjects.setup.ready') : state.outcome && !state.outcome.ok ? t('localProjects.setup.stopped') : t('localProjects.setup.settingUp')}</legend>
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
										<button type="button" onClick={() => props.onOpenProject(state.outcome!.id!, form.name.trim())}><Icon name="arrow-right" /> {t('localProjects.setup.openProject')}</button>
									)}
									{done && form.addConnection && state.outcome?.id && (
										<button type="button" className="secondary" onClick={() => props.onOpenDatabase(state.outcome!.id!)}><Icon name="database" /> {t('projects.common.openInConnections')}</button>
									)}
									<span className="spacer" />
									{state.outcome && !state.outcome.ok && !state.outcome.id && (
										<button type="button" className="secondary" onClick={() => setState({ step: 'review', installId: null, outcome: null })}><Icon name="arrow-left" /> {t('localProjects.setup.back')}</button>
									)}
									{state.outcome && <button type="button" className="secondary" onClick={restart}><Icon name="add" /> {t('localProjects.setup.another')}</button>}
								</div>
								{state.outcome && !state.outcome.ok && state.outcome.id && (
									<p className="field-hint">{t('localProjects.setup.fixHint')}</p>
								)}
							</fieldset>
							{state.lines.length > 0 && (
								<fieldset>
									<legend>{t('localProjects.setup.dockerOutput')}</legend>
									<pre className="local-log" ref={logRef}>{state.lines.slice(-MAX_LOG_LINES).join('\n')}</pre>
								</fieldset>
							)}
						</>
					)}

					{state.step !== 'install' && (
						<>
							{problem && <div className="form-status warn">{problem}</div>}
							<div className="modal-actions">
								{index > 0 && <button type="button" className="secondary" onClick={() => { setProblem(null); setState({ step: order[index - 1] }); }}><Icon name="arrow-left" /> {t('localProjects.setup.back')}</button>}
								<span className="spacer" />
								{state.step === 'review'
									? <button type="button" onClick={() => void install()}><Icon name="rocket" /> {t('localProjects.setup.setUpStart')}</button>
									: <button type="button" disabled={state.step === 'check' && !ready} onClick={() => void next()}><Icon name="chevron-right" /> {t('localProjects.setup.next')}</button>}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

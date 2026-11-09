/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copy a whole project between this computer and SnoutData Cloud (src/shared/projectCopy.ts).
 *
 * The Move's frame (`.flow-wizard*`, the route drawn in the house pipeline pulse, findings as cards
 * carrying their own fixes), because a project copy IS a move with four more parts around its
 * database. This view decides nothing: main checks both projects, main applies a fix, main checks
 * again on Start, and main runs it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Finding, FixId, MoveProgress } from '@snout/move';
import type { ComponentInfo } from '../../../shared/components';
import { PART_TITLE, PROJECT_COPY_PARTS, partUnavailable, type PartState, type ProjectCopyCheck, type ProjectCopyDestination, type ProjectCopyPart, type ProjectCopyProgress, type ProjectCopyRequest } from '../../../shared/projectCopy';
import type { ProjectTarget } from '../../../shared/projects';
import { formatBytes } from '../formatBytes';
import { Icon } from './Icon';
import { t, useT } from '../i18n';
import { FIX_LABEL, MoveProgressPanel, MoveRoute, SEVERITY, type RouteEnd } from './MoveView';

type Step = 'choose' | 'check' | 'review' | 'copying';

const STEPS: readonly { step: Step; chip: string }[] = [
	{ step: 'choose', get chip() { return t('move.steps.choose'); } },
	{ step: 'check', get chip() { return t('move.steps.check'); } },
	{ step: 'review', get chip() { return t('move.steps.review'); } },
	{ step: 'copying', get chip() { return t('move.steps.copy'); } },
];

const PART_WHAT: Record<ProjectCopyPart, { icon: string; what: string }> = {
	users: { icon: 'account', get what() { return t('move.copy.users'); } },
	database: { icon: 'database', get what() { return t('move.copy.database'); } },
	files: { icon: 'file-media', get what() { return t('move.copy.files'); } },
	functions: { icon: 'symbol-event', get what() { return t('move.copy.functions'); } },
	secrets: { icon: 'key', get what() { return t('move.copy.secrets'); } },
};

const STATE_ICON: Record<PartState, string> = {
	waiting: 'circle-large-outline',
	running: 'sync',
	done: 'pass-filled',
	skipped: 'circle-slash',
	failed: 'error',
};

/** The only region with a host accepting projects; the control plane has the final word. */
const NEW_CLOUD_REGION = 'us-west-2';
const NEW_CLOUD = 'new-cloud';

interface Option {
	readonly value: string;
	readonly label: string;
	readonly target: ProjectTarget;
}

export interface ProjectCopyViewProps {
	source: ProjectTarget;
	sourceName: string;
	active: boolean;
	onClose(): void;
	/** Open the target project's tab once the copy is done. */
	onOpenProject(target: ProjectTarget, name: string): void;
	/** There is no local project to copy into yet. */
	onSetupLocal(): void;
}

export function ProjectCopyView(props: ProjectCopyViewProps): JSX.Element {
	const t = useT();
	const { source } = props;
	const toCloud = source.kind === 'local';
	const idRef = useRef<string>(crypto.randomUUID());
	const [step, setStep] = useState<Step>('choose');
	const [options, setOptions] = useState<Option[] | null>(null);
	const [optionsNote, setOptionsNote] = useState<string | null>(null);
	const [targetValue, setTargetValue] = useState<string>(toCloud ? NEW_CLOUD : '');
	const [newName, setNewName] = useState<string>(props.sourceName);
	const [parts, setParts] = useState<Set<ProjectCopyPart>>(() => new Set(PROJECT_COPY_PARTS.filter((part) => !partUnavailable(part, source.kind, toCloud ? 'cloud' : 'local'))));
	const [check, setCheck] = useState<ProjectCopyCheck | null>(null);
	const [typed, setTyped] = useState('');
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [progress, setProgress] = useState<ProjectCopyProgress | null>(null);
	const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null);
	const [tools, setTools] = useState<ComponentInfo | null>(null);

	// The projects a copy can go to: the other kind.
	useEffect(() => {
		let gone = false;
		if (toCloud) {
			void window.sqlApi.cloudProjects().then((view) => {
				if (gone) {
					return;
				}
				setOptions(view.projects.map((p) => ({ value: p.ref, label: `${p.name}${p.production ? " (production)" : ''}`, target: { kind: 'cloud', ref: p.ref } })));
				setOptionsNote(view.unavailable ?? (view.account ? null : t('move.copy.signIn')));
			}).catch((err: unknown) => setOptionsNote(err instanceof Error ? err.message : String(err)));
		} else {
			void window.sqlApi.local.list().then((view) => {
				if (gone) {
					return;
				}
				setOptions(view.projects.map((p) => ({ value: p.id, label: `${p.name}${p.production ? " (production)" : ''}`, target: { kind: 'local', id: p.id } })));
				setOptionsNote(view.unavailable ?? null);
			}).catch((err: unknown) => setOptionsNote(err instanceof Error ? err.message : String(err)));
		}
		return () => {
			gone = true;
		};
	}, [toCloud]);

	// Progress, the copy's and its database move's.
	useEffect(() => {
		const offCopy = window.sqlApi.projectCopy.onProgress((next) => {
			if (next.id === idRef.current) {
				setProgress(next);
			}
		});
		const offMove = window.sqlApi.moves.onProgress((next) => {
			if (next.moveId === idRef.current) {
				setMoveProgress(next);
			}
		});
		return () => {
			offCopy();
			offMove();
		};
	}, []);

	// The Postgres tools, for the database part's "tools missing" card.
	useEffect(() => {
		if (!check?.toolsMissing) {
			return;
		}
		void window.sqlApi.componentsStatus().then((all) => setTools(all.find((c) => c.id === 'pgtools') ?? null));
	}, [check?.toolsMissing]);

	// Every change on the first step invalidates a check made before it.
	useEffect(() => {
		setCheck(null);
	}, [targetValue, newName, parts]);

	const chosen = options?.find((o) => o.value === targetValue);
	const creating = targetValue === NEW_CLOUD;
	const destination: ProjectCopyDestination | null = creating
		? (newName.trim() ? { kind: 'newCloud', name: newName.trim(), region: NEW_CLOUD_REGION } : null)
		: chosen?.target ?? null;
	const request: ProjectCopyRequest | null = destination ? { id: idRef.current, source, target: destination, parts: PROJECT_COPY_PARTS.filter((p) => parts.has(p)) } : null;
	const sourceEnd: RouteEnd = { label: props.sourceName, icon: toCloud ? 'device-desktop' : 'cloud' };
	const targetEnd: RouteEnd = { label: creating ? newName.trim() || t('move.newCloudProject') : chosen?.label ?? t('move.copy.chooseProject'), icon: toCloud ? 'cloud' : 'device-desktop' };

	async function runCheck(): Promise<void> {
		if (!request) {
			return;
		}
		setBusy(t('move.copy.checkingBoth'));
		setError(null);
		try {
			const answer = await window.sqlApi.projectCopy.check(request);
			setCheck(answer);
			if (answer.error) {
				setError(answer.error);
			} else {
				setStep('check');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	async function chooseFix(finding: Finding, fix: FixId): Promise<void> {
		const spec = check?.database?.spec;
		if (!spec) {
			return;
		}
		setBusy(`${FIX_LABEL[fix]}…`);
		setError(null);
		try {
			const outcome = await window.sqlApi.moves.fix(spec, finding.key, fix);
			if (!outcome.ok) {
				setError(outcome.error);
				return;
			}
		} finally {
			setBusy(null);
		}
		// The whole copy is checked again, which reads the fixed spec back from main.
		await runCheck();
	}

	async function installTools(): Promise<void> {
		setBusy(t('move.downloadingTools'));
		try {
			const outcome = await window.sqlApi.moves.installTools();
			if (!outcome.ok) {
				setError(outcome.error ?? t('move.copy.toolsFailed'));
			}
		} finally {
			setBusy(null);
		}
		await runCheck();
	}

	async function start(): Promise<void> {
		if (!request) {
			return;
		}
		setBusy(t('move.copy.checkingOnceMore'));
		setError(null);
		try {
			const outcome = await window.sqlApi.projectCopy.start(request, check?.confirmName ? typed : undefined);
			if (outcome.ok) {
				setStep('copying');
			} else {
				setError(outcome.error);
			}
		} finally {
			setBusy(null);
		}
	}

	function togglePart(part: ProjectCopyPart, on: boolean): void {
		setParts((current) => {
			const next = new Set(current);
			if (on) {
				next.add(part);
			} else {
				next.delete(part);
			}
			return next;
		});
	}

	const chosenChecks = useMemo(() => check?.parts.filter((p) => parts.has(p.part)) ?? [], [check, parts]);
	const problems = chosenChecks.filter((p) => p.available && p.problem);
	const databaseFindings = parts.has('database') ? check?.database?.check.findings ?? [] : [];
	const readyToReview = check !== null && !check.error && problems.length === 0 && !(parts.has('database') && check.toolsMissing);
	const confirmed = !check?.confirmName || typed === check.confirmName;
	const finished = progress !== null && !progress.running;
	const databaseRunning = progress?.parts.some((p) => p.part === 'database' && p.state === 'running') ?? false;
	const stepIndex = STEPS.findIndex((entry) => entry.step === step);

	return (
		<div className="flow-wizard move-view">
			<div className="flow-wizard-head">
				<span className="flow-wizard-title"><Icon name={toCloud ? 'cloud-upload' : 'cloud-download'} /> {toCloud ? t('move.copy.titleToCloud', { name: props.sourceName }) : t('move.copy.titleToComputer', { name: props.sourceName })}</span>
				<div className="flow-wizard-steps">
					{STEPS.map((entry, index) => (
						<span key={entry.step} className={`flow-wizard-step${entry.step === step ? ' active' : ''}${stepIndex > index ? ' done' : ''}`}>
							{`${index + 1}. ${entry.chip}`}
						</span>
					))}
				</div>
				<div className="flow-wizard-head-spacer" />
				<button type="button" className="icon-btn" aria-label={t('move.close')} onClick={props.onClose}><Icon name="close" /></button>
			</div>

			<div className="flow-wizard-body">
				{error && <div className="flow-wizard-error"><Icon name="error" /> {error}</div>}

				{step === 'choose' && (
					<div className="flow-wizard-pane move-pane">
						<p className="flow-wizard-lead">
							{toCloud
								? t('move.copy.introToCloud')
								: t('move.copy.introToComputer')}
						</p>
						<MoveRoute source={sourceEnd} target={targetEnd} running={false} />
						<div className="move-ends">
							<div className="move-end">
								<span className="move-end-label"><Icon name="arrow-up" /> {t('move.from')}</span>
								<span>{props.sourceName}</span>
								<span className="move-end-hint">{toCloud ? t('move.copy.onComputer') : t('move.copy.inCloud')}</span>
							</div>
							<span />
							<label className="move-end">
								<span className="move-end-label"><Icon name="arrow-down" /> {t('move.to')}</span>
								{options === null && !optionsNote ? (
									<span className="move-end-hint">{t('move.copy.loading')}</span>
								) : (
									<select value={targetValue} onChange={(event) => setTargetValue(event.target.value)}>
										{!toCloud && <option value="">{t('move.copy.chooseLocal')}</option>}
										{toCloud && <option value={NEW_CLOUD}>{t('move.newCloudOption')}</option>}
										{(options ?? []).length > 0 && (
											<optgroup label={toCloud ? t('move.copy.yourCloud') : t('move.copy.yourLocal')}>
												{(options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
											</optgroup>
										)}
									</select>
								)}
								{creating && (
									<>
										<input className="move-new-name" value={newName} placeholder={t('move.projectName')} aria-label={t('move.newProjectName')} maxLength={60} spellCheck={false} onChange={(event) => setNewName(event.target.value)} />
										<span className="move-end-hint">{t('move.copy.createdInRegion', { region: NEW_CLOUD_REGION })}</span>
									</>
								)}
								{optionsNote && <span className="move-end-hint">{optionsNote}</span>}
								{!toCloud && options !== null && options.length === 0 && (
									<span className="move-end-hint">
										{t('move.copy.noLocal')}{' '}
										<button type="button" className="link-btn" onClick={props.onSetupLocal}>{t('move.copy.setOneUp')}</button>{t('move.copy.thenBack')}
									</span>
								)}
							</label>
						</div>

						<h3 className="move-heading">{t('move.copy.whatToCopy')}</h3>
						<fieldset className="copy-parts">
							{PROJECT_COPY_PARTS.map((part) => {
								const unavailable = partUnavailable(part, source.kind, toCloud ? 'cloud' : 'local');
								return (
									<label key={part} className="check" data-part={part} title={unavailable ?? undefined}>
										<input type="checkbox" checked={parts.has(part)} disabled={unavailable !== null} onChange={(event) => togglePart(part, event.target.checked)} />
										<span className="copy-part-text">
											<strong><Icon name={PART_WHAT[part].icon} /> {PART_TITLE[part]}</strong>
											<span className="flow-wizard-dim">{unavailable ?? PART_WHAT[part].what}</span>
										</span>
									</label>
								);
							})}
						</fieldset>
					</div>
				)}

				{step === 'check' && check && (
					<div className="flow-wizard-pane move-pane">
						<div className="flow-wizard-summary">
							<span><Icon name={sourceEnd.icon} /> {check.sourceLabel}</span>
							<Icon name="arrow-right" />
							<span><Icon name={targetEnd.icon} /> {check.targetLabel}</span>
						</div>
						<ul className="move-findings">
							{chosenChecks.map((p) => (
								<li key={p.part} className={`move-finding ${p.problem ? 'block' : 'note'}`}>
									<span className="move-finding-head">
										<Icon name={p.problem ? 'error' : PART_WHAT[p.part].icon} />
										<span className="move-finding-chip">{PART_TITLE[p.part]}</span>
									</span>
									<span className="move-finding-sentence"><strong>{p.summary}</strong></span>
									{p.problem && <span className="move-finding-sentence">{p.problem}</span>}
									{p.notes.map((note) => <span key={note} className="flow-wizard-dim">{note}</span>)}
									{p.part === 'database' && check.toolsMissing && (
										<span className="move-finding-fixes">
											<span className="flow-wizard-dim">{t('move.copy.toolsMissing')}</span>
											{tools?.supported && tools.published ? (
												<button type="button" disabled={busy !== null} onClick={() => void installTools()}>
													<Icon name="cloud-download" /> {t('move.downloadThem', { size: formatBytes(tools.downloadBytes ?? 0) })}
												</button>
											) : null}
										</span>
									)}
								</li>
							))}
						</ul>

						{databaseFindings.length > 0 && (
							<>
								<h3 className="move-heading">{t('move.copy.theDatabase')}</h3>
								<ul className="move-findings">
									{databaseFindings.map((finding) => (
										<li key={finding.key} className={`move-finding ${finding.severity}${finding.resolvedBy ? ' resolved' : ''}`}>
											<span className="move-finding-head">
												<Icon name={finding.resolvedBy ? 'pass' : SEVERITY[finding.severity].icon} />
												<span className="move-finding-chip">{finding.resolvedBy ? t('move.decided', { fix: FIX_LABEL[finding.resolvedBy] }) : SEVERITY[finding.severity].chip}</span>
											</span>
											<span className="move-finding-sentence">{finding.sentence}</span>
											{finding.fixes.length > 0 && !finding.resolvedBy && (
												<span className="move-finding-fixes">
													{finding.fixes.map((fix) => (
														<button key={fix} type="button" className="secondary" disabled={busy !== null} onClick={() => void chooseFix(finding, fix)}>{FIX_LABEL[fix]}</button>
													))}
												</span>
											)}
										</li>
									))}
								</ul>
							</>
						)}
					</div>
				)}

				{step === 'review' && check && (
					<div className="flow-wizard-pane move-pane">
						<p className="flow-wizard-lead">{t('move.copy.nothingYetOrder')}</p>
						<MoveRoute source={sourceEnd} target={targetEnd} running={false} />
						<ol className="copy-review">
							{destination?.kind === 'newCloud' && <li><Icon name="add" /> {t('move.copy.createProject', { name: destination.name, region: destination.region })}</li>}
							{chosenChecks.filter((p) => p.available).map((p) => (
								<li key={p.part}><Icon name={PART_WHAT[p.part].icon} /> <strong>{PART_TITLE[p.part]}:</strong> {p.summary}</li>
							))}
						</ol>
						<h3 className="move-heading">{t('move.copy.notCopied')}</h3>
						<ul className="copy-review not">
							{check.notCopied.map((line) => <li key={line}>{line}</li>)}
						</ul>
						{check.confirmName && (
							<label className="move-confirm">
								<span>{t('move.copy.prodTarget')} {t('move.typeBefore')} <strong>{check.confirmName}</strong> {t('move.typeAfter')}</span>
								<input value={typed} onChange={(event) => setTyped(event.target.value)} spellCheck={false} />
							</label>
						)}
					</div>
				)}

				{step === 'copying' && progress && (
					<div className="flow-wizard-pane move-pane">
						<MoveRoute source={sourceEnd} target={targetEnd} running={progress.running} />
						{progress.preparing && <div className="move-progress-head"><span className="flow-wizard-dim"><Icon name="sync" className="flow-wizard-spin" /> {progress.preparing}</span></div>}
						<ul className="move-tables copy-progress">
							{progress.parts.map((p) => (
								<li key={p.part} className={`move-table copy-part ${p.state}`}>
									<Icon name={STATE_ICON[p.state]} className={p.state === 'running' ? 'flow-wizard-spin' : undefined} />
									<span className="move-table-name">{PART_TITLE[p.part]}</span>
									<span className="copy-part-message">{p.message}</span>
									{p.total !== null && p.total > 0 && p.state === 'running' && (
										<span className="progress-track move-table-bar"><span className="progress-fill" style={{ width: `${Math.round((p.done / p.total) * 100)}%` }} /></span>
									)}
									{p.failures.length > 0 && (
										<details className="move-result-failure copy-failures">
											<summary>{t('move.copy.didNotCopy', { n: p.failures.length })}</summary>
											<ul>{p.failures.slice(0, 200).map((f) => <li key={f}>{f}</li>)}</ul>
										</details>
									)}
								</li>
							))}
						</ul>
						{databaseRunning && moveProgress && <MoveProgressPanel progress={moveProgress} source={sourceEnd} target={targetEnd} />}
						{finished && (
							<div className={`move-result ${progress.ok ? 'success' : 'partial'}`} role="status">
								<div className="move-result-head">
									<Icon name={progress.ok ? 'pass' : 'warning'} />
									<span>{progress.ok ? t('move.copy.copied', { name: check?.targetLabel ?? '' }) : progress.error ?? t('move.copy.copiedExcept')}</span>
								</div>
								<p className="flow-wizard-dim">{t('move.copy.pointApp')}</p>
							</div>
						)}
					</div>
				)}

				{busy && (
					<div className="flow-wizard-status move-busy">
						<Icon name="sync" className="flow-wizard-spin" />
						<p>{busy}</p>
					</div>
				)}
			</div>

			<div className="flow-wizard-foot">
				{(step === 'check' || step === 'review') && (
					<button type="button" className="secondary" disabled={busy !== null} onClick={() => setStep(step === 'review' ? 'check' : 'choose')}>
						<Icon name="arrow-left" /> {t('move.back')}
					</button>
				)}
				<div className="flow-wizard-head-spacer" />
				{step === 'choose' && (
					<button type="button" disabled={!request || request.parts.length === 0 || busy !== null} onClick={() => void runCheck()}>
						{t('move.copy.checkBoth')} <Icon name="arrow-right" />
					</button>
				)}
				{step === 'check' && (
					<>
						<button type="button" className="secondary" disabled={busy !== null} onClick={() => void runCheck()}><Icon name="refresh" /> {t('move.checkAgain')}</button>
						<button type="button" disabled={!readyToReview || busy !== null} onClick={() => setStep('review')}>{t('move.review')} <Icon name="arrow-right" /></button>
					</>
				)}
				{step === 'review' && (
					<button type="button" disabled={!confirmed || busy !== null} onClick={() => void start()}>
						<Icon name="play" /> {confirmed ? t('move.copy.start') : t('move.copy.typeNameToStart')}
					</button>
				)}
				{step === 'copying' && progress?.running && (
					<button type="button" className="secondary" onClick={() => void window.sqlApi.projectCopy.cancel(idRef.current)}>
						<Icon name="debug-stop" /> {t('move.copy.stop')}
					</button>
				)}
				{step === 'copying' && finished && progress.target && (
					<button type="button" className="secondary" onClick={() => props.onOpenProject(progress.target as ProjectTarget, check?.targetLabel ?? '')}>
						<Icon name="arrow-right" /> {t('move.copy.open', { name: check?.targetLabel ?? '' })}
					</button>
				)}
				{step === 'copying' && finished && (
					<button type="button" onClick={props.onClose}><Icon name="close" /> {t('move.close')}</button>
				)}
			</div>
		</div>
	);
}

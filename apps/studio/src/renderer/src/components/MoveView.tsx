/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Move a database: a whole Postgres database from one place to another.
 *
 * The frame is the Data Flows wizard's (`.flow-wizard*`: header with step chips, a scrolling body,
 * a footer with Back and the one primary action), so the two whole-screen jobs in the app read as
 * one family. What is new is only what a move has and a flow does not: a source → target route
 * drawn in the house pipeline pulse, the preflight findings as cards that carry their own fixes,
 * and a progress screen with a bar per table.
 *
 * The rules are `@snout/move`'s. This view never decides whether a move may run: it asks main to
 * check both databases and shows what came back, and a fix is applied by main against a fresh
 * check, never by the view editing the spec to make a finding go away.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
	describeRun,
	etaSeconds,
	formatBytes,
	formatDuration,
	isActivePhase,
	newMoveSpec,
	overallFraction,
	tableFraction,
	type Finding,
	type FixId,
	type MoveContent,
	type MovePhase,
	type MoveProgress,
	type MoveRunResult,
	type MoveSpec,
	type SourceAfter
} from '@snout/move';
import type { ComponentInfo } from '../../../shared/components';
import type { ConnectionConfig } from '../../../shared/connection';
import type { MoveCheck } from '../../../shared/move';
import { Icon } from './Icon';
import { t, useT } from '../i18n';

type Step = 'choose' | 'check' | 'review' | 'moving';

const STEPS: readonly { step: Step; chip: string }[] = [
	{ step: 'choose', get chip() { return t('move.steps.choose'); } },
	{ step: 'check', get chip() { return t('move.steps.check'); } },
	{ step: 'review', get chip() { return t('move.steps.review'); } },
	{ step: 'moving', get chip() { return t('move.steps.move'); } }
];

export const FIX_LABEL: Record<FixId, string> = {
	get continue() { return t('move.fix.continue'); },
	get continueWithout() { return t('move.fix.continueWithout'); },
	get replaceTarget() { return t('move.fix.replaceTarget'); },
	get excludeSchema() { return t('move.fix.excludeSchema'); },
	get excludeExtension() { return t('move.fix.excludeExtension'); },
	get removeSchema() { return t('move.fix.removeSchema'); },
	get skipOwnership() { return t('move.fix.skipOwnership'); },
	get keepSource() { return t('move.fix.keepSource'); }
};

export const SEVERITY: Record<Finding['severity'], { icon: string; chip: string }> = {
	block: { icon: 'error', get chip() { return t('move.severity.block'); } },
	decide: { icon: 'question', get chip() { return t('move.severity.decide'); } },
	note: { icon: 'info', get chip() { return t('move.severity.note'); } }
};

const CONTENT: readonly { id: MoveContent; icon: string; title: string; what: string }[] = [
	{ id: 'both', icon: 'database', get title() { return t('move.content.bothTitle'); }, get what() { return t('move.content.bothWhat'); } },
	{ id: 'schema', icon: 'symbol-structure', get title() { return t('move.content.schemaTitle'); }, get what() { return t('move.content.schemaWhat'); } },
	{ id: 'data', icon: 'table', get title() { return t('move.content.dataTitle'); }, get what() { return t('move.content.dataWhat'); } }
];

const AFTER: readonly { id: SourceAfter; icon: string; title: string; what: string }[] = [
	{ id: 'keep', icon: 'check', get title() { return t('move.after.keepTitle'); }, get what() { return t('move.after.keepWhat'); } },
	{ id: 'pause', icon: 'debug-pause', get title() { return t('move.after.pauseTitle'); }, get what() { return t('move.after.pauseWhat'); } },
	{ id: 'delete', icon: 'trash', get title() { return t('move.after.deleteTitle'); }, get what() { return t('move.after.deleteWhat'); } }
];

const PHASE_TITLE: Record<MovePhase, string> = {
	get starting() { return t('move.phase.starting'); },
	get waking() { return t('move.phase.waking'); },
	get creating() { return t('move.phase.creating'); },
	get saving() { return t('move.phase.saving'); },
	get replacing() { return t('move.phase.replacing'); },
	get schema() { return t('move.phase.schema'); },
	get data() { return t('move.phase.data'); },
	get indexes() { return t('move.phase.indexes'); },
	get verifying() { return t('move.phase.verifying'); },
	get finishing() { return t('move.phase.finishing'); },
	get done() { return t('move.phase.done'); },
	get failed() { return t('move.phase.failed'); },
	get cancelled() { return t('move.phase.cancelled'); }
};

export interface MoveViewProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	active: boolean;
	/** Dev only (import.meta.env.DEV): open straight onto a simulated run, to see the progress screen. */
	preview?: boolean;
	onClose(): void;
}

/** A connection imported from a hosted project IS that project, which is what lets it be paused or deleted afterwards. */
function endpointOf(connection: ConnectionConfig): MoveSpec['source'] {
	return connection.cloudProjectRef
		? { kind: 'cloud', ref: connection.cloudProjectRef, driver: 'postgres' }
		: { kind: 'connection', id: connection.id, driver: connection.driver };
}

/** One end of the route diagram and the summary: what it is called, and whether it is a cloud. */
export interface RouteEnd {
	readonly label: string;
	readonly icon: string;
}

function endOf(connection: ConnectionConfig | undefined): RouteEnd | undefined {
	return connection ? { label: connection.label, icon: connection.cloudProjectRef ? 'cloud' : 'database' } : undefined;
}

// The target picker's two "create it now" choices. Nothing is created until Start.
const NEW_CLOUD = 'new-cloud';
const NEW_ON = 'new-on:';
/** The default region offered for a new project. The control plane has the final word. */
const NEW_CLOUD_REGION = 'us-west-2';

function optionLabel(connection: ConnectionConfig): string {
	const where = connection.cloudProjectRef ? " (SnoutData Cloud)" : '';
	const prod = connection.environment === 'prod' ? t('move.prodSuffix') : '';
	return `${connection.label}${where}${prod}`;
}

export function MoveView(props: MoveViewProps): JSX.Element {
	const t = useT();
	const [step, setStep] = useState<Step>(props.preview && import.meta.env.DEV ? 'moving' : 'choose');
	const [sourceId, setSourceId] = useState<string>('');
	const [targetId, setTargetId] = useState<string>('');
	const [newName, setNewName] = useState<string>('');
	const [content, setContent] = useState<MoveContent>('both');
	const [sourceAfter, setSourceAfter] = useState<SourceAfter>('keep');
	const [spec, setSpec] = useState<MoveSpec | null>(null);
	const [check, setCheck] = useState<MoveCheck | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [typed, setTyped] = useState<Record<string, string>>({});
	const [progress, setProgress] = useState<MoveProgress | null>(null);
	const [result, setResult] = useState<MoveRunResult | null>(null);
	const [runId, setRunId] = useState<string | null>(null);
	const [tools, setTools] = useState<ComponentInfo | null>(null);
	const idRef = useRef<string>(crypto.randomUUID());

	// Postgres first: it is the only engine a move runs on today, and the others explain themselves
	// in a finding rather than by vanishing from the list.
	const connections = useMemo(
		() => [...props.connections].sort((a, b) => Number(b.driver === 'postgres') - Number(a.driver === 'postgres') || a.label.localeCompare(b.label)),
		[props.connections]
	);
	const source = connections.find((connection) => connection.id === sourceId);
	const target = connections.find((connection) => connection.id === targetId);
	const newOn = targetId.startsWith(NEW_ON) ? connections.find((connection) => connection.id === targetId.slice(NEW_ON.length)) : undefined;
	const newCloud = targetId === NEW_CLOUD;
	const creating = newOn !== undefined || newCloud;
	const targetEnd: RouteEnd | undefined = creating
		? { label: newName.trim() || (newCloud ? t('move.newCloudProject') : t('move.newDatabase')), icon: newCloud ? 'cloud' : 'database' }
		: endOf(target);
	const targetChosen = creating ? newName.trim().length > 0 : target !== undefined;

	// Every change on the first step invalidates a check made before it.
	useEffect(() => {
		setCheck(null);
		setSpec(null);
	}, [sourceId, targetId, newName, content, sourceAfter]);

	function draft(): MoveSpec | null {
		if (!source || !targetChosen) {
			return null;
		}
		const name = newName.trim();
		const destination: MoveSpec['target'] | null = newCloud
			? { kind: 'newCloudProject', name, region: NEW_CLOUD_REGION, driver: 'postgres' }
			: newOn
				? { kind: 'newDatabase', serverConnectionId: newOn.id, database: name, driver: newOn.driver }
				: target
					? endpointOf(target)
					: null;
		if (!destination) {
			return null;
		}
		const base = newMoveSpec({ id: idRef.current, name: `${source.label} to ${targetEnd?.label ?? ''}`, source: endpointOf(source), target: destination });
		return { ...base, content, sourceAfter: source.cloudProjectRef || sourceAfter === 'keep' ? sourceAfter : 'keep' };
	}

	async function runCheck(next: MoveSpec): Promise<void> {
		setBusy(t('move.checkingBoth'));
		setError(null);
		try {
			const saved = await window.sqlApi.moves.save(next);
			setSpec(saved);
			setCheck(await window.sqlApi.moves.check(saved));
			setStep('check');
		} catch (thrown) {
			setError(thrown instanceof Error ? thrown.message : String(thrown));
		} finally {
			setBusy(null);
		}
	}

	async function chooseFix(finding: Finding, fix: FixId): Promise<void> {
		if (!spec) {
			return;
		}
		setBusy(FIX_LABEL[fix]);
		setError(null);
		try {
			const outcome = await window.sqlApi.moves.fix(spec, finding.key, fix);
			if (outcome.ok) {
				setSpec(outcome.spec);
				setCheck(outcome.check);
			} else {
				setError(outcome.error);
			}
		} finally {
			setBusy(null);
		}
	}

	// The run is main's: this view only listens, so progress keeps arriving whoever started it.
	useEffect(() => {
		const offProgress = window.sqlApi.moves.onProgress((next) => {
			if (next.moveId === idRef.current) {
				setProgress(next);
			}
		});
		const offFinished = window.sqlApi.moves.onFinished((done) => {
			if (done.moveId === idRef.current) {
				setResult(done);
				setRunId(null);
			}
		});
		return () => {
			offProgress();
			offFinished();
		};
	}, []);

	// The tools are a download, offered on the card that says they are missing.
	const toolsMissing = check?.findings.some((finding) => finding.id === 'tools-missing') ?? false;
	useEffect(() => {
		if (!toolsMissing) {
			return;
		}
		let live = true;
		void window.sqlApi.componentsStatus().then((all) => {
			if (live) {
				setTools(all.find((component) => component.id === 'pgtools') ?? null);
			}
		});
		return () => {
			live = false;
		};
	}, [toolsMissing]);

	async function installTools(): Promise<void> {
		setError(null);
		setBusy(t('move.downloadingTools'));
		const off = window.sqlApi.onComponentProgress((progress) => {
			if (progress.id !== 'pgtools') {
				return;
			}
			if (progress.phase === 'download' && progress.totalBytes) {
				setBusy(t('move.downloadingToolsProgress', { received: formatBytes(progress.receivedBytes ?? 0), total: formatBytes(progress.totalBytes) }));
			} else if (progress.phase === 'verify') {
				setBusy(t('move.checkingDownload'));
			} else if (progress.phase === 'extract') {
				setBusy(t('move.unpackingTools'));
			}
		});
		let outcome;
		try {
			outcome = await window.sqlApi.moves.installTools();
		} finally {
			off();
			setBusy(null);
		}
		if (!outcome.ok) {
			setError(outcome.error);
		} else if (spec) {
			await runCheck(spec);
		}
	}

	async function start(): Promise<void> {
		if (!spec) {
			return;
		}
		setBusy(t('move.checkingOnceMore'));
		setError(null);
		setResult(null);
		try {
			const outcome = await window.sqlApi.moves.run(spec, { target: typed.target, source: typed.source });
			if (outcome.ok) {
				setRunId(outcome.runId);
				setStep('moving');
			} else {
				setError(outcome.error);
			}
		} finally {
			setBusy(null);
		}
	}

	function swap(): void {
		setSourceId(targetId);
		setTargetId(sourceId);
	}

	// What must be typed before starting: a production target's name, and the source's when it is
	// going to be deleted.
	const mustType = useMemo(() => {
		const names: { key: string; name: string; why: string }[] = [];
		if (target?.environment === 'prod') {
			names.push({ key: 'target', name: target.label, why: t('move.whyProd') });
		}
		if (spec?.sourceAfter === 'delete' && source) {
			names.push({ key: 'source', name: source.label, why: t('move.whyDelete') });
		}
		return names;
	}, [target, source, spec]);
	const confirmed = mustType.every((entry) => typed[entry.key] === entry.name);

	usePreviewRun(Boolean(props.preview && import.meta.env.DEV), setProgress);

	const stepIndex = STEPS.findIndex((entry) => entry.step === step);

	return (
		<div className="flow-wizard move-view">
			<div className="flow-wizard-head">
				<span className="flow-wizard-title"><Icon name="arrow-both" /> {spec?.name ?? t('move.title')}</span>
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
							{t('move.intro')}
						</p>
						<MoveRoute source={endOf(source)} target={targetEnd} running={false} />
						<div className="move-ends">
							<label className="move-end">
								<span className="move-end-label"><Icon name="arrow-up" /> {t('move.from')}</span>
								<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
									<option value="">{t('move.chooseSource')}</option>
									{connections.map((connection) => (
										<option key={connection.id} value={connection.id} disabled={connection.id === targetId}>{optionLabel(connection)}</option>
									))}
								</select>
							</label>
							<button type="button" className="icon-btn move-swap" aria-label={t('move.swap')} onClick={swap} disabled={(!sourceId && !targetId) || creating}>
								<Icon name="arrow-swap" />
							</button>
							<label className="move-end">
								<span className="move-end-label"><Icon name="arrow-down" /> {t('move.to')}</span>
								<select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
									<option value="">{t('move.chooseTarget')}</option>
									<optgroup label={t('move.existingDatabases')}>
										{connections.map((connection) => (
											<option key={connection.id} value={connection.id} disabled={connection.id === sourceId}>{optionLabel(connection)}</option>
										))}
									</optgroup>
									{/* Most moves go somewhere that does not exist yet. */}
									<optgroup label={t('move.createNewDatabase')}>
										<option value={NEW_CLOUD}>{t('move.newCloudOption')}</option>
										{connections.filter((connection) => connection.driver === 'postgres' && !connection.cloudProjectRef).map((connection) => (
											<option key={`new-${connection.id}`} value={`${NEW_ON}${connection.id}`}>{t('move.newOnServer', { label: connection.label })}</option>
										))}
									</optgroup>
								</select>
								{creating && (
									<>
										<input
											className="move-new-name"
											value={newName}
											placeholder={newCloud ? t('move.projectName') : t('move.databaseName')}
											aria-label={newCloud ? t('move.newProjectName') : t('move.newDatabaseName')}
											maxLength={newCloud ? 60 : 63}
											spellCheck={false}
											onChange={(event) => setNewName(event.target.value)}
										/>
										<span className="move-end-hint">
											{newCloud ? t('move.createdInRegion', { region: NEW_CLOUD_REGION }) : t('move.createdOnServer')}
										</span>
									</>
								)}
							</label>
						</div>

						<h3 className="move-heading">{t('move.whatToMove')}</h3>
						<div className="flow-wizard-methods">
							{CONTENT.map((choice) => (
								<button key={choice.id} type="button" className={`flow-wizard-method${content === choice.id ? ' chosen' : ''}`} aria-pressed={content === choice.id} onClick={() => setContent(choice.id)}>
									<span className="flow-wizard-method-head"><Icon name={choice.icon} /><strong>{choice.title}</strong></span>
									<span className="flow-wizard-method-what">{choice.what}</span>
								</button>
							))}
						</div>

						<h3 className="move-heading">{t('move.afterHeading')}</h3>
						<div className="flow-wizard-methods">
							{AFTER.map((choice) => {
								const unavailable = choice.id !== 'keep' && !source?.cloudProjectRef;
								return (
									<button
										key={choice.id}
										type="button"
										className={`flow-wizard-method${sourceAfter === choice.id ? ' chosen' : ''}`}
										aria-pressed={sourceAfter === choice.id}
										disabled={unavailable}
										title={unavailable ? t('move.onlyCloudPause') : undefined}
										onClick={() => setSourceAfter(choice.id)}
									>
										<span className="flow-wizard-method-head"><Icon name={choice.icon} /><strong>{choice.title}</strong></span>
										<span className="flow-wizard-method-what">{choice.what}</span>
									</button>
								);
							})}
						</div>
					</div>
				)}

				{step === 'check' && check && (
					<div className="flow-wizard-pane move-pane">
						<div className="flow-wizard-summary">
							<span><Icon name={endOf(source)?.icon ?? 'database'} /> {source?.label}</span>
							<Icon name="arrow-right" />
							<span><Icon name={targetEnd?.icon ?? 'database'} /> {targetEnd?.label}</span>
						</div>
						{check.error ? (
							<div className="flow-wizard-error"><Icon name="error" /> {check.error}</div>
						) : check.findings.length === 0 ? (
							<div className="move-clear"><Icon name="pass" /> {t('move.clear')}</div>
						) : (
							<>
								<p className="flow-wizard-lead">
									{check.ready ? t('move.decidedAll') : t('move.cardsExplain')}
								</p>
								<ul className="move-findings">
									{check.findings.map((finding) => (
										<li key={finding.key} className={`move-finding ${finding.severity}${finding.resolvedBy ? ' resolved' : ''}`}>
											<span className="move-finding-head">
												<Icon name={finding.resolvedBy ? 'pass' : SEVERITY[finding.severity].icon} />
												<span className="move-finding-chip">{finding.resolvedBy ? t('move.decided', { fix: FIX_LABEL[finding.resolvedBy] }) : SEVERITY[finding.severity].chip}</span>
											</span>
											<span className="move-finding-sentence">{finding.sentence}</span>
											{finding.fixes.length > 0 && !finding.resolvedBy && (
												<span className="move-finding-fixes">
													{finding.fixes.map((fix) => (
														<button key={fix} type="button" className="secondary" disabled={busy !== null} onClick={() => void chooseFix(finding, fix)}>
															{FIX_LABEL[fix]}
														</button>
													))}
												</span>
											)}
											{finding.id === 'tools-missing' && tools && (
												<span className="move-finding-fixes">
													{tools.supported && tools.published ? (
														<button type="button" disabled={busy !== null} onClick={() => void installTools()}>
															<Icon name="cloud-download" /> {t('move.downloadThem', { size: formatBytes(tools.downloadBytes ?? 0) })}
														</button>
													) : (
														<span className="flow-wizard-dim">{t('move.noToolsDownload')}</span>
													)}
												</span>
											)}
										</li>
									))}
								</ul>
							</>
						)}
					</div>
				)}

				{step === 'review' && spec && check && (
					<div className="flow-wizard-pane move-pane">
						<p className="flow-wizard-lead">{t('move.nothingYet')}</p>
						<MoveRoute source={endOf(source)} target={targetEnd} running={false} />
						<div className="flow-wizard-summary">
							<span><Icon name="database" /> {CONTENT.find((choice) => choice.id === spec.content)?.title}</span>
							<span><Icon name="organization" /> {spec.ownership === 'skip' ? t('move.ownersSkipped') : t('move.ownersKept')}</span>
							<span><Icon name={AFTER.find((choice) => choice.id === spec.sourceAfter)?.icon ?? 'check'} /> {t('move.sourceAfter', { after: AFTER.find((choice) => choice.id === spec.sourceAfter)?.title.toLowerCase() ?? '' })}</span>
						</div>
						{spec.targetMode === 'replace' && (
							<>
								{target?.cloudProjectRef && (
									<div className="flow-wizard-notes"><span className="flow-wizard-note"><strong>{t('move.first')}</strong>{t('move.firstSaved')}</span></div>
								)}
								<h3 className="move-heading">{t('move.droppedBefore')}</h3>
								{check.drops.length > 0 ? (
									<pre className="flow-wizard-sql">{check.drops.join('\n')}</pre>
								) : (
									<p className="flow-wizard-dim">{t('move.nothingDropped')}</p>
								)}
							</>
						)}
						{mustType.map((entry) => (
							<label key={entry.key} className="move-confirm">
								<span>{entry.why} {t('move.typeBefore')} <strong>{entry.name}</strong> {t('move.typeAfter')}</span>
								<input value={typed[entry.key] ?? ''} onChange={(event) => setTyped((current) => ({ ...current, [entry.key]: event.target.value }))} spellCheck={false} />
							</label>
						))}
					</div>
				)}

				{step === 'moving' && progress && <MoveProgressPanel progress={progress} source={endOf(source)} target={targetEnd} />}
				{step === 'moving' && result && <MoveResultPanel result={result} />}

				{busy && (
					<div className="flow-wizard-status move-busy">
						<Icon name="sync" className="flow-wizard-spin" />
						<p>{busy}</p>
					</div>
				)}
			</div>

			<div className="flow-wizard-foot">
				{step !== 'choose' && step !== 'moving' && (
					<button type="button" className="secondary" disabled={busy !== null} onClick={() => setStep(step === 'review' ? 'check' : 'choose')}>
						<Icon name="arrow-left" /> {t('move.back')}
					</button>
				)}
				<div className="flow-wizard-head-spacer" />
				{step === 'choose' && (
					<button type="button" disabled={!source || !targetChosen || busy !== null} onClick={() => { const next = draft(); if (next) { void runCheck(next); } }}>
						{t('move.checkBoth')} <Icon name="arrow-right" />
					</button>
				)}
				{step === 'check' && (
					<>
						<button type="button" className="secondary" disabled={busy !== null || !spec} onClick={() => { if (spec) { void runCheck(spec); } }}>
							<Icon name="refresh" /> {t('move.checkAgain')}
						</button>
						<button type="button" disabled={!check?.ready || busy !== null} onClick={() => setStep('review')}>
							{t('move.review')} <Icon name="arrow-right" />
						</button>
					</>
				)}
				{step === 'review' && (
					<button type="button" disabled={!confirmed || busy !== null} onClick={() => void start()}>
						<Icon name="play" /> {confirmed ? t('move.startMove') : t('move.typeNamesToStart')}
					</button>
				)}
				{step === 'moving' && runId && !result && (
					<button type="button" className="secondary" onClick={() => void window.sqlApi.moves.cancel(runId)}>
						<Icon name="debug-stop" /> {t('move.stopMove')}
					</button>
				)}
				{step === 'moving' && (result || (!runId && progress && !isActivePhase(progress.phase))) && (
					<button type="button" onClick={props.onClose}><Icon name="close" /> {t('move.close')}</button>
				)}
			</div>
		</div>
	);
}

/** The source → copy → target route, in the house pipeline pulse: staged CSS keyframes coloured by theme tokens. */
export function MoveRoute(props: { source: RouteEnd | undefined; target: RouteEnd | undefined; running: boolean }): JSX.Element {
	const t = useT();
	return (
		<div className={`move-route${props.running ? ' running' : ''}`} aria-hidden="true">
			<span className="move-route-stage start">
				<span className="move-route-node"><Icon name={props.source?.icon ?? 'database'} /></span>
				<span className="move-route-label">{props.source?.label ?? t('move.sourceFallback')}</span>
			</span>
			<span className="move-route-track" />
			<span className="move-route-stage">
				<span className="move-route-node two"><Icon name="arrow-both" /></span>
				<span className="move-route-label">{t('move.copyStage')}</span>
			</span>
			<span className="move-route-track two" />
			<span className="move-route-stage end">
				<span className="move-route-node three"><Icon name={props.target?.icon ?? 'database'} /></span>
				<span className="move-route-label">{props.target?.label ?? t('move.targetFallback')}</span>
			</span>
		</div>
	);
}

const TABLE_ICON: Record<'waiting' | 'copying' | 'done' | 'failed', string> = {
	waiting: 'circle-large-outline',
	copying: 'sync',
	done: 'pass-filled',
	failed: 'error'
};

export function MoveProgressPanel(props: { progress: MoveProgress; source: RouteEnd | undefined; target: RouteEnd | undefined }): JSX.Element {
	const t = useT();
	const { progress } = props;
	const fraction = overallFraction(progress);
	const eta = etaSeconds(progress);
	const active = isActivePhase(progress.phase);
	return (
		<div className="flow-wizard-pane move-pane move-progress">
			<MoveRoute source={props.source} target={props.target} running={active} />
			<div className="move-progress-head">
				<h2>{PHASE_TITLE[progress.phase]}</h2>
				{progress.message && <span className="flow-wizard-dim">{progress.message}</span>}
			</div>
			<div
				className={`progress-track move-progress-overall${fraction === null && active ? ' indeterminate' : ''}`}
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
			>
				<div className="progress-fill" style={fraction === null && active ? undefined : { width: `${Math.round((fraction ?? 0) * 100)}%` }} />
			</div>
			<div className="flow-wizard-summary">
				<span><Icon name="database" /> {progress.bytesTotal ? t('move.bytesOfAbout', { done: formatBytes(progress.bytesDone), total: formatBytes(progress.bytesTotal) }) : formatBytes(progress.bytesDone)}</span>
				{progress.bytesPerSecond ? <span><Icon name="dashboard" /> {formatBytes(progress.bytesPerSecond)}/s</span> : null}
				{eta !== null && <span><Icon name="clock" /> {t('move.etaLeft', { eta: formatDuration(eta) })}</span>}
				{progress.objectsFailed > 0 && <span className="move-failed"><Icon name="error" /> {t('move.notRestored', { n: progress.objectsFailed })}</span>}
			</div>
			<ul className="move-tables">
				{progress.tables.map((table) => {
					const part = tableFraction(table);
					return (
						<li key={`${table.schema}.${table.table}`} className={`move-table ${table.state}`}>
							<Icon name={TABLE_ICON[table.state]} className={table.state === 'copying' ? 'flow-wizard-spin' : undefined} />
							<span className="move-table-name">{table.schema}.{table.table}</span>
							<span className={`progress-track move-table-bar${part === null && table.state === 'copying' ? ' indeterminate' : ''}`}>
								<span className="progress-fill" style={part === null && table.state === 'copying' ? undefined : { width: `${Math.round((part ?? 0) * 100)}%` }} />
							</span>
							<span className="move-table-count">
								{table.rowsEstimate ? t('move.rowsOf', { done: table.rowsDone, total: table.rowsEstimate }) : t('move.rowsDone', { done: table.rowsDone })}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

const RESULT_ICON: Record<MoveRunResult['status'], string> = {
	success: 'pass',
	partial: 'warning',
	failed: 'error',
	cancelled: 'circle-slash'
};

/** The report: one sentence, then only what did not match or did not restore, by name. */
function MoveResultPanel(props: { result: MoveRunResult }): JSX.Element {
	const t = useT();
	const { result } = props;
	const tables = result.tables.filter((table) => !table.matches);
	const sequences = result.sequences.filter((sequence) => !sequence.matches);
	const backupUrl = result.backup?.url ?? null;
	return (
		<div className={`move-result ${result.status}`} role="status">
			<div className="move-result-head">
				<Icon name={RESULT_ICON[result.status]} />
				<span>{describeRun(result)}</span>
			</div>
			{backupUrl && (
				<p className="flow-wizard-dim">
					{t('move.backupBefore')}{' '}
					<a href="#" onClick={(event) => { event.preventDefault(); void window.sqlApi.openExternal(backupUrl); }}>{t('move.backupLink')}</a> {t('move.backupAfter')}
				</p>
			)}
			{tables.length > 0 && (
				<>
					<h3 className="move-heading">{t('move.tablesMismatch')}</h3>
					<ul className="move-result-list">
						{tables.map((table) => (
							<li key={`${table.schema}.${table.table}`}>
								<span className="move-table-name">{table.schema}.{table.table}</span>
								<span className="move-table-count">
									{table.targetRows === null ? t('move.notOnTarget') : t('move.rowsOfSource', { target: table.targetRows, source: table.sourceRows ?? 0 })}
								</span>
							</li>
						))}
					</ul>
				</>
			)}
			{sequences.length > 0 && (
				<>
					<h3 className="move-heading">{t('move.sequencesMismatch')}</h3>
					<ul className="move-result-list">
						{sequences.map((sequence) => (
							<li key={`${sequence.schema}.${sequence.name}`}>
								<span className="move-table-name">{sequence.schema}.{sequence.name}</span>
								<span className="move-table-count">{t('move.sequenceValues', { target: String(sequence.target ?? t('move.missing')), source: String(sequence.source ?? t('move.neverUsed')) })}</span>
							</li>
						))}
					</ul>
				</>
			)}
			{result.failures.length > 0 && (
				<>
					<h3 className="move-heading">{t('move.didNotRestore')}</h3>
					{result.failures.map((failure, index) => (
						<details key={index} className="move-result-failure">
							<summary>{failure.object ?? t('move.anObject')}: {failure.message.split('\n')[0]}</summary>
							{failure.command && <pre className="flow-wizard-sql">{failure.command}</pre>}
						</details>
					))}
				</>
			)}
		</div>
	);
}

/**
 * Dev only: a simulated run shaped like the measured 883 MB move, so the progress
 * screen can be looked at before the runner exists. It ticks DATA in state; the motion itself stays
 * CSS, as the house pattern requires.
 */
function usePreviewRun(enabled: boolean, setProgress: (progress: MoveProgress) => void): void {
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const tables = [
			{ schema: 'public', table: 'customers', bytes: 4_200_000, rows: 20_000 },
			{ schema: 'public', table: 'orders', bytes: 880_000_000, rows: 2_000_000 },
			{ schema: 'reporting', table: 'daily', bytes: 57_344, rows: 244 }
		];
		const total = tables.reduce((sum, table) => sum + table.bytes, 0);
		const rate = 14_200_000;
		let elapsed = 0;
		const timer = window.setInterval(() => {
			elapsed += 0.25;
			const waking = elapsed < 2;
			const copied = waking ? 0 : Math.min(total, (elapsed - 2) * rate * 4);
			let left = copied;
			const rows = tables.map((table) => {
				const done = Math.max(0, Math.min(table.bytes, left));
				left -= done;
				const state: MoveProgress['tables'][number]['state'] = done >= table.bytes ? 'done' : done > 0 ? 'copying' : 'waiting';
				return { schema: table.schema, table: table.table, state, bytesDone: done, bytesTotal: table.bytes, rowsDone: Math.round((done / table.bytes) * table.rows), rowsEstimate: table.rows };
			});
			const finished = copied >= total;
			const copying = rows.find((row) => row.state === 'copying');
			setProgress({
				runId: 'preview',
				moveId: 'preview',
				phase: waking ? 'waking' : finished ? (elapsed > 2 + total / (rate * 4) + 2 ? 'done' : 'verifying') : 'data',
				message: waking ? "Waking exampleref003" : copying ? `Copying ${copying.schema}.${copying.table}` : null,
				tables: rows,
				bytesDone: copied,
				bytesTotal: total,
				bytesPerSecond: waking ? null : rate * 4,
				objectsFailed: 0
			});
			if (elapsed > 2 + total / (rate * 4) + 2) {
				window.clearInterval(timer);
			}
		}, 250);
		return () => window.clearInterval(timer);
	}, [enabled, setProgress]);
}

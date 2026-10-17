/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { CLOUD_REGIONS, type CloudActionOutcome, type CloudCreateOutcome, type CloudProjectRow, type CloudProjectsView } from '../../../shared/cloudProjects';
import type { LocalActionOutcome, LocalProjectRow, LocalProjectsView } from '../../../shared/localStack';
import { PROJECT_SECTION_GROUPS, PROJECT_SECTIONS, type ProjectSection, type ProjectTarget } from '../../../shared/projects';
import { localStateLabel, localTone } from '../localProjects';
import { ProjectsArt } from '../art/Illustrations';

/**
 * Projects, as a docked tool window: two groups, LOCAL (the SnoutData stack in the user's own
 * Docker) and CLOUD (the account's hosted projects). A project is the same idea in both: a database
 * with auth, storage, functions and an API in front, and it expands into the same kind of children.
 *
 * **Cloud: the whole life of a project.** Create, start, stop, delete, inspect. Every one is the
 * Snout Function the dashboard and the CLI call, so quotas, regions and billing stay the
 * control plane's. A project created here is added as a connection at once, and main keeps
 * the rest in step in the background (`main/cloudSync.ts`).
 *
 * **Nothing here decides anything.** Whether a project may be stopped, and what to say when
 * it may not, is computed in main from the control plane's own answer; this draws it. The
 * rules themselves (a production project is never paused, a deleted one accepts nothing)
 * live in the tested control package and come back as sentences, so a refusal is shown in
 * the words the control plane used rather than paraphrased here.
 *
 * **Cloud reports "asked", never "done".** `pause` and `resume` set a desired state; the host
 * agent acts on its next tick. So an action says what was asked for and the list is
 * re-read, which is also why a project mid-flight offers no buttons: asking for a second
 * thing on top of the first is how a pod gets told to start and stop in the same tick.
 *
 * **Local is the engine's answer.** States come from one `docker ps`, read when the panel opens
 * and every few seconds while it is shown; a start streams to the tab and the dot follows.
 *
 * Nothing is fetched until the panel is opened — the rule under "Startup is sacred",
 * applied to a network call and to a docker one.
 */
interface DashboardPanelProps {
	onCollapse(): void;
	/** Open the project's tab at a section. */
	onOpenProject(ref: string, name: string, section: ProjectSection): void;
	/** Show the connection this project's database is, in Connections. */
	onOpenDatabase(ref: string): void;
	/** Open the local setup wizard. */
	onSetupLocal(): void;
	/** Open a local project's tab at a section. */
	onOpenLocalProject(id: string, name: string, section: ProjectSection): void;
	/** Show a local project's database in Connections. */
	onOpenLocalDatabase(id: string): void;
	/** Copy a whole project to the other side: this computer to the cloud, or back. */
	onCopyProject(target: ProjectTarget, name: string): void;
}

/** How often the local states are read while the panel is on screen. */
const LOCAL_POLL_MS = 6000;

/** How often the cloud list is read while a project is on its way somewhere (starting, pausing). */
const CLOUD_SETTLE_POLL_MS = 3000;

function bytes(n: number | null): string {
	if (n === null) {
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

function ago(iso: string | null): string {
	if (!iso) {
		return "never";
	}
	const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
	if (days <= 0) {
		return "today";
	}
	return days === 1 ? "yesterday" : `${days}d ago`;
}

/** What the dot beside a project means. A paused project is not unhealthy. */
function stateTone(row: CloudProjectRow): string {
	if (row.state === 'error') {
		return 'error';
	}
	if (row.busy) {
		return 'warn';
	}
	return row.state === 'ready' ? 'ok' : 'dim';
}

export function DashboardPanel(props: DashboardPanelProps): JSX.Element {
	const [view, setView] = useState<CloudProjectsView | null>(null);
	const [local, setLocal] = useState<LocalProjectsView | null>(null);
	const [busy, setBusy] = useState(false);
	/** Expanded tree nodes: the two groups, a project's key, and `<key>:overview` / `<key>:databases`. */
	const [expanded, setExpanded] = useState<Set<string>>(new Set(['group:local', 'group:cloud']));
	/** The last thing that happened, per project: an outcome, not a status. */
	const [said, setSaid] = useState<Record<string, CloudActionOutcome | LocalActionOutcome>>({});
	/** Local projects with a start or stop in flight from here. */
	const [localBusy, setLocalBusy] = useState<Set<string>>(new Set());
	const [creating, setCreating] = useState(false);
	/** What the last create said, shown above the list until the next one. */
	const [created, setCreated] = useState<CloudCreateOutcome | null>(null);
	const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
	const [confirm, confirmDialog] = useConfirm();

	const refresh = useCallback(async (quiet = false) => {
		// A quiet read (the settle poll below) leaves the buttons alone: flickering every row's
		// actions off every few seconds is worse than a list that is a moment behind.
		if (!quiet) {
			setBusy(true);
		}
		try {
			setView(await window.sqlApi.cloudProjects());
		} catch (error) {
			// A failed read must not leave the LAST answer on screen. Without this the panel
			// keeps showing whatever it said before — "sign in", an old list — with no hint
			// that the refresh went nowhere, which is the most confusing thing it could do.
			setView({
				account: null,
				projects: [],
				unavailable: `Could not read your hosted databases: ${error instanceof Error ? error.message : String(error)}`,
			});
		} finally {
			if (!quiet) {
				setBusy(false);
			}
		}
	}, []);

	// A project on its way somewhere is read again until it gets there. The list used to be read
	// once, right after Start, when the host had not acted yet, and never again: the row stayed
	// "paused → running · working" with every button off while the project had been ready for
	// minutes.
	const settling = view?.projects.some((row) => row.busy) ?? false;
	// And once one gets there, "Asked it to start. This takes a few seconds." is no longer
	// news: it is cleared, so the overview does not keep promising what has already happened.
	const wasBusy = useRef<Set<string>>(new Set());
	useEffect(() => {
		const now = new Set((view?.projects ?? []).filter((row) => row.busy).map((row) => row.ref));
		const arrived = [...wasBusy.current].filter((ref) => !now.has(ref));
		wasBusy.current = now;
		if (arrived.length > 0) {
			setSaid((prev) => {
				const next = { ...prev };
				for (const ref of arrived) {
					if (next[ref]?.ok) {
						delete next[ref];
					}
				}
				return next;
			});
		}
	}, [view]);
	useEffect(() => {
		if (!settling) {
			return undefined;
		}
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void refresh(true);
			}
		}, CLOUD_SETTLE_POLL_MS);
		return () => clearInterval(timer);
	}, [settling, refresh]);

	// The tray starts and stops projects too: read the list again, and the settle poll above
	// follows the project the rest of the way.
	useEffect(() => window.sqlApi.onCloudChanged(() => { void refresh(true); }), [refresh]);

	const refreshLocal = useCallback(async () => {
		try {
			setLocal(await window.sqlApi.local.list());
		} catch (error) {
			setLocal({ projects: [], unavailable: `Could not read your local projects: ${error instanceof Error ? error.message : String(error)}` });
		}
	}, []);

	useEffect(() => {
		void refresh();
		void refreshLocal();
	}, [refresh, refreshLocal]);

	// Local states move on their own (a container exits, Docker is quit), so they are read again
	// while the panel is shown, and at once when a start or a setup finishes anywhere in the app.
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void refreshLocal();
			}
		}, LOCAL_POLL_MS);
		const off = window.sqlApi.local.onProgress((progress) => {
			if (progress.step === 'done' || progress.step === 'failed') {
				void refreshLocal();
			}
		});
		return () => {
			clearInterval(timer);
			off();
		};
	}, [refreshLocal]);

	// Signing in, out or into another account changes whose projects these are, so re-read the
	// list then. Only then: auth also changes on every tier refresh, and that is not a reason to
	// ask the control plane again.
	const accountRef = useRef<string | null | undefined>(undefined);
	useEffect(() => {
		void window.sqlApi.authState().then((state) => {
			accountRef.current ??= state.user?.id ?? null;
		});
	}, []);
	useEffect(() => window.sqlApi.onAuthChanged((state) => {
		const who = state.user?.id ?? null;
		if (accountRef.current !== undefined && accountRef.current !== who) {
			setSaid({});
			setCreated(null);
			setExpanded(new Set(['group:local', 'group:cloud']));
			void refresh();
		}
		accountRef.current = who;
	}), [refresh]);

	async function ask(action: 'pause' | 'resume', ref: string): Promise<void> {
		setBusy(true);
		try {
			const outcome = await window.sqlApi.cloudAsk(action, ref);
			setSaid((prev) => ({ ...prev, [ref]: outcome }));
			// Re-read rather than patching the row from the reply: what came back is what
			// was ASKED for, and the list is the only thing that knows what happened.
			await refresh();
		} finally {
			setBusy(false);
		}
	}

	async function localAction(action: 'start' | 'stop', row: LocalProjectRow): Promise<void> {
		if (action === 'stop' && row.production && !(await confirm({
			title: "Stop a production project?",
			body: "It is marked production. Everything connected to it loses it until it is started again.",
			confirmLabel: "Stop it",
			danger: true,
		}))) {
			return;
		}
		setLocalBusy((prev) => new Set(prev).add(row.id));
		setSaid((prev) => ({ ...prev, [row.id]: { ok: true, message: action === 'start' ? "Starting…" : "Stopping…" } }));
		void refreshLocal();
		try {
			const outcome = action === 'start' ? await window.sqlApi.local.start(row.id) : await window.sqlApi.local.stop(row.id);
			setSaid((prev) => ({ ...prev, [row.id]: outcome }));
		} finally {
			setLocalBusy((prev) => {
				const next = new Set(prev);
				next.delete(row.id);
				return next;
			});
			await refreshLocal();
		}
	}

	function toggle(key: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}

	/** Opening a project opens its Overview too: the state and Start/Stop are why most people came. */
	function toggleProject(key: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
				next.add(`${key}:overview`);
			}
			return next;
		});
	}

	async function remove(row: CloudProjectRow): Promise<void> {
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
			setSaid((prev) => ({ ...prev, [row.ref]: outcome }));
			await refresh();
		} finally {
			setBusy(false);
		}
	}

	function statusLine(key: string): JSX.Element | null {
		const outcome = said[key];
		if (!outcome) {
			return null;
		}
		// Three readings, not two. Asked for: quiet. Refused: amber, because
		// the app stopping something is the system working. Failed: red.
		const refused = 'refused' in outcome && outcome.refused;
		return <div className={outcome.ok ? 'muted' : refused ? 'form-status warn' : 'form-status error'}>{outcome.message}</div>;
	}

	const projects = view?.projects ?? [];
	const locals = local?.projects ?? [];
	const localOpen = expanded.has('group:local');
	const cloudOpen = expanded.has('group:cloud');

	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<span>DASHBOARD</span>
				<span className="spacer" />
				<button
					className="icon-btn"
					aria-label="New project"
					onClick={(e) => {
						const box = e.currentTarget.getBoundingClientRect();
						setNewMenu({ x: box.left, y: box.bottom + 4 });
					}}
				>
					<Icon name="add" />
				</button>
				<button className="icon-btn" aria-label="Refresh" onClick={() => { void refresh(); void refreshLocal(); }} disabled={busy}><Icon name="refresh" /></button>
				<button className="icon-btn" aria-label="Collapse" onClick={props.onCollapse}><Icon name="chevron-left" /></button>
			</div>

			{newMenu && (
				<NewProjectMenu
					at={newMenu}
					cloudAllowed={!!view?.account}
					onLocal={() => { setNewMenu(null); props.onSetupLocal(); }}
					onCloud={() => { setNewMenu(null); setCreating(true); }}
					onClose={() => setNewMenu(null)}
				/>
			)}

			<div className="tree">
				{/* ---- Local: the stack in this computer's Docker. ---- */}
				<div className="tree-row depth-0 projects-group" onClick={() => toggle('group:local')}>
					<span className="twisty"><Icon name={localOpen ? 'chevron-down' : 'chevron-right'} /></span>
					<span className="tree-icon"><Icon name="device-desktop" /></span>
					<span className="tree-label">Local</span>
					<span className="row-actions" onClick={(e) => e.stopPropagation()}>
						<button className="icon-btn" aria-label="Set up a local project" onClick={props.onSetupLocal}><Icon name="add" /></button>
					</span>
				</div>
				{localOpen && (
					<>
						{!local && <div className="muted small projects-note">Loading…</div>}
						{local?.unavailable && locals.length > 0 && <div className="muted small projects-note">{local.unavailable}</div>}
						{local && locals.length === 0 && (
							<div className="tree-row depth-1" onClick={props.onSetupLocal} title="Run the whole SnoutData stack in Docker on this computer">
								<span className="twisty" />
								<span className="tree-icon"><Icon name="add" /></span>
								<span className="tree-label">Set up a local project</span>
							</div>
						)}
						{locals.map((row) => {
							const key = `local:${row.id}`;
							const isOpen = expanded.has(key);
							const overviewOpen = expanded.has(`${key}:overview`);
							const working = localBusy.has(row.id);
							const tone = working ? 'warn' : localTone(row.state);
							return (
								<div key={key}>
									<div className="tree-row depth-1" onClick={() => toggleProject(key)}>
										<span className="twisty"><Icon name={isOpen ? 'chevron-down' : 'chevron-right'} /></span>
										<span className={`cloud-dot ${tone}`} aria-hidden="true" title={localStateLabel(row.state)} />
										<span className="tree-label" title={row.folder}>{row.name}</span>
									</div>
									{isOpen && (
										<>
											<ProjectMenu
												actions={(
													<>
														<button type="button" disabled={working || row.state === 'running' || row.state === 'missing'} onClick={() => void localAction('start', row)}><Icon name="play" /> Start</button>
														<button type="button" disabled={working || row.state === 'stopped' || row.state === 'missing' || row.state === 'unknown'} onClick={() => void localAction('stop', row)}><Icon name="debug-stop" /> Stop</button>
														<button type="button" className="secondary" title="Copy this project to SnoutData Cloud" onClick={() => props.onCopyProject({ kind: 'local', id: row.id }, row.name)}><Icon name="cloud-upload" /> Copy</button>
													</>
												)}
												overviewOpen={overviewOpen}
												onToggleOverview={() => toggle(`${key}:overview`)}
												overview={(
													<div className="small muted cloud-detail depth-detail-2">
														<div>{working ? "working" : localStateLabel(row.state)}</div>
														<div className="mono" title={row.apiUrl}>{row.apiUrl}</div>
														<div className="mono" title={row.folder}>{row.folder}</div>
														{statusLine(row.id)}
													</div>
												)}
												onOpenDatabase={() => props.onOpenLocalDatabase(row.id)}
												onOpen={(section) => props.onOpenLocalProject(row.id, row.name, section)}
											/>
										</>
									)}
								</div>
							);
						})}
					</>
				)}

				{/* ---- Cloud: the account's hosted projects. ---- */}
				<div className="tree-row depth-0 projects-group" onClick={() => toggle('group:cloud')}>
					<span className="twisty"><Icon name={cloudOpen ? 'chevron-down' : 'chevron-right'} /></span>
					<span className="tree-icon"><Icon name="cloud" /></span>
					<span className="tree-label">Cloud</span>
					{view?.account && (
						<span className="row-actions" onClick={(e) => e.stopPropagation()}>
							<button className="icon-btn" aria-label="New cloud project" onClick={() => setCreating(true)}><Icon name="add" /></button>
						</span>
					)}
				</div>
				{cloudOpen && (
					<>
						{!view && <div className="muted small projects-note">Loading…</div>}

						{/* A sentence, not an empty list: "you have no databases" and "you are not
						    signed in" are different answers and only one is the user's to fix. */}
						{view?.unavailable && <div className="muted small projects-note">{view.unavailable}</div>}

						{/* Only while it is news: once the new project has finished starting, its green dot says
						    the rest, and a line about "starting" left above a ready project reads as stale. */}
						{created && !(created.ok && created.ref && projects.some((p) => p.ref === created.ref && !p.busy && p.state === 'ready')) && (
							<div className={`small projects-note ${created.ok ? 'muted' : created.refused ? 'form-status warn' : 'form-status error'}`}>{created.message}</div>
						)}

						{view?.account && projects.length === 0 && (
							<div className="tree-row depth-1" onClick={() => setCreating(true)}>
								<span className="twisty" />
								<span className="tree-icon"><Icon name="add" /></span>
								<span className="tree-label">New cloud project</span>
							</div>
						)}

						{projects.map((row) => {
							const isOpen = expanded.has(row.ref);
							const overviewOpen = expanded.has(`${row.ref}:overview`);
							return (
								<div key={row.ref}>
									<div className="tree-row depth-1" onClick={() => toggleProject(row.ref)}>
										<span className="twisty"><Icon name={isOpen ? 'chevron-down' : 'chevron-right'} /></span>
										<span className={`cloud-dot ${stateTone(row)}`} aria-hidden="true" title={row.state} />
										<span className="tree-label" title={row.ref}>{row.name}</span>
										{row.production && <span className="env prod">prod</span>}
										{row.readOnly && <span className="env" title="Over its plan's storage limit, so the database is refusing writes">read-only</span>}
									</div>

									{isOpen && (
										<>
											<ProjectMenu
												actions={(
													<>
														<button type="button" disabled={!row.canResume || busy} onClick={() => void ask('resume', row.ref)}><Icon name="play" /> Start</button>
														{/* The one refusal worth stating BEFORE it happens, because it is a property the
														    user set rather than a passing state. */}
														<button type="button" disabled={!row.canPause || busy} title={row.pauseRefusal} onClick={() => void ask('pause', row.ref)}><Icon name="debug-stop" /> Stop</button>
														<button type="button" className="secondary" title="Copy this project to this computer" onClick={() => props.onCopyProject({ kind: 'cloud', ref: row.ref }, row.name)}><Icon name="cloud-download" /> Copy</button>
													</>
												)}
												overviewOpen={overviewOpen}
												onToggleOverview={() => toggle(`${row.ref}:overview`)}
												overview={(
													<div className="small muted cloud-detail depth-detail-2">
														<div>
															{/* The state, and what it is on its way to when those differ. A
															    healthy project shows one word, not an arrow to itself. */}
															{row.state}{row.desiredState ? ` → ${row.desiredState}` : ''}
															{row.busy ? ' · working' : ''}
														</div>
														<div>{bytes(row.sizeBytes)} · {row.region}</div>
														<div>last connected {ago(row.lastConnectionAt)}</div>
														{!row.wakesInstantly && (
															<div title="Its data is in the bucket rather than on a host">
																cold: the next start restores it, which takes longer
															</div>
														)}
														<div className="mono" title={`${row.user}@${row.host}/${row.database}`}>{row.host}</div>
	
														<div className="row cloud-actions">
															<span className="spacer" />
															<button
																type="button"
																className="danger small"
																disabled={!row.canDelete || busy}
																onClick={() => void remove(row)}
															>
																<Icon name="trash" /> Delete
															</button>
														</div>
	
														{row.pauseRefusal && !row.canPause && <div className="muted">{row.pauseRefusal}</div>}
														{statusLine(row.ref)}
													</div>
												)}
												onOpenDatabase={() => props.onOpenDatabase(row.ref)}
												onOpen={(section) => props.onOpenProject(row.ref, row.name, section)}
											/>
										</>
									)}
								</div>
							);
						})}
					</>
				)}

				{/* Nothing anywhere yet: the two kinds of project, drawn, under their two groups. */}
				{local && view && locals.length === 0 && projects.length === 0 && (
					<div className="projects-empty">
						<ProjectsArt className="projects-empty-art" />
						<p>Your projects live here: run one in Docker on this computer, or in SnoutData Cloud.</p>
					</div>
				)}
			</div>

			{/* The panel's footer, outside the scrolling tree, so it stays at the bottom by the
			    status bar however long or short the list is. */}
			{view?.account && projects.length > 0 && (
				<div className="muted small cloud-account">Signed in as {view.account}.</div>
			)}

			{creating && (
				<NewCloudProject
					onClose={() => setCreating(false)}
					onCreated={(outcome) => {
						setCreating(false);
						setCreated(outcome);
						if (outcome.ref) {
							const ref = outcome.ref;
							setExpanded((prev) => new Set([...prev, 'group:cloud', ref, `${ref}:overview`]));
						}
						void refresh();
					}}
				/>
			)}
			{confirmDialog}
		</div>
	);
}

/** The header's +: which kind of project. A cloud one needs an account; a local one needs Docker, which the wizard checks. */
function NewProjectMenu(props: { at: { x: number; y: number }; cloudAllowed: boolean; onLocal(): void; onCloud(): void; onClose(): void }): JSX.Element {
	const ref = useRef<HTMLDivElement | null>(null);
	const { onClose } = props;
	useEffect(() => {
		const away = (event: MouseEvent): void => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				onClose();
			}
		};
		const key = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('mousedown', away, true);
		document.addEventListener('keydown', key);
		return () => {
			document.removeEventListener('mousedown', away, true);
			document.removeEventListener('keydown', key);
		};
	}, [onClose]);
	const left = Math.min(props.at.x, Math.max(8, window.innerWidth - 248));
	return (
		<div className="panel-menu" ref={ref} style={{ left, top: props.at.y }} role="menu">
			<div className="panel-menu-title">New project</div>
			<button type="button" role="menuitem" className="panel-menu-item" onClick={props.onLocal}>
				<Icon name="device-desktop" /> Local, in Docker on this computer
			</button>
			<button
				type="button"
				role="menuitem"
				className="panel-menu-item"
				disabled={!props.cloudAllowed}
				title={props.cloudAllowed ? undefined : "Sign in to create a cloud project"}
				onClick={props.onCloud}
			>
				<Icon name="cloud" /> In SnoutData Cloud
			</button>
		</div>
	);
}

/**
 * The New Project form: the dashboard's fields, in the connection form's shape. Whether this
 * tier may mark a project production, and whether the plan has room for another, are the
 * control plane's to say, and a refusal is shown in its words and keeps the form open.
 */
function NewCloudProject(props: { onClose(): void; onCreated(outcome: CloudCreateOutcome): void }): JSX.Element {
	const [name, setName] = useState('');
	const [region, setRegion] = useState(CLOUD_REGIONS[0].id);
	const [production, setProduction] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<CloudActionOutcome | null>(null);

	async function submit(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const outcome = await window.sqlApi.cloudCreate({ name: name.trim(), region, production });
			if (outcome.ok) {
				props.onCreated(outcome);
			} else {
				setError(outcome);
			}
		} catch (e) {
			setError({ ok: false, message: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<form
				className="modal"
				onClick={(e) => e.stopPropagation()}
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<h2>New project</h2>
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="orders, staging, my side project" maxLength={60} autoFocus />
				</label>
				<label>
					Region
					<select value={region} onChange={(e) => setRegion(e.target.value)}>
						{CLOUD_REGIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
					</select>
				</label>
				<label className="check">
					<input type="checkbox" checked={production} onChange={(e) => setProduction(e.target.checked)} /> Treat this as production
				</label>
				<p className="field-hint">A production project is never paused, whether you ask or the idle policy does. Plus and Pro only.</p>
				<p className="field-hint">It is added to your connections as soon as it is created.</p>
				{error && <div className={error.refused ? 'form-status warn' : 'form-status error'}>{error.message}</div>}
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={props.onClose} disabled={busy}><Icon name="close" /> Cancel</button>
					<button type="submit" disabled={busy || name.trim() === ''}><Icon name="add" /> {busy ? "Creating…" : "Create"}</button>
				</div>
			</form>
		</div>
	);
}

/**
 * A project's children in the tree, local or cloud: the dashboard's project menu, group for group
 * (shared/projects.ts), the same one the project's tab shows. The Dashboard row opens in place, for
 * Start and Stop without a tab; every other row opens the project's tab at that section, and the
 * Database row also carries a plug that shows its connection in Connections.
 */
function ProjectMenu(props: {
	/** What can be done to the project, in a compact strip above its menu. */
	actions: JSX.Element;
	overviewOpen: boolean;
	onToggleOverview(): void;
	overview: JSX.Element;
	onOpenDatabase(): void;
	onOpen(section: ProjectSection): void;
}): JSX.Element {
	return (
		<>
			<div className="project-actions" onClick={(e) => e.stopPropagation()}>{props.actions}</div>
			{PROJECT_SECTION_GROUPS.map((group) => (
				<div key={group.id}>
					<div className="tree-row depth-2 projects-subgroup" aria-hidden="true">
						<span className="twisty" />
						<span className="tree-label">{group.label}</span>
					</div>
					{PROJECT_SECTIONS.filter((section) => section.group === group.id && !section.gated).map((section) => {
						if (section.id === 'overview') {
							return (
								<div key={section.id}>
									<div className="tree-row depth-2" onClick={props.onToggleOverview}>
										<span className="twisty"><Icon name={props.overviewOpen ? 'chevron-down' : 'chevron-right'} /></span>
										<span className="tree-icon"><Icon name={section.icon} /></span>
										<span className="tree-label">{section.label}</span>
									</div>
									{props.overviewOpen && props.overview}
								</div>
							);
						}
						return (
							<div key={section.id} className="tree-row depth-2" onClick={() => props.onOpen(section.id)}>
								<span className="twisty" />
								<span className="tree-icon"><Icon name={section.icon} /></span>
								<span className="tree-label">{section.label}</span>
								{/* The database is also a connection: the plug jumps to it in Connections, and
								    the row itself opens the section like every other row. */}
								{section.id === 'database' && (
									<button
										type="button"
										className="icon-btn table-stats-btn projects-jump"
										title="Show in Connections"
										aria-label="Show in Connections"
										onClick={(e) => { e.stopPropagation(); props.onOpenDatabase(); }}
									>
										<Icon name="plug" />
									</button>
								)}
							</div>
						);
					})}
				</div>
			))}
		</>
	);
}

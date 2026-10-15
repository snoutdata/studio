/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CloudProjectRow } from '../shared/cloudProjects';
import type { ConnectionConfig } from '../shared/connection';
import type { LocalProjectRow } from '../shared/localStack';
import { projectKey } from '../shared/projects';
import { updateProgressDetail, type UpdateStatus } from '../shared/update';
import type { TrayDotName } from './trayIcon';

// What the tray's menu says, as data.
//
// Kept apart from tray.ts (which is the Electron glue) so the part with rules in it - what the app
// is doing, which flows and connections are listed, in what order, and what each one says about
// itself - is pure, and can be tested without an app. Nothing here reads a clock, a disk or a
// store: the caller passes the whole state in.
//
// The shape is the one a background app wants: a status line first (is it running, is it busy, is
// something paused) with the schedule pause beside it, since that is the one switch that changes
// what the line says; then the ways back in, then the things it looks after, then the app-level
// actions, and quit at the bottom.

/** The most flows or connections the menu lists. Past this it says how many more there are and
 *  leaves them to the app's own panels: a context menu that runs off the screen is worse. */
const MAX_ITEMS = 8;

/** Windows truncates a tray tooltip at 127 characters, so build one that fits. */
const MAX_TOOLTIP = 120;

export type TrayDot = TrayDotName;

/** One flow, as the tray menu says it. */
export interface TrayFlowItem {
	id: string;
	name: string;
	/** What it is doing, shown after the name: "in 12m", "due now", "running", "paused". */
	detail: string;
	/** A run is in flight, so this one is not offered a "Run Now". */
	running: boolean;
	dot: TrayDot;
}

/** One connection, as the tray menu says it. */
export interface TrayConnectionItem {
	id: string;
	label: string;
	/** "connected", "PROD", both, or nothing. */
	detail: string;
	connected: boolean;
	dot: TrayDot;
}

/** What a project's submenu can ask of it besides opening it. */
export type TrayProjectVerb = 'start' | 'stop' | 'pause' | 'resume';

/** One project from the Dashboard panel, local or cloud, as the tray menu says it. */
export interface TrayProjectItem {
	kind: 'local' | 'cloud';
	/** The local project's id, or the cloud project's ref. */
	id: string;
	name: string;
	/** "running", "stopped", "paused", "PROD, running", ... */
	detail: string;
	dot: TrayDot;
	/** Start/Stop for a local project, Pause or Resume for a cloud one. Listed even when they
	 *  cannot be asked right now, disabled, the way the panel's own buttons are. */
	actions: { verb: TrayProjectVerb; label: string; enabled: boolean }[];
}

/** A local project as the tray reads it: the Dashboard's last `docker ps`, never a fresh one. */
export type TrayLocalProjectInput = Pick<LocalProjectRow, 'id' | 'name' | 'state' | 'production'>;

/** A cloud project as the tray reads it: the control plane's last answer, never a fresh one. */
export type TrayCloudProjectInput = Pick<CloudProjectRow, 'ref' | 'name' | 'state' | 'desiredState' | 'busy' | 'production' | 'canPause' | 'canResume'>;

/** The one line at the top: what the app is doing right now. */
export interface TrayStatus {
	label: string;
	dot: TrayDot;
}

/**
 * What the pull-request reviewer is doing, for the tray.
 *
 * It earns a place here for the same reason a scheduled flow does: it works while there is no
 * window, and a review that finished behind a hidden window is otherwise invisible until the
 * user happens to open the app. The one that MUST be readable from the bar is a review waiting
 * to be posted — nothing goes out until the user says so, so an unread one is a promise the app
 * is holding rather than keeping.
 */
export interface TrayReviewInput {
	/** The master switch. Nothing below means anything while this is off. */
	enabled: boolean;
	/** Repositories being watched right now. */
	watching: number;
	/** What it is doing this second ("Reviewing owner/name #12"), when it is doing anything. */
	activity?: string;
	/** Reviews written and waiting for the user to read them before they post. */
	awaiting: number;
}

/** The reviewer's line in the menu, or null when it has nothing to say (never configured). */
export interface TrayReview {
	label: string;
	dot: TrayDot;
}

/** The account line, which is either who you are or an invitation to sign in. */
export interface TrayAccount {
	label: string;
	signedIn: boolean;
}

/** The update line, which changes with what the updater is doing. */
export interface TrayUpdate {
	label: string;
	/** What clicking it does. `none` while an update is mid-flight, and the item is inert. */
	action: 'check' | 'download' | 'install' | 'none';
	dot: TrayDot | null;
	/** There is a newer version in play, so the ICON wears the update badge. Not the same thing as
	 *  the item being clickable: a download in flight is inert but still very much pending, and the
	 *  whole point of the badge is that it is readable from the bar without opening this menu. */
	pending: boolean;
}

/** Everything the tray draws, derived once per rebuild. */
export interface TrayModel {
	/** The icon's tooltip: what the app is doing while you cannot see it. */
	tooltip: string;
	status: TrayStatus;
	account: TrayAccount;
	flows: TrayFlowItem[];
	/** Said in place of the flow list when there is nothing to list. */
	flowsEmpty: string | null;
	flowsOverflow: number;
	connections: TrayConnectionItem[];
	connectionsEmpty: string | null;
	connectionsOverflow: number;
	update: TrayUpdate;
	/** The pull-request reviewer's line, or null when it has never been set up. */
	review: TrayReview | null;
	/** The Dashboard panel's two groups, each capped so the two together fit MAX_ITEMS. */
	localProjects: TrayProjectItem[];
	cloudProjects: TrayProjectItem[];
	projectsEmpty: string | null;
	projectsOverflow: number;
	/** The pause/resume line for background work: scheduled flows, and reviews with them. Null in a
	 *  build without Data Flows whose reviewer was never set up, since there is nothing to pause. */
	schedules: { label: string; paused: boolean } | null;
	/** Whether this build has Data Flows at all. Without it the menu has no flows submenu. */
	flowsAvailable: boolean;
}

/** A flow, as far as the tray is concerned. Data Flows supplies these, so the tray never names a
 *  flow spec (it is in every build, and Data Flows is not). `dueAt` is the scheduler's own answer,
 *  so the tray and the Data Flows panel can never disagree about when a flow next runs. */
export interface TrayFlow {
	id: string;
	name: string;
	dueAt: Date | null;
}

/** What the model is built from. */
export interface TrayInput {
	/** Whether this build has Data Flows (`ProTrayFlows.flowsAvailable`): false in a build from the
	 *  open tree, which compiles the stub, so nothing here may speak of flows. */
	flowsAvailable: boolean;
	flows: TrayFlow[];
	/** Ids of the flows running right now, from the run ledger's write path. Passed in rather than
	 *  queried so a menu rebuild never opens flows.db for a user who has no flows. */
	running: ReadonlySet<string>;
	/** Ids whose most recent finished run failed. A tray that only ever says "running" is a tray
	 *  nobody looks at; this is the one thing a person needs to be told without opening the app. */
	failed: ReadonlySet<string>;
	/** Whether the plan includes scheduled flows right now. A lapsed subscription stops the
	 *  scheduler, and the tray has to say so rather than promise a run that will not happen. */
	entitled: boolean;
	/** Whether the user paused scheduling from this menu. */
	paused: boolean;
	connections: ConnectionConfig[];
	connectedIds: ReadonlySet<string>;
	account: { email: string | null; tier: string; restoring: boolean };
	/** The last thing the updater said, or null when it has not said anything yet. */
	update: UpdateStatus | null;
	/** The pull-request reviewer's state. */
	review: TrayReviewInput;
	/** The Dashboard's projects as last read. Passed in, never fetched, because a menu rebuild must
	 *  not run docker or call the control plane. `busy` holds the projects (by `projectKey`) the
	 *  tray itself has a start, stop, pause or resume in flight for. */
	projects: { local: TrayLocalProjectInput[]; cloud: TrayCloudProjectInput[]; busy: ReadonlySet<string> };
	now: number;
}

/** "in 12m" / "in 3h" / "in 2d", or "due now" for anything already owed. */
export function dueLabel(due: Date, now: number): string {
	const minutes = Math.round((due.getTime() - now) / 60_000);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		return "due now";
	}
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** `1 flow` / `2 flows`. A count a person reads has to agree with its noun. */
function flowCount(n: number): string {
	return `${n} flow${n === 1 ? '' : 's'}`;
}

/** `1 review` / `2 reviews`. */
function reviewCount(n: number): string {
	return `${n} review${n === 1 ? '' : 's'}`;
}

/** "free" -> "Free". The tier is stored lower-case and read here by a person. */
function tierLabel(tier: string): string {
	return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : '';
}

export function trayModel(input: TrayInput): TrayModel {
	const { items: flows, scheduled } = flowItems(input);
	const connections = connectionItems(input);
	const running = flows.filter((item) => item.running);
	const local = localProjectItems(input);
	const cloud = cloudProjectItems(input);
	// Local first, as the panel draws them; cloud gets whatever room is left.
	const localShown = local.slice(0, MAX_ITEMS);
	const cloudShown = cloud.slice(0, MAX_ITEMS - localShown.length);
	return {
		tooltip: tooltip(running, scheduled, input),
		status: status(flows, running, scheduled, input),
		account: account(input),
		flows: flows.slice(0, MAX_ITEMS),
		flowsEmpty: flows.length === 0 && input.flowsAvailable ? "No scheduled flows" : null,
		flowsOverflow: Math.max(0, flows.length - MAX_ITEMS),
		connections: connections.slice(0, MAX_ITEMS),
		connectionsEmpty: connections.length === 0 ? "No connections yet" : null,
		connectionsOverflow: Math.max(0, connections.length - MAX_ITEMS),
		update: updateLine(input.update, input.now),
		review: reviewLine(input.review),
		localProjects: localShown,
		cloudProjects: cloudShown,
		projectsEmpty: local.length + cloud.length === 0 ? "No projects yet" : null,
		projectsOverflow: local.length + cloud.length - localShown.length - cloudShown.length,
		schedules: schedulesLine(input),
		flowsAvailable: input.flowsAvailable,
	};
}

/** The pause switch. It holds scheduled flows and reviews together (one promise about background
 *  work), so a build without Data Flows names only the reviews, and only once there are any. */
function schedulesLine(input: TrayInput): TrayModel['schedules'] {
	if (input.flowsAvailable) {
		return { label: input.paused ? "Resume Scheduled Flows" : "Pause Scheduled Flows", paused: input.paused };
	}
	if (reviewLine(input.review) === null) {
		return null;
	}
	return { label: input.paused ? "Resume Reviews" : "Pause Reviews", paused: input.paused };
}

/** The flows worth listing, and how many of them are on a schedule (which is not the same number:
 *  a manual run that failed or is still going is listed too). */
function flowItems(input: TrayInput): { items: TrayFlowItem[]; scheduled: number } {
	const items: (TrayFlowItem & { at: number })[] = [];
	let scheduled = 0;
	for (const spec of input.flows) {
		const running = input.running.has(spec.id);
		const due = spec.dueAt;
		const failed = !running && input.failed.has(spec.id);
		// Listed if it is scheduled, if it is doing something right now, or if its last run failed:
		// a run left going, or one that broke, while the window was hidden is exactly what the tray
		// exists to show, and a failed flow has to be reachable to try again.
		if (!running && !due && !failed) {
			continue;
		}
		if (due) {
			scheduled += 1;
		}
		// Held: the schedule is real but nothing will act on it, either because the user paused
		// scheduling or because the plan no longer includes it. Either way the countdown would be a
		// promise the app is not keeping, so it says "paused" instead.
		const held = !input.entitled || input.paused;
		items.push({
			id: spec.id,
			name: spec.name,
			detail: detail(running, failed, held, due, input.now),
			running,
			dot: running ? 'busy' : failed ? 'error' : held ? 'idle' : 'ok',
			// Running first, then anything that failed, then soonest due. A run with no schedule
			// behind it (a manual one still going) sorts with the running ones by the first branch.
			at: running ? -1 : failed ? 0 : due ? due.getTime() : Number.MAX_SAFE_INTEGER,
		});
	}
	items.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	return {
		items: items.map((item) => ({ id: item.id, name: item.name, detail: item.detail, running: item.running, dot: item.dot })),
		scheduled,
	};
}

/** What one flow says about itself after its name. A failure is named first and still says when it
 *  will try again, because both are things the person reading this menu needs. */
function detail(running: boolean, failed: boolean, held: boolean, due: Date | null, now: number): string {
	if (running) {
		return "running";
	}
	const when = !due ? '' : held ? "paused" : dueLabel(due, now);
	if (!failed) {
		return when;
	}
	return when ? `failed, ${when}` : "failed";
}

function connectionItems(input: TrayInput): TrayConnectionItem[] {
	return input.connections
		.map((config) => {
			const connected = input.connectedIds.has(config.id);
			const prod = config.environment === 'prod';
			return {
				id: config.id,
				label: config.label,
				detail: [prod ? "PROD" : '', connected ? "connected" : ''].filter(Boolean).join(', '),
				connected,
				// A live production connection is the one thing in this menu worth a colour of its own:
				// it is what the app's guardrails are about, and this is where a user sees it while the
				// window is hidden.
				dot: (connected ? (prod ? 'warn' : 'ok') : 'idle') as TrayDot,
			};
		})
		.sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/** Running first (a green dot means running for both kinds), then by name, the order the
 *  Connections submenu uses. */
function byRunningThenName(a: TrayProjectItem, b: TrayProjectItem): number {
	return Number(b.dot === 'ok') - Number(a.dot === 'ok') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** "PROD, running". Production is said first for the same reason a connection says it: it is
 *  what the guardrails are about, and here it is the one project a Stop should make you pause on. */
function projectDetail(production: boolean, state: string): string {
	return [production ? "PROD" : '', state].filter(Boolean).join(', ');
}

/**
 * A local project's line. The words are the Dashboard panel's (renderer/src/localProjects.ts), so
 * the menu and the panel describe one project the same way, and Start/Stop are enabled exactly
 * when the panel's buttons are.
 */
function localProjectItems(input: TrayInput): TrayProjectItem[] {
	return input.projects.local
		.map((project): TrayProjectItem => {
			const working = input.projects.busy.has(projectKey({ kind: 'local', id: project.id }));
			const [state, dot]: [string, TrayDot] = working ? ["working", 'busy'] : localState(project.state);
			return {
				kind: 'local',
				id: project.id,
				name: project.name,
				detail: projectDetail(project.production, state),
				dot,
				actions: [
					{ verb: 'start', label: "Start", enabled: !working && project.state !== 'running' && project.state !== 'missing' },
					{ verb: 'stop', label: "Stop", enabled: !working && project.state !== 'stopped' && project.state !== 'missing' && project.state !== 'unknown' },
				],
			};
		})
		.sort(byRunningThenName);
}

function localState(state: LocalProjectRow['state']): [string, TrayDot] {
	switch (state) {
		case 'running': return ["running", 'ok'];
		case 'starting': return ["starting", 'busy'];
		case 'partial': return ["some services are down", 'error'];
		case 'missing': return ["its folder is gone", 'error'];
		case 'unknown': return ["Docker is not running", 'idle'];
		default: return ["stopped", 'idle'];
	}
}

/** States that already name what is happening, so they are said as they are. */
const CLOUD_IN_FLIGHT = new Set(['creating', 'starting', 'pausing', 'restoring', 'deleting']);

/**
 * A cloud project's line. Pause and Resume are the control plane's to allow (`canPause`,
 * `canResume`, computed by cloudProjects.ts `toRow`), so this only picks which one to show: the
 * one that would change where the project is.
 */
function cloudProjectItems(input: TrayInput): TrayProjectItem[] {
	return input.projects.cloud
		.map((project): TrayProjectItem => {
			const working = input.projects.busy.has(projectKey({ kind: 'cloud', ref: project.ref }));
			const [state, dot]: [string, TrayDot] = working ? ["asking", 'busy'] : cloudState(project);
			const paused = project.state === 'paused' || project.desiredState === 'paused';
			return {
				kind: 'cloud',
				id: project.ref,
				name: project.name,
				detail: projectDetail(project.production, state),
				dot,
				actions: [paused
					? { verb: 'resume', label: "Resume", enabled: !working && project.canResume }
					: { verb: 'pause', label: "Pause", enabled: !working && project.canPause }],
			};
		})
		.sort(byRunningThenName);
}

function cloudState(project: TrayCloudProjectInput): [string, TrayDot] {
	if (project.state === 'error') {
		return ["error", 'error'];
	}
	if (project.busy) {
		// `ready` on its way to `paused` is pausing, and the other way is starting; a state that is
		// already a verb (creating, restoring) says so itself.
		const word = CLOUD_IN_FLIGHT.has(project.state)
			? project.state
			: project.desiredState === 'paused' ? "pausing" : project.desiredState === 'deleted' ? "deleting" : "starting";
		return [word, 'busy'];
	}
	// `ready` is the control plane's word for a database that is up; a person reads "running".
	return project.state === 'ready' ? ["running", 'ok'] : [project.state, 'idle'];
}

function status(listed: TrayFlowItem[], running: TrayFlowItem[], scheduled: number, input: TrayInput): TrayStatus {
	if (running.length === 1) {
		return { label: `Running "${running[0].name}"`, dot: 'busy' };
	}
	if (running.length > 1) {
		return { label: `Running ${flowCount(running.length)}`, dot: 'busy' };
	}
	// A failure outranks everything except work in flight: it is the reason to look at the app.
	const failed = listed.filter((item) => item.dot === 'error');
	if (failed.length === 1) {
		return { label: `Last run of "${failed[0].name}" failed`, dot: 'error' };
	}
	if (failed.length > 1) {
		return { label: `${flowCount(failed.length)} failed`, dot: 'error' };
	}
	// The reviewer sits between the flows and the standing states: work in flight is worth saying,
	// and a review nobody has read yet is a thing WAITING ON THE USER, which outranks a switch the
	// user threw themselves.
	if (input.review.enabled && input.review.activity) {
		return { label: input.review.activity, dot: 'busy' };
	}
	if (input.review.awaiting > 0) {
		return { label: `${reviewCount(input.review.awaiting)} waiting for you`, dot: 'warn' };
	}
	if (input.paused) {
		return { label: input.flowsAvailable ? "Scheduled flows are paused" : "Reviews are paused", dot: 'warn' };
	}
	if (scheduled > 0 && !input.entitled) {
		return { label: "Scheduled flows need a paid plan", dot: 'warn' };
	}
	if (scheduled > 0) {
		return { label: `SnoutData Studio is running, ${flowCount(scheduled)} scheduled`, dot: 'ok' };
	}
	return { label: "SnoutData Studio is running", dot: 'ok' };
}

/** "Downloading update…", plus how it is going once there is something to say about that. */
function downloadLine(status: UpdateStatus & { state: 'downloading' }, now: number): string {
	if (status.preparing) {
		return "Preparing update…";
	}
	if (status.percent !== undefined) {
		return `Downloading update… ${status.percent}%`;
	}
	const detail = updateProgressDetail(status, now, false);
	return detail ? `Downloading update, ${detail}…` : "Downloading update…";
}

function account(input: TrayInput): TrayAccount {
	if (input.account.restoring) {
		return { label: "Signing in…", signedIn: false };
	}
	if (!input.account.email) {
		return { label: "Sign In / Sign Up", signedIn: false };
	}
	const tier = tierLabel(input.account.tier);
	return { label: tier ? `${input.account.email} (${tier})` : input.account.email, signedIn: true };
}

function updateLine(status: UpdateStatus | null, now: number): TrayUpdate {
	switch (status?.state) {
		case 'available':
			return { label: `Download Update (${status.version})`, action: 'download', dot: 'info', pending: true };
		case 'downloading':
			return {
				// No clock here, unlike the status bar: this menu is rebuilt on an interval rather
				// than every second, and a counter frozen at "1min 10s" reads as the hang it is
				// meant to rule out. The note alone is slow enough to survive a stale rebuild.
				label: downloadLine(status, now),
				action: 'none',
				dot: 'info',
				pending: true,
			};
		case 'downloaded':
			return { label: `Restart & Update (${status.version})`, action: 'install', dot: 'info', pending: true };
		case 'checking':
			// Checking is not pending: badging here would flash the badge on every launch and every
			// four-hourly poll, on the machines that turn out to have nothing to install.
			return { label: "Checking for updates…", action: 'none', dot: null, pending: false };
		default:
			return { label: "Check for Updates…", action: 'check', dot: null, pending: false };
	}
}

/**
 * The reviewer's own line in the menu.
 *
 * Null until it has been set up: an item that says "Snoutbot is off" to somebody who has never
 * heard of Snoutbot is an advertisement in a context menu, and the tray is not where a feature
 * gets sold. Once there ARE watched repositories it says what it is doing, including when it is
 * switched off — that is a state a user who configured it needs to be able to see.
 */
function reviewLine(input: TrayReviewInput): TrayReview | null {
	if (!input.enabled && input.watching === 0) {
		return null;
	}
	if (!input.enabled) {
		return { label: "Snoutbot is off", dot: 'idle' };
	}
	if (input.awaiting > 0) {
		return { label: `Snoutbot: ${reviewCount(input.awaiting)} to read`, dot: 'warn' };
	}
	if (input.activity) {
		return { label: `Snoutbot: ${input.activity}`, dot: 'busy' };
	}
	if (input.watching === 0) {
		return { label: "Snoutbot: no repositories yet", dot: 'idle' };
	}
	return { label: `Snoutbot: watching ${input.watching} repositor${input.watching === 1 ? 'y' : 'ies'}`, dot: 'ok' };
}

function tooltip(running: TrayFlowItem[], scheduled: number, input: TrayInput): string {
	const parts: string[] = ["SnoutData Studio"];
	if (running.length === 1) {
		parts.push(`Running "${running[0].name}"`);
	} else if (running.length > 1) {
		parts.push(`Running ${flowCount(running.length)}`);
	}
	if (scheduled > 0) {
		parts.push(input.paused || !input.entitled
			? `${flowCount(scheduled)} scheduled, paused`
			: `${flowCount(scheduled)} scheduled`);
	}
	const connected = input.connections.filter((config) => input.connectedIds.has(config.id)).length;
	if (connected > 0) {
		parts.push(`${connected} connection${connected === 1 ? '' : 's'} open`);
	}
	// Only the waiting ones. The tooltip is what a person reads without clicking anything, so it
	// carries the thing that needs them and not the reviewer's idle state.
	if (input.review.awaiting > 0) {
		parts.push(`${reviewCount(input.review.awaiting)} waiting to post`);
	}
	const text = parts.join('\n');
	return text.length > MAX_TOOLTIP ? `${text.slice(0, MAX_TOOLTIP - 1)}…` : text;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudRequestError, detailFrom, type CloudApi, type CloudProjectSummary } from './cloudApi';
import type { CloudActionOutcome, CloudCreateForm, CloudCreateOutcome, CloudProjectRow, CloudProjectsView } from '../shared/cloudProjects';

// The pods view's half: the signed-in account's hosted databases, and what may be done to
// one right now.
//
// **The whole life of a project: create, start, stop, delete, inspect.** It was lifecycle only
// at first, which left the desktop as the one surface that could not make the database it was
// meant to work in. Every action is the same Snout Function the dashboard and the CLI call, so
// the quota, the region, the tier and every refusal stay the control plane's: the desktop is a
// third client of one control plane, never a second control plane. Move Database uses the same
// create and delete.
//
// ## The rules are the control plane's, and are not repeated here
//
// A production project is never paused; a deleted one accepts nothing; a project mid-flight
// is not asked for something else. Those refusals live in the control plane's own tested
// logic and come back as sentences. What this file decides is only what to OFFER —
// whether a button is live — and it is deliberately the weaker of the two: it never enables
// something the control plane would refuse, and when the two disagree the server's sentence
// is what the user is shown. A second copy of the policy here would be the copy that
// disagrees, and it would disagree silently.
//
// ## Asked, never done
//
// `pause` and `resume` set a DESIRED state and return. The host agent notices on its next
// tick and does the work, so a screen reporting "paused" the instant the call returns would
// be lying for several seconds. Everything below says what was ASKED for, and the list is
// re-read to find out what happened.

/** States in which something is already happening, so nothing else should be asked. */
const IN_FLIGHT = new Set(['creating', 'starting', 'pausing', 'restoring', 'deleting']);

/**
 * The STATE that satisfies a desired state, because the two vocabularies are not the same
 * one and comparing them directly is wrong.
 *
 * `desired_state` is what was asked for — `running`, `paused`, `deleted`. `state` is where
 * the project actually is, and the settled form of `running` is **`ready`**, not
 * `running`. Comparing the raw strings marks every perfectly healthy project as busy and
 * offers it no actions at all, which is what the first version of this did and what the
 * test above caught.
 */
const SETTLED: Record<string, string> = { running: 'ready', paused: 'paused', deleted: 'deleted' };

export function toRow(project: CloudProjectSummary): CloudProjectRow {
	const state = project.state;
	const desired = project.desiredState;
	// `error` is not busy: it is STUCK. Something failed and nothing is happening, so the
	// project should still offer what it can rather than showing a spinner forever.
	const busy = IN_FLIGHT.has(state)
		|| (state !== 'error' && desired !== undefined && (SETTLED[desired] ?? desired) !== state);
	const paused = state === 'paused' || desired === 'paused';
	const deleted = state === 'deleted' || desired === 'deleted';

	// The one refusal worth stating before it happens, because it is a property of the
	// project rather than of the moment and the user set it themselves. Everything else
	// resolves in a second or two, so "wait" is a better answer than a sentence.
	const pauseRefusal = project.production
		? "This project is marked production, so it is never paused."
		: undefined;

	return {
		ref: project.ref,
		name: project.name,
		region: project.region,
		production: project.production,
		state,
		// Shown only while it differs from where the project actually is, so a healthy
		// project does not carry a redundant "→ running" beside "ready".
		desiredState: desired !== undefined && (SETTLED[desired] ?? desired) !== state ? desired : undefined,
		busy,
		readOnly: project.readOnly,
		wakesInstantly: project.wakesInstantly,
		sizeBytes: project.sizeBytes ?? null,
		host: project.host,
		database: project.database,
		user: project.user,
		createdAt: project.createdAt ?? null,
		lastConnectionAt: project.lastConnectionAt ?? null,
		canPause: !deleted && !busy && !paused && !project.production,
		pauseRefusal,
		canResume: !deleted && !busy && paused,
		canDelete: !deleted && !busy,
	};
}

/**
 * A failure that says nothing about the request: it never completed (status 0), or something in
 * front of the control plane was briefly unable to answer (502-504, Cloudflare's 520-524), or it
 * asked us to slow down (429). A control-plane deploy restarts the front door, which is a few
 * seconds of exactly these, and the panel polls every three seconds while a project is created,
 * so it was the likeliest thing to be asking (reported from the dashboard, 2026-10-15).
 */
export function isTransientCloudFailure(error: unknown): boolean {
	if (!(error instanceof CloudRequestError)) {
		return false;
	}
	const status = error.status;
	return status === 0 || status === 429 || (status >= 502 && status <= 504) || (status >= 520 && status <= 524);
}

/** About seven seconds in all: longer than the front door's restart, short enough to say so when it is down. */
const LIST_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 3500];

/**
 * A READ, asked again through a blip before the caller hears about it. Reads only: asking twice
 * costs nothing, where a create or a delete that failed in transit may still have happened.
 */
export async function readThroughBlips<T>(read: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await read();
		} catch (error) {
			if (attempt >= LIST_RETRY_DELAYS_MS.length || !isTransientCloudFailure(error)) {
				throw error;
			}
			await sleep(LIST_RETRY_DELAYS_MS[attempt]);
		}
	}
}

/** The list, asked again through a blip before the panel hears about it. */
function listThroughBlips(api: CloudApi, sleep: (ms: number) => Promise<void>): Promise<CloudProjectSummary[]> {
	return readThroughBlips(() => api.list(), sleep);
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The panel's whole state, fetched on demand and never on the boot path. */
export async function cloudProjectsView(api: CloudApi, sleep: (ms: number) => Promise<void> = pause): Promise<CloudProjectsView> {
	const account = await api.account();
	if (!account) {
		// Not an error and not an empty list. An empty list would say "you have no
		// databases", which is a different and more discouraging thing to be told.
		return { account: null, projects: [], unavailable: "Sign in to SnoutData to see your hosted databases." };
	}
	try {
		const projects = await listThroughBlips(api, sleep);
		const rows = projects.filter((p) => p.state !== 'deleted').map(toRow);
		return {
			account,
			projects: rows,
			unavailable: rows.length === 0
				? "This account has no hosted databases yet."
				: undefined,
		};
	} catch (error) {
		return { account, projects: [], unavailable: `Could not reach SnoutData Cloud: ${detailFrom(error)}` };
	}
}

/**
 * Ask, and report what the answer was — including a refusal, which is not a failure.
 *
 * The message on success says ASKED rather than done, because that is what happened: the
 * host agent has not run yet. The panel re-reads the list to find out what became of it.
 */
export async function askCloudProject(
	api: CloudApi,
	action: 'pause' | 'resume',
	ref: string,
	/**
	 * Once a pause is accepted: close this app's own connections to the project. The front door
	 * wakes a paused project on connect, so an open connection (the schema poll, a reconnecting
	 * pool) woke it again three seconds after it stopped (seen live, 2026-10-15).
	 */
	afterPause?: (ref: string) => Promise<void>,
): Promise<CloudActionOutcome> {
	try {
		const result = action === 'pause' ? await api.pause(ref) : await api.resume(ref);
		if (action === 'pause' && afterPause) {
			await afterPause(ref).catch(() => undefined);
		}
		if (!result.changed) {
			// Already where it was asked to be. Saying "asked to stop" here would have the
			// user waiting for something that is not going to happen.
			return { ok: true, message: action === 'pause' ? "Already stopped." : "Already running." };
		}
		return {
			ok: true,
			message: action === 'pause' ? "Asked it to stop. This takes a few seconds." : "Asked it to start. This takes a few seconds.",
		};
	} catch (error) {
		// A refusal comes back as the control plane's own sentence ("a production project
		// is never paused"), and it is better than anything this side could compose. Which
		// of the two it is comes from the STATUS: 4xx is the system deciding, anything else
		// is the system breaking, and telling a user something broke when nothing did is
		// the thing this flag exists to prevent.
		return failed(error);
	}
}

/** What a refusal or a failure looks like, told apart by the status (see `askCloudProject`). */
function failed(error: unknown): CloudActionOutcome {
	return {
		ok: false,
		refused: error instanceof CloudRequestError && error.refused,
		message: detailFrom(error),
	};
}

/**
 * Create a project, then add it as a connection so it is in the explorer without a second step.
 *
 * `connect` is handed in (it is `resolveSnoutdataCloudImport` + save, in main) so this stays
 * pure. The connection is added while the project is still `creating`: its host, role and
 * password exist from the moment the row does, and connecting to it before the pod is up is the
 * same wait-on-connect the front door gives a paused project. A create that worked and a
 * connection that did not is still a create that worked, and says so.
 */
export async function createCloudProject(
	api: CloudApi,
	form: CloudCreateForm,
	connect: (ref: string) => Promise<void>,
): Promise<CloudCreateOutcome> {
	const name = form.name.trim();
	if (!name) {
		return { ok: false, refused: true, message: "A project needs a name." };
	}
	let ref: string;
	try {
		const { project } = await api.create(name, form.region, { production: form.production });
		ref = project.ref;
	} catch (error) {
		return failed(error);
	}
	try {
		await connect(ref);
	} catch (error) {
		return {
			ok: true,
			ref,
			connected: false,
			message: `Created ${ref}. It is starting. Adding it as a connection failed (${detailFrom(error)}); use Import to add it.`,
		};
	}
	return { ok: true, ref, connected: true, message: `Created ${ref} and added it as a connection. It is starting, which takes about half a minute.` };
}

/**
 * Delete a project: the control plane's soft delete, recoverable for the plan's grace period.
 * Its connections go with it (`disconnect`, handed in so this stays pure): a database that is
 * being deleted is not one to leave in the explorer. Only after the control plane said yes, so a
 * refused delete leaves everything as it was.
 */
export async function deleteCloudProject(
	api: CloudApi,
	ref: string,
	removeConnections: (ref: string) => Promise<number> = async () => 0,
): Promise<CloudActionOutcome> {
	let changed: boolean;
	try {
		changed = (await api.remove(ref)).changed;
	} catch (error) {
		return failed(error);
	}
	const removed = await removeConnections(ref).catch(() => 0);
	const base = changed ? "Asked it to delete. This takes a few seconds." : "Already deleted.";
	return { ok: true, message: removed > 0 ? `${base} Its connection was removed.` : base };
}

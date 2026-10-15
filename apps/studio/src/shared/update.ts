/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Auto-update status pushed from main → renderer over the `update:status` channel.
// The renderer turns these into a small toast; see components/UpdateToast.tsx.
export type UpdateStatus =
	| { state: 'checking' }
	| { state: 'available'; version: string; notes?: string }
	/** `fromSource`: a build from the open-source tree, which has no update feed and asked nothing;
	 *  it is updated by building the source again (src/shared/officialBuild.ts). */
	| { state: 'not-available'; version: string; fromSource?: boolean }
	/** `percent` only ever arrives on Windows (see below). `startedAt` is stamped by AppUpdater
	 *  when the download begins and held for its whole life, so a surface can show how long it
	 *  has been going without keeping a clock of its own.
	 *
	 *  `preparing`: the download is done and the update is being made ready beside the live app
	 *  (Windows: unpack, self-check, write to disk, 10-20 s) so that Restart is quick. Still "busy"
	 *  to everything that asks, but it is not a download and must not sit at "100%" while it
	 *  happens. */
	| { state: 'downloading'; percent?: number; startedAt?: number; preparing?: boolean }
	| { state: 'downloaded'; version: string; notes?: string }
	/** `message` is the SENTENCE a person reads; `detail` is the one line of the underlying error
	 *  worth keeping, for the tooltip, the log and the bug report. Never the raw error: see
	 *  {@link describeUpdateFailure}. */
	| { state: 'error'; message: string; kind?: UpdateFailureKind; detail?: string };

// ── When an update check fails ───────────────────────────────────────────────────────
//
// The renderer used to print the error object's own message, and electron-updater's is not a
// sentence: a GitHub 504 arrived as four lines of method, URL, HTML body and every response
// header, which stretched the toast across the whole window and told the reader nothing they
// could act on. It is also the wrong question. What somebody needs to know is whether this is
// THEIR problem (offline, no disk) or OURS (the feed is down, the signature did not verify), and
// whether anything is expected of them.
//
// So the classification is here, pure and tested, rather than in the toast: main needs the same
// answer to decide what is worth reporting, and the tray shows the same line.

export type UpdateFailureKind =
	/** This computer cannot reach anything: asleep, offline, a captive portal. Not worth reporting. */
	| 'offline'
	/** The feed answered, badly: a 5xx, a timeout, a body that is not the feed. Ours, not theirs. */
	| 'feed-unavailable'
	/** GitHub is rate limiting this address, which a shared office network can do to everyone. */
	| 'rate-limited'
	/** The feed is reachable and has no release to offer. */
	| 'no-release'
	/** A download arrived and did not match what it should be. The one kind that is alarming. */
	| 'signature'
	/** Nowhere to put the download. */
	| 'disk'
	| 'unknown';

export interface UpdateFailure {
	kind: UpdateFailureKind;
	/** One sentence, addressed to the person, saying whose problem it is and what happens next. */
	message: string;
	/** The useful line of the original error, for a tooltip and the log. Never headers or HTML. */
	detail?: string;
}

const FAILURE_MESSAGE: Record<UpdateFailureKind, string> = {
	'offline': "Updates could not be checked: this computer is offline. It will try again later.",
	'feed-unavailable': "Updates could not be checked: GitHub is not answering. Nothing is wrong with your installation, and it will try again later.",
	'rate-limited': "Updates could not be checked: GitHub is rate limiting this network. It will try again later.",
	'no-release': "Updates could not be checked: no published release was found to update to.",
	'signature': "An update was downloaded and refused: it did not match the signature it should have. Nothing was installed.",
	'disk': "The update could not be saved: there is not enough disk space.",
	'unknown': "Updates could not be checked.",
};

/** The first line of an error, capped, with the HTML and the header dump that electron-updater
 *  appends thrown away. This is what a tooltip and the log get. */
export function updateErrorDetail(raw: string): string | undefined {
	const first = String(raw ?? '')
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!first) {
		return undefined;
	}
	const trimmed = first.replace(/\s+/g, ' ').trim();
	return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

/**
 * What kind of failure this is, and the sentence to show for it.
 *
 * The ORDER of these tests is the whole of the logic, because the messages overlap. A GitHub 504
 * arrives inside a message that also says "please ensure a production release exists", which
 * reads as "there is no release" and is not true: the release is there and the front door timed
 * out. So the transport is judged before the content, and "offline" is judged before either,
 * since a machine with no network produces both.
 */
export function describeUpdateFailure(raw: string, statusCode?: number): UpdateFailure {
	const text = String(raw ?? '');
	const detail = updateErrorDetail(text);
	const kind = failureKind(text, statusCode);
	return { kind, message: FAILURE_MESSAGE[kind], detail };
}

function failureKind(text: string, statusCode?: number): UpdateFailureKind {
	if (/ENOTFOUND|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN|ECONNRESET|ETIMEDOUT|net::ERR_/i.test(text)) {
		return 'offline';
	}
	if (/ENOSPC|no space left|not enough space/i.test(text)) {
		return 'disk';
	}
	// A checksum or signature failure is about the FILE, so it is judged before the transport:
	// the request succeeded, which is what makes it worth saying loudly.
	if (/sha512|checksum|signature|not signed|integrity/i.test(text)) {
		return 'signature';
	}
	if (statusCode === 429 || /rate limit/i.test(text)) {
		return 'rate-limited';
	}
	if ((statusCode !== undefined && statusCode >= 500) || /\b5\d\d\b.*(gateway|unavailable|timeout|time-out|server error)|gateway time-?out|bad gateway|service unavailable|internal server error/i.test(text)) {
		return 'feed-unavailable';
	}
	if (/cannot parse releases feed|unexpected end of|invalid yaml|not a valid/i.test(text)) {
		return 'feed-unavailable';
	}
	if (statusCode === 404 || /unable to find latest version|no published version|production release exists/i.test(text)) {
		return 'no-release';
	}
	return 'unknown';
}

/** The codicon for a failure, so the tray, the toast and anything else agree. */
export function updateFailureIcon(kind: UpdateFailureKind | undefined): string {
	switch (kind) {
		case 'offline': return 'debug-disconnect';
		case 'feed-unavailable':
		case 'rate-limited': return 'cloud';
		case 'signature': return 'shield';
		default: return 'warning';
	}
}


// ── How a download in flight says what it is doing ───────────────────────────────────
//
// Windows downloads through electron-updater, which reports bytes-so-far, so its label has a
// percentage in it. macOS does not: Squirrel.Mac pulls the whole signed .zip in its own process
// (there is no delta on mac) and Electron's built-in autoUpdater exposes no progress event at
// all, so the label sat at a bare ellipsis for however long the download took, with no way to
// tell a slow one from a stuck one. The elapsed clock is the answer to that, and the notes below
// say, in order: this is normal, it is happening in the background, nothing is waiting on you.

/** How long a download runs, in ms, before each successive note is added to its label. */
export const UPDATE_PROGRESS_STEPS_MS = [20_000, 40_000, 60_000];

/** The note for each step. Index 0 is "too early to say anything". */
const UPDATE_PROGRESS_NOTES = ["", "this can take a minute", "still going, in the background", "you can keep working"];

/** How long a download has been running, from the stamp main puts on the status. 0 when there is
 *  no stamp (a status from an older main, or a dev preview) or the clock moved backwards. */
export function updateElapsedMs(status: UpdateStatus, now: number): number {
	if (status.state !== 'downloading' || status.startedAt === undefined) {
		return 0;
	}
	return Math.max(0, now - status.startedAt);
}

/** What to add to a download's label at this point, or "" while it is too early to say anything. */
export function updateProgressNote(elapsedMs: number): string {
	let step = 0;
	for (const threshold of UPDATE_PROGRESS_STEPS_MS) {
		if (elapsedMs >= threshold) {
			step++;
		}
	}
	return UPDATE_PROGRESS_NOTES[step] ?? '';
}

/** Elapsed ms as the clock a person reads: "7s", "1min 44s", "12min 30s". Minutes are as far as
 *  it goes: a download that has been running for an hour has a problem the label cannot fix. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60);
	return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
}

/** The macOS half of a download's label: how long it has been running, and (once it has been a
 *  while) that nothing is waiting on the user. Empty string on Windows, which is deliberate and
 *  is the whole rule here: electron-updater reports bytes-so-far, and a percentage that moves
 *  already answers "is it stuck?", so that label is left exactly as it was. Only the path with
 *  nothing to show (Squirrel.Mac, which reports no progress at all) gets a clock.
 *
 *  `clock` is opt-in because only a surface that re-renders on a timer should show one: a frozen
 *  counter reads as a hang, which is the exact thing this is here to rule out. A tray menu, which
 *  is rebuilt on an interval rather than every second, asks for the note alone.
 */
export function updateProgressDetail(status: UpdateStatus, now: number, clock: boolean): string {
	if (status.state !== 'downloading' || status.percent !== undefined || status.startedAt === undefined) {
		return '';
	}
	const elapsedMs = updateElapsedMs(status, now);
	const parts = clock ? [formatElapsed(elapsedMs)] : [];
	parts.push(updateProgressNote(elapsedMs));
	return parts.filter(Boolean).join(' · ');
}

/** Compare dotted versions ("1.0.31" > "1.0.30"). Our tags are plain x.y.z (no prerelease
 *  suffixes), so a numeric segment compare is enough; missing/garbage segments read as 0. */
export function isNewerVersion(remote: string, current: string): boolean {
	const parse = (v: string): number[] => v.split('.').map((n) => parseInt(n, 10) || 0);
	const r = parse(remote);
	const c = parse(current);
	for (let i = 0; i < Math.max(r.length, c.length); i++) {
		const a = r[i] ?? 0;
		const b = c[i] ?? 0;
		if (a !== b) {
			return a > b;
		}
	}
	return false;
}

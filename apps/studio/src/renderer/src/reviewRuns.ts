/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Snoutbot — what a finished review SAYS about itself, in the app.
 *
 *  The markdown comment is review-core's job and is not re-derived here; this is the handful of
 *  one-line summaries the app needs around it — the list row, the meta line above the comment,
 *  and the notification a review leaves behind when it finished with no window up.
 *
 *  Pure, with its own tests, because two surfaces need the
 *  same sentence (the review view and the notifications centre), and two copies of it is how they
 *  come to disagree.
 *
 *  Two of the product's rules are enforced HERE rather than trusted to whoever writes the JSX
 *  next:
 *
 *    - **Never imply the static tier checked the database.** A static review says the database
 *      was not consulted, in those words.
 *    - **Never print a number without what it was measured on.** The counts always travel with
 *      the depth line, and the depth line always names the destination when there was one.
 *--------------------------------------------------------------------------------------------*/

import type { ReviewRun, ReviewStarted } from '../../shared/review';

/** What a review is worth telling someone, or null when it is not worth telling them anything. */
export interface ReviewNotice {
	severity: 'error' | 'warn' | 'info';
	title: string;
	detail: string;
}

/** `2 blockers, 1 warning` — zero counts are left out rather than said. */
export function findingsSummary(run: Pick<ReviewRun, 'blockers' | 'warnings' | 'notes'>): string {
	const parts: string[] = [];
	if (run.blockers > 0) {
		parts.push(`${run.blockers} blocker${run.blockers === 1 ? '' : 's'}`);
	}
	if (run.warnings > 0) {
		parts.push(`${run.warnings} warning${run.warnings === 1 ? '' : 's'}`);
	}
	if (run.notes > 0) {
		parts.push(`${run.notes} note${run.notes === 1 ? '' : 's'}`);
	}
	return parts.length === 0 ? "nothing to flag" : parts.join(', ');
}

/**
 * How much of the database this review actually saw.
 *
 * The wording is deliberate at `static`: that tier read the diff and nothing else, and a line
 * that left the database unmentioned would let a reader assume it had been consulted. The whole
 * product is the difference between the two.
 */
export function depthLine(run: Pick<ReviewRun, 'depth' | 'destinationName'>): string {
	const on = run.destinationName;
	switch (run.depth) {
		case 'connected':
			return on ? `Measured against ${on}` : "Measured against the bound database";
		case 'schema':
			return on ? `Read the schema of ${on}, ran no queries` : "Read the schema, ran no queries";
		default:
			return "Read the diff only, the database was not consulted";
	}
}

/** `acme/api #12`. */
export function runLabel(run: Pick<ReviewRun, 'repoLabel' | 'prNumber'>): string {
	return `${run.repoLabel} #${run.prNumber}`;
}

/**
 * What to tell someone about a review that has finished, or null for one that needs no telling.
 *
 * Three deliberate calls:
 *
 *  - **A review waiting for approval always speaks**, and it is a warning rather than a note: it
 *    is the one state where the app is holding something and nothing at all happens until the
 *    person acts. Holding a review for the person to read before it posts is what the desktop
 *    reviewer is for.
 *  - **A clean review that posted itself says nothing.** It happens on every push to every
 *    watched pull request, and an app that announces its own routine success teaches people to
 *    dismiss it without reading, which costs the notification that mattered.
 *  - **Warnings without blockers are a note, not a warning.** Only a blocker (a change that will
 *    FAIL on the destination) is worth interrupting for; the notifications centre still keeps
 *    the rest.
 */
export function reviewNotice(run: ReviewRun): ReviewNotice | null {
	const what = runLabel(run);
	if (run.error) {
		return { severity: 'error', title: `Snoutbot could not review ${what}`, detail: run.error };
	}
	const summary = `${findingsSummary(run)} · ${depthLine(run)}`;
	if (run.awaitingApproval) {
		return {
			severity: 'warn',
			title: `Snoutbot has a review of ${what} for you to read`,
			detail: `${summary}. Nothing is posted to GitHub until you say so.`,
		};
	}
	if (run.blockers > 0) {
		return {
			severity: 'warn',
			title: `Snoutbot found ${run.blockers} blocker${run.blockers === 1 ? '' : 's'} in ${what}`,
			detail: `${summary}. The comment has been posted.`,
		};
	}
	if (run.warnings > 0 || run.notes > 0) {
		return {
			severity: 'info',
			title: `Snoutbot reviewed ${what}`,
			detail: `${summary}. The comment has been posted.`,
		};
	}
	return null;
}

/**
 * The transient card, bottom right, while a review happens and once it is done.
 *
 * A different job from `reviewNotice`, which decides what is worth KEEPING in the notifications
 * centre. This is what is worth SHOWING for nine seconds, and the two answers are deliberately
 * different in one place: a clean review that posted itself leaves no entry behind (it happens on
 * every push, and an app that announces its own routine success teaches people to ignore it) but
 * it does get a card, because somebody who just pressed "Check now" is owed an answer either way.
 *
 * `running` has no auto-dismiss. It is replaced by the `done` card for the same review, and a
 * spinner that vanishes on a timer while the work continues is a worse lie than no spinner.
 */
export type ReviewToastState =
	| { phase: 'running'; label: string; prTitle?: string; prUrl?: string }
	| { phase: 'done'; label: string; prUrl?: string; runId: string; text: string; tone: 'ok' | 'warn' | 'error'; awaiting: boolean };

/** The card for a review that has just begun. */
export function startedToast(started: ReviewStarted): ReviewToastState {
	return {
		phase: 'running',
		label: `${started.repoLabel} #${started.prNumber}`,
		prTitle: started.prTitle,
		prUrl: started.prUrl,
	};
}

/** The card for one that has just finished. Always returns something: see the type's note. */
export function finishedToast(run: ReviewRun): ReviewToastState {
	const label = runLabel(run);
	if (run.error) {
		return { phase: 'done', label, prUrl: run.prUrl, runId: run.id, text: run.error, tone: 'error', awaiting: false };
	}
	const summary = findingsSummary(run);
	if (run.awaitingApproval) {
		return { phase: 'done', label, prUrl: run.prUrl, runId: run.id, text: `${summary}, waiting for you to post it`, tone: 'warn', awaiting: true };
	}
	return {
		phase: 'done',
		label,
		prUrl: run.prUrl,
		runId: run.id,
		text: `${summary}, posted`,
		tone: run.blockers > 0 ? 'warn' : 'ok',
		awaiting: false,
	};
}

/** Does this card replace the one already showing? A finished review always replaces its own
 *  running card, and a second review starting replaces the first one's result. */
export function replacesToast(current: ReviewToastState | null, next: ReviewToastState): boolean {
	if (!current) {
		return true;
	}
	// Never let a `running` card overwrite the RESULT of the same review: the events can arrive
	// out of order when a review finishes faster than the renderer re-renders.
	return !(next.phase === 'running' && current.phase === 'done' && current.label === next.label);
}

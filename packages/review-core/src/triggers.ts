/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Manners: when the bot speaks, when it stays quiet, and how it acknowledges being asked.
 *
 *  A reviewer is judged on its behaviour long before it is judged on its findings. The ways a
 *  bot makes itself hated are well known and every one of them is avoidable:
 *
 *    - it comments on pull requests that have nothing to do with it
 *    - it says nothing for ninety seconds after you ask, so you ask again
 *    - it posts a new comment on every push until the thread is unreadable
 *    - it replies to itself, or to another bot, and the two of them fill the page
 *    - it argues with a `help` typo instead of doing the obvious thing
 *    - it cannot be turned off for one repository without being uninstalled from all of them
 *
 *  All of that is decidable without any I/O, so it lives here where it can be tested, rather
 *  than being spread through a webhook handler as a pile of early returns.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_BRANDING } from './branding.js';
import { isReviewablePath, parseDiff } from './diff.js';
import type { PathFilter } from './diff.js';
import { parseMention } from './mention.js';
import type { ReviewCommand } from './mention.js';
import { COMMENT_MARKER } from './report.js';

/** GitHub reaction names, which are a fixed set. `eyes` is "I have seen this and started". */
export type Reaction = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';

export type TriggerKind =
	/** A pull request was opened, reopened, pushed to, or taken out of draft. */
	| 'pull_request'
	/** Somebody commented on the pull request or on a line of it. */
	| 'comment'
	/** A human pressed a button, or a scheduled/CI run asked for it. */
	| 'manual';

/** How a repository wants to be reviewed. Matches `.snoutbot.yml`'s `on:` block. */
export interface TriggerConfig {
	/**
	 * - `sql-only` (default) — review automatically, but only when the change touches SQL.
	 *   The behaviour people actually want: useful without being asked, silent otherwise.
	 * - `mention`  — never automatic. Only when somebody asks.
	 * - `always`   — review every pull request, even ones with no SQL in them. Rarely wanted;
	 *   offered because a team that has asked for it should not have to fight the tool.
	 */
	auto?: 'sql-only' | 'mention' | 'always';
	/** Review draft pull requests. Default false: a draft is not finished being written. */
	drafts?: boolean;
	/** Review changes authored by other bots (Dependabot, a migration generator). Default false. */
	bots?: boolean;
	/** Which paths count as SQL. */
	paths?: PathFilter;
	/** The handle to answer to. Defaults to the branding handle. */
	handle?: string;
}

export interface TriggerEvent {
	kind: TriggerKind;
	/** The webhook action: `opened`, `synchronize`, `reopened`, `ready_for_review`, `created`, … */
	action?: string;
	/** The comment body, for a comment event. */
	body?: string;
	/** True when the pull request is a draft. */
	draft?: boolean;
	/** True when the author of the event is a bot (including us). */
	authorIsBot?: boolean;
	/** True when the author of the event is US. The strongest loop guard there is. */
	authorIsSelf?: boolean;
	/** The diff, when the host already has it. Lets the gate run before any work is done. */
	diff?: string;
	/** Changed paths, when the host has them but not the diff. Cheaper than fetching a diff. */
	changedPaths?: string[];
}

export type TriggerDecision =
	| {
		act: false;
		/** Why nothing happened, for the log. Never posted: silence has no footnote. */
		reason: string;
	}
	| {
		act: true;
		command: ReviewCommand;
		/** Leave this on the triggering comment the moment the job is accepted, before any
		 *  work — the whole point is that the person who asked sees it immediately. */
		reaction?: Reaction;
		/** True when a person asked directly and is waiting for an answer. Governs whether a
		 *  failure is reported back to them or only logged. */
		requested: boolean;
		reason: string;
	};

const AUTO_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** A review command with nothing set — what a bare trigger means. */
function autoCommand(): ReviewCommand {
	return { name: 'review', deep: false, raw: '' };
}

/** True when this text is one of our own comments. The loop guard of last resort. */
export function isOwnComment(body: string | undefined): boolean {
	return !!body && body.includes(COMMENT_MARKER);
}

/**
 * Whether to act on an event, and how to acknowledge it.
 *
 * Deliberately conservative: every branch that is not clearly a request to review returns
 * `act: false` with a reason. The cost of missing one review is that somebody types a mention;
 * the cost of one unwanted comment is that a team turns the whole thing off.
 */
export function decideTrigger(event: TriggerEvent, config: TriggerConfig = {}): TriggerDecision {
	const handle = config.handle ?? DEFAULT_BRANDING.handle;
	const auto = config.auto ?? 'sql-only';

	// Loop guards first, before anything else can go wrong.
	if (event.authorIsSelf || isOwnComment(event.body)) {
		return { act: false, reason: 'the event came from us' };
	}
	if (event.authorIsBot && !config.bots) {
		return { act: false, reason: 'the author is a bot and `bots` is off' };
	}

	if (event.kind === 'comment') {
		const command = parseMention(event.body ?? '', handle);
		if (!command) {
			return { act: false, reason: 'the comment does not address us' };
		}
		// `help` and `status` are answered instantly and do not run a review, so the eyes
		// reaction would be on screen for less time than it takes to render. Skip it.
		const quick = command.name === 'help' || command.name === 'status';
		return {
			act: true,
			command,
			reaction: quick ? undefined : 'eyes',
			requested: true,
			reason: `\`${command.name}\` requested by comment`,
		};
	}

	if (event.kind === 'manual') {
		return { act: true, command: autoCommand(), requested: true, reason: 'asked for directly' };
	}

	// A pull request event.
	if (auto === 'mention') {
		return { act: false, reason: 'automatic review is off for this repository' };
	}
	if (event.action && !AUTO_ACTIONS.has(event.action)) {
		return { act: false, reason: `nothing to do on \`${event.action}\`` };
	}
	if (event.draft && !config.drafts) {
		// `ready_for_review` arrives when it stops being a draft, and that is when we review.
		return { act: false, reason: 'the pull request is a draft' };
	}
	if (auto === 'always') {
		return { act: true, command: autoCommand(), requested: false, reason: 'every pull request is reviewed here' };
	}

	const touches = touchesSql(event, config.paths);
	if (touches === false) {
		return { act: false, reason: 'the change does not touch SQL' };
	}
	if (touches === undefined) {
		// The host gave us neither a diff nor a path list, so the gate has to run later, after
		// the diff is fetched. Say so rather than guessing in either direction.
		return { act: true, command: autoCommand(), requested: false, reason: 'paths unknown; gate again once the diff is fetched' };
	}
	return { act: true, command: autoCommand(), requested: false, reason: 'the change touches SQL' };
}

/** Whether the change touches a reviewable path. `undefined` when we cannot tell yet. */
export function touchesSql(event: Pick<TriggerEvent, 'diff' | 'changedPaths'>, paths?: PathFilter): boolean | undefined {
	if (event.changedPaths) {
		return event.changedPaths.some((path) => isReviewablePath(path, paths));
	}
	if (typeof event.diff === 'string') {
		return parseDiff(event.diff).some((file) => file.status !== 'deleted' && isReviewablePath(file.path, paths));
	}
	return undefined;
}

/**
 * The reaction to leave when the work is done, replacing nothing — the comment carries the
 * result, so this only says "finished". A clean review gets a tick; a review with findings
 * gets none, because the comment is the answer and a rocket over bad news reads badly.
 */
export function doneReaction(blockers: number, warnings: number): Reaction | undefined {
	return blockers === 0 && warnings === 0 ? '+1' : undefined;
}

/**
 * What to say when somebody asked and the review could not run at all.
 *
 * Only ever posted for a REQUESTED review (`decision.requested`). An automatic review that
 * fails logs and stays quiet: nobody asked, so nobody is owed an error message.
 */
export function renderFailure(reason: string, handle = DEFAULT_BRANDING.handle): string {
	return [
		COMMENT_MARKER,
		`Could not run the review: ${reason}`,
		'',
		`_Ask again with \`@${handle} review\` once that is sorted._`,
	].join('\n');
}

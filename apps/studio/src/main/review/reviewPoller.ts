/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decideTrigger, parseMention } from '@snout/review-core';
import type { TriggerConfig } from '@snout/review-core';

import { earliest, headPredatesComment } from './forge';
import type { Forge, ForgeAuthor, IssueComment, PullRequestRef } from './forge';
import type { ReviewRunner } from './reviewRunner';
import type { ReviewStore, WatchedRepo } from './reviewStore';

/*---------------------------------------------------------------------------------------------
 *  Finding the work.
 *
 *  A webhook cannot reach a laptop, so the desktop asks GitHub instead of being told. That is
 *  the one real cost of reviewing on the user's own machine, and it is stated plainly wherever the
 *  feature is described: it reviews while the app is running, and not otherwise. The app living in the tray is what
 *  makes that mostly fine.
 *
 *  Everything about WHETHER to review is decided by review-core's `decideTrigger`, not here —
 *  this file only supplies the facts (is it a draft, is the author a bot, what changed) and
 *  carries out the verdict. Behaviour rules buried in a poll loop are behaviour rules that get
 *  broken by the next person to edit the loop.
 *
 *  It is deferred off the boot path by its caller and does nothing at all until the user turns
 *  it on: "Startup is sacred", and polling somebody's GitHub account is not a
 *  thing to opt out of.
 *--------------------------------------------------------------------------------------------*/

/** How far back to look for mentions on the very first poll of a repository. */
const FIRST_POLL_LOOKBACK_MS = 60 * 60 * 1000;

/** How long a "can this person write here" answer is trusted before it is asked again. Long
 *  enough that a busy fork does not cost a permission call per poll, short enough that a removed
 *  collaborator stops being obeyed within minutes. */
const PERMISSION_TTL_MS = 10 * 60 * 1000;

/** Pull requests examined per repository per poll. Newest-updated first, so this is a cap on
 *  work rather than on coverage: a repo with 200 open PRs still gets the active ones. */
const MAX_PRS_PER_POLL = 20;

export interface PollerDeps {
	store: ReviewStore;
	runner: ReviewRunner;
	/** Builds the client for a repository's host. Throws when that host is not connected, which
	 *  is one repository's problem and not the poll's — see the per-repo catch below. */
	forge: (repo: WatchedRepo) => Promise<Forge>;
	/** True while the user has paused scheduled work from the tray. */
	isPaused?: () => boolean;
	onError?: (repoId: string, message: string) => void;
	onStatus?: (status: string | undefined) => void;
}

/** One thing the poller decided to do. Returned so a caller (and a test) can see the decisions
 *  without watching side effects. */
export interface PollAction {
	repoId: string;
	prNumber: number;
	/** `mention` — somebody asked. `auto` — it changed and the repo is on automatic. */
	because: 'mention' | 'auto';
	/** The comment that asked, when one did. */
	commentId?: number;
	ran: boolean;
	skipped?: string;
}

function triggerConfig(repo: WatchedRepo): TriggerConfig {
	return {
		auto: repo.auto,
		drafts: false,
		bots: false,
		handle: 'snoutbot',
		paths:
			repo.includePaths?.length || repo.excludePaths?.length
				? { include: repo.includePaths, exclude: repo.excludePaths }
				: undefined,
	};
}

export class ReviewPoller {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	/** `repoId:login` to whether that person can write there, and when it was asked. */
	private readonly writers = new Map<string, { ok: boolean; at: number }>();
	/** `repoId:commentId` of every command already answered with "it changed since", so a comment
	 *  the next poll fetches again is not answered twice. */
	private readonly moved = new Set<string>();

	constructor(private readonly deps: PollerDeps) {}

	/** Start polling. Safe to call repeatedly; the schedule is rebuilt from the store each time. */
	start(): void {
		this.stop();
		if (!this.deps.store.isEnabled()) {
			return;
		}
		const seconds = this.deps.store.config().pollSeconds;
		const tick = async (): Promise<void> => {
			await this.pollOnce().catch(() => undefined);
			this.timer = setTimeout(tick, seconds * 1000);
		};
		// First run on the interval, not immediately: the caller already defers us off boot, and
		// a poll racing the first paint is exactly what "startup is sacred" forbids.
		this.timer = setTimeout(tick, seconds * 1000);
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Whether a pass is running now, so a manual check can say "already checking". */
	get isRunning(): boolean {
		return this.running;
	}

	/** One pass over every watched repository. Returns what it decided, for the UI and tests. */
	async pollOnce(manual = false): Promise<PollAction[]> {
		// "Pause Scheduled Flows" pauses the INTERVAL. A person pressing Check now is not a
		// schedule, and before this the press was silently swallowed while paused.
		if (this.running || (!manual && this.deps.isPaused?.())) {
			return [];
		}
		const repos = this.deps.store.activeRepos();
		if (repos.length === 0) {
			return [];
		}
		this.running = true;
		const actions: PollAction[] = [];
		try {
			for (const repo of repos) {
				try {
					// One client per repository: two of them can be on different hosts, and a
					// GitLab install has a base URL of its own.
					actions.push(...(await this.pollRepo(await this.deps.forge(repo), repo)));
				} catch (err) {
					// One unreachable or misconfigured repository must not stop the others.
					this.deps.onError?.(repo.id, err instanceof Error ? err.message : String(err));
				}
			}
		} finally {
			this.running = false;
			this.deps.onStatus?.(undefined);
		}
		return actions;
	}

	private async pollRepo(github: Forge, repo: WatchedRepo): Promise<PollAction[]> {
		const actions: PollAction[] = [];
		const since = repo.cursor ?? new Date(Date.now() - FIRST_POLL_LOOKBACK_MS).toISOString();
		const login = this.deps.store.loginFor(repo.forge)?.toLowerCase();
		const pulls = await github.openPullRequests(repo.owner, repo.name, MAX_PRS_PER_POLL);
		// Taken AFTER the list came back: each head in it was the head at least from this moment.
		const seenAt = new Date().toISOString();
		const heads: NonNullable<WatchedRepo['heads']> = {};
		for (const pr of pulls) {
			const known = repo.heads?.[String(pr.number)];
			heads[String(pr.number)] = known && known.sha === pr.headSha ? known : { sha: pr.headSha, since: seenAt };
		}
		let newest = repo.cursor ?? '';

		for (const pr of pulls) {
			if (pr.updatedAt > newest) {
				newest = pr.updatedAt;
			}
			// Mentions first: somebody asking always outranks the automatic pass, and an explicit
			// request ignores the already-reviewed check.
			const asked = await this.mentionOn(github, repo, pr, since, login);
			if (asked) {
				// A review is bound to the commit that was there when it was asked for. A fork's
				// author can push after a maintainer comments; running that would put SQL nobody
				// asked about past the bound database, under the user's name.
				if (asked.runs && !(await this.headWasThere(github, repo, pr, asked.comment, heads[String(pr.number)]?.since))) {
					actions.push(await this.holdMoved(repo, pr, asked.comment));
					continue;
				}
				actions.push(await this.act(repo, pr, asked.comment, 'mention'));
				continue;
			}
			const decision = decideTrigger(
				{
					kind: 'pull_request',
					action: 'synchronize',
					draft: pr.draft,
					authorIsBot: pr.authorIsBot,
					// The path gate runs later, on the diff itself: fetching a diff per open PR
					// per minute is exactly the kind of politeness GitHub rate limits reward.
				},
				triggerConfig(repo),
			);
			if (!decision.act) {
				continue;
			}
			if (this.deps.store.alreadyReviewed(repo.id, pr.number, pr.headSha)) {
				continue;
			}
			if (!(await this.mayAutoReview(github, repo, pr))) {
				continue;
			}
			actions.push(await this.act(repo, pr, undefined, 'auto'));
		}

		this.deps.store.recordPoll(repo.id, Date.now(), newest || undefined, heads);
		return actions;
	}

	/** Was the pull request's current head already its head when the comment was written? The
	 *  host's record when it keeps one (GitLab), else the first poll that saw it there. */
	private async headWasThere(github: Forge, repo: WatchedRepo, pr: PullRequestRef, comment: IssueComment, seenSince: string | undefined): Promise<boolean> {
		const hostSince = await github.headSince(repo.owner, repo.name, pr.number, pr.headSha).catch(() => undefined);
		return headPredatesComment(earliest(hostSince, seenSince), comment.createdAt);
	}

	/** Not run: the change moved after it was asked for. Said once per comment, by the runner. */
	private async holdMoved(repo: WatchedRepo, pr: PullRequestRef, comment: IssueComment): Promise<PollAction> {
		const skipped = 'it changed after the review was asked for';
		const key = `${repo.id}:${comment.id}`;
		if (!this.moved.has(key)) {
			this.moved.add(key);
			await this.deps.runner.postMoved(repo, pr.number, pr.headSha).catch((err: unknown) => {
				this.deps.onError?.(repo.id, err instanceof Error ? err.message : String(err));
			});
		}
		return { repoId: repo.id, prNumber: pr.number, because: 'mention', commentId: comment.id, ran: false, skipped };
	}

	/** The newest unanswered `@snoutbot` on this pull request, if there is one. */
	private async mentionOn(
		github: Forge,
		repo: WatchedRepo,
		pr: PullRequestRef,
		since: string,
		login: string | undefined,
	): Promise<{ comment: IssueComment; deep: boolean; runs: boolean } | undefined> {
		const comments = await github.comments(repo.owner, repo.name, pr.number, since);
		for (const comment of [...comments].reverse()) {
			// Never answer ourselves, whatever the comment says.
			if (login && comment.authorLogin.toLowerCase() === login) {
				continue;
			}
			const decision = decideTrigger(
				{ kind: 'comment', action: 'created', body: comment.body, authorIsBot: comment.authorIsBot },
				triggerConfig(repo),
			);
			if (!decision.act) {
				continue;
			}
			// Only the repository's own people command the reviewer. A review reads the bound
			// database and answers under the user's name, so on a public repository "anyone who
			// can comment" is anyone at all. Everybody else is ignored without a reply: an answer
			// would tell them the reviewer is here and what it is pointed at.
			if (!(await this.isWriter(github, repo, { login: comment.authorLogin, id: comment.authorId, association: comment.authorAssociation }))) {
				continue;
			}
			// Everything but these four runs a review (see `act`), so everything else is bound to the head.
			const runs = !['help', 'ignore', 'explain', 'fix'].includes(decision.command.name);
			return { comment, deep: decision.command.deep, runs };
		}
		return undefined;
	}

	/**
	 * May this pull request be reviewed without anybody asking?
	 *
	 * A branch in the repository itself was pushed by somebody who can write there. A fork can be
	 * opened by anyone, so it is reviewed automatically only when its author can write here too,
	 * or when the user has said, for this repository, that outsiders are fine.
	 */
	private async mayAutoReview(github: Forge, repo: WatchedRepo, pr: PullRequestRef): Promise<boolean> {
		if (!pr.fromFork || repo.reviewOutsiders) {
			return true;
		}
		return this.isWriter(github, repo, { login: pr.authorLogin, id: pr.authorId, association: pr.authorAssociation });
	}

	private async isWriter(github: Forge, repo: WatchedRepo, author: ForgeAuthor): Promise<boolean> {
		const key = `${repo.id}:${author.login.toLowerCase()}`;
		const cached = this.writers.get(key);
		if (cached && Date.now() - cached.at < PERMISSION_TTL_MS) {
			return cached.ok;
		}
		const ok = await github.canWrite(repo.owner, repo.name, author).catch(() => false);
		this.writers.set(key, { ok, at: Date.now() });
		return ok;
	}

	private async act(
		repo: WatchedRepo,
		pr: PullRequestRef,
		comment: IssueComment | undefined,
		because: PollAction['because'],
	): Promise<PollAction> {
		const command = comment
			? parseMention(comment.body, 'snoutbot') ?? { name: 'review' as const, deep: false, raw: '' }
			: { name: 'review' as const, deep: false, raw: '' };

		const action: PollAction = { repoId: repo.id, prNumber: pr.number, because, commentId: comment?.id, ran: false };
		try {
			if (command.name === 'help') {
				await this.deps.runner.postHelp(repo, pr.number);
				action.ran = true;
				return action;
			}
			if (command.name === 'ignore' || command.name === 'explain' || command.name === 'fix') {
				// Not built yet. Saying so is better than silence, but it is
				// the runner's job to say it, not the poller's.
				action.skipped = `\`${command.name}\` is not implemented yet`;
				return action;
			}
			await this.deps.runner.run(repo, pr, command, comment?.id);
			this.deps.store.recordReviewed(repo.id, pr.number, pr.headSha);
			action.ran = true;
		} catch (err) {
			action.skipped = err instanceof Error ? err.message : String(err);
			this.deps.onError?.(repo.id, action.skipped);
		}
		return action;
	}
}

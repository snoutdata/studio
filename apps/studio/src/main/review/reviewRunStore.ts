/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ReviewForge, ReviewMethod, ReviewRun } from '../../shared/review';
import { DEFAULT_REVIEW_METHOD } from '../../shared/review';

/*---------------------------------------------------------------------------------------------
 *  The reviews that have been written, kept across restarts.
 *
 *  These used to live in an array on `ReviewService` and nowhere else, with a comment saying so
 *  on purpose: "a review is about a commit, and a stale one is worse than none." The concern was
 *  right and the conclusion was not. What was actually lost on every restart:
 *
 *   - **A review waiting to be read.** Approval before posting is what the desktop reviewer is for, and the app is
 *     a tray app whose window close button hides it. A review written at 4pm, not yet read, was
 *     gone by morning, and nothing said it had ever existed.
 *   - **The record of what was said.** The comment is on the pull request, but which rung wrote
 *     it, what it was measured against and when are not, and that is exactly what somebody asks
 *     three weeks later when a migration went wrong.
 *
 *  STALENESS IS ANSWERED, NOT AVOIDED. A run names its `headSha`, the view prints it, and the
 *  comment is of that sha and says so. A stale review is one whose sha has been superseded, which
 *  is legible from the card rather than from the review's absence. Deleting the history was a way
 *  of never having to show it, not a way of being right about it.
 *
 *  It is a separate file from `review.json` for the same reason `queries.json` is separate from
 *  `connections.json`: one is configuration the user set, the other is history the app accumulated,
 *  and losing the second must never cost the first. A corrupt file here starts an empty history and
 *  leaves every watched repository alone.
 *--------------------------------------------------------------------------------------------*/

/**
 * How many reviews to keep.
 *
 * The bodies are rendered markdown comments, a few KB each, so fifty is a file in the low
 * hundreds of KB. It was the in-memory cap before this and stays the number, because it is not
 * memory that decides it: fifty is more history than anybody scrolls and few enough that the view
 * needs no paging.
 */
export const MAX_RUNS = 50;

function runsPath(): string {
	return join(app.getPath('userData'), 'reviewRuns.json');
}

/** One stored review, validated. A JSON file a user can edit is not a type. Exported for its
 *  tests: the rest of this module reaches `app.getPath`, which only exists inside Electron. */
export function normaliseRun(raw: Partial<ReviewRun> & Record<string, unknown>): ReviewRun | null {
	if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.repoId !== 'string') {
		return null;
	}
	if (typeof raw.prNumber !== 'number' || typeof raw.body !== 'string') {
		return null;
	}
	return {
		id: raw.id,
		repoId: raw.repoId,
		forge: raw.forge === 'gitlab' ? 'gitlab' : ('github' as ReviewForge),
		repoLabel: typeof raw.repoLabel === 'string' ? raw.repoLabel : raw.repoId,
		prNumber: raw.prNumber,
		prTitle: typeof raw.prTitle === 'string' ? raw.prTitle : undefined,
		prUrl: typeof raw.prUrl === 'string' ? raw.prUrl : undefined,
		headSha: typeof raw.headSha === 'string' ? raw.headSha : '',
		body: raw.body,
		depth: raw.depth === 'static' || raw.depth === 'schema' ? raw.depth : 'connected',
		destinationName: typeof raw.destinationName === 'string' ? raw.destinationName : undefined,
		blockers: typeof raw.blockers === 'number' ? raw.blockers : 0,
		warnings: typeof raw.warnings === 'number' ? raw.warnings : 0,
		notes: typeof raw.notes === 'number' ? raw.notes : 0,
		postedCommentId: typeof raw.postedCommentId === 'number' ? raw.postedCommentId : undefined,
		awaitingApproval: raw.awaitingApproval === true,
		// A history written before the rungs existed says nothing about which one ran, and the
		// truthful answer for those is the default rather than a guess at what was configured.
		method: readMethod(raw.method),
		at: typeof raw.at === 'number' ? raw.at : 0,
		error: typeof raw.error === 'string' ? raw.error : undefined,
	};
}

function readMethod(stored: unknown): ReviewMethod {
	if (!stored || typeof stored !== 'object') {
		return DEFAULT_REVIEW_METHOD;
	}
	const method = stored as { kind?: unknown; provider?: unknown; model?: unknown; host?: unknown };
	switch (method.kind) {
		case 'localEngine':
			return { kind: 'localEngine' };
		case 'snoutAi':
			return { kind: 'snoutAi', consent: true };
		case 'byok':
			if (method.provider === 'ollama' || method.provider === 'openai' || method.provider === 'anthropic' || method.provider === 'openrouter') {
				return {
					kind: 'byok',
					provider: method.provider,
					model: typeof method.model === 'string' ? method.model : '',
					host: typeof method.host === 'string' && method.host !== '' ? method.host : undefined,
					consent: true,
				};
			}
			return DEFAULT_REVIEW_METHOD;
		default:
			return DEFAULT_REVIEW_METHOD;
	}
}

export class ReviewRunStore {
	private cache: ReviewRun[] | null = null;

	/**
	 * The history, newest first.
	 *
	 * Read lazily and cached, so nothing touches the disk until something actually asks — the
	 * service is constructed on launch and startup is sacred. Nothing on the boot path
	 * asks for reviews.
	 */
	all(): ReviewRun[] {
		if (this.cache) {
			return this.cache;
		}
		let runs: ReviewRun[] = [];
		const path = runsPath();
		if (existsSync(path)) {
			try {
				const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
				if (Array.isArray(raw)) {
					runs = raw
						.map((r) => normaliseRun(r as Partial<ReviewRun> & Record<string, unknown>))
						.filter((r): r is ReviewRun => r !== null);
				}
			} catch {
				// Corrupt history is an empty history. It must never take the watched repositories
				// with it, which is why this is not in `review.json`.
			}
		}
		runs.sort((a, b) => b.at - a.at);
		this.cache = runs.slice(0, MAX_RUNS);
		return this.cache;
	}

	/** Replace the history. The caller owns the ordering and the cap; this only stores it. */
	save(runs: ReviewRun[]): void {
		this.cache = runs.slice(0, MAX_RUNS);
		const path = runsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(this.cache, null, 2), 'utf8');
	}
}

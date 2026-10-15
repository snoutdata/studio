/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The forge seam: GitHub and GitLab, behind one interface.
 *
 *  Plenty of the teams this product is for are not on GitHub, and a reviewer that only speaks to
 *  one host is a reviewer most companies cannot install. So the poller and the runner know about
 *  a `Forge` and nothing else; `githubClient.ts` and `gitlabClient.ts` are the only files that
 *  know what a REST call looks like.
 *
 *  **One vocabulary, deliberately.** GitLab says merge request, note and award emoji; GitHub says
 *  pull request, issue comment and reaction. Carrying both sets of words through the poller, the
 *  runner, the store and the UI would double every name for no gain, so the product's own words
 *  win everywhere inside the app and each client translates at its own boundary. The one place the
 *  user's word is used is the COMMENT, because that is read on their host, by them (see
 *  `forgeVocabulary`).
 *
 *  **A project path can have more than two segments.** `acme/backend/api` is one GitLab project
 *  in the `acme/backend` group. `owner` therefore holds everything before the last slash, `name`
 *  the last segment, and `owner/name` remains the id — which is exactly what GitHub already did,
 *  so nothing above this file changes.
 *--------------------------------------------------------------------------------------------*/

export type ForgeKind = 'github' | 'gitlab';

/** The account a token belongs to. */
export interface ForgeUser {
	login: string;
	name?: string;
	/** Scopes the host reports, when it reports any. Empty is not a problem: GitHub's
	 *  fine-grained tokens and GitLab both simply do not answer this question. */
	scopes: string[];
}

/** One repository the token can reach. */
export interface ForgeRepoRef {
	/** Everything before the last slash of the project path. `acme` or `acme/backend`. */
	owner: string;
	name: string;
	/** `owner/name`, as the host spells it. */
	fullName: string;
	private: boolean;
	archived: boolean;
	/** Last push/activity, ISO. Used only to order the picker. */
	pushedAt?: string;
	/**
	 * Whether the token can WRITE here.
	 *
	 * Not a database permission — this is about the comment. Snoutbot posts as the user, so a
	 * repository they can only read is one it could review and never speak in, and saying that
	 * before they pick it beats a 403 on the first pull request.
	 */
	canComment: boolean;
}

/** A pull request (GitHub) or merge request (GitLab). */
export interface PullRequestRef {
	/** GitHub's number, GitLab's `iid`. Both are the number in the URL. */
	number: number;
	title: string;
	/** Head commit the review is about. A review is always OF a sha, never of "the PR". */
	headSha: string;
	baseRef: string;
	draft: boolean;
	authorLogin: string;
	authorIsBot: boolean;
	/** GitLab's numeric user id for the author, which its membership API is keyed on. */
	authorId?: number;
	/** GitHub's `author_association` (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, …), the
	 *  fallback when the permission API cannot be asked. Absent on GitLab. */
	authorAssociation?: string;
	/**
	 * True when the change comes from ANOTHER repository (a fork), or when the host could not say
	 * where it comes from. A branch in the watched repository itself was pushed by somebody who can
	 * write there; a fork can be opened by anybody who can see the repository, so an automatic
	 * review of one runs a stranger's SQL against the bound database. See `ReviewPoller`.
	 */
	fromFork: boolean;
	updatedAt: string;
	htmlUrl: string;
}

/** Who wrote a comment or opened a pull request, as much as the host told us. */
export interface ForgeAuthor {
	login: string;
	id?: number;
	association?: string;
}

/** A comment on one (GitHub's issue comment, GitLab's note). */
export interface IssueComment {
	id: number;
	body: string;
	authorLogin: string;
	authorIsBot: boolean;
	/** See {@link PullRequestRef.authorId}. */
	authorId?: number;
	/** See {@link PullRequestRef.authorAssociation}. */
	authorAssociation?: string;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
}

/**
 * The reviewer's line in the host's own checks box.
 *
 * This is a COMMIT STATUS, not a check run, and the difference is not cosmetic: check runs can
 * only be created by a GitHub App, and this product's whole shape is that it runs on the user's
 * machine with the user's token. A commit status is what a personal token can write, and it
 * renders in the same place, beside CI.
 *
 * `pending` goes up the moment a review starts, so a pull request says the reviewer is looking
 * at it rather than saying nothing for however long the diff and the probes take. The final one
 * replaces it. `neutral` has no commit-status equivalent, so it is sent as a success whose
 * description says what actually happened.
 */
export interface CommitStatus {
	state: 'pending' | 'success' | 'failure' | 'neutral';
	/** One line, shown next to the check. Hosts truncate it, so put the point first. */
	description: string;
	/** Where "Details" goes. The pull request itself, since the review is a comment on it. */
	targetUrl?: string;
}

/** The reactions the reviewer leaves. Each client maps these to its host's own names. */
export type ForgeReaction = 'seen' | 'good';

/**
 * What the reviewer needs from a host.
 *
 * Every method takes `owner` + `name` rather than an opaque handle so nothing above has to hold
 * host state, and `updateComment`/`react` take the pull request too: GitHub can address a comment
 * by id alone, GitLab cannot, and the interface has to fit the stricter of the two.
 */
export interface Forge {
	readonly kind: ForgeKind;
	/** Who the token belongs to. Used to verify it before it is stored, and to recognise our own
	 *  comments afterwards. */
	viewer(): Promise<ForgeUser>;
	/** Everything the token can reach — its permission list, which is what the picker offers. */
	repositories(): Promise<ForgeRepoRef[]>;
	openPullRequests(owner: string, name: string, limit?: number): Promise<PullRequestRef[]>;
	pullRequest(owner: string, name: string, number: number): Promise<PullRequestRef>;
	/** A unified diff of the whole change. */
	pullRequestDiff(owner: string, name: string, number: number): Promise<string>;
	/** A file's full content at a commit, or undefined when it is not there. */
	fileContent(owner: string, name: string, path: string, ref: string): Promise<string | undefined>;
	comments(owner: string, name: string, number: number, since?: string): Promise<IssueComment[]>;
	createComment(owner: string, name: string, number: number, body: string): Promise<IssueComment>;
	updateComment(owner: string, name: string, number: number, commentId: number, body: string): Promise<IssueComment>;
	react(owner: string, name: string, number: number, commentId: number, reaction: ForgeReaction): Promise<void>;
	/**
	 * Put the reviewer's state on the head commit.
	 *
	 * Optional in practice rather than in the type: the token may not carry the permission, and
	 * a missing status must never cost a review. The runner calls it and swallows the failure.
	 */
	setStatus(owner: string, name: string, sha: string, status: CommitStatus): Promise<void>;
	/**
	 * Can this person WRITE to the repository: GitHub write, maintain or admin, GitLab Developer
	 * or above.
	 *
	 * The gate on who may command the reviewer. A review reads the bound database and posts under
	 * the user's name, so it is something only the repository's own people may ask for, never
	 * whoever can leave a comment. Never throws: a host that cannot answer is a NO.
	 */
	canWrite(owner: string, name: string, author: ForgeAuthor): Promise<boolean>;
	/**
	 * Since when `headSha` has been this request's head, by the HOST's clock, or undefined when
	 * the host keeps no such record.
	 *
	 * What binds a `@snoutbot review` to the commit it was written about: a fork's author can push
	 * after a maintainer comments, and the review would then run their new SQL against the bound
	 * database. GitLab records every push as a merge request version, with its own timestamp.
	 * GitHub's REST API has no push time for a pull request's head (a commit's dates are whatever
	 * its author wrote), so there the poller's own sightings of the head are the record. Never
	 * throws: a host that cannot answer is "no record".
	 */
	headSince(owner: string, name: string, number: number, headSha: string): Promise<string | undefined>;
}

/**
 * Was this head already the head when the comment was written? `headSince` is the earliest
 * moment the head is KNOWN to have been in place (the host's record or the poller's first
 * sighting); without one, the answer is no. A command written before the head arrived was
 * written about another commit, so it is not run on this one.
 */
export function headPredatesComment(headSince: string | undefined, commentCreatedAt: string): boolean {
	if (!headSince) {
		return false;
	}
	const head = Date.parse(headSince);
	const comment = Date.parse(commentCreatedAt);
	return Number.isFinite(head) && Number.isFinite(comment) && head <= comment;
}

/** The earlier of two moments, either of which may be missing. */
export function earliest(a: string | undefined, b: string | undefined): string | undefined {
	if (!a || !Number.isFinite(Date.parse(a))) {
		return b;
	}
	if (!b || !Number.isFinite(Date.parse(b))) {
		return a;
	}
	return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The fallback for when GitHub's collaborator-permission API cannot be asked: the comment's
 *  `author_association` alone. Only OWNER is trusted. MEMBER is any member of the organisation and
 *  COLLABORATOR includes read-only outside collaborators, so neither proves write access, and a
 *  check that cannot be made fails closed. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER']);

/** Whether a comment's `author_association` alone may command the reviewer (see {@link TRUSTED_ASSOCIATIONS}). */
export function associationCanWrite(association: string | undefined): boolean {
	return association !== undefined && TRUSTED_ASSOCIATIONS.has(association.toUpperCase());
}

/**
 * GitHub's collaborator-permission answer as "may command the reviewer". `role_name` tells
 * `maintain` and `triage` apart (the older `permission` folds them into `write` and `read`); an
 * organization's custom role has a name of its own, and then its base permission decides. Here
 * rather than in `githubClient.ts` so a Node test can reach it without Electron.
 */
export function githubWriteRole(body: { permission?: string; role_name?: string }): boolean {
	const role = body.role_name?.toLowerCase();
	if (role === 'admin' || role === 'maintain' || role === 'write') {
		return true;
	}
	if (role === 'triage' || role === 'read' || role === 'none') {
		return false;
	}
	const permission = body.permission?.toLowerCase();
	return permission === 'admin' || permission === 'write';
}

/** A GitHub pull request whose head is not the base repository. A head whose repository is gone
 *  (a deleted fork) or was not reported counts as a fork: the safe answer to "may a stranger's
 *  SQL be run automatically" is no. */
export function githubFromFork(raw: {
	head: { repo?: { full_name?: string } | null };
	base: { repo?: { full_name?: string } | null };
}): boolean {
	const head = raw.head.repo?.full_name?.toLowerCase();
	const base = raw.base.repo?.full_name?.toLowerCase();
	return !head || !base || head !== base;
}

/** An error a client raises, in terms the caller can act on. */
export class ForgeError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** True when waiting and retrying is the right response (rate limit, 5xx, a timeout). */
		readonly retryable: boolean,
	) {
		super(message);
		this.name = 'ForgeError';
	}
}

/** The name the status appears under. One constant: a host keys on it to REPLACE the previous
 *  status rather than stack a second one, so a changed name leaves a stale line behind forever. */
export const STATUS_CONTEXT = 'snoutbot';

/** The host's own words, for text the user reads on their host. */
export function forgeVocabulary(kind: ForgeKind): { pullRequest: string; pullRequests: string } {
	return kind === 'gitlab'
		? { pullRequest: 'merge request', pullRequests: 'merge requests' }
		: { pullRequest: 'pull request', pullRequests: 'pull requests' };
}

/** Split a project path into the `owner` + `name` pair the store keys on. `acme/backend/api`
 *  becomes `acme/backend` + `api`, because the group can be nested and the project cannot. */
export function splitProjectPath(path: string): { owner: string; name: string } | undefined {
	const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
	const cut = trimmed.lastIndexOf('/');
	if (cut <= 0 || cut === trimmed.length - 1) {
		return undefined;
	}
	return { owner: trimmed.slice(0, cut), name: trimmed.slice(cut + 1) };
}

/**
 * A repository file path from a pull request, checked before it goes into an API URL.
 *
 * The path is the PR author's to choose, and each client builds the file-content URL from it. A
 * `..` segment survives `encodeURIComponent`, and the URL parser resolves it, so `../../../user`
 * would send the user's token to a different endpoint on the same host. Git itself never writes a
 * path with an empty, `.` or `..` segment, a leading slash or a control character, so one that has
 * any of those did not come from git and is refused rather than repaired.
 */
export function checkedRepoPath(path: string): string {
	if (path === '' || path.length > 4096) {
		throw new ForgeError('That file path is empty or too long to fetch.', 0, false);
	}
	if (/[\u0000-\u001f\u007f]/.test(path)) {
		throw new ForgeError('That file path has a control character in it, so it was not fetched.', 0, false);
	}
	if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
		throw new ForgeError(`\`${path}\` is an absolute path, so it was not fetched.`, 0, false);
	}
	for (const segment of path.split(/[/\\]/)) {
		if (segment === '' || segment === '.' || segment === '..') {
			throw new ForgeError(`\`${path}\` is not a plain repository path, so it was not fetched.`, 0, false);
		}
	}
	return path;
}

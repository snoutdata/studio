/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { netFetch, isNetworkError, networkBlockedMessage, networkErrorDetail, type NetFetchInit } from '../netFetch';
import { cacheable, type ConditionalCache } from './httpCache';
import {
	checkedRepoPath,
	ForgeError,
	splitProjectPath,
	STATUS_CONTEXT,
	type CommitStatus,
	type Forge,
	type ForgeAuthor,
	type ForgeKind,
	type ForgeReaction,
	type ForgeRepoRef,
	type ForgeUser,
	type IssueComment,
	type PullRequestRef,
} from './forge';

/*---------------------------------------------------------------------------------------------
 *  GitLab, as a Forge.
 *
 *  The same job `githubClient.ts` does, against a host that is different in four ways that
 *  actually matter — the rest is renaming:
 *
 *    1. **The instance is not ours to assume.** Most companies on GitLab self-host, so the base
 *       URL is a setting, not a constant. That is the single reason this is worth building: a
 *       team on `gitlab.internal.acme.com` cannot use a reviewer that hardcodes gitlab.com.
 *    2. **There is no ready-made unified diff.** GitHub serves one with an Accept header; GitLab
 *       returns per-file hunks, so `assembleDiff` builds the real thing. review-core's diff
 *       reader is the same code in both cases, so it has to be a real unified diff and not an
 *       approximation of one.
 *    3. **A note cannot be addressed by id alone.** Editing or reacting needs the merge request
 *       too, which is why the Forge interface carries it.
 *    4. **System notes are not comments.** "changed the description", "assigned to @x" come back
 *       from the same endpoint as real ones. Left in, they would be scanned for mentions and
 *       counted as somebody talking. They are dropped here, at the boundary.
 *--------------------------------------------------------------------------------------------*/

/** gitlab.com. A self-hosted instance overrides this per install. */
export const GITLAB_DEFAULT_URL = 'https://gitlab.com';

/** Same reasoning as the GitHub client: a request that cannot finish has to become an error
 *  somebody can read, or it wedges the poller for the rest of the session. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Access levels GitLab reports. 30 is Developer, the lowest that can comment on other people's
 *  merge requests; 20 (Reporter) can read but not speak, which is exactly the case the picker
 *  has to warn about. */
const DEVELOPER = 30;

/** The reviewer's reactions, in GitLab's emoji names. */
const AWARD: Record<ForgeReaction, string> = { seen: 'eyes', good: 'thumbsup' };

export class GitlabClient implements Forge {
	readonly kind: ForgeKind = 'gitlab';
	private readonly api: string;

	constructor(
		private readonly token: string,
		baseUrl: string = GITLAB_DEFAULT_URL,
		/** Shared ETags, so polling a quiet project costs nothing (`httpCache.ts`). Keyed on the
		 *  full url, which includes this instance's base, so two GitLabs cannot collide. */
		private readonly cache?: ConditionalCache,
	) {
		this.api = `${baseUrl.trim().replace(/\/+$/, '')}/api/v4`;
	}

	private async request(path: string, init: RequestInit = {}, etag?: string): Promise<Response> {
		try {
			const request: NetFetchInit = {
				// Revalidate rather than be served out of Chromium's cache: a poller that can be
				// handed a stale merge-request list without asking is a poller that misses one.
				// See the same note in `githubClient.ts`.
				cache: 'no-cache',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				...init,
				headers: {
					// A personal access token goes in PRIVATE-TOKEN; GitLab accepts Bearer only for
					// OAuth tokens, and sending the wrong one is a 401 that reads like a bad token.
					'PRIVATE-TOKEN': this.token,
					'User-Agent': 'SnoutData',
					...(etag ? { 'If-None-Match': etag } : {}),
					...(init.headers ?? {}),
				},
			};
			return await netFetch(`${this.api}${path}`, request);
		} catch (err) {
			if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
				throw new ForgeError(
					`GitLab did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. It may be slow, or your network may be holding the request.`,
					0,
					true,
				);
			}
			if (isNetworkError(err)) {
				throw new ForgeError(
					`${networkBlockedMessage('GitLab', err)} ${networkErrorDetail(err, hostOf(this.api))}`,
					0,
					true,
				);
			}
			throw err;
		}
	}

	/** A JSON call, asked conditionally when we have asked it before. The 304 branch comes before
	 *  the failure branch, because 304 is outside the 2xx range and is not a failure: it is the
	 *  server agreeing with the copy we already hold. */
	private async json<T>(path: string, what: string, init?: RequestInit): Promise<T> {
		const url = `${this.api}${path}`;
		const cached = this.cache && cacheable(init?.method) ? this.cache.peek(url) : undefined;
		const response = await this.request(path, init, cached?.etag);
		if (response.status === 304 && cached) {
			return cached.body as T;
		}
		if (!response.ok) {
			throw await toError(response, what);
		}
		const body = (await response.json()) as T;
		if (this.cache && cacheable(init?.method)) {
			this.cache.store(url, response.headers.get('etag'), body);
		}
		return body;
	}

	/** A project path as GitLab wants it in a URL: fully encoded, slashes included. */
	private project(owner: string, name: string): string {
		return encodeURIComponent(`${owner}/${name}`);
	}

	async viewer(): Promise<ForgeUser> {
		const body = await this.json<{ username: string; name?: string }>('/user', 'your GitLab account');
		// GitLab does not report a token's scopes on this endpoint, and that is fine: absence is
		// a different scheme rather than a warning, exactly as with a fine-grained GitHub token.
		return { login: body.username, name: body.name ?? undefined, scopes: [] };
	}

	async repositories(maxPages = 5): Promise<ForgeRepoRef[]> {
		const out: ForgeRepoRef[] = [];
		for (let page = 1; page <= maxPages; page++) {
			const body = await this.json<GitlabProject[]>(
				`/projects?membership=true&per_page=100&page=${page}&order_by=last_activity_at&sort=desc&archived=false`,
				'your projects',
			);
			for (const project of body) {
				const ref = toRepoRef(project);
				if (ref) {
					out.push(ref);
				}
			}
			if (body.length < 100) {
				break;
			}
		}
		return out;
	}

	async openPullRequests(owner: string, name: string, limit = 30): Promise<PullRequestRef[]> {
		const body = await this.json<GitlabMergeRequest[]>(
			`/projects/${this.project(owner, name)}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${Math.min(100, limit)}`,
			`merge requests for ${owner}/${name}`,
		);
		return body.map(toPullRequest);
	}

	async pullRequest(owner: string, name: string, number: number): Promise<PullRequestRef> {
		return toPullRequest(
			await this.json<GitlabMergeRequest>(
				`/projects/${this.project(owner, name)}/merge_requests/${number}`,
				`merge request !${number}`,
			),
		);
	}

	/**
	 * The change as a unified diff.
	 *
	 * GitLab has no equivalent of GitHub's `Accept: application/vnd.github.diff`; it returns the
	 * hunks per file and leaves the headers to the caller. review-core's diff reader is the same
	 * code for both hosts, so what it gets here has to be a real unified diff.
	 */
	async pullRequestDiff(owner: string, name: string, number: number): Promise<string> {
		const body = await this.json<{ changes?: GitlabChange[] }>(
			`/projects/${this.project(owner, name)}/merge_requests/${number}/changes`,
			`the diff for !${number}`,
		);
		return assembleDiff(body.changes ?? []);
	}

	async fileContent(owner: string, name: string, path: string, ref: string): Promise<string | undefined> {
		const response = await this.request(
			`/projects/${this.project(owner, name)}/repository/files/${encodeURIComponent(checkedRepoPath(path))}/raw?ref=${encodeURIComponent(ref)}`,
		);
		if (response.status === 404) {
			return undefined; // deleted, or not on this ref
		}
		if (!response.ok) {
			throw await toError(response, `\`${path}\``);
		}
		return await response.text();
	}

	async comments(owner: string, name: string, number: number, since?: string): Promise<IssueComment[]> {
		const body = await this.json<GitlabNote[]>(
			`/projects/${this.project(owner, name)}/merge_requests/${number}/notes?per_page=100&sort=asc&order_by=created_at`,
			`notes on !${number}`,
		);
		return body
			// A system note is GitLab's activity feed ("assigned to @x"), not somebody talking.
			// Scanning them for mentions would have the reviewer answering the timeline.
			.filter((note) => note.system !== true)
			.filter((note) => !since || (note.created_at ?? '') >= since)
			.map((note) => toComment(note, owner, name, number));
	}

	async createComment(owner: string, name: string, number: number, body: string): Promise<IssueComment> {
		return toComment(
			await this.json<GitlabNote>(
				`/projects/${this.project(owner, name)}/merge_requests/${number}/notes`,
				`a comment on !${number}`,
				{
					method: 'POST',
					body: JSON.stringify({ body }),
					headers: { 'Content-Type': 'application/json' },
				},
			),
			owner,
			name,
			number,
		);
	}

	async updateComment(owner: string, name: string, number: number, commentId: number, body: string): Promise<IssueComment> {
		return toComment(
			await this.json<GitlabNote>(
				`/projects/${this.project(owner, name)}/merge_requests/${number}/notes/${commentId}`,
				'the review comment',
				{
					method: 'PUT',
					body: JSON.stringify({ body }),
					headers: { 'Content-Type': 'application/json' },
				},
			),
			owner,
			name,
			number,
		);
	}

	async react(owner: string, name: string, number: number, commentId: number, reaction: ForgeReaction): Promise<void> {
		const response = await this.request(
			`/projects/${this.project(owner, name)}/merge_requests/${number}/notes/${commentId}/award_emoji`,
			{
				method: 'POST',
				body: JSON.stringify({ name: AWARD[reaction] }),
				headers: { 'Content-Type': 'application/json' },
			},
		);
		// 404 is what GitLab returns when the same award is already there. Neither that nor
		// anything else here is worth failing a review over; the caller swallows it anyway.
		if (!response.ok && response.status !== 404 && response.status !== 409) {
			throw await toError(response, 'a reaction');
		}
	}

	/**
	 * The reviewer's line in the pipeline box.
	 *
	 * GitLab calls the same idea a commit status and spells the states differently: `running`
	 * rather than pending, `failed` rather than failure. A second status under the same `name`
	 * supersedes the first. 400 is what it answers when the state cannot follow the one already
	 * there (posting `running` twice), which is not worth failing a review over.
	 */
	async setStatus(owner: string, name: string, sha: string, status: CommitStatus): Promise<void> {
		const state = status.state === 'pending' ? 'running' : status.state === 'failure' ? 'failed' : 'success';
		const response = await this.request(`/projects/${this.project(owner, name)}/statuses/${sha}`, {
			method: 'POST',
			body: JSON.stringify({
				state,
				name: STATUS_CONTEXT,
				description: status.description.slice(0, 140),
				target_url: status.targetUrl,
			}),
			headers: { 'Content-Type': 'application/json' },
		});
		if (!response.ok && response.status !== 400) {
			throw await toError(response, 'a commit status');
		}
	}

	/**
	 * Whether `author` is a Developer or above on the project, inherited membership included
	 * (`members/all`). The id comes with every note and merge request; when it is missing it is
	 * looked up by username. Any failure is a no.
	 */
	async canWrite(owner: string, name: string, author: ForgeAuthor): Promise<boolean> {
		try {
			let id = author.id;
			if (id === undefined) {
				if (author.login === '') {
					return false;
				}
				const users = await this.json<{ id?: number; username?: string }[]>(
					`/users?username=${encodeURIComponent(author.login)}`,
					`the user ${author.login}`,
				);
				id = users.find((u) => u.username?.toLowerCase() === author.login.toLowerCase())?.id;
				if (id === undefined) {
					return false;
				}
			}
			const response = await this.request(`/projects/${this.project(owner, name)}/members/all/${id}`);
			if (!response.ok) {
				return false;
			}
			const member = (await response.json()) as { access_level?: number };
			return (member.access_level ?? 0) >= DEVELOPER;
		} catch {
			return false;
		}
	}

	/** From the merge request's versions: GitLab records each push as one, with its own time. */
	async headSince(owner: string, name: string, number: number, headSha: string): Promise<string | undefined> {
		try {
			const versions = await this.json<GitlabVersion[]>(
				`/projects/${this.project(owner, name)}/merge_requests/${number}/versions?per_page=100`,
				`the versions of !${number}`,
			);
			return gitlabHeadSince(versions, headSha);
		} catch {
			return undefined;
		}
	}
}

/**
 * When `headSha` became the merge request's head, from its versions (newest first): the oldest
 * of the unbroken run of versions at the top whose head it is. Undefined when the newest version
 * is not that head (GitLab records versions after the push, so it can lag), which the caller
 * treats as no record. Exported for its test.
 */
export function gitlabHeadSince(versions: GitlabVersion[], headSha: string): string | undefined {
	const sorted = [...versions].sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
	let since: string | undefined;
	for (const version of sorted) {
		if (version.head_commit_sha !== headSha || !version.created_at) {
			break;
		}
		since = version.created_at;
	}
	return since;
}

/**
 * Per-file hunks into one unified diff.
 *
 * Exported for its own test: this is the only place in either client where a payload is
 * RECONSTRUCTED rather than read, so it is the only place that can quietly produce something the
 * diff reader parses into the wrong line numbers.
 */
export function assembleDiff(changes: GitlabChange[]): string {
	const parts: string[] = [];
	for (const change of changes) {
		const oldPath = change.old_path ?? change.new_path ?? '';
		const newPath = change.new_path ?? change.old_path ?? '';
		if (change.diff === undefined || change.diff === '') {
			continue; // a rename or mode change with no content change: nothing to review
		}
		parts.push(`diff --git a/${oldPath} b/${newPath}`);
		if (change.new_file) {
			parts.push('new file mode 100644');
			parts.push('--- /dev/null');
			parts.push(`+++ b/${newPath}`);
		} else if (change.deleted_file) {
			parts.push('deleted file mode 100644');
			parts.push(`--- a/${oldPath}`);
			parts.push('+++ /dev/null');
		} else {
			parts.push(`--- a/${oldPath}`);
			parts.push(`+++ b/${newPath}`);
		}
		// GitLab's `diff` starts at the first `@@` hunk header and keeps its own trailing newline.
		parts.push(change.diff.replace(/\n$/, ''));
	}
	return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

/** GitLab marks a draft two ways depending on version, and older instances only put it in the
 *  title. All three mean the same thing and the reviewer stays quiet for all three. */
export function isDraft(mr: Pick<GitlabMergeRequest, 'draft' | 'work_in_progress' | 'title'>): boolean {
	return mr.draft === true || mr.work_in_progress === true || /^\s*(draft:|wip:)/i.test(mr.title ?? '');
}

/** Whether an author is a bot. GitLab flags its own service accounts, and project/group access
 *  tokens act as users named `project_<id>_bot…`, which nothing flags. */
export function isBotAuthor(user: { username?: string; bot?: boolean } | undefined): boolean {
	if (!user) {
		return false;
	}
	return user.bot === true || /(^|_)bot(_|\d|$)/i.test(user.username ?? '');
}

function toRepoRef(project: GitlabProject): ForgeRepoRef | undefined {
	const path = project.path_with_namespace ?? '';
	const split = splitProjectPath(path);
	if (!split) {
		return undefined;
	}
	const access = Math.max(
		project.permissions?.project_access?.access_level ?? 0,
		project.permissions?.group_access?.access_level ?? 0,
	);
	return {
		owner: split.owner,
		name: split.name,
		fullName: path,
		private: project.visibility !== 'public',
		archived: project.archived === true,
		pushedAt: project.last_activity_at,
		canComment: access >= DEVELOPER,
	};
}

/** A merge request from another project. Unknown counts as one, for the same reason as on
 *  GitHub (`githubFromFork`). */
export function gitlabFromFork(mr: Pick<GitlabMergeRequest, 'source_project_id' | 'target_project_id'>): boolean {
	return mr.source_project_id === undefined || mr.source_project_id !== mr.target_project_id;
}

function toPullRequest(mr: GitlabMergeRequest): PullRequestRef {
	return {
		number: mr.iid,
		title: mr.title ?? '',
		headSha: mr.sha ?? '',
		baseRef: mr.target_branch ?? '',
		draft: isDraft(mr),
		authorLogin: mr.author?.username ?? '',
		authorIsBot: isBotAuthor(mr.author),
		authorId: mr.author?.id,
		fromFork: gitlabFromFork(mr),
		updatedAt: mr.updated_at ?? '',
		htmlUrl: mr.web_url ?? '',
	};
}

function toComment(note: GitlabNote, owner: string, name: string, number: number): IssueComment {
	return {
		id: note.id,
		body: note.body ?? '',
		authorLogin: note.author?.username ?? '',
		authorIsBot: isBotAuthor(note.author),
		authorId: note.author?.id,
		createdAt: note.created_at ?? '',
		updatedAt: note.updated_at ?? note.created_at ?? '',
		// GitLab does not return a per-note URL; it is addressable by anchor, so build it.
		htmlUrl: `${owner}/${name}/-/merge_requests/${number}#note_${note.id}`,
	};
}

async function toError(response: Response, what: string): Promise<ForgeError> {
	let detail = '';
	try {
		const body = (await response.json()) as { message?: unknown; error?: unknown };
		const raw = body.message ?? body.error;
		detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
	} catch {
		// A non-JSON body (an HTML login page from a proxy, say) tells us nothing useful.
	}
	if (response.status === 401) {
		return new ForgeError(`GitLab rejected the token while reading ${what}. It may be expired or revoked.`, 401, false);
	}
	if (response.status === 403) {
		return new ForgeError(`The token is not allowed to read ${what}. It needs the \`api\` scope.`, 403, false);
	}
	if (response.status === 404) {
		return new ForgeError(`Could not find ${what}. A private project also reads as missing to a token that cannot see it.`, 404, false);
	}
	if (response.status === 429) {
		return new ForgeError(`GitLab is rate limiting this token. ${detail}`.trim(), 429, true);
	}
	return new ForgeError(
		`GitLab returned ${response.status} for ${what}.${detail ? ` ${detail}` : ''}`,
		response.status,
		response.status >= 500,
	);
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return 'gitlab';
	}
}

/** One push to a merge request, as `GET …/merge_requests/:iid/versions` lists it. */
export interface GitlabVersion {
	head_commit_sha?: string;
	created_at?: string;
}

export interface GitlabChange {
	old_path?: string;
	new_path?: string;
	new_file?: boolean;
	deleted_file?: boolean;
	renamed_file?: boolean;
	diff?: string;
}

interface GitlabProject {
	path_with_namespace?: string;
	visibility?: string;
	archived?: boolean;
	last_activity_at?: string;
	permissions?: {
		project_access?: { access_level?: number } | null;
		group_access?: { access_level?: number } | null;
	};
}

export interface GitlabMergeRequest {
	iid: number;
	title?: string;
	sha?: string;
	target_branch?: string;
	draft?: boolean;
	work_in_progress?: boolean;
	updated_at?: string;
	web_url?: string;
	author?: { id?: number; username?: string; bot?: boolean };
	source_project_id?: number;
	target_project_id?: number;
}

interface GitlabNote {
	id: number;
	body?: string;
	system?: boolean;
	created_at?: string;
	updated_at?: string;
	author?: { id?: number; username?: string; bot?: boolean };
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { netFetch, isNetworkError, networkBlockedMessage, networkErrorDetail, type NetFetchInit } from '../netFetch';
import { cacheable, type ConditionalCache } from './httpCache';
import {
	checkedRepoPath,
	ForgeError,
	STATUS_CONTEXT,
	associationCanWrite,
	githubFromFork,
	githubWriteRole,
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
 *  The GitHub half of the desktop reviewer: the only file here that touches the network.
 *
 *  Everything it does is done AS THE USER, with a token of theirs that never leaves this
 *  machine. There is no app of ours in the middle, which is the entire point of reviewing on the
 *  desktop: a database behind a VPN gets reviewed by the app that already has the tunnel, and
 *  GitHub only ever sees a comment posted by the user's own account.
 *
 *  Calls go through `netFetch` (Chromium's stack) rather than Node's `fetch`, so a corporate
 *  proxy with TLS inspection works — the same reason sign-in does. See `netFetch.ts`.
 *--------------------------------------------------------------------------------------------*/

const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

/**
 * No call to GitHub may hang forever.
 *
 * Without this, a connection that stalls rather than refuses — a proxy that swallows the request,
 * a VPN dropping mid-flight — never settles, and every caller inherits that. The settings pane
 * shows "Loading…" for the rest of the session, and worse, the POLLER leaves its `running` flag
 * set and quietly stops reviewing anything ever again. A request that cannot finish has to become
 * an error somebody can read.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** The reviewer's reactions, in GitHub's own names. */
const REACTION: Record<ForgeReaction, string> = { seen: 'eyes', good: '+1' };

/**
 * Where the API lives. GitHub, except under the e2e harness.
 *
 * `snoutbot.spec.ts` stands up a fake GitHub on 127.0.0.1 and drives the whole mode-D loop
 * through it — token check, poll, diff, review, post — so the parts of this feature that CAN be
 * tested without somebody's real repository are. It is read once, and ONLY when
 * `SNOUT_E2E_USERDATA` already pointed the whole profile at a scratch directory, which is the
 * same gate the scheduler's e2e knobs use, and never in a packaged build: nothing in a normal run
 * can be pointed anywhere but GitHub.
 *
 * It does not make the hand test unnecessary. A fake server proves the app's half; only a real
 * repository proves GitHub's shapes are what we think they are.
 */
const API = (!app.isPackaged && process.env.SNOUT_E2E_USERDATA && process.env.SNOUT_E2E_GITHUB_API) || 'https://api.github.com';

/** The same base, for the App auth that lives beside this file. Exported so the fake GitHub the
 *  e2e stands up serves BOTH halves rather than only the ordinary one. */
export const GITHUB_API = API;

/** Kept as a name for the shared error: this file used to own it, and callers import it. */
export { ForgeError as GithubError } from './forge';

async function toError(response: Response, what: string): Promise<ForgeError> {
	let detail = '';
	try {
		const body = (await response.json()) as { message?: string };
		detail = typeof body?.message === 'string' ? body.message : '';
	} catch {
		// Not JSON. The status alone will have to do.
	}
	const rateLimited =
		response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
	if (rateLimited) {
		const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000;
		const minutes = reset > 0 ? Math.max(1, Math.round((reset - Date.now()) / 60_000)) : undefined;
		return new ForgeError(
			`GitHub rate limit reached${minutes ? `; it resets in about ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}.`,
			response.status,
			true,
		);
	}
	if (response.status === 401) {
		return new ForgeError('GitHub rejected the token. It may have expired or been revoked.', 401, false);
	}
	if (response.status === 404) {
		return new ForgeError(
			`${what} was not found. For a private repository the token also needs access to it, not just the right scopes.`,
			404,
			false,
		);
	}
	return new ForgeError(
		`GitHub returned ${response.status} for ${what}${detail ? `: ${detail}` : ''}`,
		response.status,
		response.status >= 500 || response.status === 429,
	);
}

export class GithubClient implements Forge {
	readonly kind: ForgeKind = 'github';

	/**
	 * A token, or something that produces one.
	 *
	 * The whole difference between posting as a person and posting as `snoutbot[bot]` lives in
	 * this parameter. A personal token is a string that never changes; an App's installation
	 * token is minted and expires hourly, so it has to be asked for per request rather than held.
	 * Nothing else in this file knows which it got, which is why both modes are the same client
	 * and not two.
	 */
	constructor(
		private readonly auth: string | (() => Promise<string>),
		private readonly app = false,
		/**
		 * Shared ETags, so a poll over a quiet repository costs nothing (`httpCache.ts`).
		 *
		 * Passed in rather than owned: a fresh client is built for every repository on every pass,
		 * so a cache on the instance would be thrown away before it was ever consulted. It lives
		 * on `reviewService` for the life of the app.
		 */
		private readonly cache?: ConditionalCache,
	) {}

	private async headers(accept = ACCEPT): Promise<Record<string, string>> {
		return {
			Authorization: `Bearer ${typeof this.auth === 'string' ? this.auth : await this.auth()}`,
			Accept: accept,
			'X-GitHub-Api-Version': API_VERSION,
			// GitHub asks for a User-Agent and rejects requests without one.
			'User-Agent': 'SnoutData',
		};
	}

	private async request(path: string, init: RequestInit = {}, accept?: string, etag?: string): Promise<Response> {
		const url = path.startsWith('http') ? path : `${API}${path}`;
		try {
			const headers = await this.headers(accept);
			if (etag) {
				headers['If-None-Match'] = etag;
			}
			const request: NetFetchInit = {
				// `netFetch` is Chromium's stack, which brings Chromium's HTTP cache with it, and
				// GitHub answers with `Cache-Control: private, max-age=60`. Left alone, a poll on a
				// 60s interval can be served a PULL REQUEST LIST out of that cache without asking
				// GitHub at all, so a pull request opened a moment ago is invisible until the entry
				// goes stale. `no-cache` keeps the cache but forces revalidation: the request always
				// goes out, and an unchanged answer still comes back as a cheap 304.
				cache: 'no-cache',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				...init,
				headers: { ...headers, ...(init.headers ?? {}) },
			};
			return await netFetch(url, request);
		} catch (err) {
			// A timeout is retryable and, unlike a refusal, says nothing about the network being
			// blocked — so it gets its own sentence rather than the proxy/firewall one below.
			if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
				throw new ForgeError(
					`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. It may be slow, or your network may be holding the request.`,
					0,
					true,
				);
			}
			if (isNetworkError(err)) {
				throw new ForgeError(
					`${networkBlockedMessage('GitHub', err)} ${networkErrorDetail(err, 'api.github.com')}`,
					0,
					true,
				);
			}
			throw err;
		}
	}

	/**
	 * A JSON call, asked conditionally when we have asked it before.
	 *
	 * The 304 branch comes BEFORE the `!response.ok` one, and has to: 304 is not in the 2xx range,
	 * so treating it as a failure would turn the entire optimization into "GitHub returned 304"
	 * errors. It is not an error, it is the server agreeing with the copy we already hold.
	 */
	private async json<T>(path: string, what: string, init?: RequestInit): Promise<T> {
		const url = path.startsWith('http') ? path : `${API}${path}`;
		const cached = this.cache && cacheable(init?.method) ? this.cache.peek(url) : undefined;
		const response = await this.request(path, init, undefined, cached?.etag);
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

	/** Who the token belongs to. The first thing the settings pane calls, to prove it works. */
	async viewer(): Promise<ForgeUser> {
		// An App has no `/user`: it is not a person, and the whole reason somebody chose it is
		// that its comments are authored by `<slug>[bot]` instead of by them. `/app` is the
		// equivalent question, and the login it yields is what the poller compares against so the
		// reviewer never answers its own comment.
		if (this.app) {
			const info = await this.json<{ slug?: string; name?: string }>('/app', 'this GitHub App');
			const slug = info.slug ?? 'app';
			return { login: `${slug}[bot]`, name: info.name ?? slug, scopes: [] };
		}
		const response = await this.request('/user');
		if (!response.ok) {
			throw await toError(response, 'your GitHub account');
		}
		const body = (await response.json()) as { login: string; name?: string };
		const scopes = (response.headers.get('x-oauth-scopes') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s !== '');
		return { login: body.login, name: body.name ?? undefined, scopes };
	}

	/**
	 * Every repository this token can reach, most recently pushed first.
	 *
	 * This IS the token's permission list, which is the point: a fine-grained token scoped to two
	 * repositories returns exactly those two, and a classic `repo` token returns everything the
	 * account can see. Asking the user to type `owner/name` made them the index of their own
	 * access — and a typo produced a repository that simply never found anything.
	 *
	 * Paged, because 100 is the API's maximum page and plenty of people are over it. Capped, so a
	 * settings pane can never sit through forty round-trips for an account in a large org; the
	 * caller says so in the UI and manual entry stays as the way to reach anything past the cap.
	 */
	async repositories(maxPages = 5): Promise<ForgeRepoRef[]> {
		const out: ForgeRepoRef[] = [];
		for (let page = 1; page <= maxPages; page++) {
			// An App sees what it was INSTALLED on, which is a different question from what a
			// person can reach and a different endpoint. It is also the better list: the user
			// chose those repositories when they installed it.
			const body = this.app
				? (await this.json<{ repositories?: GithubRepo[] }>(
					`/installation/repositories?per_page=100&page=${page}`,
					'the repositories Snoutbot is installed on',
				)).repositories ?? []
				: await this.json<GithubRepo[]>(
					`/user/repos?per_page=100&page=${page}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`,
					'your repositories',
				);
			out.push(...body.map((raw) => toRepoRef(raw, this.app)));
			if (body.length < 100) {
				break;
			}
		}
		return out;
	}

	/** Open pull requests, most recently updated first. */
	async openPullRequests(owner: string, repo: string, limit = 30): Promise<PullRequestRef[]> {
		const body = await this.json<GithubPull[]>(
			`/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(100, limit)}`,
			`pull requests for ${owner}/${repo}`,
		);
		return body.map(toPullRequest);
	}

	async pullRequest(owner: string, repo: string, number: number): Promise<PullRequestRef> {
		return toPullRequest(
			await this.json<GithubPull>(`/repos/${owner}/${repo}/pulls/${number}`, `pull request #${number}`),
		);
	}

	/**
	 * The pull request's diff.
	 *
	 * Requested as `application/vnd.github.diff` so GitHub renders it for us rather than us
	 * reassembling one from the files API. GitHub caps this at 300 files and truncates beyond
	 * it; the reviewer reads what it is given and the report's gap list carries the rest.
	 */
	async pullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
		const response = await this.request(
			`/repos/${owner}/${repo}/pulls/${number}`,
			{},
			'application/vnd.github.diff',
		);
		if (!response.ok) {
			throw await toError(response, `the diff for #${number}`);
		}
		return await response.text();
	}

	/** A file's full content at a commit. Used so a statement spanning unchanged context is
	 *  reviewed whole rather than clipped to the added lines. */
	async fileContent(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
		const safe = checkedRepoPath(path);
		const response = await this.request(
			`/repos/${owner}/${repo}/contents/${safe.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
			{},
			'application/vnd.github.raw',
		);
		if (response.status === 404) {
			return undefined; // deleted, or too large for the contents API
		}
		if (!response.ok) {
			throw await toError(response, `\`${path}\``);
		}
		return await response.text();
	}

	/** Comments on a pull request's conversation, oldest first. */
	async comments(owner: string, repo: string, number: number, since?: string): Promise<IssueComment[]> {
		const query = since ? `?since=${encodeURIComponent(since)}&per_page=100` : '?per_page=100';
		const body = await this.json<GithubComment[]>(
			`/repos/${owner}/${repo}/issues/${number}/comments${query}`,
			`comments on #${number}`,
		);
		return body.map(toComment);
	}

	async createComment(owner: string, repo: string, number: number, body: string): Promise<IssueComment> {
		return toComment(
			await this.json<GithubComment>(`/repos/${owner}/${repo}/issues/${number}/comments`, `a comment on #${number}`, {
				method: 'POST',
				body: JSON.stringify({ body }),
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	}

	/** Edit a comment in place. One comment per pull request is the rule; this is how it is kept.
	 *  `number` is unused here — GitHub addresses a comment by id alone — and present because
	 *  GitLab cannot, and the seam has to fit the stricter of the two (`forge.ts`). */
	async updateComment(owner: string, repo: string, _number: number, commentId: number, body: string): Promise<IssueComment> {
		return toComment(
			await this.json<GithubComment>(`/repos/${owner}/${repo}/issues/comments/${commentId}`, 'the review comment', {
				method: 'PATCH',
				body: JSON.stringify({ body }),
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	}

	/**
	 * Leave a reaction on a comment — 👀 the moment a request is accepted.
	 *
	 * Failures here are swallowed by the caller on purpose: an acknowledgement that could not
	 * be left is not a reason to abandon a review somebody asked for.
	 */
	async react(owner: string, repo: string, _number: number, commentId: number, reaction: ForgeReaction): Promise<void> {
		const response = await this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
			method: 'POST',
			body: JSON.stringify({ content: REACTION[reaction] }),
			headers: { 'Content-Type': 'application/json' },
		});
		// 200 = already reacted, 201 = created. Anything else is not worth failing a review over.
		if (!response.ok && response.status !== 200 && response.status !== 201) {
			throw await toError(response, 'a reaction');
		}
	}

	/**
	 * The reviewer's line beside CI, as a COMMIT STATUS.
	 *
	 * Not a check run: those are creatable only by a GitHub App, and Snoutbot is the user's own
	 * token on the user's own machine. A status posted under the same `context` replaces the
	 * previous one, which is what turns "pending" into the result rather than a second row.
	 */
	async setStatus(owner: string, repo: string, sha: string, status: CommitStatus): Promise<void> {
		const response = await this.request(`/repos/${owner}/${repo}/statuses/${sha}`, {
			method: 'POST',
			body: JSON.stringify({
				// GitHub has no neutral. Saying `success` with a description that tells the truth
				// beats a red cross for a review that found nothing to fail on.
				state: status.state === 'neutral' ? 'success' : status.state,
				context: STATUS_CONTEXT,
				description: status.description.slice(0, 140),
				target_url: status.targetUrl,
			}),
			headers: { 'Content-Type': 'application/json' },
		});
		if (!response.ok) {
			throw await toError(response, 'a commit status');
		}
	}

	/**
	 * Whether `author` can write to the repository.
	 *
	 * Asked of the collaborator-permission API, whose `role_name` distinguishes `maintain` and
	 * `triage` (the older `permission` field folds them into `write` and `read`). When that cannot
	 * be asked (the token lacks the permission, the host is down) only the repository's OWNER
	 * passes on the comment's `author_association`; anyone else is a no.
	 */
	async canWrite(owner: string, repo: string, author: ForgeAuthor): Promise<boolean> {
		if (author.login === '') {
			return false;
		}
		try {
			const response = await this.request(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(author.login)}/permission`);
			if (response.ok) {
				const body = (await response.json()) as { permission?: string; role_name?: string };
				return githubWriteRole(body);
			}
		} catch {
			// Falls through to the association below.
		}
		return associationCanWrite(author.association);
	}

	/** GitHub's REST API records no push time for a pull request's head; see `Forge.headSince`. */
	async headSince(): Promise<string | undefined> {
		return undefined;
	}
}


interface GithubPull {
	number: number;
	title: string;
	draft?: boolean;
	updated_at: string;
	html_url: string;
	/** `repo` is null when the fork it came from has since been deleted. */
	head: { sha: string; repo?: { full_name?: string } | null };
	base: { ref: string; repo?: { full_name?: string } | null };
	user?: { login?: string; type?: string };
	author_association?: string;
}

interface GithubRepo {
	name: string;
	full_name: string;
	private?: boolean;
	archived?: boolean;
	pushed_at?: string;
	owner?: { login?: string };
	permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

interface GithubComment {
	id: number;
	body?: string;
	created_at: string;
	updated_at: string;
	html_url: string;
	user?: { login?: string; type?: string };
	author_association?: string;
}

function toRepoRef(raw: GithubRepo, assume = false): ForgeRepoRef {
	const full = raw.full_name ?? '';
	return {
		owner: raw.owner?.login ?? full.split('/')[0] ?? '',
		name: raw.name ?? full.split('/')[1] ?? '',
		fullName: full,
		private: raw.private === true,
		archived: raw.archived === true,
		pushedAt: raw.pushed_at,
		// `triage` can open an issue but not comment on somebody else's, so it does not count.
		//
		// An installation listing does not always carry a `permissions` block, and its absence
		// there does not mean "read only": it means GitHub did not answer a question about a
		// person, because an App is not one. Being installed at all is the grant, so `assume`
		// says yes for that path rather than marking every repository "cannot comment".
		canComment: raw.permissions === undefined
			? assume
			: Boolean(raw.permissions.push || raw.permissions.maintain || raw.permissions.admin),
	};
}

function toPullRequest(raw: GithubPull): PullRequestRef {
	return {
		number: raw.number,
		title: raw.title,
		headSha: raw.head.sha,
		baseRef: raw.base.ref,
		draft: raw.draft === true,
		authorLogin: raw.user?.login ?? '',
		authorIsBot: raw.user?.type === 'Bot',
		authorAssociation: raw.author_association,
		fromFork: githubFromFork(raw),
		updatedAt: raw.updated_at,
		htmlUrl: raw.html_url,
	};
}


function toComment(raw: GithubComment): IssueComment {
	return {
		id: raw.id,
		body: raw.body ?? '',
		authorLogin: raw.user?.login ?? '',
		authorIsBot: raw.user?.type === 'Bot',
		authorAssociation: raw.author_association,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		htmlUrl: raw.html_url,
	};
}

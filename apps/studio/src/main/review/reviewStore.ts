/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';

import type { ForgeKind } from './forge';
import { DEFAULT_REVIEW_METHOD, reviewMethodFromLegacy, type ReviewMethod } from '../../shared/review';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*---------------------------------------------------------------------------------------------
 *  What the PR reviewer watches, and which database each repository is reviewed against.
 *
 *  The non-secret half lives in `userData/review.json` beside the other stores; the GitHub
 *  token goes to the keychain via `SecretStore` under a reserved connection id, exactly like a
 *  database password. Nothing here reaches the network — see `githubClient.ts` for that and
 *  `reviewRunner.ts` for the orchestration.
 *
 *  The binding is the whole point of the desktop mode: a repository is mapped to a connection
 *  the user has ALREADY configured, so the review runs against a real database over their
 *  existing tunnel, and no credential ever leaves the machine.
 *--------------------------------------------------------------------------------------------*/

/** How a repository's reviews are triggered. Mirrors review-core's `TriggerConfig.auto`. */
export type ReviewAuto = 'sql-only' | 'mention' | 'always';

/** The three-string original, kept only to read a stored value forward. @deprecated */
export type ReviewAiMode = 'off' | 'snoutdata' | 'byok';

/** What a review is allowed to do to the destination it is bound to. */
export type ReviewDepthSetting =
	/** Never touch the database: findings come from the pull request's text alone. */
	| 'static'
	/** Read the schema (already cached by the app) but run no queries against the data. */
	| 'schema'
	/** Also run the read-only probes that turn "consider" into "this will fail". */
	| 'connected';

export interface WatchedRepo {
	/** `owner/name`, lower-cased — the key everywhere. */
	id: string;
	/** Which host this lives on. GitHub unless it says otherwise, so every repository stored
	 *  before GitLab existed keeps working without a migration. */
	forge: ForgeKind;
	/** Everything before the last slash. A GitLab group can be nested (`acme/backend`), which is
	 *  why this is not simply a user or an org. */
	owner: string;
	name: string;
	/** Connection id this repository's SQL is reviewed against. Empty = static only. */
	connectionId?: string;
	/** A name for the destination the comment will quote. Defaults to the connection's name. */
	destinationName?: string;
	auto: ReviewAuto;
	depth: ReviewDepthSetting;
	/**
	 * Post the comment only after the user has read it in the app.
	 *
	 * Default OFF: a reviewer that posts is what a reviewer is, and every product in this
	 * category (CodeRabbit and the rest) comments on the pull request without being asked twice.
	 * It was default ON, which meant the out-of-the-box experience was a bot that reviewed
	 * silently and waited in a window nobody had open.
	 *
	 * The exception is a PRODUCTION connection, where binding it turns this back on once
	 * (`ReviewService.updateRepo`): pointing the reviewer at production is a deliberate act, and
	 * reading the first review before it goes out under your own name is worth one click.
	 * A stored `true` is always honoured, so nobody's existing choice moves on an upgrade.
	 */
	approveBeforePosting: boolean;
	/**
	 * How this repository is reviewed: one of the four rungs, the same ladder Data Flows offers
	 * for reading a file. See {@link ReviewMethod}, which carries the reasoning.
	 *
	 * The rule set is deterministic on ALL FOUR — this only decides whether an explanation is
	 * written UNDER the findings, by whom, and whose budget pays. Rung 1 is the same review with
	 * nobody writing it up, not a lesser one.
	 */
	method: ReviewMethod;
	/**
	 * Review pull requests from OUTSIDE the repository automatically: a fork, or an author who
	 * cannot write here.
	 *
	 * Default OFF, and per repository. An automatic review runs the change's SQL past the bound
	 * database (deep mode EXPLAINs it there) and posts under the user's name, so on a public
	 * repository the default would let anybody with a GitHub account do both by opening a pull
	 * request. Off, such a change is reviewed only when one of the repository's own people asks.
	 */
	reviewOutsiders: boolean;
	/** Watching is off without this; a repo can be configured and paused. */
	enabled: boolean;
	/** Glob overrides for what counts as reviewable. Empty = review-core's defaults. */
	includePaths?: string[];
	excludePaths?: string[];
	/** Epoch ms of the last poll that completed, so the poller can ask for deltas. */
	lastPolledAt?: number;
	/** Highest `updated_at` seen, as an ISO string — the GitHub-side watermark. */
	cursor?: string;
	/**
	 * Pull request number to the head sha last reviewed automatically.
	 *
	 * Persisted, because the alternative is re-reviewing every open pull request every time
	 * the app starts — which on a busy repository is a wall of edited comments and the fastest
	 * way to have the feature switched off. An explicit `@snoutbot review` ignores this.
	 */
	reviewed?: Record<string, string>;
	/**
	 * Pull request number to its head as the poller last saw it, and the first poll that saw it
	 * there (ISO). On a host that records no push times (GitHub) this is what binds a
	 * `@snoutbot review` to the commit it was written about (`Forge.headSince`). Rewritten on
	 * every poll from the open pull requests it listed, so it never grows past them.
	 */
	heads?: Record<string, { sha: string; since: string }>;
}

export interface ReviewConfig {
	/** Master switch. Off by default: nothing polls anything until the user asks for it. */
	enabled: boolean;
	/**
	 * The login each connected host's token belongs to, for display and for recognising our own
	 * comments. The tokens themselves are in the keychain, one per host.
	 *
	 * `login` (singular) is the pre-GitLab field and is read once on load into `logins.github`,
	 * so an existing install does not have to reconnect.
	 */
	logins?: Partial<Record<ForgeKind, string>>;
	/** @deprecated Read on load, never written. See {@link ReviewConfig.logins}. */
	login?: string;
	/**
	 * Which GitLab. Most companies on GitLab self-host, so this is a setting rather than a
	 * constant — it is the single reason supporting GitLab is worth anything to them.
	 */
	gitlabBaseUrl?: string;
	/**
	 * How the reviewer authenticates to GitHub, which decides WHO the comment is from.
	 *
	 * `token` (the default) is a personal access token, so the comment is authored by the person
	 * it belongs to. `app` is a GitHub App the team created in their own organization, whose
	 * comments are authored by `<slug>[bot]` — the thing every reviewer of this shape does, and
	 * the only way either host allows it. Both are local: an App's private key sits in the
	 * keychain beside the database passwords, and no service of ours holds anything.
	 *
	 * GitHub only. GitLab has no App concept; its equivalent is a project access token, which
	 * already runs as a bot user and is therefore just a token here.
	 */
	githubAuth?: 'token' | 'app';
	/** The App's numeric id, when `githubAuth` is `app`. Its key is in the keychain. */
	githubAppId?: string;
	/** Which installation to review as. Discovered on first use when there is only one. */
	githubInstallationId?: number;
	/** The App's own login (`<slug>[bot]`), kept apart from the personal token's so switching
	 *  between them restores the right one. See {@link ReviewStore.loginFor}. */
	githubAppLogin?: string;
	/** Seconds between polls. Floored at 30 so a mistake cannot hammer the API. */
	pollSeconds: number;
	repos: WatchedRepo[];
}

/** Reserved `SecretStore` connection ids for the host tokens. Not real connections. */
export const GITHUB_TOKEN_SECRET_ID = '__review_github__';
export const GITLAB_TOKEN_SECRET_ID = '__review_gitlab__';
/** And for the GitHub App's private key, which is a credential like any other and goes in the
 *  same encrypted store rather than sitting on disk as a `.pem`. */
export const GITHUB_APP_KEY_SECRET_ID = '__review_github_app__';

/** Where a host's token lives in the keychain. */
export function tokenSecretId(forge: ForgeKind): string {
	return forge === 'gitlab' ? GITLAB_TOKEN_SECRET_ID : GITHUB_TOKEN_SECRET_ID;
}

export const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 30;

function reviewPath(): string {
	return join(app.getPath('userData'), 'review.json');
}

function pickLogin(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

export function repoId(owner: string, name: string): string {
	return `${owner.trim()}/${name.trim()}`.toLowerCase();
}

/** Accepts `owner/name`, a full GitHub URL, or a `git@` remote. Returns undefined if it is none. */
/**
 * Anything that names a repository, into the `owner` + `name` pair the store keys on.
 *
 * Accepts `owner/name`, a nested GitLab path (`acme/backend/api`), a browser URL from any host
 * (self-hosted GitLab included, which is why the host is not matched), and an SSH or HTTPS git
 * remote. `owner` is everything before the LAST slash, because a GitLab group can be nested and
 * a project cannot.
 */
export function parseRepoRef(input: string): { owner: string; name: string } | undefined {
	let text = input.trim();
	if (text === '') {
		return undefined;
	}
	// `git@host:group/project.git` — the colon is the path separator in an SSH remote.
	const ssh = /^[A-Za-z0-9_.-]+@[^:]+:(.+)$/.exec(text);
	if (ssh) {
		text = ssh[1];
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		try {
			text = new URL(text).pathname;
		} catch {
			return undefined;
		}
	} else if (/^[^/\s]+\.[^/\s]+\//.test(text)) {
		// A URL with the scheme left off, e.g. `gitlab.acme.com/team/api`. The first segment is a
		// host and not an owner: it has a dot and something follows it.
		text = text.slice(text.indexOf('/'));
	}

	// GitLab hangs its own pages off `/-/` (`/group/project/-/merge_requests/7`); GitHub uses a
	// path segment (`/owner/repo/pull/7`). Either way the repository is what comes before.
	text = text.replace(/\/-\/.*$/, '');
	text = text.replace(/\/(pull|pulls|tree|blob|commit|issues|merge_requests)(\/.*)?$/i, '');
	text = text.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');

	const parts = text.split('/').filter((part) => part !== '');
	if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
		return undefined;
	}
	return { owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
}

function normaliseRepo(raw: Partial<WatchedRepo>): WatchedRepo | undefined {
	if (typeof raw.owner !== 'string' || typeof raw.name !== 'string' || raw.owner === '' || raw.name === '') {
		return undefined;
	}
	return {
		id: repoId(raw.owner, raw.name),
		forge: raw.forge === 'gitlab' ? 'gitlab' : 'github',
		owner: raw.owner,
		name: raw.name,
		connectionId: typeof raw.connectionId === 'string' && raw.connectionId !== '' ? raw.connectionId : undefined,
		destinationName: typeof raw.destinationName === 'string' ? raw.destinationName : undefined,
		auto: raw.auto === 'mention' || raw.auto === 'always' ? raw.auto : 'sql-only',
		depth: raw.depth === 'static' || raw.depth === 'schema' ? raw.depth : 'connected',
		approveBeforePosting: raw.approveBeforePosting === true,
		// The rules alone are the default and STAY the default on an upgrade: a model was never
		// going to start spending somebody's AI allowance because they updated the app. A profile
		// written before the four rungs existed carries the old three-string `aiMode` and is read
		// forward here, which is the only place that string is still understood.
		method: readMethod(raw),
		reviewOutsiders: raw.reviewOutsiders === true,
		enabled: raw.enabled !== false,
		includePaths: Array.isArray(raw.includePaths) ? raw.includePaths.filter((p) => typeof p === 'string') : undefined,
		excludePaths: Array.isArray(raw.excludePaths) ? raw.excludePaths.filter((p) => typeof p === 'string') : undefined,
		lastPolledAt: typeof raw.lastPolledAt === 'number' ? raw.lastPolledAt : undefined,
		cursor: typeof raw.cursor === 'string' ? raw.cursor : undefined,
		reviewed: raw.reviewed && typeof raw.reviewed === 'object' ? { ...raw.reviewed } : undefined,
		heads: readHeads(raw.heads),
	};
}

export class ReviewStore {
	private cache: ReviewConfig | null = null;

	private read(): ReviewConfig {
		if (this.cache) {
			return this.cache;
		}
		let data: Partial<ReviewConfig> = {};
		const path = reviewPath();
		if (existsSync(path)) {
			try {
				const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
				if (raw && typeof raw === 'object') {
					data = raw as Partial<ReviewConfig>;
				}
			} catch {
				// Corrupt file — fall back to defaults rather than blocking startup.
			}
		}
		const config: ReviewConfig = {
			// Off by default. Polling somebody's GitHub account is not something to opt out of.
			enabled: data.enabled === true,
			// The pre-GitLab `login` is folded into `logins.github` on load, so an install made
			// before there were two hosts does not have to reconnect.
			logins: {
				github: pickLogin(data.logins?.github ?? data.login),
				gitlab: pickLogin(data.logins?.gitlab),
			},
			gitlabBaseUrl: typeof data.gitlabBaseUrl === 'string' && data.gitlabBaseUrl.trim() !== ''
				? data.gitlabBaseUrl.trim()
				: undefined,
			githubAuth: data.githubAuth === 'app' ? 'app' : 'token',
			githubAppId: typeof data.githubAppId === 'string' && data.githubAppId.trim() !== '' ? data.githubAppId.trim() : undefined,
			githubInstallationId: typeof data.githubInstallationId === 'number' ? data.githubInstallationId : undefined,
			githubAppLogin: pickLogin(data.githubAppLogin),
			pollSeconds: Math.max(MIN_POLL_SECONDS, typeof data.pollSeconds === 'number' ? data.pollSeconds : DEFAULT_POLL_SECONDS),
			repos: Array.isArray(data.repos)
				? data.repos.map((r) => normaliseRepo(r as Partial<WatchedRepo>)).filter((r): r is WatchedRepo => !!r)
				: [],
		};
		this.cache = config;
		return config;
	}

	private write(config: ReviewConfig): void {
		this.cache = config;
		const path = reviewPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
	}

	config(): ReviewConfig {
		const config = this.read();
		return { ...config, repos: config.repos.map((r) => ({ ...r })) };
	}

	isEnabled(): boolean {
		return this.read().enabled;
	}

	setEnabled(enabled: boolean): void {
		this.write({ ...this.read(), enabled });
	}

	/** The account a host's token belongs to, or undefined when it is not connected. */
	/**
	 * Whose name the comments carry, for THIS host as it is currently configured.
	 *
	 * Two identities can be set up at once on GitHub — a personal token and an App — and the
	 * answer is whichever is in use. They are stored separately rather than one overwriting the
	 * other, because this is not only what the pane displays: it is what the poller compares a
	 * comment's author against so the reviewer never answers itself. A stale login there means
	 * a bot reviewing its own review.
	 */
	loginFor(forge: ForgeKind): string | undefined {
		const config = this.read();
		if (forge === 'github' && config.githubAuth === 'app') {
			return config.githubAppLogin;
		}
		return config.logins?.[forge];
	}

	setLogin(forge: ForgeKind, login: string | undefined): void {
		const config = this.read();
		// The App's identity is kept apart from the person's, so switching between them restores
		// the right one instead of leaving the last one that happened to be verified.
		if (forge === 'github' && config.githubAuth === 'app') {
			this.write({ ...config, githubAppLogin: login });
			return;
		}
		this.write({ ...config, logins: { ...config.logins, [forge]: login } });
	}

	/** Which GitLab, for a self-hosted instance. Undefined means gitlab.com. */
	gitlabBaseUrl(): string | undefined {
		return this.read().gitlabBaseUrl;
	}

	setGitlabBaseUrl(url: string | undefined): void {
		const trimmed = url?.trim();
		this.write({ ...this.read(), gitlabBaseUrl: trimmed === '' ? undefined : trimmed });
	}

	/** Whether GitHub is spoken to as a person or as an App. Defaults to the person, which is
	 *  the one that needs no setup. */
	githubAuth(): 'token' | 'app' {
		return this.read().githubAuth === 'app' ? 'app' : 'token';
	}

	/** The App's id and chosen installation. The key itself is never here; see the keychain. */
	githubApp(): { appId?: string; installationId?: number } {
		const config = this.read();
		return { appId: config.githubAppId, installationId: config.githubInstallationId };
	}

	setGithubApp(patch: { auth?: 'token' | 'app'; appId?: string; installationId?: number }): void {
		const config = this.read();
		this.write({
			...config,
			githubAuth: patch.auth ?? config.githubAuth,
			githubAppId: patch.appId === undefined ? config.githubAppId : (patch.appId.trim() || undefined),
			// `installationId` is cleared by passing 0, since undefined means "leave it alone" and
			// changing the App has to forget the installation that belonged to the old one.
			githubInstallationId: patch.installationId === undefined
				? config.githubInstallationId
				: (patch.installationId === 0 ? undefined : patch.installationId),
		});
	}

	setPollSeconds(seconds: number): void {
		this.write({ ...this.read(), pollSeconds: Math.max(MIN_POLL_SECONDS, Math.round(seconds)) });
	}

	repos(): WatchedRepo[] {
		return this.read().repos.map((r) => ({ ...r }));
	}

	/** Repos that are enabled AND, when the master switch is off, none of them. */
	activeRepos(): WatchedRepo[] {
		const config = this.read();
		return config.enabled ? config.repos.filter((r) => r.enabled).map((r) => ({ ...r })) : [];
	}

	repo(id: string): WatchedRepo | undefined {
		const found = this.read().repos.find((r) => r.id === id.toLowerCase());
		return found ? { ...found } : undefined;
	}

	/** Add or replace a watched repository. Returns the stored form. */
	upsertRepo(patch: Partial<WatchedRepo> & { owner: string; name: string }): WatchedRepo {
		const config = this.read();
		const id = repoId(patch.owner, patch.name);
		const existing = config.repos.find((r) => r.id === id);
		const merged = normaliseRepo({ ...existing, ...patch });
		if (!merged) {
			throw new Error('a watched repository needs an owner and a name');
		}
		const repos = config.repos.filter((r) => r.id !== id);
		repos.push(merged);
		repos.sort((a, b) => a.id.localeCompare(b.id));
		this.write({ ...config, repos });
		return { ...merged };
	}

	removeRepo(id: string): void {
		const config = this.read();
		this.write({ ...config, repos: config.repos.filter((r) => r.id !== id.toLowerCase()) });
	}

	/** Record where a poll got to. Kept separate from `upsertRepo` so a poll never rewrites
	 *  settings the user changed while it was in flight. */
	recordPoll(id: string, at: number, cursor?: string, heads?: WatchedRepo['heads']): void {
		const config = this.read();
		const repos = config.repos.map((r) => (r.id === id.toLowerCase() ? { ...r, lastPolledAt: at, cursor: cursor ?? r.cursor, heads: heads ?? r.heads } : r));
		this.write({ ...config, repos });
	}

	/** Remember that a pull request was reviewed at this commit, so a poll does not do it again.
	 *  Capped, oldest dropped: this is a de-duplication aid, not a history. */
	recordReviewed(id: string, prNumber: number, headSha: string): void {
		const config = this.read();
		const repos = config.repos.map((r) => {
			if (r.id !== id.toLowerCase()) {
				return r;
			}
			const reviewed = { ...(r.reviewed ?? {}), [String(prNumber)]: headSha };
			const keys = Object.keys(reviewed);
			if (keys.length > 200) {
				for (const key of keys.slice(0, keys.length - 200)) {
					delete reviewed[key];
				}
			}
			return { ...r, reviewed };
		});
		this.write({ ...config, repos });
	}

	/** True when this exact commit of this pull request has already been reviewed. */
	alreadyReviewed(id: string, prNumber: number, headSha: string): boolean {
		return this.repo(id)?.reviewed?.[String(prNumber)] === headSha;
	}

	/** Every connection id a watched repository is bound to — used to warn before a delete. */
	boundConnectionIds(): string[] {
		return [...new Set(this.read().repos.map((r) => r.connectionId).filter((id): id is string => !!id))];
	}

	/** Forget a connection that has been deleted, leaving the repo watched but static-only. */
	unbindConnection(connectionId: string): void {
		const config = this.read();
		const repos = config.repos.map((r) => (r.connectionId === connectionId ? { ...r, connectionId: undefined } : r));
		this.write({ ...config, repos });
	}
}

/**
 * A stored review method, or the old three-string `aiMode` read forward.
 *
 * Validated rather than trusted: this is a JSON file a user can edit, and an unknown `kind` must
 * become the rules rather than an object the runner then branches on. The byok arm keeps only what
 * a spec is allowed to hold - a provider, a model and a host - and never a key, which lives in the
 * keychain exactly as a connection's password does.
 */
function readMethod(raw: Record<string, any>): ReviewMethod {
	const stored = raw.method;
	if (stored && typeof stored === 'object') {
		switch (stored.kind) {
			case 'deterministic':
				return { kind: 'deterministic' };
			case 'localEngine':
				return { kind: 'localEngine' };
			case 'snoutAi':
				return { kind: 'snoutAi', consent: true };
			case 'byok':
				if (stored.provider === 'ollama' || stored.provider === 'openai' || stored.provider === 'anthropic' || stored.provider === 'openrouter') {
					return {
						kind: 'byok',
						provider: stored.provider,
						model: typeof stored.model === 'string' ? stored.model : '',
						host: typeof stored.host === 'string' && stored.host !== '' ? stored.host : undefined,
						consent: true,
					};
				}
				return DEFAULT_REVIEW_METHOD;
			default:
				return DEFAULT_REVIEW_METHOD;
		}
	}
	return reviewMethodFromLegacy(raw.aiMode);
}

/** The stored head sightings, keeping only well-formed entries: a user can edit this file. */
function readHeads(raw: unknown): WatchedRepo['heads'] {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const heads: NonNullable<WatchedRepo['heads']> = {};
	for (const [number, entry] of Object.entries(raw as Record<string, unknown>)) {
		const { sha, since } = (entry ?? {}) as { sha?: unknown; since?: unknown };
		if (typeof sha === 'string' && typeof since === 'string') {
			heads[number] = { sha, since };
		}
	}
	return heads;
}

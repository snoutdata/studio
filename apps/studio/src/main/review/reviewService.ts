/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionManager } from '../connectionManager';
import { readConnections } from '../configStore';
import type { SecretStore } from '../secretStore';
import type { CommitStatus, Forge, ForgeKind } from './forge';
import { GithubClient, GITHUB_API } from './githubClient';
import { ConditionalCache } from './httpCache';
import { GithubAppAuth, defaultInstallation, looksLikePrivateKey } from './githubApp';
import { GitlabClient, GITLAB_DEFAULT_URL } from './gitlabClient';
import { ReviewPoller } from './reviewPoller';
import { ReviewRunner } from './reviewRunner';
import type { ReviewOutcome } from './reviewRunner';
import { MAX_RUNS, ReviewRunStore } from './reviewRunStore';
import { ReviewStore, GITHUB_APP_KEY_SECRET_ID, parseRepoRef, repoId, tokenSecretId } from './reviewStore';
import type { WatchedRepo } from './reviewStore';
import { REVIEW_FORGES } from '../../shared/review';
import type { ReviewAppCheck, ReviewAvailableRepo, ReviewForgeStatus, ReviewMethod, ReviewPollResult, ReviewRepoInfo, ReviewRepoList, ReviewRun, ReviewStarted, ReviewStatus, ReviewTokenCheck } from '../../shared/review';

/*---------------------------------------------------------------------------------------------
 *  Snoutbot's front door in the main process: one object the IPC handlers talk to.
 *
 *  Everything below this is already built and tested — the store, the GitHub client, the
 *  runner, the poller. This assembles them, owns the small amount of live state the UI needs
 *  (what ran, what is waiting for approval, what went wrong), and keeps `index.ts` to one
 *  block instead of a dozen handlers reaching into four modules.
 *
 *  Nothing here starts on its own. `start()` is called from the app's deferred/idle work, never
 *  on the boot path, and it returns immediately if the user has not turned the feature on.
 *--------------------------------------------------------------------------------------------*/


export interface ReviewServiceDeps {
	connections: ConnectionManager;
	secrets: SecretStore;
	/** The optional prose pass over a finished review. Injected, so
	 *  nothing under `review/` imports the AI service and the rule set stays model-free. */
	commentary?: (prompt: { system: string; user: string }, method: ReviewMethod) => Promise<{ text: string; model: string }>;
	/** True while the user has paused scheduled work from the tray. */
	isPaused?: () => boolean;
	/** Push a status change to the renderer (and the tray). */
	onChanged?: () => void;
	/**
	 * One review finished.
	 *
	 * Separate from `onChanged` on purpose: a status change is a STATE the UI re-reads, and a
	 * finished review is an EVENT that happened once. The notifications centre needs the second
	 * kind — a review that landed while the window was hidden has to leave something behind that
	 * can be found afterwards, and re-deriving "is this one new" from a status snapshot is how a
	 * poll loop ends up announcing the same review every minute.
	 */
	onRun?: (run: ReviewRun) => void;
	/** A review has STARTED. The other half of `onRun`: without it the app is silent for the
	 *  whole time a review takes, which is what made "Check now" look like a dead button. */
	onStarted?: (started: ReviewStarted) => void;
}

export class ReviewService {
	readonly store = new ReviewStore();
	private readonly runner: ReviewRunner;
	private readonly poller: ReviewPoller;
	private readonly runStore = new ReviewRunStore();
	private runsCache: ReviewRun[] | null = null;
	private activity: string | undefined;
	private lastError: string | undefined;
	/** Errors from the manual check in flight, collected so it can report them. */
	private pollErrors: string[] | undefined;
	private scopes: Partial<Record<ForgeKind, string[]>> = {};

	constructor(private readonly deps: ReviewServiceDeps) {
		this.runner = new ReviewRunner({
			store: this.store,
			connections: deps.connections,
			forge: (repo) => this.forgeClient(repo.forge),
			commentary: deps.commentary,
			onOutcome: (outcome) => this.record(outcome),
			onStatus: (status) => {
				this.activity = status;
				this.deps.onChanged?.();
			},
			onStarted: (repo, pr) => this.deps.onStarted?.({
				repoId: repo.id,
				forge: repo.forge,
				repoLabel: `${repo.owner}/${repo.name}`,
				prNumber: pr.number,
				prTitle: pr.title,
				prUrl: pr.htmlUrl,
			}),
		});
		this.poller = new ReviewPoller({
			store: this.store,
			runner: this.runner,
			forge: (repo) => this.forgeClient(repo.forge),
			isPaused: deps.isPaused,
			onError: (repoId, message) => {
				const repo = this.store.repo(repoId);
				this.pollErrors?.push(`${repo ? `${repo.owner}/${repo.name}` : repoId}: ${message}`);
				this.lastError = `${repoId}: ${message}`;
				this.deps.onChanged?.();
			},
			onStatus: (status) => {
				this.activity = status;
				this.deps.onChanged?.();
			},
		});
	}

	/** Begin (or restart) polling. Called from deferred startup work and after any settings
	 *  change. Does nothing while the feature is off. */
	start(): void {
		this.poller.start();
	}

	stop(): void {
		this.poller.stop();
	}

	private async token(forge: ForgeKind): Promise<string | undefined> {
		return this.deps.secrets.get(tokenSecretId(forge), 'githubToken');
	}

	/**
	 * The client for one host, with its token out of the keychain.
	 *
	 * The one place that knows GitHub from GitLab. Everything above it — the poller, the runner,
	 * the whole rule set — sees a `Forge` (see `forge.ts`), which is what makes adding a third
	 * host a new file rather than a sweep.
	 */
	/**
	 * ETags for every GET the reviewer makes, for the life of the app (`httpCache.ts`).
	 *
	 * Here rather than on a client because a fresh client is built for every repository on every
	 * poll pass, so a cache with a client's lifetime would never survive to be consulted. This is
	 * what makes polling a quiet repository free: GitHub does not charge a 304 against the rate
	 * limit, and 1 + N calls a minute per repository otherwise reaches the ceiling on four of them.
	 */
	private readonly http = new ConditionalCache();

	private async forgeClient(forge: ForgeKind): Promise<Forge> {
		// GitHub, as an App. The client is the same one: only where the bearer token comes from
		// changes, which is the whole reason "post as me" and "post as snoutbot[bot]" did not
		// need a second implementation of anything.
		if (forge === 'github' && this.store.githubAuth() === 'app') {
			return new GithubClient(() => this.appToken(), true, this.http);
		}
		const token = await this.token(forge);
		if (!token) {
			throw new Error(
				forge === 'gitlab'
					? 'No GitLab token is stored. Connect GitLab in Settings first.'
					: 'No GitHub token is stored. Connect GitHub in Settings first.',
			);
		}
		return forge === 'gitlab'
			? new GitlabClient(token, this.store.gitlabBaseUrl() ?? GITLAB_DEFAULT_URL, this.http)
			: new GithubClient(token, false, this.http);
	}

	/**
	 * The App's credentials, out of the keychain, as something that mints installation tokens.
	 *
	 * Cached on the instance so the hourly token is reused across polls rather than re-minted per
	 * request, and thrown away whenever the App's settings change (`setGithubApp`) so a new key
	 * or a different installation takes effect immediately rather than in an hour.
	 */
	private appAuth?: GithubAppAuth;

	private async appAuthFor(): Promise<GithubAppAuth> {
		if (this.appAuth) {
			return this.appAuth;
		}
		const { appId, installationId } = this.store.githubApp();
		const privateKeyPem = await this.deps.secrets.get(GITHUB_APP_KEY_SECRET_ID, 'githubAppKey');
		if (!appId || !privateKeyPem) {
			throw new Error("Snoutbot's GitHub App is not set up. Add its App ID and private key in Settings.");
		}
		this.appAuth = new GithubAppAuth({ appId, privateKeyPem }, GITHUB_API, installationId);
		return this.appAuth;
	}

	private async appToken(): Promise<string> {
		return (await this.appAuthFor()).token();
	}

	/**
	 * Store the App and check it works, the way a pasted token is checked before it is stored.
	 *
	 * Verified end to end rather than merely saved: it signs a JWT with the key, asks GitHub who
	 * the App is, and asks where it is installed. Every setup mistake there is — a key that is not
	 * the App's, an id that is not a number, an App created but never INSTALLED — becomes a
	 * sentence at the moment it is made rather than a review that silently never posts.
	 */
	async setGithubApp(appId: string, privateKeyPem: string): Promise<ReviewAppCheck> {
		if (!looksLikePrivateKey(privateKeyPem)) {
			return { ok: false, error: "That does not look like a private key. Choose the .pem GitHub generated for the App." };
		}
		try {
			const auth = new GithubAppAuth({ appId: appId.trim(), privateKeyPem }, GITHUB_API);
			const info = await auth.info();
			const installations = await auth.installations();
			this.deps.secrets.store(GITHUB_APP_KEY_SECRET_ID, 'githubAppKey', privateKeyPem);
			this.store.setGithubApp({
				auth: 'app',
				appId: appId.trim(),
				// 0 clears: a different App's installation id is meaningless.
				installationId: defaultInstallation(installations) ?? 0,
			});
			this.store.setLogin('github', info.login);
			this.appAuth = undefined;
			this.http.clear();
			this.deps.onChanged?.();
			return { ok: true, login: info.login, name: info.name, installations };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Which installation to review as, when the App is installed on more than one account. */
	setGithubInstallation(installationId: number): void {
		this.store.setGithubApp({ installationId });
		this.appAuth = undefined;
		this.http.clear();
		this.deps.onChanged?.();
	}

	/**
	 * Choose how GitHub is spoken to: as the person whose token it is, or as the App.
	 *
	 * Switching is not destructive in either direction. The token stays in the keychain while the
	 * App is in use and the App's key stays while the token is, so trying the bot and going back
	 * costs nothing, and neither does the reverse.
	 */
	async setGithubAuth(auth: 'token' | 'app'): Promise<ReviewStatus> {
		this.store.setGithubApp({ auth });
		this.appAuth = undefined;
		this.http.clear();
		// The login shown, and the one the poller compares against so it never answers itself,
		// belongs to whichever identity is now in use.
		if (auth === 'app') {
			await this.appAuthFor()
				.then(async (a) => this.store.setLogin('github', (await a.info()).login))
				.catch(() => undefined);
		}
		this.deps.onChanged?.();
		return this.status();
	}

	/** Everything the Settings pane renders. */
	async status(): Promise<ReviewStatus> {
		const config = this.store.config();
		const connections = readConnections();
		const repos: ReviewRepoInfo[] = config.repos.map((repo) => {
			const bound = repo.connectionId ? connections.find((c) => c.id === repo.connectionId) : undefined;
			return {
				id: repo.id,
				forge: repo.forge,
				owner: repo.owner,
				name: repo.name,
				connectionId: repo.connectionId,
				connectionLabel: bound?.label,
				connectionIsProd: bound?.environment === 'prod',
				auto: repo.auto,
				depth: repo.depth,
				method: repo.method,
				approveBeforePosting: repo.approveBeforePosting,
				reviewOutsiders: repo.reviewOutsiders,
				enabled: repo.enabled,
				lastPolledAt: repo.lastPolledAt,
			};
		});
		const forges: ReviewForgeStatus[] = await Promise.all(
			REVIEW_FORGES.map(async (kind) => ({
				kind,
				// "Connected" means this host can be spoken to AS CONFIGURED. In App mode a personal
				// token is neither present nor needed, so asking for one would report a working setup
				// as disconnected and hide the whole pane.
				hasToken: kind === 'github' && this.store.githubAuth() === 'app'
					? !!this.store.githubApp().appId && !!(await this.deps.secrets.get(GITHUB_APP_KEY_SECRET_ID, 'githubAppKey'))
					: !!(await this.token(kind)),
				login: this.store.loginFor(kind),
				// GitLab does not report a token's scopes at all, so this is empty there by design.
				scopes: this.scopes[kind] ?? [],
				baseUrl: kind === 'gitlab' ? this.store.gitlabBaseUrl() ?? GITLAB_DEFAULT_URL : undefined,
				auth: kind === 'github' ? this.store.githubAuth() : 'token',
				appId: kind === 'github' ? this.store.githubApp().appId : undefined,
				appInstallationId: kind === 'github' ? this.store.githubApp().installationId : undefined,
			})),
		);
		return {
			enabled: config.enabled,
			forges,
			pollSeconds: config.pollSeconds,
			repos,
			activity: this.activity,
			awaiting: this.runs.filter((run) => run.awaitingApproval).length,
			lastError: this.lastError,
		};
	}

	/**
	 * Store a token after checking it works.
	 *
	 * Checked before it is stored, deliberately: a token that is saved and then silently fails
	 * every poll is the worst version of this feature, and the check costs one request.
	 */
	async setToken(forge: ForgeKind, token: string): Promise<ReviewTokenCheck> {
		const trimmed = token.trim();
		if (trimmed === '') {
			this.deps.secrets.delete(tokenSecretId(forge), 'githubToken');
			this.store.setLogin(forge, undefined);
			this.scopes[forge] = [];
			this.http.clear();
			this.deps.onChanged?.();
			return { ok: false, error: 'No token given.' };
		}
		try {
			// Built directly rather than through `forgeClient`, which reads the stored token — the
			// whole point here is to check the one being pasted BEFORE it is stored.
			const client = forge === 'gitlab'
				? new GitlabClient(trimmed, this.store.gitlabBaseUrl() ?? GITLAB_DEFAULT_URL)
				: new GithubClient(trimmed);
			const viewer = await client.viewer();
			this.deps.secrets.store(tokenSecretId(forge), 'githubToken', trimmed);
			this.store.setLogin(forge, viewer.login);
			this.scopes[forge] = viewer.scopes;
			this.http.clear();
			this.lastError = undefined;
			this.deps.onChanged?.();
			return { ok: true, login: viewer.login, scopes: viewer.scopes };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Which GitLab. Changing it invalidates the stored token, which belonged to the old one. */
	setGitlabBaseUrl(url: string): void {
		this.store.setGitlabBaseUrl(url);
		this.deps.secrets.delete(tokenSecretId('gitlab'), 'githubToken');
		this.store.setLogin('gitlab', undefined);
		this.scopes.gitlab = [];
		this.http.clear();
		this.deps.onChanged?.();
	}

	/** Forget the token. Watched repositories are kept: the user may be swapping accounts. */
	clearToken(forge: ForgeKind): void {
		this.deps.secrets.delete(tokenSecretId(forge), 'githubToken');
		this.store.setLogin(forge, undefined);
		this.scopes[forge] = [];
		this.http.clear();
		// Only stop entirely when nothing is connected any more; the other host keeps working.
		void this.anyToken().then((any) => {
			if (!any) {
				this.stop();
			}
		});
		this.deps.onChanged?.();
	}

	private async anyToken(): Promise<boolean> {
		for (const kind of REVIEW_FORGES) {
			if (await this.token(kind)) {
				return true;
			}
		}
		return false;
	}

	setEnabled(enabled: boolean): void {
		this.store.setEnabled(enabled);
		if (enabled) {
			this.start();
		} else {
			this.stop();
		}
		this.deps.onChanged?.();
	}

	setPollSeconds(seconds: number): void {
		this.store.setPollSeconds(seconds);
		this.start();
		this.deps.onChanged?.();
	}

	/**
	 * The repositories this token can reach.
	 *
	 * Fetched on demand rather than kept in sync: the answer changes when the user changes a
	 * token's scope on GitHub, not when anything here happens, so a cache would mostly be a way
	 * of showing a stale one. Each is marked with whether it is already watched, so the picker
	 * never offers the same repository twice.
	 */
	async listRepositories(): Promise<ReviewRepoList> {
		// Everything is inside the try, the keychain read included. This handler must NEVER reject:
		// the pane awaits it to clear its own "Loading…", and a rejected IPC call left that spinner
		// up for the rest of the session with nothing on screen to say why.
		try {
			const watched = new Set(this.store.config().repos.map((repo) => repo.id));
			const repos: ReviewAvailableRepo[] = [];
			const failures: string[] = [];
			let connected = 0;
			// Both hosts, when both are connected. One being unreachable must not hide the other's
			// list: a team on GitLab that also has a GitHub token should still see both.
			for (const kind of REVIEW_FORGES) {
				if (!(await this.token(kind))) {
					continue;
				}
				connected += 1;
				try {
					const client = await this.forgeClient(kind);
					for (const repo of await client.repositories()) {
						repos.push({
							id: repoId(repo.owner, repo.name),
							forge: kind,
							owner: repo.owner,
							name: repo.name,
							private: repo.private,
							archived: repo.archived,
							canComment: repo.canComment,
							watched: watched.has(repoId(repo.owner, repo.name)),
						});
					}
				} catch (err) {
					failures.push(`${kind}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (connected === 0) {
				return { ok: false, error: 'Connect a GitHub or GitLab account first.' };
			}
			// Every host failed: that is an error, not an empty list, and the two say very
			// different things to somebody looking at this screen.
			if (repos.length === 0 && failures.length > 0) {
				const error = failures.join('; ');
				console.error(`[review] could not list repositories: ${error}`);
				return { ok: false, error };
			}
			return { ok: true, repos };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			console.error(`[review] could not list repositories: ${error}`);
			return { ok: false, error };
		}
	}

	/** Add a repository from anything that names one: `owner/name`, a URL, a git remote. */
	addRepo(ref: string, forge: ForgeKind = 'github'): { ok: true; id: string } | { ok: false; error: string } {
		const parsed = parseRepoRef(ref);
		if (!parsed) {
			return { ok: false, error: 'That is not a repository. Try `owner/name` or the repository URL.' };
		}
		const repo = this.store.upsertRepo({ ...parsed, forge });
		this.deps.onChanged?.();
		return { ok: true, id: repo.id };
	}

	updateRepo(id: string, patch: Partial<WatchedRepo>): void {
		const existing = this.store.repo(id);
		if (!existing) {
			return;
		}
		const next = { ...existing, ...patch, owner: existing.owner, name: existing.name };
		// Binding PRODUCTION turns approval back on, once. Posting is the default everywhere
		// else (that is what a reviewer is), but pointing it at production is a deliberate act
		// and the comment goes out under the user's own name. Only when the binding CHANGES, so
		// turning it off afterwards sticks.
		if (patch.connectionId !== undefined && patch.connectionId !== existing.connectionId && this.isProd(patch.connectionId)) {
			next.approveBeforePosting = true;
		}
		this.store.upsertRepo(next);
		this.deps.onChanged?.();
	}

	/** Is this connection flagged production? Read from the same config the explorer reads. */
	private isProd(connectionId: string): boolean {
		return readConnections().some((c) => c.id === connectionId && c.environment === 'prod');
	}

	removeRepo(id: string): void {
		this.store.removeRepo(id);
		this.deps.onChanged?.();
	}

	/** Poll now rather than waiting for the interval — the "Check now" button. */
	async pollNow(): Promise<ReviewPollResult> {
		const repos = this.store.activeRepos().length;
		if (repos === 0) {
			return { outcome: 'noRepos', repos, reviewed: 0, errors: [], at: Date.now() };
		}
		if (this.poller.isRunning) {
			return { outcome: 'busy', repos, reviewed: 0, errors: [], at: Date.now() };
		}
		this.lastError = undefined;
		this.pollErrors = [];
		try {
			const actions = await this.poller.pollOnce(true);
			return { outcome: 'checked', repos, reviewed: actions.filter((a) => a.ran).length, errors: this.pollErrors, at: Date.now() };
		} finally {
			this.pollErrors = undefined;
			this.deps.onChanged?.();
		}
	}

	/**
	 * Review one pull request on demand, ignoring the already-reviewed record.
	 *
	 * `method` reviews it again with a DIFFERENT rung, for this run only. The findings come out
	 * identical unless the database moved underneath (which is itself worth seeing), so what the
	 * user is really re-running is who writes the explanation.
	 */
	async reviewPull(repoId: string, prNumber: number, deep = false, method?: ReviewMethod): Promise<ReviewRun | undefined> {
		const repo = this.store.repo(repoId);
		if (!repo) {
			return undefined;
		}
		try {
			const pr = await (await this.forgeClient(repo.forge)).pullRequest(repo.owner, repo.name, prNumber);
			await this.runner.run(repo, pr, { name: 'review', deep, raw: '' }, undefined, method);
			this.store.recordReviewed(repo.id, prNumber, pr.headSha);
			return this.runs[0];
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			this.deps.onChanged?.();
			return undefined;
		}
	}

	/**
	 * What the tray draws, read synchronously.
	 *
	 * `status()` is async because it asks the keychain whether a token exists; the tray rebuilds
	 * on every menu open and on a timer, and must never wait on the OS keychain to write one
	 * line. Everything here is already in memory.
	 */
	trayState(): { enabled: boolean; watching: number; activity?: string; awaiting: number } {
		return {
			enabled: this.store.isEnabled(),
			watching: this.store.activeRepos().length,
			activity: this.activity,
			awaiting: this.runs.filter((run) => run.awaitingApproval).length,
		};
	}

	/** Reviews held in memory, newest first. */
	/**
	 * The reviews, newest first, read from disk the first time anything asks.
	 *
	 * Lazy on purpose: the service is constructed on launch and startup is sacred.
	 * Nothing on the boot path asks for reviews, so the file is not touched until the tray counts
	 * what is waiting or the user opens the view.
	 */
	private get runs(): ReviewRun[] {
		if (!this.runsCache) {
			this.runsCache = this.runStore.all();
		}
		return this.runsCache;
	}

	/** Write the history after it changes. Every mutation below calls this; a review the user has
	 *  not read yet must survive a restart, which is the whole point of keeping them. */
	private persist(): void {
		this.runStore.save(this.runs);
	}

	list(): ReviewRun[] {
		return this.runs.map((r) => ({ ...r }));
	}

	/** Post a review the user read and approved. */
	async approve(runId: string): Promise<{ ok: boolean; error?: string }> {
		const run = this.runs.find((r) => r.id === runId);
		const repo = run ? this.store.repo(run.repoId) : undefined;
		if (!run || !repo) {
			return { ok: false, error: 'That review is no longer available.' };
		}
		try {
			// The commit has read `pending` since the review ran, because with approval on nothing
			// had been said yet. Settling it is part of posting, not part of reviewing.
			const result: CommitStatus = run.blockers > 0
				? { state: 'failure', description: findingsLine(run), targetUrl: run.prUrl }
				: { state: 'success', description: findingsLine(run), targetUrl: run.prUrl };
			run.postedCommentId = await this.runner.postApproved(repo, run.prNumber, run.body, run.headSha, result);
			run.awaitingApproval = false;
			this.persist();
			this.deps.onChanged?.();
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Discard a review without posting it. */
	discard(runId: string): void {
		const index = this.runs.findIndex((r) => r.id === runId);
		if (index !== -1) {
			this.runs.splice(index, 1);
			this.persist();
			this.deps.onChanged?.();
		}
	}

	private record(outcome: ReviewOutcome): void {
		const repo = this.store.repo(outcome.repoId);
		const findings = outcome.report.findings;
		const run: ReviewRun = {
			// The rung is part of the identity, so "review this again with something else" leaves
			// BOTH on screen to be compared. An ordinary re-review, which uses the repository's own
			// method, still has the same id as the one before it and still replaces it.
			id: `${outcome.repoId}#${outcome.prNumber}@${outcome.headSha.slice(0, 7)}~${outcome.method.kind}`,
			repoId: outcome.repoId,
			forge: repo?.forge ?? 'github',
			repoLabel: repo ? `${repo.owner}/${repo.name}` : outcome.repoId,
			prNumber: outcome.prNumber,
			prTitle: outcome.prTitle,
			prUrl: outcome.prUrl,
			headSha: outcome.headSha,
			body: outcome.body,
			localErrors: outcome.report.localErrors,
			depth: outcome.report.depth,
			destinationName: outcome.report.destinationName,
			blockers: findings.filter((f) => f.severity === 'blocker').length,
			warnings: findings.filter((f) => f.severity === 'warn').length,
			notes: findings.filter((f) => f.severity === 'note').length,
			postedCommentId: outcome.postedCommentId,
			awaitingApproval: outcome.awaitingApproval,
			method: outcome.method,
			at: outcome.at,
		};
		// One entry per pull request commit: a re-review of the same commit replaces its entry
		// rather than stacking another card the user has to read past.
		const existing = this.runs.findIndex((r) => r.id === run.id);
		if (existing !== -1) {
			this.runs.splice(existing, 1);
		}
		this.runs.unshift(run);
		if (this.runs.length > MAX_RUNS) {
			this.runs.length = MAX_RUNS;
		}
		this.persist();
		this.deps.onRun?.({ ...run });
		this.deps.onChanged?.();
	}
}

/** The findings of a finished run as one line, for a host's check description. Zero counts are
 *  left out rather than said, the same rule the in-app summary follows. */
function findingsLine(run: ReviewRun): string {
	const parts: string[] = [];
	if (run.blockers > 0) {
		parts.push(`${run.blockers} ${run.blockers === 1 ? 'blocker' : 'blockers'}`);
	}
	if (run.warnings > 0) {
		parts.push(`${run.warnings} ${run.warnings === 1 ? 'warning' : 'warnings'}`);
	}
	if (run.notes > 0) {
		parts.push(`${run.notes} ${run.notes === 1 ? 'note' : 'notes'}`);
	}
	return parts.length === 0 ? 'Nothing to flag' : parts.join(', ');
}

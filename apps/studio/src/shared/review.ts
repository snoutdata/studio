/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Contracts for Snoutbot, the pull-request reviewer running on this machine.
// The rule set itself lives in `@snout/review-core`; this is only what crosses the IPC
// boundary to the Settings pane and the review view.

import { isLocalHost } from './engine';
import type { ByokProvider, DataBoundary, FlowReader } from './engine';

/**
 * The hosts the reviewer speaks to.
 *
 * GitLab is not a nicety: plenty of the companies this is for self-host it, and a reviewer that
 * only knows GitHub is one they cannot install at all. The seam is `main/review/forge.ts`; adding
 * a third host is a new client, not a sweep.
 */
export type ReviewForge = 'github' | 'gitlab';

export const REVIEW_FORGES: ReviewForge[] = ['github', 'gitlab'];

/** What each host calls itself, and what it calls a change. */
export const FORGE_LABELS: Record<ReviewForge, { name: string; pullRequest: string; icon: string }> = {
	github: { name: 'GitHub', pullRequest: 'pull request', icon: 'github' },
	gitlab: { name: 'GitLab', pullRequest: 'merge request', icon: 'git-merge' },
};

/** How a repository's reviews are triggered. Mirrors review-core's `TriggerConfig.auto`. */
export type ReviewAuto = 'sql-only' | 'mention' | 'always';

/** How much of the bound database a review may use. */
export type ReviewDepthSetting = 'static' | 'schema' | 'connected';

/**
 * Who, if anyone, writes the prose half of a review. The THREE-STRING original, kept only so a
 * stored value can be read forward — see {@link reviewMethodFromLegacy}. Nothing new should use it.
 *
 * @deprecated Superseded by {@link ReviewMethod}, which has the local rungs this never had.
 */
export type ReviewAiMode = 'off' | 'snoutdata' | 'byok';

/**
 * HOW a repository is reviewed: the same four rungs, in the same escalation order, that Data Flows
 * offers for reading a file.
 *
 * It is deliberately the SAME TYPE rather than a parallel one. Both screens are asking the user the
 * one question that matters before a model is involved — does my data leave this computer — and the
 * moment there are two unions there are two answers to it that can drift apart. `FlowReader` already
 * carries the awkward case that makes a plain string wrong: "bring your own model" is local when
 * their Ollama is on this machine and a network hop when it is on the box under their desk.
 *
 * What each rung means HERE:
 *
 *   1. `deterministic`  the rules and the database probes, and nothing else. The default.
 *   2. `localEngine`    the model on this computer writes the explanation.
 *   3. `snoutAi`        our gateway writes it, on the user's AI allowance.
 *   4. `byok`           their own Ollama or their own vendor key writes it.
 *
 * THE FINDINGS DO NOT MOVE BETWEEN RUNGS. Every one of them is produced by the deterministic rule
 * set and by read-only probes against the real database: no model decides whether something will
 * fail, reads a measurement, or judges severity, on any rung. Rung 1 is not "a worse review", it is
 * the same review with nobody writing it up. That is the product's whole claim and this type must
 * never be the thing that quietly breaks it.
 */
export type ReviewMethod = FlowReader;

/** Rules only. The default, and it stays the default on an upgrade: a model was never going to
 *  write on somebody's pull request because they installed a new version. */
export const DEFAULT_REVIEW_METHOD: ReviewMethod = { kind: 'deterministic' };

/**
 * Read a stored `aiMode` forward into a method, so nobody's setting moves under them.
 *
 * `off` is rung 1 and `snoutdata` is rung 3 exactly. `byok` is the lossy one: it used to mean "the
 * vendor key you already use for chat", with no provider recorded anywhere, so there is nothing to
 * recover a provider FROM. It becomes a byok method with an empty provider, which the settings pane
 * renders as "your own key" needing a provider chosen, rather than a method that silently picks one.
 */
export function reviewMethodFromLegacy(mode: ReviewAiMode | undefined): ReviewMethod {
	switch (mode) {
		case 'snoutdata':
			return { kind: 'snoutAi', consent: true };
		case 'byok':
			return { kind: 'byok', provider: 'openai', model: '', consent: true };
		default:
			return DEFAULT_REVIEW_METHOD;
	}
}

/**
 * What to tell the user about where a review's contents go, computed from the method rather than
 * written on a screen.
 *
 * Its own sentences rather than `dataBoundary`'s, because what leaves is not a file the user chose:
 * it is the changed SQL in somebody's pull request AND the findings, and the findings carry
 * measurements taken from the bound database (how many rows are NULL, how big the table is). A user
 * reading "your files are sent" would not think of either. The classification underneath is the
 * same, `isLocalHost` and all, which is the part that must not fork.
 */
export function reviewBoundary(method: ReviewMethod): { boundary: DataBoundary; sentence: string } {
	const leaves = "The changed SQL, and the findings taken from your database, are sent";
	switch (method.kind) {
		case 'deterministic':
			return { boundary: 'local', sentence: "No explanation is written, and no model is called. The findings are the rules' own words." };
		case 'localEngine':
			return { boundary: 'local', sentence: "The model runs on this computer, so nothing about the review is sent anywhere. It costs time and power on this machine instead." };
		case 'snoutAi':
			return { boundary: 'ourServers', sentence: `${leaves} to our servers to be written up, and it comes out of your AI allowance.` };
		case 'byok':
			if (method.provider === 'ollama') {
				return isLocalHost(method.host)
					? { boundary: 'local', sentence: "The model runs on this computer, on the Ollama you are running. Nothing about the review is sent anywhere." }
					: { boundary: 'theirNetwork', sentence: `${leaves} to the Ollama server you named (${method.host}). They do not reach us.` };
			}
			return { boundary: 'thirdParty', sentence: `${leaves} to ${REVIEW_VENDOR_NAMES[method.provider]} using your own key. They do not reach us.` };
	}
}

const REVIEW_VENDOR_NAMES: Record<ByokProvider, string> = {
	ollama: 'your Ollama server',
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	openrouter: 'OpenRouter',
};

/** One watched repository, as the Settings pane renders it. */
export interface ReviewRepoInfo {
	id: string;
	forge: ReviewForge;
	owner: string;
	name: string;
	/** Connection the repository's SQL is reviewed against; absent = text-only review. */
	connectionId?: string;
	/** The bound connection's label, resolved for display. Absent when it has been deleted. */
	connectionLabel?: string;
	/** True when the bound connection is flagged production — the UI says so, loudly. */
	connectionIsProd?: boolean;
	auto: ReviewAuto;
	depth: ReviewDepthSetting;
	method: ReviewMethod;
	approveBeforePosting: boolean;
	/** Pull requests from forks and from people who cannot write here are reviewed without being
	 *  asked. Off unless the user turned it on for this repository. */
	reviewOutsiders: boolean;
	enabled: boolean;
	lastPolledAt?: number;
}

/** One host, as the Settings pane renders it. */
export interface ReviewForgeStatus {
	kind: ReviewForge;
	/** True when a token for this host is in the keychain. The token never crosses IPC. */
	hasToken: boolean;
	/** The account it belongs to, once verified. */
	login?: string;
	/** Scopes the host reports. Empty for a GitHub fine-grained token and for GitLab, neither of
	 *  which answers the question — absence is a different scheme, not a warning. */
	scopes: string[];
	/** GitLab only: which instance. Most companies on GitLab self-host. */
	baseUrl?: string;
	/** GitHub only: whether reviews are posted as the person or as the App. */
	auth: ReviewForgeAuth;
	/** The App's id, when one is set up. Its private key never crosses IPC. */
	appId?: string;
	/** Which installation it reviews as, when the App is on more than one account. */
	appInstallationId?: number;
}

/** Everything the Settings pane needs in one call. */
/**
 * What "Check now" found, so the button can say something. It used to return nothing, which read
 * as a dead button whenever a check found nothing new, failed, or had no repository to look at.
 */
export interface ReviewPollResult {
	/** `checked`: it looked. `busy`: a check was already running. `noRepos`: nothing is watched. */
	outcome: 'checked' | 'busy' | 'noRepos';
	/** Repositories looked at. */
	repos: number;
	/** Pull requests it reviewed on this pass. */
	reviewed: number;
	/** One sentence per repository that could not be read. */
	errors: string[];
	/** When it finished, epoch ms. */
	at: number;
}

export interface ReviewStatus {
	/** Master switch. Off by default — nothing polls anything until the user asks. */
	enabled: boolean;
	/** One entry per host, connected or not. */
	forges: ReviewForgeStatus[];
	/** Seconds between polls. */
	pollSeconds: number;
	repos: ReviewRepoInfo[];
	/** What the poller is doing right now, for a status line. */
	activity?: string;
	/**
	 * Reviews written and waiting for the user to read them before they post.
	 *
	 * Here rather than derived from `runs()` because it is what the ACTIVITY BAR badges, and the
	 * bar is up whether or not anything has ever opened the reviews. The tray reads the same
	 * number from `trayState()`; both are the one thing in this feature that is waiting on a
	 * person, and neither should have to fetch a list of reviews to count it.
	 */
	awaiting: number;
	/** The last error a poll produced, so a silent failure is visible somewhere. */
	lastError?: string;
}

/**
 * A repository the stored token can reach, for the picker.
 *
 * The list IS the token's permission list. A fine-grained token scoped to two repositories offers
 * exactly those two, which is why there is no "search all of GitHub" here: a repository this token
 * cannot reach is one Snoutbot could never review.
 */
export interface ReviewAvailableRepo {
	/** `owner/name` lower-cased — the same id `ReviewRepoInfo` uses, so the two lists join. */
	id: string;
	forge: ReviewForge;
	owner: string;
	name: string;
	private: boolean;
	archived: boolean;
	/** False when the token can read but not comment. Reviewing would work; posting would 403. */
	canComment: boolean;
	/** Already being watched, so the picker shows it rather than offering it twice. */
	watched: boolean;
}

/** What the repository picker got back. */
export type ReviewRepoList =
	| { ok: true; repos: ReviewAvailableRepo[] }
	| { ok: false; error: string };

/**
 * How a host is spoken to, which decides WHO the review comment is from.
 *
 * `token` is a personal access token: the comment is authored by the person it belongs to, and
 * it needs no setup at all, which is why it is the default. `app` is a GitHub App the team
 * created in their own organization, whose comments are authored by `<slug>[bot]` — what every
 * reviewer of this shape does, and the only way GitHub allows a name other than a person's.
 *
 * Both keep every credential on this machine: an App's private key goes in the keychain beside
 * the database passwords, and no service of ours is involved in either.
 *
 * GitHub only. GitLab has no App concept, and its project access tokens already act as a bot
 * user, so there the bot is a token like any other.
 */
export type ReviewForgeAuth = 'token' | 'app';

/** One place a GitHub App is installed. */
export interface ReviewInstallation {
	id: number;
	account: string;
}

/** The result of setting up a GitHub App, checked the way a pasted token is. */
export type ReviewAppCheck =
	| { ok: true; login: string; name: string; installations: ReviewInstallation[] }
	| { ok: false; error: string };

/** The result of verifying a token the user just pasted. */
export type ReviewTokenCheck =
	| { ok: true; login: string; scopes: string[] }
	| { ok: false; error: string };

/**
 * A review that has STARTED.
 *
 * Separate from `ReviewRun`, which is one that finished. The gap between the two is the whole
 * reason this exists: a review takes as long as it takes to fetch a diff and count some rows,
 * and until this event the app said nothing at all, so pressing "Check now" looked like pressing
 * a dead button. The app shows it as a toast; the host shows it as a pending commit status.
 */
export interface ReviewStarted {
	repoId: string;
	forge: ReviewForge;
	repoLabel: string;
	prNumber: number;
	prTitle?: string;
	prUrl?: string;
}

/** A review that has run, held in memory for the in-app view. */
export interface ReviewRun {
	id: string;
	repoId: string;
	/** Which host it is on, so the view can use that host's word for a change and name the
	 *  account the comment will be posted as. */
	forge: ReviewForge;
	repoLabel: string;
	prNumber: number;
	prTitle?: string;
	prUrl?: string;
	headSha: string;
	/** The rendered markdown comment, whether or not it was posted. */
	body: string;
	/** The database's own error for each check that failed, shown in the review tab only. The
	 *  comment carries a fixed reason instead: this text echoes names the pull request chose and
	 *  can carry hosts, roles and values. */
	localErrors?: { about: string; error: string }[];
	/** How much of the database the review could see. */
	depth: 'static' | 'schema' | 'connected';
	/** The destination it was measured against, when there was one. Named in the view for the
	 *  same reason the comment names it: a number with nothing attached to it is not a
	 *  measurement. */
	destinationName?: string;
	blockers: number;
	warnings: number;
	notes: number;
	/** Set once the comment reached GitHub. */
	postedCommentId?: number;
	/** True while it waits for the user to approve posting. */
	awaitingApproval: boolean;
	/**
	 * Which rung produced this review, so the view can SAY so.
	 *
	 * The findings are the same on all four, but which one ran is still the first thing a user
	 * asks when a review reads differently from the last one, and until this existed the only
	 * answer on screen was the model's name at the bottom of the prose (and nothing at all on the
	 * rules-only rung). It is the run's own method, which may be a one-off override rather than
	 * the repository's setting, which is exactly why it is recorded per run.
	 */
	method: ReviewMethod;
	at: number;
	error?: string;
}

/**
 * Where to send a GitHub user who has no token yet: the FINE-GRAINED form.
 *
 * The classic form was here first because GitHub pre-fills it from the query string, so the
 * scope arrives already ticked. That convenience was not worth what it hands over: classic
 * `repo` is one switch granting read AND WRITE to every repository the account can touch,
 * present and future, including pushing code — for a bot that only reads pull requests, comments
 * on them and sets a commit status. A fine-grained token is granted to the repositories the user chooses, with
 * the four permissions below and nothing else, so a reviewer that is compromised or simply
 * wrong cannot reach a repository it was never pointed at.
 *
 * The cost is that this form cannot be pre-filled, so the UI has to NAME the permissions
 * (`GITHUB_FINE_GRAINED_PERMISSIONS`) instead of ticking them. That is the right trade for a
 * credential that sits in a keychain indefinitely.
 */
export const GITHUB_FINE_GRAINED_URL = 'https://github.com/settings/personal-access-tokens/new';

/** Where to create a GitHub App. The org-scoped page is the one people actually want, but its
 *  URL needs an org name, and the personal one offers the org as a choice, so this is the form
 *  that works without asking a question first. */
export const GITHUB_NEW_APP_URL = 'https://github.com/settings/apps/new';

/** Where to send a GitLab user. The path is the same on a self-hosted instance, so it is built
 *  from whichever base URL they configured rather than hardcoded to gitlab.com. */
export function gitlabTokenUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/-/user_settings/personal_access_tokens`;
}

/** What a GitLab token needs. `api` is the only scope that covers reading merge requests AND
 *  posting a note; `read_api` can review and would then fail to say anything. */
export const GITLAB_TOKEN_SCOPE = 'api';

/**
 * The classic form, kept as the fallback rather than the default.
 *
 * Two real cases still need it: a GitHub Enterprise Server old enough to have no fine-grained
 * tokens, and an organization that has not enabled them (they are opt-in per org, and a
 * fine-grained token is simply refused until it is). GitHub pre-fills this one, so the `repo`
 * scope arrives ticked; `public_repo` is the smaller version for public repositories only.
 */
export const GITHUB_CLASSIC_TOKEN_URL =
	'https://github.com/settings/tokens/new?description=SnoutData%20review&scopes=repo';

/**
 * One thing the user has to grant on the host's own token form.
 *
 * It carries WHY, not just what. The list is read on one screen and ticked on another, and a
 * permission with no stated purpose is one the careful user has to either trust or refuse. Four
 * lines each saying what they buy is also the argument that the set is minimal: there is nothing
 * in it that cannot be pointed at a thing Snoutbot does.
 */
export interface TokenGrant {
	/** Exactly as the host labels it, so it can be matched by eye on their form. */
	name: string;
	/** What Snoutbot does with it. */
	why: string;
}

/** Permissions a fine-grained GitHub token needs, in GitHub's own words. */
export const GITHUB_FINE_GRAINED_PERMISSIONS: TokenGrant[] = [
	{ name: 'Repository access', why: "the repositories you want reviewed, picked one by one. \"All repositories\" is not needed" },
	{ name: 'Contents: Read-only', why: 'read the changed SQL files' },
	{ name: 'Pull requests: Read and write', why: 'read the pull request, and post the review on it' },
	{ name: 'Issues: Read and write', why: 'read @snoutbot mentions in the conversation, and reply' },
	{ name: 'Commit statuses: Read and write', why: 'show the review beside your CI checks, running then done' },
	{ name: 'Metadata: Read-only', why: 'name the repository; GitHub grants this automatically' },
];

/** The same list for GitLab, which asks for scopes rather than per-permission switches. */
export const GITLAB_TOKEN_PERMISSIONS: TokenGrant[] = [
	{ name: 'api', why: 'read merge requests and post the review. The read-only scope could review and then fail to say anything' },
];

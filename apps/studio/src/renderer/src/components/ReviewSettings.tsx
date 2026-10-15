/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { PRO_AVAILABLE } from '@snout/studio-pro/renderer';

import {
	GITHUB_CLASSIC_TOKEN_URL,
	GITHUB_FINE_GRAINED_PERMISSIONS,
	GITHUB_FINE_GRAINED_URL,
	GITHUB_NEW_APP_URL,
} from '../../../shared/review';
import {
	FORGE_LABELS,
	GITLAB_TOKEN_PERMISSIONS,
	GITLAB_TOKEN_SCOPE,
	gitlabTokenUrl,
} from '../../../shared/review';
import { reviewBoundary } from '../../../shared/review';
import type { ReviewAvailableRepo, ReviewForge, ReviewForgeStatus, ReviewInstallation, ReviewMethod, ReviewRepoInfo, ReviewStatus } from '../../../shared/review';
import type { ByokProvider } from '../../../shared/engine';
import { Icon } from './Icon';
import { ReviewArt } from '../art/Illustrations';
import { SettingsIntro } from './SettingsIntro';
import { useConfirm } from './ConfirmDialog';
import { secretsPlace, useSecretsWeak } from '../secretsPlace';

/**
 * Move to another rung, keeping what the new one can use.
 *
 * The byok details are REMEMBERED across a trip through the other three: a user who typed an Ollama
 * host, tried our AI once and came back should not have to type it again. Nothing is remembered
 * that the new rung cannot hold, so this never produces a method with a stale field on it.
 */
function methodOfKind(kind: ReviewMethod['kind'], current: ReviewMethod): ReviewMethod {
	switch (kind) {
		case 'deterministic':
			return { kind: 'deterministic' };
		case 'localEngine':
			return { kind: 'localEngine' };
		case 'snoutAi':
			return { kind: 'snoutAi', consent: true };
		case 'byok':
			return current.kind === 'byok'
				? current
				: { kind: 'byok', provider: 'ollama', model: '', consent: true };
	}
}

/*
 * Settings → Snoutbot. The pull-request reviewer, running here rather than in anybody's cloud.
 *
 * Two things this screen has to be honest about, because both are real limits a user will
 * otherwise discover as a bug:
 *   1. It POLLS. GitHub cannot reach this machine, so a review arrives within the poll
 *      interval, not instantly.
 *   2. It only runs while the app does. That is what the tray is for, and it is said here
 *      rather than left to be found out.
 *
 * The repositories are PICKED FROM THE TOKEN'S OWN ACCESS, not typed. Asking somebody to type
 * `owner/name` made them the index of their own permissions, and a typo produced a watched
 * repository that simply never found anything — indistinguishable, from this screen, from one
 * with no pull requests. Typing one by hand is still there, folded away, for a repository the
 * list cannot show (past the page cap, or reachable by a token GitHub does not enumerate).
 *
 * The tick IS the state. Nothing on this screen has a save step — the switch, the interval and
 * every per-repository setting apply as they change — so the picker does not have one either.
 * See `toggle` for what that replaced and why.
 *
 * Follows the house design system: cards (`fieldset` + `legend`), switches for booleans, TICKS
 * for a list of things, tokens for every colour.
 */

/*
 * Three jobs, three tabs, in the order they are done: connect a host, say how it reviews, choose
 * what it watches. Stacked they ran to about three screens, and the repositories half (a list plus
 * a card per watched repository) is most of that height, so the two small cards above it were
 * pushed off screen by the one card nobody scrolls past.
 *
 * The tab names ARE the card names, so the legends they duplicated are gone rather than repeated
 * two rows apart.
 */
const REVIEW_TABS = [
	{ id: 'code', label: 'Where your code lives' },
	{ id: 'reviewing', label: 'Reviewing' },
	{ id: 'repos', label: 'Repositories' },
] as const;

type ReviewTab = typeof REVIEW_TABS[number]['id'];

interface Props {
	connections: { id: string; label: string; environment?: string }[];
	/** Close settings and show the reviews themselves. */
	onOpenReviews?(): void;
}

export function ReviewSettings({ connections, onOpenReviews }: Props): JSX.Element {
	const [status, setStatus] = useState<ReviewStatus | undefined>();
	const [repoRef, setRepoRef] = useState('');
	/** Which host a hand-typed repository belongs to; the text alone cannot say. */
	const [manualForge, setManualForge] = useState<ReviewForge>('github');
	const [repoError, setRepoError] = useState<string | undefined>();
	const [available, setAvailable] = useState<ReviewAvailableRepo[] | undefined>();
	const [listBusy, setListBusy] = useState(false);
	const [listError, setListError] = useState<string | undefined>();
	/**
	 * Which host's card is showing. `undefined` means "whichever one is connected", so the pane
	 * opens on the user's host rather than on GitHub-by-alphabet; picking a tab pins it.
	 */
	const [forgeTab, setForgeTab] = useState<ReviewForge | undefined>();
	/** "Check now" is a round trip to the host and possibly a whole review, so it says so. It
	 *  said nothing at all, which made a working button indistinguishable from a dead one. */
	const [checking, setChecking] = useState(false);
	const [confirm, confirmDialog] = useConfirm();
	const [tab, setTab] = useState<ReviewTab>('code');
	/* Which tab opens is decided ONCE, from the first status that arrives: a user with a host
	   already connected came here for the repositories, and one without cannot do anything until
	   they connect. Once, not on every status: connecting a token would otherwise throw the pane
	   to another tab under the hand that was still using this one. */
	const decidedTab = useRef(false);

	const refresh = useCallback(async () => {
		setStatus(await window.sqlApi.review.status());
	}, []);

	/** At least one host is connected, which is what decides whether there is a list to fetch. */
	const connected = (status?.forges ?? []).some((forge) => forge.hasToken);

	/**
	 * Fetch the token's repositories.
	 *
	 * The `finally` is the point. Without it a rejected IPC call — main throwing outside its own
	 * try, a channel that is not registered, a serialization failure — left `listBusy` true for
	 * the rest of the session: a "Loading…" that never finished and never said anything, which
	 * reads as a broken app rather than as a failure. A spinner with no timeout is a lie, so
	 * every path out of here either sets a list or sets an error.
	 */
	const loadRepositories = useCallback(async () => {
		setListBusy(true);
		setListError(undefined);
		try {
			const result = await window.sqlApi.review.listRepositories();
			if (result.ok) {
				setAvailable(result.repos);
			} else {
				setListError(result.error);
			}
		} catch (err) {
			setListError(err instanceof Error ? err.message : String(err));
		} finally {
			setListBusy(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		return window.sqlApi.onReviewChanged((next) => setStatus(next));
	}, [refresh]);

	useEffect(() => {
		if (!status || decidedTab.current) {
			return;
		}
		decidedTab.current = true;
		setTab(status.forges.some((forge) => forge.hasToken) ? 'repos' : 'code');
	}, [status]);

	// Fetch the token's repositories once the pane knows there IS a token. Not on the app's boot
	// path — this is a settings screen somebody opened, and the list is the reason they opened it.
	useEffect(() => {
		if (connected && available === undefined && !listBusy && !listError) {
			void loadRepositories();
		}
	}, [connected, available, listBusy, listError, loadRepositories]);

	if (!status) {
		return <div className="muted small">Loading…</div>;
	}

	const addRepo = async (): Promise<void> => {
		setRepoError(undefined);
		const result = await window.sqlApi.review.addRepo(repoRef, manualForge);
		if (result.ok) {
			setRepoRef('');
			void refresh();
			void loadRepositories();
		} else {
			setRepoError(result.error);
		}
	};

	/**
	 * Picking IS watching. It is not a selection waiting to be committed: nothing else on this
	 * screen has a save step either — the switch, the interval and every per-repository setting
	 * all apply as they change — so a "Watch N repositories" button here was the odd one out, and
	 * it also made the choice one-way (the row went disabled once committed).
	 *
	 * Stopping is the card's own button, and stopping a repository that has been SET UP (bound to
	 * a connection) throws that setup away, so that one asks first. An untouched one just goes.
	 */
	const stopWatching = async (repo: { id: string; owner: string; name: string }): Promise<void> => {
		const configured = status?.repos.find((r) => r.id === repo.id)?.connectionId;
		if (configured && !(await confirm({
			title: `Stop watching ${repo.owner}/${repo.name}?`,
			body: "Its database binding and review settings are forgotten. Watching it again starts from the defaults.",
			confirmLabel: "Stop watching",
			danger: true,
		}))) {
			return;
		}
		setWatched(repo.id, false);
		setStatus(await window.sqlApi.review.removeRepo(repo.id));
		await refresh();
		await loadRepositories();
	};

	const startWatching = async (repo: ReviewAvailableRepo): Promise<void> => {
		// It leaves the combo NOW, not when the round trip finishes: a picker that keeps offering
		// what you just picked reads as one that ignored the click.
		setWatched(repo.id, true);
		try {
			const result = await window.sqlApi.review.addRepo(repo.id);
			if (!result.ok) {
				setWatched(repo.id, false);
				setListError(result.error);
				return;
			}
			await refresh();
			// Reconcile against what main actually holds; the optimistic move was a guess until now.
			await loadRepositories();
		} catch (err) {
			setWatched(repo.id, false);
			setListError(err instanceof Error ? err.message : String(err));
		}
	};

	/** Move one repository between the combo and the cards without waiting for main. */
	function setWatched(id: string, watched: boolean): void {
		setAvailable((prev) => prev?.map((repo) => (repo.id === id ? { ...repo, watched } : repo)));
	}

	// The tab opens on the host that is already connected, until the user picks one.
	const activeForge: ReviewForge = forgeTab ?? status.forges.find((f) => f.hasToken)?.kind ?? 'github';
	const shownForge = status.forges.find((f) => f.kind === activeForge) ?? status.forges[0];

	const scopesReported = (status?.forges ?? []).flatMap((f) => f.scopes);
	/* What the combo offers: everything the token can reach that is NOT already watched. A watched
	   one has a card below, which is where it is turned off, so leaving it in the list would be two
	   places to say the same thing and one of them would be wrong for a moment after every click. */
	const unwatched = (available ?? []).filter((repo) => !repo.watched);

	const patch = async (id: string, changes: Record<string, unknown>): Promise<void> => {
		setStatus(await window.sqlApi.review.updateRepo(id, changes));
	};

	return (
		<div className="review-settings">
			<SettingsIntro art={ReviewArt}>
				<p>
					Snoutbot reviews the database change in a pull request against the database it is going to
					land on. Comment <code>@snoutbot review</code> on a pull request, or let it review every
					one that touches SQL.
				</p>
			</SettingsIntro>

			<div className="tabs review-section-tabs">
				{REVIEW_TABS.map((t) => (
					<button
						type="button"
						key={t.id}
						className={tab === t.id ? 'tab active' : 'tab'}
						onClick={() => setTab(t.id)}
					>
						{t.label}
					</button>
				))}
			</div>

			{tab === 'code' && (
			<fieldset>
				{/* One card, TABBED, not one card per host.
				    Almost nobody has both: a team is on GitHub or it is on GitLab. Two stacked cards
				    made the pane open on two token fields, so the first thing it asked was which of
				    two things this user is not doing. Both can still be connected at once — the tab
				    carries a dot when its host has a token, the same mark the connection form uses
				    for a configured AWS/SSH tab — so nothing is taken away, it is just folded. */}
				<div className="tabs subtabs review-forge-tabs" role="tablist">
					{status.forges.map((forge) => (
						<button
							key={forge.kind}
							type="button"
							role="tab"
							aria-selected={forge.kind === activeForge}
							className={`tab${forge.kind === activeForge ? ' active' : ''}`}
							onClick={() => setForgeTab(forge.kind)}
						>
							<Icon name={FORGE_LABELS[forge.kind].icon} /> {FORGE_LABELS[forge.kind].name}
							{forge.hasToken && <span className="tab-dot" title="Connected" />}
						</button>
					))}
				</div>
				{shownForge && (
					<ForgeCard
						key={shownForge.kind}
						forge={shownForge}
						onChanged={setStatus}
						onConnected={() => { setAvailable(undefined); setListError(undefined); }}
					/>
				)}
			</fieldset>

			)}

			{tab === 'reviewing' && (
			<fieldset>
				<label className="check">
					<input
						type="checkbox"
						checked={status.enabled}
						disabled={!connected}
						onChange={async (e) => setStatus(await window.sqlApi.review.setEnabled(e.target.checked))}
					/>
					<span>Watch my repositories</span>
				</label>
				<p className="muted small">
					GitHub cannot reach this computer, so SnoutData Studio checks for new pull requests and for
					<code> @snoutbot</code> comments every {status.pollSeconds} seconds. Reviews happen while
					the app is running; closing the window keeps it in the tray, quitting stops it.
				</p>
				<label>
					Check every
					<select
						value={status.pollSeconds}
						onChange={async (e) => setStatus(await window.sqlApi.review.setPollSeconds(Number(e.target.value)))}
					>
						<option value={30}>30 seconds</option>
						<option value={60}>1 minute</option>
						<option value={300}>5 minutes</option>
						<option value={900}>15 minutes</option>
					</select>
				</label>
				<div className="row">
					<button
						disabled={!status.enabled || checking}
						onClick={async () => {
							// Awaited, not fired and forgotten: the poll resolves when the host has
							// been asked and any review it found has run, which is exactly how long
							// the button should look busy for.
							setChecking(true);
							try {
								await window.sqlApi.review.pollNow();
							} finally {
								setChecking(false);
							}
						}}
					>
						<Icon name={checking ? 'sync' : 'search'} className={checking ? 'spin' : undefined} />
						{checking ? 'Checking…' : 'Check now'}
					</button>
					{onOpenReviews && (
						<button onClick={onOpenReviews}>
							<Icon name="git-pull-request" /> Show reviews
						</button>
					)}
					{status.activity
						? <span className="muted small"><Icon name="sync" className="spin" /> {status.activity}…</span>
						: checking && <span className="muted small">Asking {FORGE_LABELS[activeForge].name} what has changed…</span>}
				</div>
				{status.lastError && <div className="form-error">{status.lastError}</div>}
			</fieldset>

			)}

			{tab === 'repos' && (
			<fieldset className="review-repos-card">
				{/* Two halves, side by side once there is room for them (see `.review-repos-card` in
				    styles.css). Picking a repository and configuring the ones already picked are
				    different jobs, and stacking them made this card as tall as the other two put
				    together on a wide monitor: a 280px list, then a hint, then a fold, then a grid
				    of cards, all in one column with the right two thirds of the screen empty. */}
				<div className="review-pick">
				{!connected ? (
					<p className="muted small">
						Connect a GitHub or GitLab account on the "Where your code lives" tab, and the
						repositories those tokens can reach appear here to pick from.
					</p>
				) : (
					<>
						<p className="muted small">
							These are the repositories your token can reach. Pick one to start watching it, and it
							gets a card below where you choose the database its SQL is reviewed against. If one you
							expect is missing, the token's access is what decides, so widen it on GitHub.
						</p>
						{/* A combo, not a tick list of everything the token can see. The list WAS the whole
						    reachable set with the watched ones ticked inside it, which meant the repositories
						    actually being reviewed were a handful of ticks scattered through a scrolling box of
						    the ones that are not, and the card for each of them was somewhere further down. The
						    two halves are separate now: this picks, the cards below are the answer. A picked
						    repository leaves the combo, so what it offers is exactly what is not watched yet. */}
						<div className="row">
							<select
								className="grow"
								data-test="review-pick"
								value=""
								disabled={listBusy || unwatched.length === 0}
								onChange={(e) => {
									const picked = unwatched.find((repo) => repo.id === e.target.value);
									if (picked) {
										void startWatching(picked);
									}
								}}
							>
								<option value="">
									{listBusy && available === undefined
										? `Asking ${FORGE_LABELS[activeForge].name} which repositories this token can reach…`
										: unwatched.length > 0
											? `Pick a repository to watch (${unwatched.length})`
											: "Every repository this token can reach is already watched"}
								</option>
								{unwatched.map((repo) => (
									<option key={repo.id} value={repo.id}>
										{repo.owner}/{repo.name}
										{repo.private ? ' · private' : ''}
										{repo.archived ? ' · archived' : ''}
										{repo.canComment ? '' : ' · cannot comment'}
									</option>
								))}
							</select>
							<button disabled={listBusy} onClick={() => void loadRepositories()}>
								<Icon name="refresh" /> {listBusy ? 'Loading…' : 'Refresh'}
							</button>
						</div>
						{/* The roll call, under the picker that cannot be it: a repository LEAVES the combo
						    when it is picked, so without this the only place the chosen set exists is the
						    cards, and reading "what am I watching" meant scrolling four settings apart.
						    Remove here is the same act as the card's own button, question and all. */}
						{status.repos.length > 0 && (
							<ul className="review-watched-list">
								{status.repos.map((repo) => (
									<li key={repo.id}>
										<Icon name="repo" />
										<span className="review-watched-name">
											<span className="muted">{repo.owner}/</span>{repo.name}
										</span>
										{!repo.enabled && <span className="muted small">paused</span>}
										<button type="button" className="link-btn" onClick={() => void stopWatching(repo)}>
											Remove
										</button>
									</li>
								))}
							</ul>
						)}
						{listError && (
							<div className="form-error">
								{listError}
								<button className="link-btn" onClick={() => void loadRepositories()}>Try again</button>
							</div>
						)}
						{available !== undefined && available.length === 0 && (
							// An empty list is a RESULT, not a blank screen. The two things that
							// actually cause it are a scope that is too narrow and an organization
							// whose SSO the token was never authorized for, and neither is guessable
							// from here — so both are named, with the page that fixes them.
							<div className="review-empty-list">
								<p>
									<Icon name="warning" /> This token cannot reach any repositories.
								</p>
								<p className="muted small">
									Snoutbot can only watch what the token can already see, so there is nothing to
									offer. Two things cause this:
								</p>
								<ul className="muted small">
									<li>
										It was not granted the repositories. A GitHub fine-grained token lists them one
										by one, and "All repositories" is not the default; a classic token needs the
										<code> repo</code> scope, and a GitLab one needs
										<code> {GITLAB_TOKEN_SCOPE}</code>.
										{scopesReported.length > 0
											? ` The connected token reports: ${scopesReported.join(', ')}.`
											: ' No scopes are reported, which is normal for a GitHub fine-grained token and for GitLab: check the token was granted the projects you expect.'}
									</li>
									<li>
										Your organization requires SSO and this token has not been authorized for it.
										Both hosts hide those repositories entirely rather than refusing them.
									</li>
								</ul>
								<div className="row">
									{status.forges.filter((f) => f.hasToken).map((f) => (
										<button
											key={f.kind}
											onClick={() => window.sqlApi.openExternal(
												f.kind === 'gitlab' ? gitlabTokenUrl(f.baseUrl ?? '') : GITHUB_FINE_GRAINED_URL,
											)}
										>
											<Icon name="link-external" /> Check the token on {FORGE_LABELS[f.kind].name}
										</button>
									))}
									<button className="secondary" onClick={() => void loadRepositories()}>
										<Icon name="refresh" /> Look again
									</button>
								</div>
							</div>
						)}
					</>
				)}

				<details className="muted small">
					<summary>Add one by name instead</summary>
					<p>
						For a repository the list above cannot show, name it directly. Snoutbot still needs the
						token to be able to reach it.
					</p>
					<div className="row">
						<input
							className="grow"
							value={repoRef}
							placeholder="owner/name, or paste the repository URL"
							onChange={(e) => setRepoRef(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && repoRef.trim() !== '') {
									void addRepo();
								}
							}}
						/>
						<button disabled={repoRef.trim() === ''} onClick={() => void addRepo()}>
							<Icon name="eye" /> Watch
						</button>
					</div>
					{repoError && <div className="form-error">{repoError}</div>}
				</details>
				</div>

				<div className="review-watched">
				{status.repos.length === 0 ? (
					<p className="muted small">
						Nothing is being watched yet. Pick a repository above, then choose which of your
						connections its SQL should be reviewed against.
					</p>
				) : (
					<div className="review-repos">
						{status.repos.map((repo) => (
							<RepoCard
								key={repo.id}
								repo={repo}
								connections={connections}
								onPatch={(changes) => void patch(repo.id, changes)}
								onRemove={() => void stopWatching(repo)}
							/>
						))}
					</div>
				)}
				</div>
			</fieldset>
			)}
			{confirmDialog}
		</div>
	);
}

/**
 * One host's connection, as the body of the tab above it.
 *
 * Tabbed rather than one card each, because a team is on GitHub or it is on GitLab and showing
 * both asked every user about a host they do not use. Both can still be connected at once, and
 * the tab's dot says which are; nothing here decides that. GitLab gets one extra field that
 * GitHub does not need and that is the whole reason this was worth building: WHICH GitLab. Most
 * companies on GitLab self-host, and a reviewer hardcoded to gitlab.com is one they cannot use.
 */
function ForgeCard({
	forge,
	onChanged,
	onConnected,
}: {
	forge: ReviewForgeStatus;
	onChanged(status: ReviewStatus): void;
	onConnected(): void;
}): JSX.Element {
	const keyPlace = secretsPlace(useSecretsWeak());
	const [token, setToken] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [baseUrl, setBaseUrl] = useState(forge.baseUrl ?? '');
	const label = FORGE_LABELS[forge.kind];

	const save = async (): Promise<void> => {
		setBusy(true);
		setError(undefined);
		const result = await window.sqlApi.review.setToken(forge.kind, token);
		setBusy(false);
		if (result.ok) {
			setToken('');
			onConnected();
			onChanged(await window.sqlApi.review.status());
		} else {
			setError(result.error);
		}
	};

	return (
		<>
			{/* WHO the comment comes from, above everything it changes. GitHub only: GitLab has no
			    App concept, and a project access token there already runs as a bot user. */}
			{forge.kind === 'github' && (
				<>
					<p className="small">Reviews are posted by:</p>
					<div className="review-identity">
						{([
							['token', 'You', 'A personal access token. No setup, and the comment carries your name.'],
							['app', 'Snoutbot', 'A GitHub App in your own organization. Comments come from snoutbot[bot], and its key stays on this computer.'],
						] as const).map(([value, title, why]) => (
							<button
								key={value}
								type="button"
								className={`review-identity-option${forge.auth === value ? ' chosen' : ''}`}
								aria-pressed={forge.auth === value}
								onClick={async () => onChanged(await window.sqlApi.review.setGithubAuth(value))}
							>
								<span className="review-identity-title">
									<Icon name={value === 'app' ? 'github' : 'account'} /> {title}
								</span>
								<span className="review-identity-why">{why}</span>
							</button>
						))}
					</div>
				</>
			)}
			{forge.kind === 'github' && forge.auth === 'app' ? (
				<GithubAppSetup forge={forge} onChanged={onChanged} onConnected={onConnected} />
			) : forge.hasToken ? (
				<div className="row spread">
					<div>
						<Icon name={label.icon} /> Connected as <strong>{forge.login ?? 'your account'}</strong>
						{forge.scopes.length > 0 && <span className="muted small"> ({forge.scopes.join(', ')})</span>}
						{forge.kind === 'gitlab' && forge.baseUrl && (
							<span className="muted small"> at {forge.baseUrl}</span>
						)}
						<div className="muted small">Reviews are posted by this account.</div>
					</div>
					<button
						onClick={async () => {
							onConnected();
							onChanged(await window.sqlApi.review.clearToken(forge.kind));
						}}
					>
						<Icon name="debug-disconnect" /> Disconnect
					</button>
				</div>
			) : null}
			{forge.hasToken && forge.auth !== 'app' && <BotAccountNote forge={forge.kind} />}
			{forge.hasToken || (forge.kind === 'github' && forge.auth === 'app') ? null : (
				<>
					<p className="muted small">
						Snoutbot posts as whoever the token below belongs to: as you, if it is your own token,
						or as a bot if you give it a bot's (see "Post as a bot" once it is connected). The
						token is kept {keyPlace} and never leaves this computer.
					</p>
					{/* What to tick, UP HERE rather than folded away below the token field. It was one
					    comma-joined sentence inside a <details>, which is the wrong shape for something
					    the user reads on this screen and ticks on another one. Each line says what it
					    buys, which is also the argument that the set is minimal. */}
					<p className="small">What to allow on the token, and nothing else:</p>
					<ul className="review-grants">
						{(forge.kind === 'gitlab' ? GITLAB_TOKEN_PERMISSIONS : GITHUB_FINE_GRAINED_PERMISSIONS).map((grant) => (
							<li key={grant.name}>
								<code>{grant.name}</code>
								<span className="why">{grant.why}</span>
							</li>
						))}
					</ul>
					<p className="muted small">
						{forge.kind === 'gitlab'
							? "Snoutbot never pushes, merges or changes a branch. On a merge request it posts one note and edits it as the review changes, adds an emoji to the note that asked, and sets a status on the commit. The api scope allows more than that; GitLab has no narrower one."
							: "Snoutbot never pushes, merges or changes a branch. On a pull request it posts one comment and edits it as the review changes, adds a reaction to the comment that asked, and sets a status on the commit."}
					</p>
					{forge.kind === 'gitlab' && (
						<>
							<label>
								Which GitLab
								<input
									value={baseUrl}
									placeholder="https://gitlab.com"
									autoComplete="off"
									spellCheck={false}
									onChange={(e) => setBaseUrl(e.target.value)}
									onBlur={async () => {
										const next = baseUrl.trim();
										if (next !== '' && next !== forge.baseUrl) {
											onChanged(await window.sqlApi.review.setGitlabBaseUrl(next));
										}
									}}
								/>
							</label>
							<p className="muted small">
								Your company's own instance, if you have one. The token below has to come from
								whichever GitLab this points at.
							</p>
						</>
					)}
					<label>
						Personal access token
						<input
							type="password"
							value={token}
							placeholder={forge.kind === 'gitlab' ? 'glpat-…' : 'ghp_…'}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setToken(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && token.trim() !== '') {
									void save();
								}
							}}
						/>
					</label>
					<div className="row">
						<button className="primary" disabled={busy || token.trim() === ''} onClick={() => void save()}>
							<Icon name="plug" /> {busy ? 'Checking…' : 'Connect'}
						</button>
						<button
							onClick={() => window.sqlApi.openExternal(
								forge.kind === 'gitlab'
									? gitlabTokenUrl(baseUrl.trim() || forge.baseUrl || 'https://gitlab.com')
									: GITHUB_FINE_GRAINED_URL,
							)}
						>
							<Icon name="link-external" /> Create a token on {label.name}
						</button>
					</div>
					{error && <div className="form-error">{error}</div>}
					<details className="muted small">
						<summary>{forge.kind === 'github' ? 'Why fine-grained, and what to do if your organization refuses it' : 'Why GitLab asks for so much'}</summary>
						{forge.kind === 'gitlab' ? (
							<p>
								<code>{GITLAB_TOKEN_SCOPE}</code> is a broad scope, and GitLab has no narrower one that
								can both read a merge request and post a note. That is the whole reason this token stays
								on your computer rather than being handed to a service.
							</p>
						) : (
							<>
								<p>
									GitHub cannot pre-tick the fine-grained form from a link, so the permissions above
									have to be set by hand. If the repository belongs to an organization, an owner also
									has to approve the token before it works.
								</p>
								<p>
									It is worth the extra minute. The older <code>repo</code> scope is one switch that
									grants read and write to every repository your account can touch, now and in the
									future, including pushing code. Snoutbot reads pull requests, comments on them and sets a commit status.
								</p>
								<p>
									If your organization has not enabled fine-grained tokens, or you are on an older
									GitHub Enterprise Server, they are refused; a{' '}
									<a
										href="#"
										onClick={(e) => {
											e.preventDefault();
											window.sqlApi.openExternal(GITHUB_CLASSIC_TOKEN_URL);
										}}
									>
										classic token
									</a>{' '}
									is the fallback, with <code>repo</code>, or <code>public_repo</code> for public
									repositories only.
								</p>
							</>
						)}
					</details>
				</>
			)}
		</>
	);
}

/**
 * Setting up the GitHub App, which is what makes reviews come from `snoutbot[bot]`.
 *
 * Two fields, because GitHub gives you exactly two things when you create an App: a numeric id
 * and a `.pem`. The key is picked as a FILE and read in main, so it goes from disk into the
 * keychain without ever crossing the IPC bridge or sitting in a text input somebody might paste
 * into a screenshot.
 *
 * The order of the steps is the order they fail in. An App that is created but never INSTALLED
 * is the mistake everybody makes, and it fails silently: the credentials are perfect, the token
 * mints, and there is simply nothing to review. So installations are fetched at setup time and
 * an empty list is its own screen rather than a surprise later.
 */
function GithubAppSetup({
	forge,
	onChanged,
	onConnected,
}: {
	forge: ReviewForgeStatus;
	onChanged(status: ReviewStatus): void;
	onConnected(): void;
}): JSX.Element {
	const keyPlace = secretsPlace(useSecretsWeak());
	const [appId, setAppId] = useState(forge.appId ?? '');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [result, setResult] = useState<{ login: string; name: string; installations: ReviewInstallation[] } | undefined>();

	const choose = async (): Promise<void> => {
		setBusy(true);
		setError(undefined);
		const check = await window.sqlApi.review.chooseGithubApp(appId.trim());
		setBusy(false);
		if (check.ok) {
			setResult({ login: check.login, name: check.name, installations: check.installations });
			onConnected();
			onChanged(await window.sqlApi.review.status());
		} else if (check.error !== '') {
			// An empty error is the file picker being cancelled, which is not a failure.
			setError(check.error);
		}
	};

	const installations = result?.installations ?? [];

	return (
		<>
			{forge.hasToken ? (
				<div className="row spread">
					<div>
						<Icon name="github" /> Posting as <strong>{forge.login ?? 'the App'}</strong>
						<div className="muted small">
							App {forge.appId}
							{forge.appInstallationId ? `, installation ${forge.appInstallationId}` : ''}.
							The private key is kept {keyPlace} and never leaves this computer.
						</div>
					</div>
					<button onClick={() => void choose()} disabled={busy}>
						<Icon name="key" /> {busy ? 'Checking…' : 'Replace key'}
					</button>
				</div>
			) : (
				<>
					<p className="muted small">
						A GitHub App belongs to your organization, not to us. Create one, install it on the
						repositories Snoutbot should review, then give it its id and key here. Its comments
						come from <code>snoutbot[bot]</code>, and the key is kept {keyPlace}.
					</p>
					<ol className="muted small review-app-steps">
						<li>
							Create the App, and give it these repository permissions:{' '}
							{GITHUB_FINE_GRAINED_PERMISSIONS.filter((g) => g.name !== 'Repository access').map((g) => g.name).join(', ')}.
						</li>
						<li>Generate a private key on its settings page. GitHub downloads a <code>.pem</code>.</li>
						<li>Install it on the repositories to review, then paste its App ID below.</li>
					</ol>
					<div className="row">
						<button onClick={() => window.sqlApi.openExternal(GITHUB_NEW_APP_URL)}>
							<Icon name="link-external" /> Create the App on GitHub
						</button>
					</div>
					<label>
						App ID
						<input
							value={appId}
							placeholder="1234567"
							inputMode="numeric"
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setAppId(e.target.value)}
						/>
					</label>
					<div className="row">
						<button className="primary" disabled={busy || appId.trim() === ''} onClick={() => void choose()}>
							<Icon name="folder-opened" /> {busy ? 'Checking…' : 'Choose the private key…'}
						</button>
					</div>
					{error && <div className="form-error">{error}</div>}
				</>
			)}
			{result && installations.length === 0 && (
				<div className="review-empty-list">
					<p><Icon name="warning" /> {result.name} is not installed anywhere yet.</p>
					<p className="muted small">
						The credentials are right, so this is the last step: install the App on the
						repositories it should review. Until then there is nothing for it to look at, and
						nothing here will report an error.
					</p>
					<div className="row">
						<button onClick={() => window.sqlApi.openExternal(`https://github.com/apps/${result.login.replace('[bot]', '')}/installations/new`)}>
							<Icon name="link-external" /> Install it
						</button>
					</div>
				</div>
			)}
			{installations.length > 1 && (
				<label>
					Review as
					<select
						value={forge.appInstallationId ?? ''}
						onChange={async (e) => onChanged(await window.sqlApi.review.setGithubInstallation(Number(e.target.value)))}
					>
						<option value="">Choose an account</option>
						{installations.map((i) => (
							<option key={i.id} value={i.id}>{i.account}</option>
						))}
					</select>
				</label>
			)}
		</>
	);
}

/**
 * How to make reviews come from a bot rather than from you.
 *
 * The honest constraint first, because it is the whole reason this note exists: a comment's
 * author is the account whose token posted it, and NEITHER host lets a token post under another
 * name. A GitHub App can, which is what CodeRabbit and the rest are; this product is deliberately
 * not one, because an App means handing a service access to your repositories and your database.
 *
 * So the answer is a second ACCOUNT, and it is genuinely easy on both hosts: GitHub calls it a
 * machine user, and GitLab's project access tokens already act as a bot user with no new account
 * at all. Nothing in the reviewer needs changing for it — it posts as whoever the token belongs
 * to, and it recognises its own comments by a marker rather than by who wrote them.
 */
function BotAccountNote({ forge }: { forge: ReviewForge }): JSX.Element {
	return (
		<details className="muted small">
			<summary>Post as a bot, not as you</summary>
			<p>
				A comment is written by whoever the token belongs to. Neither GitHub nor GitLab lets a
				token post under a different name, so if reviews should come from "snoutbot" rather than
				from you, connect a token that belongs to a bot account. Nothing else changes: the review
				is the same, and Snoutbot still recognises its own comments.
			</p>
			{forge === 'gitlab' ? (
				<ol>
					<li>In the project (or group), open Settings, Access tokens.</li>
					<li>
						Create one with the <code>{GITLAB_TOKEN_SCOPE}</code> scope and the Developer role.
						GitLab runs it as a bot user, so there is no second account to create.
					</li>
					<li>Disconnect above, and connect that token instead.</li>
				</ol>
			) : (
				<ol>
					<li>Create a second GitHub account for it, what GitHub calls a machine user.</li>
					<li>Invite it to the repositories it should review, with write access.</li>
					<li>
						Sign in as it, create a fine-grained token with the permissions listed above, then
						disconnect here and connect that token instead.
					</li>
				</ol>
			)}
			<p>
				Either way the review comment says who wrote it, in its heading and its footer, so it
				reads as Snoutbot's even while your name is on the byline.
			</p>
		</details>
	);
}

interface RepoCardProps {
	repo: ReviewRepoInfo;
	connections: { id: string; label: string; environment?: string }[];
	onPatch: (changes: Record<string, unknown>) => void;
	onRemove: () => void;
}

function RepoCard({ repo, connections, onPatch, onRemove }: RepoCardProps): JSX.Element {
	return (
		<fieldset className="review-repo">
			<legend>
				{repo.owner}/{repo.name}
			</legend>

			<label className="check">
				<input type="checkbox" checked={repo.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
				<span>Watch this repository</span>
			</label>

			{/* The four choices, 2-up. One per row they were a column of four short selects down the
			    left of a card twice their width (grids of peers go 2-up), and each one's
			    own note then sat between it and the next, so the questions never lined up. Each cell
			    carries its label, its select AND the notes that belong to it. */}
			<div className="review-repo-grid">
			<div className="review-repo-field">
			<label>
				Review against
				<select value={repo.connectionId ?? ''} onChange={(e) => onPatch({ connectionId: e.target.value || undefined })}>
					<option value="">No database (review the text only)</option>
					{connections.map((c) => (
						<option key={c.id} value={c.id}>
							{c.label}
							{c.environment === 'prod' ? ' (production)' : ''}
						</option>
					))}
				</select>
			</label>
			{repo.connectionId && !repo.connectionLabel && (
				<div className="form-error">That connection no longer exists. Pick another, or reviews stay text-only.</div>
			)}
			{repo.connectionIsProd && (
				<p className="muted small">
					<Icon name="warning" /> This is a production connection, so reviews now wait for you to
					read them before they post. Snoutbot only ever reads, and only ever counts (it never
					returns rows), but a staging copy of the same schema gives you almost every finding with
					none of the load.
				</p>
			)}
			</div>

			<div className="review-repo-field">
			<label>
				Run
				<select value={repo.auto} onChange={(e) => onPatch({ auto: e.target.value })}>
					<option value="sql-only">On any pull request that touches SQL</option>
					<option value="always">On every pull request</option>
					<option value="mention">Only when someone asks with @snoutbot</option>
				</select>
			</label>
			</div>

			<div className="review-repo-field">
			<label>
				How deep
				<select value={repo.depth} onChange={(e) => onPatch({ depth: e.target.value })}>
					<option value="connected">Read the schema and measure the data</option>
					<option value="schema">Read the schema only</option>
					<option value="static">Read the diff only</option>
				</select>
			</label>
			</div>

			<div className="review-repo-field">
			{/* The four rungs, in escalation order, and the SAME four Data Flows offers for reading
			    a file. The findings are deterministic on every one of them: this chooses who writes
			    the explanation underneath.
			    The sentence below is COMPUTED by `reviewBoundary`, never typed here, which is what
			    stops this screen and the code disagreeing about where the data goes. */}
			<label>
				How it is reviewed
				<select
					value={repo.method.kind}
					onChange={(e) => onPatch({ method: methodOfKind(e.target.value as ReviewMethod['kind'], repo.method) })}
				>
					<option value="deterministic">The rules only</option>
					{/* The model on this computer is Data Flows' local runtime: a build without Data Flows
					    does not offer it, and shows a repository already set to it as unavailable. */}
					{(PRO_AVAILABLE || repo.method.kind === 'localEngine') && (
						<option value="localEngine" disabled={!PRO_AVAILABLE}>
							{PRO_AVAILABLE ? "The rules, explained by the model on this computer" : "The rules, explained by the model on this computer (not in this build)"}
						</option>
					)}
					<option value="snoutAi">The rules, explained by SnoutData AI</option>
					<option value="byok">The rules, explained by a model of my own</option>
				</select>
			</label>
			{repo.method.kind === 'byok' && (
				<div className="review-method-byok">
					<label>
						Provider
						<select
							value={repo.method.provider}
							onChange={(e) => onPatch({ method: { ...repo.method, provider: e.target.value as ByokProvider } })}
						>
							<option value="ollama">Ollama</option>
							<option value="openai">OpenAI</option>
							<option value="anthropic">Anthropic</option>
							<option value="openrouter">OpenRouter</option>
						</select>
					</label>
					<label>
						Model
						<input
							value={repo.method.model}
							placeholder={repo.method.provider === 'ollama' ? 'qwen2.5:7b' : 'gpt-4o-mini'}
							onChange={(e) => onPatch({ method: { ...repo.method, model: e.target.value } })}
						/>
					</label>
					{repo.method.provider === 'ollama' && (
						// The host is what decides whether this rung is local or a hop onto their
						// network, so it is asked for here rather than assumed to be this machine.
						<label>
							Server
							<input
								value={repo.method.host ?? ''}
								placeholder="http://127.0.0.1:11434"
								onChange={(e) => onPatch({ method: { ...repo.method, host: e.target.value || undefined } })}
							/>
						</label>
					)}
				</div>
			)}
			<p className="muted small review-method-boundary" data-boundary={reviewBoundary(repo.method).boundary}>
				{reviewBoundary(repo.method).sentence}
			</p>
			<p className="muted small">
				The findings never move between these. Every one of them is decided by the rules and
				measured against your database, on all four.
			</p>
			</div>
			</div>

			{/* Off by default: a reviewer that posts is what a reviewer is. Binding a PRODUCTION
			    connection turns it back on once, which is why the note below says so. */}
			<label className="check">
				<input
					type="checkbox"
					checked={repo.approveBeforePosting}
					onChange={(e) => onPatch({ approveBeforePosting: e.target.checked })}
				/>
				<span>Let me read the review before it is posted</span>
			</label>
			<p className="muted small">
				{repo.approveBeforePosting
					? "Reviews wait in the app until you post them, and the check on the commit stays amber while they wait."
					: "Reviews are posted as a comment on the pull request as soon as they finish, and the check on the commit turns green or red. Snoutbot posts as you."}
				{repo.connectionIsProd && " A review against a production connection always waits for you, whatever this says."}
			</p>

			{/* Off by default: an automatic review runs a stranger's SQL past the bound database
			    and posts under the user's name. */}
			<label className="check">
				<input
					type="checkbox"
					checked={repo.reviewOutsiders}
					onChange={(e) => onPatch({ reviewOutsiders: e.target.checked })}
				/>
				<span>Also review changes from forks and outside contributors automatically</span>
			</label>
			<p className="muted small">
				{repo.reviewOutsiders
					? "Every pull request is reviewed on its own, including ones opened from a fork by someone who cannot write to this repository."
					: "Only changes from people who can write to this repository are reviewed on their own. Anyone else's waits until one of them comments a review command; comments from anyone else are ignored."}
			</p>

			<div className="row spread">
				<span className="muted small">
					{repo.lastPolledAt ? `Last checked ${new Date(repo.lastPolledAt).toLocaleTimeString()}` : 'Not checked yet'}
				</span>
				<button className="danger" onClick={onRemove}>
					<Icon name="eye-closed" /> Stop watching
				</button>
			</div>
		</fieldset>
	);
}

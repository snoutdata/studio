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
import { useSecretsWeak } from '../secretsPlace';
import { formatLocale, rich, useT } from '../i18n';

/** What each token permission buys, by the permission's own name (which is GitHub's and GitLab's,
 *  so it stays as they write it). The English is on the tables in shared/review.ts. */
const GRANT_WHY: Record<string, string> = {
	'Repository access': 'review.grants.repositoryAccess',
	'Contents: Read-only': 'review.grants.contents',
	'Pull requests: Read and write': 'review.grants.pullRequests',
	'Issues: Read and write': 'review.grants.issues',
	'Commit statuses: Read and write': 'review.grants.commitStatuses',
	'Metadata: Read-only': 'review.grants.metadata',
	api: 'review.grants.gitlabApi',
};

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
	{ id: 'code', labelKey: 'review.tabs.code' },
	{ id: 'reviewing', labelKey: 'review.tabs.reviewing' },
	{ id: 'repos', labelKey: 'review.tabs.repos' },
] as const;

type ReviewTab = typeof REVIEW_TABS[number]['id'];

interface Props {
	connections: { id: string; label: string; environment?: string }[];
	/** Close settings and show the reviews themselves. */
	onOpenReviews?(): void;
}

export function ReviewSettings({ connections, onOpenReviews }: Props): JSX.Element {
	const t = useT();
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
		return <div className="muted small">{t('settings.common.loading')}</div>;
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
			title: t('review.stopTitle', { repo: `${repo.owner}/${repo.name}` }),
			body: t('review.stopBody'),
			confirmLabel: t('review.stopWatching'),
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
				<p>{rich(t('review.intro'))}</p>
			</SettingsIntro>

			<div className="tabs review-section-tabs">
				{REVIEW_TABS.map((entry) => (
					<button
						type="button"
						key={entry.id}
						className={tab === entry.id ? 'tab active' : 'tab'}
						onClick={() => setTab(entry.id)}
					>
						{t(entry.labelKey)}
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
							{forge.hasToken && <span className="tab-dot" title={t('review.connected')} />}
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
					<span>{t('review.watchMine')}</span>
				</label>
				<p className="muted small">{rich(t('review.pollHelp', { seconds: status.pollSeconds }))}</p>
				<label>
					{t('review.checkEvery')}
					<select
						value={status.pollSeconds}
						onChange={async (e) => setStatus(await window.sqlApi.review.setPollSeconds(Number(e.target.value)))}
					>
						<option value={30}>{t('review.poll30')}</option>
						<option value={60}>{t('review.poll60')}</option>
						<option value={300}>{t('review.poll300')}</option>
						<option value={900}>{t('review.poll900')}</option>
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
						{checking ? t('review.checking') : t('review.checkNow')}
					</button>
					{onOpenReviews && (
						<button onClick={onOpenReviews}>
							<Icon name="git-pull-request" /> {t('review.showReviews')}
						</button>
					)}
					{status.activity
						? <span className="muted small"><Icon name="sync" className="spin" /> {status.activity}…</span>
						: checking && <span className="muted small">{t('review.askingForge', { forge: FORGE_LABELS[activeForge].name })}</span>}
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
					<p className="muted small">{t('review.connectFirst')}</p>
				) : (
					<>
						<p className="muted small">{t('review.pickHelp')}</p>
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
										? t('review.askingWhich', { forge: FORGE_LABELS[activeForge].name })
										: unwatched.length > 0
											? t('review.pickRepo', { count: unwatched.length })
											: t('review.allWatched')}
								</option>
								{unwatched.map((repo) => (
									<option key={repo.id} value={repo.id}>
										{repo.owner}/{repo.name}
										{repo.private ? ` · ${t('review.private')}` : ''}
										{repo.archived ? ` · ${t('review.archived')}` : ''}
										{repo.canComment ? '' : ` · ${t('review.cannotComment')}`}
									</option>
								))}
							</select>
							<button disabled={listBusy} onClick={() => void loadRepositories()}>
								<Icon name="refresh" /> {listBusy ? t('settings.common.loading') : t('settings.common.refresh')}
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
										{!repo.enabled && <span className="muted small">{t('review.paused')}</span>}
										<button type="button" className="link-btn" onClick={() => void stopWatching(repo)}>
											{t('review.remove')}
										</button>
									</li>
								))}
							</ul>
						)}
						{listError && (
							<div className="form-error">
								{listError}
								<button className="link-btn" onClick={() => void loadRepositories()}>{t('review.tryAgain')}</button>
							</div>
						)}
						{available !== undefined && available.length === 0 && (
							// An empty list is a RESULT, not a blank screen. The two things that
							// actually cause it are a scope that is too narrow and an organization
							// whose SSO the token was never authorized for, and neither is guessable
							// from here — so both are named, with the page that fixes them.
							<div className="review-empty-list">
								<p>
									<Icon name="warning" /> {t('review.noReach')}
								</p>
								<p className="muted small">{t('review.noReachHelp')}</p>
								<ul className="muted small">
									<li>
										{rich(t('review.cause1', { scope: GITLAB_TOKEN_SCOPE }))}
										{' '}
										{scopesReported.length > 0
											? t('review.scopesReport', { scopes: scopesReported.join(', ') })
											: t('review.noScopes')}
									</li>
									<li>{t('review.cause2')}</li>
								</ul>
								<div className="row">
									{status.forges.filter((f) => f.hasToken).map((f) => (
										<button
											key={f.kind}
											onClick={() => window.sqlApi.openExternal(
												f.kind === 'gitlab' ? gitlabTokenUrl(f.baseUrl ?? '') : GITHUB_FINE_GRAINED_URL,
											)}
										>
											<Icon name="link-external" /> {t('review.checkTokenOn', { forge: FORGE_LABELS[f.kind].name })}
										</button>
									))}
									<button className="secondary" onClick={() => void loadRepositories()}>
										<Icon name="refresh" /> {t('review.lookAgain')}
									</button>
								</div>
							</div>
						)}
					</>
				)}

				<details className="muted small">
					<summary>{t('review.addByName')}</summary>
					<p>{t('review.addByNameHelp')}</p>
					<div className="row">
						<input
							className="grow"
							value={repoRef}
							placeholder={t('review.repoPlaceholder')}
							onChange={(e) => setRepoRef(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && repoRef.trim() !== '') {
									void addRepo();
								}
							}}
						/>
						<button disabled={repoRef.trim() === ''} onClick={() => void addRepo()}>
							<Icon name="eye" /> {t('review.watch')}
						</button>
					</div>
					{repoError && <div className="form-error">{repoError}</div>}
				</details>
				</div>

				<div className="review-watched">
				{status.repos.length === 0 ? (
					<p className="muted small">{t('review.nothingWatched')}</p>
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
	const t = useT();
	const keyPlace = t(useSecretsWeak() ? 'settings.secretsPlace.file' : 'settings.secretsPlace.keychain');
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
					<p className="small">{t('review.postedBy')}</p>
					<div className="review-identity">
						{([
							['token', t('review.identityYou'), t('review.identityYouWhy')],
							['app', 'Snoutbot', t('review.identityAppWhy')],
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
						<Icon name={label.icon} /> {rich(t('review.connectedAs', { login: forge.login ?? t('review.yourAccount') }))}
						{forge.scopes.length > 0 && <span className="muted small"> ({forge.scopes.join(', ')})</span>}
						{forge.kind === 'gitlab' && forge.baseUrl && (
							<span className="muted small"> {t('review.atBase', { url: forge.baseUrl })}</span>
						)}
						<div className="muted small">{t('review.postedByThis')}</div>
					</div>
					<button
						onClick={async () => {
							onConnected();
							onChanged(await window.sqlApi.review.clearToken(forge.kind));
						}}
					>
						<Icon name="debug-disconnect" /> {t('review.disconnect')}
					</button>
				</div>
			) : null}
			{forge.hasToken && forge.auth !== 'app' && <BotAccountNote forge={forge.kind} />}
			{forge.hasToken || (forge.kind === 'github' && forge.auth === 'app') ? null : (
				<>
					<p className="muted small">{t('review.postsAs', { place: keyPlace })}</p>
					{/* What to tick, UP HERE rather than folded away below the token field. It was one
					    comma-joined sentence inside a <details>, which is the wrong shape for something
					    the user reads on this screen and ticks on another one. Each line says what it
					    buys, which is also the argument that the set is minimal. */}
					<p className="small">{t('review.whatToAllow')}</p>
					<ul className="review-grants">
						{(forge.kind === 'gitlab' ? GITLAB_TOKEN_PERMISSIONS : GITHUB_FINE_GRAINED_PERMISSIONS).map((grant) => (
							<li key={grant.name}>
								<code>{grant.name}</code>
								<span className="why">{GRANT_WHY[grant.name] ? t(GRANT_WHY[grant.name]) : grant.why}</span>
							</li>
						))}
					</ul>
					<p className="muted small">
						{forge.kind === 'gitlab' ? t('review.neverPushesGitlab') : t('review.neverPushesGithub')}
					</p>
					{forge.kind === 'gitlab' && (
						<>
							<label>
								{t('review.whichGitlab')}
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
							<p className="muted small">{t('review.whichGitlabHelp')}</p>
						</>
					)}
					<label>
						{t('review.pat')}
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
							<Icon name="plug" /> {busy ? t('review.checkingShort') : t('review.connect')}
						</button>
						<button
							onClick={() => window.sqlApi.openExternal(
								forge.kind === 'gitlab'
									? gitlabTokenUrl(baseUrl.trim() || forge.baseUrl || 'https://gitlab.com')
									: GITHUB_FINE_GRAINED_URL,
							)}
						>
							<Icon name="link-external" /> {t('review.createTokenOn', { forge: label.name })}
						</button>
					</div>
					{error && <div className="form-error">{error}</div>}
					<details className="muted small">
						<summary>{forge.kind === 'github' ? t('review.whyGithub') : t('review.whyGitlab')}</summary>
						{forge.kind === 'gitlab' ? (
							<p>{rich(t('review.gitlabBroad', { scope: GITLAB_TOKEN_SCOPE }))}</p>
						) : (
							<>
								<p>{t('review.fineGrained1')}</p>
								<p>{rich(t('review.fineGrained2'))}</p>
								<p>
									{t('review.fineGrained3Before')}{' '}
									<a
										href="#"
										onClick={(e) => {
											e.preventDefault();
											window.sqlApi.openExternal(GITHUB_CLASSIC_TOKEN_URL);
										}}
									>
										{t('review.classicToken')}
									</a>{' '}
									{rich(t('review.fineGrained3After'))}
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
	const t = useT();
	const keyPlace = t(useSecretsWeak() ? 'settings.secretsPlace.file' : 'settings.secretsPlace.keychain');
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
						<Icon name="github" /> {rich(t('review.postingAs', { login: forge.login ?? t('review.theApp') }))}
						<div className="muted small">
							{forge.appInstallationId
								? t('review.appLineInstall', { id: forge.appId ?? '', installation: String(forge.appInstallationId) })
								: t('review.appLine', { id: forge.appId ?? '' })}.{' '}
							{t('review.privateKeyKept', { place: keyPlace })}
						</div>
					</div>
					<button onClick={() => void choose()} disabled={busy}>
						<Icon name="key" /> {busy ? t('review.checkingShort') : t('review.replaceKey')}
					</button>
				</div>
			) : (
				<>
					<p className="muted small">{rich(t('review.appHelp', { place: keyPlace }))}</p>
					<ol className="muted small review-app-steps">
						<li>
							{t('review.appStep1')}{' '}
							{GITHUB_FINE_GRAINED_PERMISSIONS.filter((g) => g.name !== 'Repository access').map((g) => g.name).join(', ')}.
						</li>
						<li>{rich(t('review.appStep2'))}</li>
						<li>{t('review.appStep3')}</li>
					</ol>
					<div className="row">
						<button onClick={() => window.sqlApi.openExternal(GITHUB_NEW_APP_URL)}>
							<Icon name="link-external" /> {t('review.createAppOn')}
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
							<Icon name="folder-opened" /> {busy ? t('review.checkingShort') : t('review.chooseKey')}
						</button>
					</div>
					{error && <div className="form-error">{error}</div>}
				</>
			)}
			{result && installations.length === 0 && (
				<div className="review-empty-list">
					<p><Icon name="warning" /> {t('review.notInstalled', { name: result.name })}</p>
					<p className="muted small">{t('review.notInstalledHelp')}</p>
					<div className="row">
						<button onClick={() => window.sqlApi.openExternal(`https://github.com/apps/${result.login.replace('[bot]', '')}/installations/new`)}>
							<Icon name="link-external" /> {t('review.installIt')}
						</button>
					</div>
				</div>
			)}
			{installations.length > 1 && (
				<label>
					{t('review.reviewAs')}
					<select
						value={forge.appInstallationId ?? ''}
						onChange={async (e) => onChanged(await window.sqlApi.review.setGithubInstallation(Number(e.target.value)))}
					>
						<option value="">{t('review.chooseAccount')}</option>
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
	const t = useT();
	return (
		<details className="muted small">
			<summary>{t('review.botSummary')}</summary>
			<p>{t('review.botHelp')}</p>
			{forge === 'gitlab' ? (
				<ol>
					<li>{t('review.botGitlab1')}</li>
					<li>{rich(t('review.botGitlab2', { scope: GITLAB_TOKEN_SCOPE }))}</li>
					<li>{t('review.botGitlab3')}</li>
				</ol>
			) : (
				<ol>
					<li>{t('review.botGithub1')}</li>
					<li>{t('review.botGithub2')}</li>
					<li>{t('review.botGithub3')}</li>
				</ol>
			)}
			<p>{t('review.botFooter')}</p>
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
	const t = useT();
	return (
		<fieldset className="review-repo">
			<legend>
				{repo.owner}/{repo.name}
			</legend>

			<label className="check">
				<input type="checkbox" checked={repo.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
				<span>{t('review.watchThis')}</span>
			</label>

			{/* The four choices, 2-up. One per row they were a column of four short selects down the
			    left of a card twice their width (grids of peers go 2-up), and each one's
			    own note then sat between it and the next, so the questions never lined up. Each cell
			    carries its label, its select AND the notes that belong to it. */}
			<div className="review-repo-grid">
			<div className="review-repo-field">
			<label>
				{t('review.reviewAgainst')}
				<select value={repo.connectionId ?? ''} onChange={(e) => onPatch({ connectionId: e.target.value || undefined })}>
					<option value="">{t('review.noDb')}</option>
					{connections.map((c) => (
						<option key={c.id} value={c.id}>
							{c.label}
							{c.environment === 'prod' ? ` ${t('review.production')}` : ''}
						</option>
					))}
				</select>
			</label>
			{repo.connectionId && !repo.connectionLabel && (
				<div className="form-error">{t('review.connectionGone')}</div>
			)}
			{repo.connectionIsProd && (
				<p className="muted small">
					<Icon name="warning" /> {t('review.prodWarning')}
				</p>
			)}
			</div>

			<div className="review-repo-field">
			<label>
				{t('review.run')}
				<select value={repo.auto} onChange={(e) => onPatch({ auto: e.target.value })}>
					<option value="sql-only">{t('review.runSqlOnly')}</option>
					<option value="always">{t('review.runAlways')}</option>
					<option value="mention">{t('review.runMention')}</option>
				</select>
			</label>
			</div>

			<div className="review-repo-field">
			<label>
				{t('review.howDeep')}
				<select value={repo.depth} onChange={(e) => onPatch({ depth: e.target.value })}>
					<option value="connected">{t('review.deepConnected')}</option>
					<option value="schema">{t('review.deepSchema')}</option>
					<option value="static">{t('review.deepStatic')}</option>
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
				{t('review.howReviewed')}
				<select
					value={repo.method.kind}
					onChange={(e) => onPatch({ method: methodOfKind(e.target.value as ReviewMethod['kind'], repo.method) })}
				>
					<option value="deterministic">{t('review.methodRules')}</option>
					{/* The model on this computer is Data Flows' local runtime: a build without Data Flows
					    does not offer it, and shows a repository already set to it as unavailable. */}
					{(PRO_AVAILABLE || repo.method.kind === 'localEngine') && (
						<option value="localEngine" disabled={!PRO_AVAILABLE}>
							{PRO_AVAILABLE ? t('review.methodLocal') : t('review.methodLocalNotInBuild')}
						</option>
					)}
					<option value="snoutAi">{t('review.methodSnoutAi')}</option>
					<option value="byok">{t('review.methodByok')}</option>
				</select>
			</label>
			{repo.method.kind === 'byok' && (
				<div className="review-method-byok">
					<label>
						{t('review.provider')}
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
						{t('review.model')}
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
							{t('review.server')}
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
			<p className="muted small">{t('review.findingsSame')}</p>
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
				<span>{t('review.readBeforePost')}</span>
			</label>
			<p className="muted small">
				{repo.approveBeforePosting ? t('review.waitsInApp') : t('review.postedDirect')}
				{repo.connectionIsProd && ` ${t('review.prodAlwaysWaits')}`}
			</p>

			{/* Off by default: an automatic review runs a stranger's SQL past the bound database
			    and posts under the user's name. */}
			<label className="check">
				<input
					type="checkbox"
					checked={repo.reviewOutsiders}
					onChange={(e) => onPatch({ reviewOutsiders: e.target.checked })}
				/>
				<span>{t('review.reviewOutsiders')}</span>
			</label>
			<p className="muted small">
				{repo.reviewOutsiders ? t('review.outsidersOn') : t('review.outsidersOff')}
			</p>

			<div className="row spread">
				<span className="muted small">
					{repo.lastPolledAt ? t('review.lastChecked', { time: new Date(repo.lastPolledAt).toLocaleTimeString(formatLocale()) }) : t('review.notChecked')}
				</span>
				<button className="danger" onClick={onRemove}>
					<Icon name="eye-closed" /> {t('review.stopWatching')}
				</button>
			</div>
		</fieldset>
	);
}

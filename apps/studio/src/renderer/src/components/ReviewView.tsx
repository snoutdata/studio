/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react';
import { PRO_AVAILABLE } from '@snout/studio-pro/renderer';

import { FORGE_LABELS, reviewBoundary } from '../../../shared/review';
import type { ReviewMethod, ReviewPollResult, ReviewRun, ReviewStatus } from '../../../shared/review';
import { depthLine, findingsSummary, runLabel } from '../reviewRuns';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { formatLocale, rich, useT, type Translate } from '../i18n';

/** One line for what Check now found, so a check that finds nothing still says it looked. */
function pollLine(result: ReviewPollResult, t: Translate): string {
	if (result.outcome === 'noRepos') {
		return t('reviews.poll.noRepos');
	}
	if (result.outcome === 'busy') {
		return t('reviews.poll.busy');
	}
	const time = new Date(result.at).toLocaleTimeString(formatLocale(), { hour: 'numeric', minute: '2-digit' });
	if (result.errors.length > 0) {
		return t('reviews.poll.errors', { errors: result.errors.join('; ') });
	}
	const where = t('reviews.poll.repos', { count: result.repos });
	const found = t('reviews.poll.found', { count: result.reviewed });
	return t('reviews.poll.checked', { where, time, found });
}

/** What each rung is called, in one place, so the meta line and the buttons cannot disagree. */
const METHOD_LABELS: Record<ReviewMethod['kind'], string> = {
	deterministic: 'reviews.methods.deterministic',
	localEngine: 'reviews.methods.localEngine',
	snoutAi: 'reviews.methods.snoutAi',
	byok: 'reviews.methods.byok',
};

/** Each rung's glyph and its one line on where the review goes, for the re-run choices. The full
 *  sentence (reviewBoundary) stays on hover; this is the part that fits under a label. */
/** The rungs a review can be asked again on. The model on this computer is Data Flows' local
 *  runtime, so a build without Data Flows does not offer it. */
const RERUN_KINDS: readonly ReviewMethod['kind'][] = PRO_AVAILABLE ? ['deterministic', 'localEngine', 'snoutAi', 'byok'] : ['deterministic', 'snoutAi', 'byok'];

const METHOD_CHOICES: Record<ReviewMethod['kind'], { icon: string; hint: string }> = {
	deterministic: { icon: 'checklist', hint: 'reviews.hints.deterministic' },
	localEngine: { icon: 'device-desktop', hint: 'reviews.hints.localEngine' },
	snoutAi: { icon: 'sparkle', hint: 'reviews.hints.snoutAi' },
	byok: { icon: 'key', hint: 'reviews.hints.byok' },
};

/**
 * The method to re-run on, given a rung and the one that just ran.
 *
 * The byok details come from the run being re-read when it HAS them, so asking for "your own model"
 * again does not lose the Ollama host that produced the review on screen. Coming from another rung
 * there is nothing to inherit, and main answers with what it cannot resolve rather than guessing.
 */
function rerunMethod(kind: ReviewMethod['kind'], current: ReviewMethod): ReviewMethod {
	switch (kind) {
		case 'deterministic':
			return { kind: 'deterministic' };
		case 'localEngine':
			return { kind: 'localEngine' };
		case 'snoutAi':
			return { kind: 'snoutAi', consent: true };
		case 'byok':
			return current.kind === 'byok' ? current : { kind: 'byok', provider: 'ollama', model: '', consent: true };
	}
}

/*
 * Snoutbot's reviews, in the app.
 *
 * This is the ONE thing the desktop reviewer can do that the cloud one cannot: **read the review
 * before it is posted**. The app comments from the user's own account, so a review going out
 * unread is their name on somebody else's pull request. Everything else here is in service of
 * that: the list is on the left so a waiting review is visible without hunting, the markdown is
 * exactly what GitHub will show, and the two buttons are the whole decision.
 *
 * The list is what the main process is holding in memory, which is deliberate and is said on the
 * screen: a review is about a COMMIT, and one restored from disk after a restart would be about a
 * commit that has since been pushed over. Stale is worse than absent here.
 */

interface ReviewViewProps {
	/** Hidden rather than unmounted when another tab is in front, like every workbench view. */
	active: boolean;
	/**
	 * Show THIS review, because something outside the view asked for it (the toast's button).
	 *
	 * The `nonce` is what makes asking twice work: without it, clicking the card for a review
	 * that is already selected is a no-op, and clicking the card for a review while a different
	 * one is open leaves the person looking at the wrong one and blaming the button.
	 */
	select?: { runId: string; nonce: number };
	onOpenSettings(): void;
	onClose(): void;
}

export function ReviewView({ active, select, onOpenSettings, onClose }: ReviewViewProps): JSX.Element {
	const t = useT();
	const [runs, setRuns] = useState<ReviewRun[]>([]);
	const [status, setStatus] = useState<ReviewStatus | undefined>();
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [checking, setChecking] = useState(false);
	const [checked, setChecked] = useState<ReviewPollResult | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		const [next, nextStatus] = await Promise.all([window.sqlApi.review.runs(), window.sqlApi.review.status()]);
		setRuns(next);
		setStatus(nextStatus);
		// Select the review that most wants reading: the oldest one still waiting for a decision,
		// or failing that the newest. Only when nothing is selected, so a poll landing mid-read
		// never moves the page out from under the person.
		setSelectedId((current) => {
			if (current && next.some((run) => run.id === current)) {
				return current;
			}
			const waiting = [...next].reverse().find((run) => run.awaitingApproval);
			return (waiting ?? next[0])?.id;
		});
	}, []);

	useEffect(() => {
		void refresh();
		return window.sqlApi.onReviewChanged(() => void refresh());
	}, [refresh]);

	// Asked for from outside. It wins over the automatic choice below, and it re-runs on the
	// nonce rather than on the id, so the same review can be asked for twice.
	useEffect(() => {
		if (select) {
			setSelectedId(select.runId);
			setError(undefined);
		}
	}, [select?.nonce, select?.runId]);

	const selected = runs.find((run) => run.id === selectedId);
	// Whose account the comment goes out as, and what that host calls a change. A review of a
	// GitLab project must not offer to post it to a pull request.
	const host = selected ? status?.forges.find((f) => f.kind === selected.forge) : undefined;
	const words = FORGE_LABELS[selected?.forge ?? 'github'];

	const approve = async (run: ReviewRun): Promise<void> => {
		setBusy(true);
		setError(undefined);
		const result = await window.sqlApi.review.approve(run.id);
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? t('reviews.commentFailed'));
		}
		await refresh();
	};

	/**
	 * Review the same commit again on another rung.
	 *
	 * The override is passed per call and never saved: this is "let me see what that one says",
	 * not "change what this repository does". A failure is shown here rather than swallowed,
	 * because the commonest one by far is a local rung that has not been set up, and the sentence
	 * main sends back names the fix.
	 */
	const rerun = async (run: ReviewRun, kind: ReviewMethod['kind']): Promise<void> => {
		setBusy(true);
		setError(undefined);
		try {
			const produced = await window.sqlApi.review.reviewPull(run.repoId, run.prNumber, false, rerunMethod(kind, run.method));
			if (!produced) {
				setError(t('reviews.rerunFailed'));
			} else {
				setSelectedId(produced.id);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
		setBusy(false);
		await refresh();
	};

	const discard = async (run: ReviewRun): Promise<void> => {
		setRuns(await window.sqlApi.review.discard(run.id));
		setSelectedId(undefined);
	};

	return (
		<div className="review-view" data-test="review-view">
			<div className="review-view-bar">
				<span className="review-view-title">
					<Icon name="git-pull-request" /> {t('reviews.title')}
				</span>
				{status?.activity
					? <span className="muted small">{status.activity}</span>
					: checked && <span className={checked.errors.length > 0 ? 'small review-check-error' : 'muted small'} data-test="review-check-result">{pollLine(checked, t)}</span>}
				<span className="spacer" />
				<button
					className="secondary"
					disabled={!status?.enabled || checking}
					title={status?.enabled ? t('reviews.check.tooltip') : t('reviews.check.tooltipOff')}
					onClick={() => {
						setChecking(true);
						void window.sqlApi.review.pollNow()
							.then(setChecked)
							.finally(() => setChecking(false));
					}}
				>
					<Icon name={checking ? 'loading' : 'refresh'} className={checking ? 'codicon-modifier-spin' : undefined} /> {checking ? t('reviews.check.checking') : t('reviews.check.now')}
				</button>
				<button className="secondary" onClick={onOpenSettings}><Icon name="settings-gear" /> {t('reviews.settings')}</button>
				<button className="icon-button" title={t('reviews.close')} onClick={onClose}><Icon name="close" /></button>
			</div>

			{runs.length === 0 ? (
				<Empty status={status} onOpenSettings={onOpenSettings} />
			) : (
				<div className="review-view-body">
					<div className="review-list">
						{runs.map((run) => (
							<button
								key={run.id}
								className={`review-list-item${run.id === selectedId ? ' chosen' : ''}`}
								data-test="review-list-item"
								onClick={() => { setSelectedId(run.id); setError(undefined); }}
							>
								<span className="review-list-head">
									<span className="review-list-name">{runLabel(run)}</span>
									{run.awaitingApproval && <span className="review-pill waiting">{t('reviews.waiting')}</span>}
									{run.blockers > 0 && <span className="review-pill blocker">{run.blockers}</span>}
								</span>
								{run.prTitle && <span className="review-list-sub">{run.prTitle}</span>}
								<span className="review-list-meta">
									{findingsSummary(run)} · {new Date(run.at).toLocaleTimeString(formatLocale())}
								</span>
							</button>
						))}
					</div>

					{selected && (
						<div className="review-detail" key={selected.id} data-test="review-detail">
							<div className="review-detail-head">
								<h2>{selected.prTitle || runLabel(selected)}</h2>
								<div className="review-detail-meta">
									<span>{runLabel(selected)}</span>
									<span>·</span>
									<span title={t('reviews.detail.shaTitle')}>
										{selected.headSha.slice(0, 7)}
									</span>
									<span>·</span>
									{/* Rule 3: never print a number without what it was measured on. */}
									<span>{depthLine(selected)}</span>
									<span>·</span>
									{/* WHICH RUNG RAN. The findings are the same on all four, but "why does this
									    one read differently from the last one" is the first thing anybody asks,
									    and the only answer on screen used to be a model name at the foot of the
									    prose, with nothing at all on the rules-only rung. */}
									<span title={reviewBoundary(selected.method).sentence}>{t(METHOD_LABELS[selected.method.kind])}</span>
									<span>·</span>
									<span>{new Date(selected.at).toLocaleString(formatLocale())}</span>
									{selected.prUrl && (
										<button type="button" className="link-btn" onClick={() => void window.sqlApi.openExternal(selected.prUrl!)}>
											{t('reviews.detail.openOnGithub')}
										</button>
									)}
								</div>
							</div>

							{/* A link in the comment goes to the user's browser, not this window: the renderer
							    navigating away from the app is a one-way trip out of it. */}
							{active && (
								<div className="review-comment-host" onClick={openLinksExternally}>
									<Markdown className="review-comment" source={selected.body} />
								</div>
							)}

							{/* The database's own words, here and never in the comment. Plain text, so a
							    name the pull request chose is shown and not rendered. */}
							{active && selected.localErrors && selected.localErrors.length > 0 && (
								<details className="review-local-errors" data-test="review-local-errors">
									<summary>{t('reviews.detail.localErrors', { count: selected.localErrors.length })}</summary>
									<ul>
										{selected.localErrors.map((e, i) => (
											<li key={i}>
												<span className="muted">{clip(e.about)}</span>
												<pre>{clip(e.error)}</pre>
											</li>
										))}
									</ul>
								</details>
							)}

							{error && <div className="form-error">{error}</div>}

							<div className="review-actions">
								{selected.awaitingApproval ? (
									<>
										<span className="muted small review-actions-note">
											{host?.login
												? rich(t('reviews.detail.notPostedAs', { pullRequest: words.pullRequest, login: host.login }))
												: t('reviews.detail.notPostedYou', { pullRequest: words.pullRequest })}
										</span>
										<button onClick={() => void discard(selected)}><Icon name="discard" /> {t('reviews.detail.discard')}</button>
										<button className="primary" data-test="review-approve" disabled={busy} onClick={() => void approve(selected)}><Icon name="comment" /> 
											{busy ? t('reviews.detail.posting') : t('reviews.detail.post', { name: words.name })}
										</button>
									</>
								) : (
									<>
										<span className="muted small review-actions-note">
											<Icon name="check" /> {host?.login
												? t('reviews.detail.postedAs', { pullRequest: words.pullRequest, login: host.login })
												: t('reviews.detail.posted', { pullRequest: words.pullRequest })}
										</span>
										<button onClick={() => void discard(selected)}><Icon name="trash" /> {t('reviews.detail.remove')}</button>
									</>
								)}
							</div>

							{/* REVIEW IT AGAIN, on a different rung. The findings are deterministic, so what
							    this re-runs is who writes the explanation; if a number HAS moved since,
							    that is the database changing underneath and is worth seeing. It is a
							    one-off and is never written back to the repository's setting: trying our
							    AI once on a repository set to the rules alone must not change what that
							    repository does from then on. Both reviews stay in the list, because the
							    point of asking again is to compare the answers. */}
							<div className="review-rerun">
								<div className="review-rerun-head"><Icon name="refresh" /> {t('reviews.detail.again')}</div>
								<div className="review-rerun-grid">
									{RERUN_KINDS.map((kind) => {
										const current = kind === selected.method.kind;
										return (
											<button
												key={kind}
												type="button"
												className={`review-rerun-choice${current ? ' current' : ''}`}
												data-test={`review-rerun-${kind}`}
												disabled={busy || current}
												title={current ? t('reviews.detail.wroteThisTitle') : reviewBoundary(rerunMethod(kind, selected.method)).sentence}
												onClick={() => void rerun(selected, kind)}
											>
												<Icon name={METHOD_CHOICES[kind].icon} />
												<span className="review-rerun-text">
													<span className="review-rerun-label">{t(METHOD_LABELS[kind])}</span>
													<span className="review-rerun-hint">{current ? t('reviews.detail.wroteThis') : t(METHOD_CHOICES[kind].hint)}</span>
												</span>
												{current && <Icon name="check" />}
											</button>
										);
									})}
								</div>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** A database error can be any length; the tab shows enough of it to act on. */
function clip(text: string): string {
	return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/** Send an http(s) link inside the rendered comment to the user's browser. Without this the
 *  renderer would navigate to GitHub and the app would be gone. */
function openLinksExternally(e: React.MouseEvent<HTMLDivElement>): void {
	// A link inside <Markdown> has already been handled (and opened) by it.
	if (e.defaultPrevented) {
		return;
	}
	const href = (e.target as HTMLElement).closest('a')?.getAttribute('href');
	if (href && /^https?:/i.test(href)) {
		e.preventDefault();
		void window.sqlApi.openExternal(href);
	}
}

/** Nothing has run yet. Which sentence to show depends on how far the user has actually got, so
 *  the screen answers "why is this empty" rather than restating that it is. */
function Empty({ status, onOpenSettings }: { status?: ReviewStatus; onOpenSettings(): void }): JSX.Element {
	const t = useT();
	const reason = !status
		? ''
		: !status.forges.some((f) => f.hasToken)
			? t('reviews.empty.connect')
			: status.repos.length === 0
				? t('reviews.empty.addRepo')
				: !status.enabled
					? t('reviews.empty.off')
					: t('reviews.empty.nothing');
	return (
		<div className="review-empty" data-test="review-empty">
			<Icon name="git-pull-request" />
			<h3>{t('reviews.empty.title')}</h3>
			<p>{reason}</p>
			<button onClick={onOpenSettings}><Icon name="settings-gear" /> {t('reviews.empty.openSettings')}</button>
			<p className="muted small">
				{t('reviews.empty.note')}
			</p>
		</div>
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASSISTANT_INTRO, ASSISTANT_NAME } from '../../../shared/assistant';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { AssistantArt } from '../art/Illustrations';
import type { AuthProviderId, AuthState, Tier } from '../../../shared/auth';
import { ssoDomainFromEmail } from '../../../shared/auth';
import type { AiBudgetStatus, AiModelInfo } from '../../../shared/ai';

const TIER_LABEL: Record<Tier, string> = { free: 'Free', plus: 'Plus', pro: 'Pro', business: 'Business' };

// Plan comparison shown to every signed-in user. What a plan unlocks is
// decided by the tier (main/entitlements.ts); what it COSTS, and which models it serves, change on
// their own schedule and are stated once, on the website's pricing page (PRICING_URL), so this
// screen names the plans and what sets them apart and links there for the numbers. Agentic mode is
// not a plan feature (every signed-in user gets it), so it is part of the base assistant under Free.
//
// Business is bought by a company for its people, so it is the one row here nobody can buy from
// this screen. Enterprise is deliberately absent: it is quote-only, and the pricing page carries it.
const PLANS: { tier: Tier; perks: string[] }[] = [
	{ tier: 'free', perks: ['Monthly AI credits, on us', 'Full SQL assistant'] },
	{ tier: 'plus', perks: ['Premium cloud models', 'A bigger monthly AI-credit balance', 'AI audit logging'] },
	{ tier: 'pro', perks: ['Everything in Plus', '3x the monthly AI credits of Plus'] },
	{ tier: 'business', perks: ['Everything in Pro, for everyone on the team', 'SAML single sign-on, included and not an add-on', 'Per seat, bought by your company'] },
];

/** Prices, and what each plan includes today, live on the website. */
const PRICING_URL = 'https://snoutdata.com/pricing';

// Pay-as-you-go credit packs. Plus & Pro only; each opens the website checkout for that pack.
// The dollar amounts are the customer price; what a pack grants is decided server-side, so the
// app only needs the price label here.
const CREDIT_PACKS: number[] = [5, 10, 20];
const BUY_CREDITS_URL = 'https://snoutdata.com/buy-credits';

/** Format a USD amount for the credit balance line, e.g. 3 → "$3.00". */
/** The signed-in person's picture, or the placeholder when there is none or it cannot load: the
 *  page's Content-Security-Policy allows only the Google and GitHub avatar hosts (rendererCsp.ts),
 *  so a picture from an SSO provider elsewhere falls back here rather than showing a broken image. */
function Avatar({ url }: { url?: string | null }): JSX.Element {
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		setFailed(false);
	}, [url]);
	if (!url || failed) {
		return <span className="account-avatar placeholder"><Icon name="account" /></span>;
	}
	return <img className="account-avatar" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** One model in the Account screen's breakdown: friendly name + speed/power label + blurb. */
function ModelRow({ model }: { model: AiModelInfo }): JSX.Element {
	return (
		<div className="account-model-row">
			<span className="account-model-id">
				<span className="tree-label">{model.displayName?.trim() || model.model}</span>
				{model.description && <span className="muted small">{model.description}</span>}
			</span>
			{model.label && <span className="model-picker-label">{model.label}</span>}
			{model.recommended && <span className="model-picker-tag">Recommended</span>}
		</div>
	);
}

/** Format the reset timestamp as a plain date (no time), e.g. "resets Jun 30". */
function resetLabel(iso: string): string | null {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) {
		return null;
	}
	return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Format the account-creation timestamp as month + year, e.g. "May 2026". */
function memberSince(iso: string): string | null {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) {
		return null;
	}
	return when.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

interface AccountSectionProps {
	auth: AuthState;
	/** True while a sign-in/out round-trip is in flight (buttons disabled). */
	busy: boolean;
	/** Why the last sign-in did not start (no SSO for that domain, the service unreachable), or null. */
	signInError?: string | null;
	/** `workEmail` is passed only for the 'sso' provider: its domain picks the identity provider. */
	onSignIn(provider: AuthProviderId, workEmail?: string): void;
	onSignOut(): void;
	/** Abandon an in-flight browser sign-in (e.g. the user closed the OAuth tab) so the
	 *  providers are clickable again. */
	onCancelSignIn(): void;
}

/** The Account tab of the Settings page. Signed out: provider buttons (a browser window
 *  completes the OAuth round-trip). Signed in: profile + member-since, live plan usage, the
 *  models included vs. metered, and the plan comparison (Pro's incentive: more usage). Renders
 *  bare sections that flow inside the Settings content column. */
export function AccountSection(props: AccountSectionProps): JSX.Element {
	const { user, tier } = props.auth;
	const [budget, setBudget] = useState<AiBudgetStatus | null>(null);
	const [models, setModels] = useState<AiModelInfo[]>([]);
	const [refreshing, setRefreshing] = useState(false);
	// The wallet→credits switch: whether the assistant spends purchased credits once the monthly
	// wallet is exhausted. `togglingCredits` disables the switch while the write to ai_preferences
	// is in flight.
	const [creditsEnabled, setCreditsEnabled] = useState(false);
	const [togglingCredits, setTogglingCredits] = useState(false);
	// Sub-tab within the Account screen, so the (otherwise long) page isn't one crowded scroll:
	// Usage (live spend + extra credits), Plans (the comparison), Models (what you can reach). The
	// profile header and the actions row stay outside the tabs, always visible.
	const [accountTab, setAccountTab] = useState<'usage' | 'plans' | 'models'>('usage');
	// Single sign-on asks for one thing the other two providers don't: which company. `ssoOpen`
	// keeps that question folded away until it is wanted, so the common path stays two buttons.
	const [ssoOpen, setSsoOpen] = useState(false);
	const [ssoEmail, setSsoEmail] = useState('');
	// Null until what's typed could be a domain, which is also what disables Continue. The same
	// function derives the domain main actually sends, so the button and the call agree.
	const ssoDomain = ssoDomainFromEmail(ssoEmail);

	// Read live plan usage + the reachable models (with their metadata + metered flag) from the
	// gateway when signed in. Best-effort: a null/empty result (signed out, gateway unreachable)
	// just leaves those sections out. `alive` lets a caller bail if it was torn down mid-flight.
	const loadUsage = useCallback((alive: () => boolean = () => true): void => {
		if (!user) {
			setBudget(null);
			setModels([]);
			setCreditsEnabled(false);
			return;
		}
		window.sqlApi.aiBudgetStatus().then((status) => { if (alive()) { setBudget(status); } });
		window.sqlApi.aiCreditsEnabled().then((enabled) => { if (alive()) { setCreditsEnabled(enabled); } }).catch(() => undefined);
		window.sqlApi.aiProviderStatus().then((statuses) => {
			if (!alive()) {
				return;
			}
			const cloud = statuses.find((s) => s.provider === 'positron-cloud');
			setModels(cloud?.models ?? []);
		}).catch(() => { if (alive()) { setModels([]); } });
	}, [user]);

	useEffect(() => {
		let live = true;
		loadUsage(() => live);
		return () => { live = false; };
	}, [loadUsage]);

	// Re-sync entitlements once when the Account screen opens, so a model released since the key
	// was last minted shows up here without the user hitting "Refresh plan". The resulting
	// auth:changed push reloads the lists above via `loadUsage`. Mount-only (empty deps) and a
	// no-op while signed out, so it can never loop with that reload.
	useEffect(() => {
		void window.sqlApi.authRefresh();
	}, []);

	// Manual refresh: re-read the tier (picks up an upgrade just made on the website) and reload
	// usage so the allowance/models reflect the new plan. A tier change also arrives via the
	// auth:changed push that updates `props.auth`.
	const refresh = useCallback(async (): Promise<void> => {
		setRefreshing(true);
		try {
			await window.sqlApi.authRefresh();
			loadUsage();
		} finally {
			setRefreshing(false);
		}
	}, [loadUsage]);

	// Flip the wallet→credits switch through to ai_preferences (shared with the website). Optimistic
	// with a revert on failure, so the toggle feels instant but never lies about the saved state.
	const toggleCredits = useCallback(async (next: boolean): Promise<void> => {
		setTogglingCredits(true);
		setCreditsEnabled(next);
		try {
			await window.sqlApi.aiSetCreditsEnabled(next);
		} catch {
			setCreditsEnabled(!next);
		} finally {
			setTogglingCredits(false);
		}
	}, []);

	// Open the website checkout for a credit pack (the website gates it to paid tiers too). On
	// returning to the app, the focus-driven authRefresh re-syncs the top-up key and balance.
	const buyCredits = useCallback((pack?: number): void => {
		void window.sqlApi.openExternal(pack ? `${BUY_CREDITS_URL}?pack=${pack}` : BUY_CREDITS_URL);
	}, []);

	// Near the limit once spend crosses the soft threshold (the gateway's soft_budget when it
	// reports one, else 80% of the cap) — drives the warning styling + fallback note.
	const nearLimit = !!budget?.metered
		&& (budget.softBudget !== undefined ? budget.spend >= budget.softBudget : (budget.percentUsed ?? 0) >= 80);

	const includedModels = models.filter((m) => !m.metered);
	const meteredModels = models.filter((m) => m.metered);
	const since = user?.createdAt ? memberSince(user.createdAt) : null;
	// Pay-as-you-go credits are a paid-tier feature: buy buttons + the usage toggle only show for
	// Plus/Pro. The credits block (balance + toggle) only shows once the user actually has a top-up
	// key with a balance reported by the gateway.
	const paid = tier !== 'free';
	// A business seat is the one plan that never comes from a personal purchase: `business` is sold
	// per seat to a company with a floor of five and reaches this user because effective_tier
	// composes their team's plan on top of their own, so the tier alone is enough to say where it
	// came from. What the app genuinely cannot say is WHICH team, or whether they own it: the tier
	// arrives as a bare string from get_my_effective_tier and carries neither.
	//
	// **The converse is not available and must not be inferred.** Since 2026-09-18 `plus` and `pro`
	// are sold per seat as well, so a Plus user may also be on a team; this flag answers "did this
	// certainly come from a team", never "is this person alone".
	const fromTeam = tier === 'business';
	const credits = budget?.credits;
	const hasCredits = !!credits && credits.purchasedTotal > 0;
	// Credits are a lifetime ledger (no reset), so the bar is spend / purchased, mirroring the
	// monthly billing-period bar above.
	const creditsPercentUsed = credits && credits.purchasedTotal > 0
		? Math.min(100, Math.round((credits.spend / credits.purchasedTotal) * 1000) / 10)
		: 0;

	if (!user) {
		return (
			<div className="account-signin">
				<AssistantArt className="account-signin-art" />
				<h3 className="account-section-title">Sign in to SnoutData</h3>
				<p className="confirm-detail">Sign in to unlock {ASSISTANT_INTRO}, and every feature, completely free. The SQL editor works without an account.</p>
				<div className="account-providers">
					<button type="button" disabled={props.busy} onClick={() => props.onSignIn('github')}><Icon name="github" /> Continue with GitHub</button>
					<button type="button" disabled={props.busy} onClick={() => props.onSignIn('google')}><Icon name="account" /> Continue with Google</button>
					{ssoOpen ? (
						<form
							className="account-sso"
							onSubmit={(e) => {
								e.preventDefault();
								if (ssoDomain) {
									props.onSignIn('sso', ssoEmail);
								}
							}}
						>
							<label className="account-sso-label" htmlFor="account-sso-email">Work email</label>
							<input
								id="account-sso-email"
								type="email"
								autoFocus
								autoComplete="email"
								spellCheck={false}
								placeholder="you@yourcompany.com"
								value={ssoEmail}
								disabled={props.busy}
								onChange={(e) => setSsoEmail(e.target.value)}
							/>
							<div className="account-sso-actions">
								<button type="button" className="secondary" disabled={props.busy} onClick={() => setSsoOpen(false)}><Icon name="arrow-left" /> Back</button>
								<button type="submit" disabled={props.busy || !ssoDomain}>Continue <Icon name="arrow-right" /></button>
							</div>
							{props.signInError && !props.busy
								? <div className="form-status warn">{props.signInError}</div>
								: (
									<span className="muted small">
										{ssoDomain
											? `We will look for the single sign-on set up for ${ssoDomain}.`
											: "Only the domain of this address is sent, to find your company's identity provider."}
									</span>
								)}
						</form>
					) : (
						<button type="button" className="secondary" disabled={props.busy} onClick={() => setSsoOpen(true)}><Icon name="organization" /> Continue with SSO</button>
					)}
				</div>
				{/* A GitHub or Google sign-in that could not start: said here, where it was asked. The SSO
				    form shows its own, inside the box. */}
				{props.signInError && !props.busy && !ssoOpen && <div className="form-status warn">{props.signInError}</div>}
				{props.busy ? (
					<div className="account-waiting">
						<span className="muted small">Waiting for the browser sign-in to finish…</span>
						<button type="button" className="link-btn" onClick={props.onCancelSignIn}>Cancel</button>
					</div>
				) : (
					<div className="muted small">A browser window opens to complete sign-in, then returns to the app.</div>
				)}
			</div>
		);
	}

	return (
		<>
			<section className="account-section account-profile">
				<Avatar url={user.avatarUrl} />
				<div className="account-id">
					<div className="account-name">{user.name ?? user.email ?? 'Signed in'}</div>
					{user.email && user.name && <div className="muted small">{user.email}</div>}
					{since && <div className="muted small">Member since {since}</div>}
					{fromTeam && <div className="muted small">On your team's plan, not a personal subscription.</div>}
				</div>
				<span className="spacer" />
				<span className={`tier-badge ${tier}`}>{TIER_LABEL[tier]}</span>
			</section>

			<div className="account-tabs" role="tablist">
				{([['usage', 'Usage'], ['plans', 'Plans'], ['models', 'Models']] as const).map(([id, label]) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={accountTab === id}
						className={`account-tab${accountTab === id ? ' active' : ''}`}
						onClick={() => setAccountTab(id)}
					>
						{label}
					</button>
				))}
			</div>

			{accountTab === 'usage' && (
				<>
					{!budget && !paid && (
						<div className="muted small">Your AI usage will appear here once you have asked {ASSISTANT_NAME} something.</div>
					)}
					{budget && (
				<section className="account-section">
					<h3 className="account-section-title">AI usage</h3>
					<div className="account-usage">
						{budget.metered ? (
							<>
								<div className="usage-head">
									<span className="muted small">This billing period</span>
									<span className="spacer" />
									{budget.resetAt && resetLabel(budget.resetAt) && <span className="muted small">resets {resetLabel(budget.resetAt)}</span>}
								</div>
								<div className={`usage-bar ${nearLimit ? 'warn' : ''}`}>
									<div className="usage-fill" style={{ width: `${budget.percentUsed ?? 0}%` }} />
								</div>
								<div className="usage-detail">
									<span>{Math.round((budget.percentUsed ?? 0) * 10) / 10}% used</span>
									<span className="spacer" />
									<span className="muted">{Math.round((100 - (budget.percentUsed ?? 0)) * 10) / 10}% left</span>
								</div>
								{nearLimit && (
									<div className="usage-note muted small">
										You're near your monthly limit. Once it runs out, AI usage pauses until it resets.
										{/* A team seat is not this person's to upgrade, so say nothing about upgrading rather than
										    send them to a checkout their admin owns. */}
										{fromTeam ? '' : paid ? ' Upgrade for a bigger balance, or buy extra credits that never expire.' : ' Upgrade anytime for a bigger balance.'}
									</div>
								)}
							</>
						) : (
							<div className="usage-head unlimited">
								<Icon name="check" />
								<span className="feature-label">Unlimited AI usage</span>
								<span className="feature-state included">SnoutData Cloud</span>
							</div>
						)}
					</div>
				</section>
			)}

			{paid && (
				<section className="account-section">
					<h3 className="account-section-title">Extra credits</h3>
					{hasCredits && credits && (
						<div className="account-usage">
							<div className="usage-head">
								<span className="muted small">Pay-as-you-go credits</span>
								<span className="spacer" />
								<span className="muted small">never expire</span>
							</div>
							<div className="usage-bar">
								<div className="usage-fill" style={{ width: `${creditsPercentUsed}%` }} />
							</div>
							<div className="usage-detail">
								<span>{formatUsd(credits.spend)} used</span>
								<span className="spacer" />
								<span className="muted">{formatUsd(credits.balance)} left of {formatUsd(credits.purchasedTotal)}</span>
							</div>
							<label className="account-credits-toggle">
								<input
									type="checkbox"
									checked={creditsEnabled}
									disabled={togglingCredits}
									onChange={(e) => void toggleCredits(e.target.checked)}
								/>
								<span>Use credits after my monthly limit</span>
							</label>
							<div className="muted small">
								{creditsEnabled
									? "When your monthly balance runs out, the assistant keeps going on your credits until they're gone."
									: 'Off: when your monthly balance runs out, AI pauses and your credits are saved until next month.'}
							</div>
						</div>
					)}
					<div className="account-credits-buy">
						{CREDIT_PACKS.map((pack) => (
							<button type="button" className="secondary" key={pack} onClick={() => buyCredits(pack)}><Icon name="credit-card" /> Buy {formatUsd(pack)}</button>
						))}
					</div>
					<div className="muted small">Credits never expire and are spent only after your monthly balance, and only when the toggle above is on. Purchased securely at <a href={BUY_CREDITS_URL} onClick={(e) => { e.preventDefault(); buyCredits(); }}>snoutdata.com</a>.</div>
				</section>
			)}
				</>
			)}

			{accountTab === 'models' && models.length > 0 && (
				<section className="account-section">
					<h3 className="account-section-title">Models</h3>
					<div className="account-models">
						{includedModels.length > 0 && (
							<div className="account-model-group">
								<div className="account-model-group-head">
									<Icon name="check" />
									<span>Included</span>
									<span className="muted small">never touches your balance</span>
								</div>
								{includedModels.map((m) => <ModelRow key={m.model} model={m} />)}
							</div>
						)}
						{meteredModels.length > 0 && (
							<div className="account-model-group">
								<div className="account-model-group-head">
									<Icon name="dashboard" />
									<span>Included in your plan</span>
									<span className="muted small">each request draws from your monthly AI credits</span>
								</div>
								{meteredModels.map((m) => <ModelRow key={m.model} model={m} />)}
							</div>
						)}
					</div>
					<div className="muted small">
						Every request draws from your monthly AI credits. When they run out, AI usage pauses until your balance resets.
						{fromTeam ? " Your balance comes with your team seat." : <> Upgrade anytime at <a href="https://snoutdata.com" onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal('https://snoutdata.com'); }}>snoutdata.com</a> for a bigger balance.</>}
					</div>
				</section>
			)}

			{accountTab === 'plans' && (
			<section className="account-section">
				<h3 className="account-section-title">Plans</h3>
				<div className="account-plans">
					{PLANS.map((p) => (
						<div className={`account-plan${p.tier === tier ? ' current' : ''}`} key={p.tier}>
							<div className="account-plan-head">
								<span className={`tier-badge ${p.tier}`}>{TIER_LABEL[p.tier]}</span>
								<span className="spacer" />
								{p.tier === tier && <span className="feature-state included">{fromTeam ? 'Your team' : 'Current'}</span>}
							</div>
							<ul className="account-plan-perks">
								{p.perks.map((perk) => (
									<li key={perk}><Icon name="check" /> {perk}</li>
								))}
							</ul>
						</div>
					))}
				</div>
				{fromTeam ? (
					<div className="muted small">Your seat is part of your team's plan, so the plan and the billing are your team admin's to change, not yours. Single sign-on is included.</div>
				) : (
					<div className="muted small">Pro gives you 3x the monthly AI credits of Plus, for heavier days, plus first access to new models. Change your plan anytime at <a href="https://snoutdata.com" onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal('https://snoutdata.com'); }}>snoutdata.com</a>.</div>
				)}
				<div className="muted small">Prices, and the models each plan includes, are on <a href={PRICING_URL} onClick={(e) => { e.preventDefault(); void window.sqlApi.openExternal(PRICING_URL); }}>snoutdata.com/pricing</a>.</div>
			</section>
			)}

			<section className="account-section account-actions">
				<button type="button" className="secondary" onClick={() => void window.sqlApi.openExternal('https://snoutdata.com')}><Icon name="link-external" /> Manage plan</button>
				<button type="button" className="secondary" disabled={refreshing} onClick={() => void refresh()}><Icon name="refresh" /> {refreshing ? 'Refreshing…' : 'Refresh plan'}</button>
				<span className="spacer" />
				<button type="button" className="secondary" disabled={props.busy} onClick={props.onSignOut}><Icon name="sign-out" /> Sign out</button>
			</section>
		</>
	);
}

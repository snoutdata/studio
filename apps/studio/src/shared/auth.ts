/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// App-shell contracts for user accounts + soft feature-gating. The renderer only ever sees
// the resolved AuthState (who's signed in, their tier, and the entitlements that tier
// unlocks) — never tokens, which live in the main process (see src/main/authStore.ts).

/** Subscription tier, written in ladder order: each one unlocks everything below it.
 *
 *  `business` is the top rung and is the only tier nobody buys for themselves: it is sold per seat
 *  to a company with a floor of five seats and reaches a person because `effective_tier` composes
 *  their team's plan on top of their personal one. So a `business` tier in hand always means "this
 *  came from a team", which is the one thing about the seat the app can state without asking the
 *  backend.
 *
 *  **The reverse is NOT true, and that changed on 2026-09-18.** `plus` and `pro` are now sold per
 *  seat as well, from a floor of two, so a `plus` in hand may equally have come from a team or from
 *  the person's own card. Nothing in the app may infer "personal" from a tier below `business`; ask
 *  the backend, which is what `resolve_team_seat` is for.
 *
 *  `enterprise` is deliberately absent: it is a reserved, quote-only name and nothing sells it
 *  (T2a), so this build must not know it as a plan a user can be on.
 *
 *  Adding a rung is a code change in both apps (the website only ever writes the tier string): the
 *  union here, the entitlements map in src/main/entitlements.ts, and every `Record<Tier, …>` the
 *  compiler then points at. */
export type Tier = 'free' | 'plus' | 'pro' | 'business';

/** How a user can sign in. `google` and `github` are OAuth providers; `sso` is the user's own
 *  identity provider reached by SAML, chosen by the DOMAIN of their work email rather than by a
 *  provider name (see {@link ssoDomainFromEmail}). All three take the same road: the system
 *  browser, back through https://snoutdata.com/signed-in, into the app on snoutdata://auth-callback. */
export type AuthProviderId = 'google' | 'github' | 'sso';

// A domain is one or more dot-separated labels, each starting and ending alphanumeric and allowed
// hyphens inside. Deliberately no length or IDN handling: this only has to be good enough to stop
// an obvious typo reaching the backend, which is the real authority on whether a domain has SSO.
const SSO_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The domain to ask for single sign-on with, from what the user typed — or null when what they
 * typed cannot be one. A work email is what we ask for ("you@yourcompany.com"), because that is
 * what a person knows; a bare domain is accepted too, since people type that just as readily and
 * it is the only part we ever send.
 *
 * Shared by the renderer (to decide whether Continue is clickable) and main (which derives the
 * domain it actually sends), so the button and the call can never disagree about what is valid.
 */
export function ssoDomainFromEmail(input: string): string | null {
	const text = input.trim().toLowerCase();
	if (!text || /\s/.test(text)) {
		return null;
	}
	const at = text.indexOf('@');
	// An address with no local part, or with more than one "@", is a typo rather than an address.
	if (at === 0 || text.indexOf('@', at + 1) !== -1) {
		return null;
	}
	const domain = at === -1 ? text : text.slice(at + 1);
	if (!SSO_DOMAIN.test(domain)) {
		return null;
	}
	// Require an alphabetic top-level label, so "you@localhost" and "acme.1" are refused here
	// instead of becoming a request nobody can answer.
	const tld = domain.slice(domain.lastIndexOf('.') + 1);
	return /^[a-z]{2,}$/.test(tld) ? domain : null;
}

/** What each tier unlocks. Soft-gated: the client honours these, but a determined user who
 *  cracks the binary could flip them — fine for low-stakes features. The tier → entitlements
 *  map lives in src/main/entitlements.ts so adding a gate is a code change, not a migration. */
export interface Entitlements {
	/** May enable the AI audit log (recording every model round-trip). Every tier. */
	aiLogging: boolean;
	/** May use Agentic mode — let the assistant inspect the database and run read-only
	 *  queries (with approval). Plus+. Without it the chat is limited to single-shot Ask. */
	agentMode: boolean;
	/** May bring their own provider key (OpenAI / OpenRouter / Anthropic) — the assistant talks
	 *  to the provider directly, bypassing the hosted gateway so keys/prompts never touch our
	 *  servers. Plus+ (so plus, pro and business). */
	byok: boolean;
	/** May put a data flow on a schedule so it runs by itself. Plus+ (so plus, pro and business).
	 *  Running a flow BY HAND is free for everyone — the gate is the automation. */
	scheduledFlows: boolean;
}

/** The signed-in user, distilled from the OAuth provider's profile. */
export interface AuthUser {
	id: string;
	email?: string;
	/** Display name / handle from the provider, when present. */
	name?: string;
	/** Avatar URL from the provider, when present. */
	avatarUrl?: string;
	/** Which provider signed THIS session in (e.g. "github", "google", "sso"). Resolved from the
	 *  identity that was actually used, not from the account's first one. */
	provider?: string;
	/** ISO timestamp the account was created (from the auth provider), for "member since". */
	createdAt?: string;
}

/** The renderer's whole view of auth. Logged-out is
 *  `{ user: null, tier: 'free', entitlements: <free> }`. */
export interface AuthState {
	user: AuthUser | null;
	tier: Tier;
	entitlements: Entitlements;
	/** True while a session persisted on disk is still being restored on launch, i.e. `user: null`
	 *  is not yet the final answer. Auth-gated UI should show a loading state instead of a
	 *  sign-in prompt while this holds, so a returning user isn't told to sign in during the
	 *  restore. False once auth settles (including when it settles to genuinely signed out) and
	 *  false from the start when no session was saved. Never gates anything but presentation:
	 *  entitlements stay locked until a user actually resolves. */
	restoring: boolean;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Who signed in, and how. Kept apart from authStore.ts (like authErrors.ts beside it) so both
// answers can be tested without Electron or a live backend: one reads a user record, the other
// reads a failed SSO start, and neither needs a session to exist.

/** The shape of one linked identity on an auth user. Structural, so this file never has to
 *  import the client library and a test can hand it a literal. */
export interface IdentityLike {
	provider?: string;
	created_at?: string;
	last_sign_in_at?: string;
}

/** The shape of the auth user this file reads. Structural for the same reason. */
export interface UserLike {
	/** What only the server may set. `app_metadata` is its earlier name, which an identity server
	 *  not yet on the new names sends instead (the client carries both, a literal may carry one). */
	server_data?: Record<string, unknown>;
	app_metadata?: Record<string, unknown>;
	identities?: IdentityLike[] | null;
	is_sso_user?: boolean;
}

/** The auth server names a SAML identity `sso:<provider uuid>`. Nothing in the app wants the uuid, and a
 *  raw one on screen reads as a fault, so every SAML identity reports as plain "sso". */
function normalizeProvider(provider: string): string {
	return provider.startsWith('sso:') ? 'sso' : provider;
}

/**
 * Which provider signed THIS session in.
 *
 * `server_data.provider` is the tempting answer and it is the wrong one: the auth server writes it when
 * the account is CREATED and never again, so it reports the first provider the person ever used.
 * An account created with Google and later signed into with GitHub still says "google", and an
 * SSO sign-in on any pre-existing account would have said whatever it said before. That was the
 * live bug this replaces.
 *
 * `user.identities` carries one entry per linked identity with its own `last_sign_in_at`, which
 * The auth server does update on each sign-in, so the most recently used identity is the session's. Ties
 * (a brand-new account, where every stamp is the same instant, or an identity with no stamp at
 * all) keep the first identity, which for a fresh sign-up is the only one there is.
 *
 * Falls back to `server_data.provider` when there are no identities to read, and to "sso" for an
 * SSO account with neither, so an SSO session is never reported as a password one.
 */
export function sessionProvider(user: UserLike): string | undefined {
	let best: IdentityLike | undefined;
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const identity of Array.isArray(user.identities) ? user.identities : []) {
		if (typeof identity?.provider !== 'string' || identity.provider.length === 0) {
			continue;
		}
		const parsed = Date.parse(identity.last_sign_in_at ?? identity.created_at ?? '');
		const when = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
		if (!best || when > bestAt) {
			best = identity;
			bestAt = when;
		}
	}
	if (best?.provider) {
		return normalizeProvider(best.provider);
	}
	const declared = (user.server_data ?? user.app_metadata)?.provider;
	if (typeof declared === 'string' && declared.length > 0) {
		return normalizeProvider(declared);
	}
	return user.is_sso_user === true ? 'sso' : undefined;
}

/** Pull whatever a client error carries, without assuming its class. */
function errorParts(error: unknown): { status?: number; message: string } {
	if (!error || typeof error !== 'object') {
		return { message: typeof error === 'string' ? error : '' };
	}
	const e = error as { status?: unknown; message?: unknown };
	return {
		status: typeof e.status === 'number' ? e.status : undefined,
		message: typeof e.message === 'string' ? e.message : '',
	};
}

/**
 * What to tell a person whose single sign-on could not be started, in a sentence they can act on.
 *
 * The case that matters is the ordinary one: nobody has connected an identity provider for that
 * domain, which the auth server answers with a 404 and "No SSO provider assigned for this domain". Raw,
 * that reads as a fault in the app; it is not, and the person has somewhere to go. Anything we do
 * not recognise keeps the backend's own words rather than inventing a diagnosis.
 */
export function ssoFailureMessage(error: unknown, domain: string): string {
	const { status, message } = errorParts(error);
	if (status === 404 || /no sso provider/i.test(message)) {
		return `No single sign-on is set up for ${domain}. Check the address, or ask whoever administers your team to connect your identity provider.`;
	}
	if (/saml.*(disabled|not enabled)/i.test(message)) {
		return `Single sign-on is not available for ${domain} yet. Ask whoever administers your team to connect your identity provider.`;
	}
	return message || `Could not start single sign-on for ${domain}.`;
}

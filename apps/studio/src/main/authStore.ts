/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import type { Person } from '@snoutdata/client';

import type { AuthProviderId, AuthState, AuthUser, Tier } from '../shared/auth';
import { ssoDomainFromEmail } from '../shared/auth';
import { OFFICIAL_BUILD, signInReturn } from '../shared/officialBuild';
import { isRejectedToken } from './authErrors';
import { authOnResume, authOnSuspend, type AuthWakeHost } from './authWake';
import { sessionProvider, ssoFailureMessage } from './authIdentity';
import { entitlementsForTier, normalizeTier } from './entitlements';
import { sendInstallHeartbeat } from './installHeartbeat';
import { isNetworkError, networkBlockedMessage, networkErrorDetail } from './netFetch';
import { openExternalIfAllowed } from './navigationGuard';
import { listenForLoopbackReturn, loggableReason, newSignInState, readSignInCallback, SIGN_IN_REFUSED, SignInAttempt } from './signInCallback';
import { getCloudClient, hasPersistedSession, ACCOUNTS_HOST, waitForAuthReachable } from './cloudClient';

// Where the OAuth redirect comes back to. Registered as a custom protocol in main and on the auth server's
// URI allow list. This is the LAST hop: the browser reaches it from SIGN_IN_RETURN_URL below, not
// from the auth server.
const REDIRECT_URL = 'snoutdata://auth-callback';

// The page the auth server sends the browser to when sign-in succeeds: a static file on our own
// site that says so and then hands the query to
// REDIRECT_URL. The auth server could redirect straight to `snoutdata://auth-callback` — it is on the allow
// list and that is what shipped until v1.0.37 — but then the last thing a person sees is whatever
// page the browser was on, under a permission prompt, with no word from us about whether it
// worked. A custom-scheme redirect is also the one hop a browser may refuse outright, and when it
// does there is nothing on screen to try again with.
//
// It must stay on the auth server's allow list (`AUTH_URI_ALLOW_LIST`) and it must stay a STATIC
// file: a React route on this origin would try to complete the PKCE exchange itself and spend the
// code (the file's own comment carries that in full).
const SIGN_IN_RETURN_URL = 'https://snoutdata.com/signed-in';

// How long a development build's loopback listener waits for the browser (`loopbackReturn`).
const LOOPBACK_WAIT_MS = 10 * 60_000;

// Hard cap on the initial account resolve (tier read + gateway-key mint). The cap only bites on a
// genuinely hung link — the happy path resolves as fast as the network actually allows — so it must
// be GENEROUS, not tight: the mint makes several sequential round-trips (an RPC + reads, then
// LiteLLM /user/new + /key/generate), and a real user can be on a high-latency link (Japan, Brazil,
// Australia), a corporate proxy doing TLS inspection, or hitting us under load. A 3s cap used to time
// out a slow-BUT-SUCCESSFUL mint, so a brand-new user's key (created server-side) was never stored
// locally and the model list came up empty. On timeout each call still falls back to its safe default
// (free tier / keep existing key) and the background entitlement resync (~8s after launch, then every
// 30 min) corrects it.
const ACCOUNT_RESOLVE_TIMEOUT_MS = 15000;

// Hard cap on the interactive sign-in network calls (the OAuth token exchange against the backend).
// Longer than the account-resolve budget because this is the one call the user is actively waiting
// on, but still bounded so a blocking network surfaces a clear error instead of an endless spinner.
const SIGN_IN_NETWORK_TIMEOUT_MS = 20000;

// Hard cap on how long auth-gated UI stays in its "restoring" skeleton on launch. Only bites when
// The client's INITIAL_SESSION is slow to land — it refreshes an expired token inside initialize,
// retrying with backoff for up to ~30s when the backend is unreachable (see init), and a skeleton
// held that long reads as a hang. On expiry we just present as signed out; nothing is cancelled, so
// a late TOKEN_REFRESHED still signs the user in with no restart. Comfortably longer than a healthy
// restore (a local disk read + one token refresh), short enough to stay under "is it broken?".
const RESTORE_SETTLE_TIMEOUT_MS = 6000;

/** Reject `p` after `ms` so a hung network call can't stall the caller past its budget. */
/** Open the sign-in page the auth server named, in the system browser, over https only. */
async function openSignInPage(url: string): Promise<void> {
	const opened = openExternalIfAllowed(url, { httpsOnly: true });
	if (!opened) {
		throw new Error('The sign-in service answered with an address that is not a secure web page, so it was not opened.');
	}
	await opened;
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
	return Promise.race([
		Promise.resolve(p),
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
	]);
}

/** Technical suffix for a failed sign-in call against the backend, appended to the friendly
 *  {@link networkBlockedMessage} so the notification's "Details" names the real cause + domain.
 *  A {@link withTimeout} rejection ("timeout") becomes "timed out reaching <host>"; anything else
 *  reports its `net::ERR_*`/errno via {@link networkErrorDetail}. */
function signInFailDetail(err: unknown): string {
	if (err instanceof Error && err.message === 'timeout') {
		return `(timed out reaching ${ACCOUNTS_HOST})`;
	}
	return networkErrorDetail(err, ACCOUNTS_HOST) || `(reaching ${ACCOUNTS_HOST})`;
}

/**
 * Owns the auth session in the main process: starts OAuth in the system browser,
 * completes it from the deep-link redirect, restores a saved session on launch, and resolves
 * the user's tier from the `profiles` table. The renderer reaches it only over IPC and only
 * ever receives the resolved {@link AuthState} — never tokens. `onChange` fires whenever the
 * signed-in user or tier changes, so main can re-broadcast and re-gate features.
 */
export class AuthStore {
	private user: AuthUser | null = null;
	private tier: Tier = 'free';
	/** True only between init() finding a session on disk and that session resolving either way.
	 *  See {@link AuthState.restoring} — it keeps the UI on a skeleton instead of telling a
	 *  returning user to sign in while we restore. */
	private restoring = false;
	/** A person being adopted for the first time: their plan read and AI key minted, and the rest
	 *  of the app (the AI service among it) not yet told. `state()` does not report them until
	 *  then, or a window that asked in between showed a composer the AI service refused. */
	private adopting = false;
	private restoreTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set by {@link e2eSignIn}: the account is made up, so nothing re-reads its tier. */
	private e2eAccount = false;
	/** A sign-in this app started and is waiting on the browser for. A refusal that arrives with
	 *  none waiting is somebody else's link, and is not shown. */
	private readonly attempt = new SignInAttempt(LOOPBACK_WAIT_MS);

	/**
	 * @param onChange      fired whenever the signed-in user or tier changes (main re-broadcasts + re-gates).
	 * @param onGatewayKey  hands the store the user's minted gateway virtual key + account user id
	 *                      + the optional persistent top-up (credits) key on sign-in, and
	 *                      `(null, null, null)` on sign-out, so positron-cloud uses the
	 *                      subscription key as the bearer, the user id (opaque, never the email)
	 *                      as the request's end-user, and the top-up key for the pay-as-you-go
	 *                      credits fallback.
	 */
	constructor(
		private readonly onChange: () => void,
		private readonly onGatewayKey: (key: string | null, endUser: string | null, topupKey: string | null) => void = () => undefined,
		/** A sign-in that failed after the browser handed it back, for the loopback path; the
		 *  protocol path reports through `handleAuthDeepLink` in main. */
		private readonly onSignInError: (message: string) => void = () => undefined,
	) {}

	/** Where the browser returns after sign-in.
	 *
	 *  A packaged app: `SIGN_IN_RETURN_URL`, which hands the code to `snoutdata://auth-callback`.
	 *  A DEVELOPMENT build (`npm run dev`, the e2e signed-in profile) cannot use that protocol: macOS
	 *  gives `snoutdata://` to the INSTALLED app, which receives a code whose PKCE verifier is in
	 *  this process, so the exchange fails there and this one never signs in. So a development
	 *  build returns through a one-shot listener on 127.0.0.1 (RFC 8252's loopback redirect, and the
	 *  CLI's own route: `http://127.0.0.1:*\/callback` is on the auth server's allow list). The code
	 *  is useless without this process's verifier, which is what makes a loopback return safe.
	 *  A build from the open-source tree, packaged or not, never registers `snoutdata://` (it is the
	 *  official app's), so it always returns this way (shared/officialBuild.ts, `signInReturn`). */
	private async returnUrl(): Promise<string> {
		if (signInReturn({ official: OFFICIAL_BUILD, packaged: app.isPackaged }) === 'site') {
			return SIGN_IN_RETURN_URL;
		}
		return this.loopbackReturn();
	}

	/** The 127.0.0.1 return. Its address carries a fresh random `state`, and the listener answers only
	 *  the request that brings it back, so another program on this computer cannot end (or answer) a
	 *  sign-in by requesting the port: it is ignored and the listener keeps waiting (signInCallback.ts). */
	private async loopbackReturn(): Promise<string> {
		const listener = await listenForLoopbackReturn(newSignInState(), LOOPBACK_WAIT_MS, (search, res) => {
			this.completeSignIn(`snoutdata://auth-callback${search}`).then(
				() => {
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
						`<!doctype html><meta charset="utf-8"><title>Signed in</title><p style="font:16px system-ui;margin:40px">Signed in to this ${OFFICIAL_BUILD ? 'development' : 'source'} build of SnoutData Studio. You can close this tab.</p>`,
					);
				},
				(err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(message.startsWith('Sign-in did not finish') ? message : `Sign-in did not finish: ${message}`);
					this.onSignInError(message);
				},
			);
		});
		return listener.url;
	}

	/** Restore a persisted session on launch — but never block startup on the network. We adopt
	 *  (and drop) the session purely in reaction to the client's auth events. Always notifies
	 *  once up front, so the feature gates settle immediately even before any session resolves. */
	async init(): Promise<void> {
		// Drive everything off auth transitions, and crucially do NOT await getSession() here.
		// The client refreshes an expired access token *inside* getSession()/initialize, retrying
		// with exponential backoff for up to ~30s (AUTO_REFRESH_TICK_DURATION_MS) when the backend
		// is unreachable. Awaiting that on a cold start (app launched before the network/backend is
		// up) stalled the signed-in state and every auth-gated feature for that whole window. So:
		//   - SIGNED_OUT                                    -> clear; a dead/revoked session (refresh
		//     token rotated out from under us by another instance) self-heals to logged out.
		//   - INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED -> adopt the user when one appears.
		// The background auto-refresh re-emits TOKEN_REFRESHED once the backend comes up, so a launch
		// while offline still signs us in as soon as it's reachable, with no restart. adopt() is
		// fired without await so we don't re-enter (and deadlock) the auth lock held by the emit.
		// A session on disk means the logged-out state we start in is provisional, not the answer:
		// hold the auth-gated UI on a skeleton until it resolves, capped by RESTORE_SETTLE_TIMEOUT_MS
		// so a slow/unreachable backend degrades to the sign-in prompt instead of an endless skeleton.
		this.restoring = hasPersistedSession();
		if (this.restoring) {
			this.restoreTimer = setTimeout(() => {
				if (this.settleRestore()) {
					this.onChange();
				}
			}, RESTORE_SETTLE_TIMEOUT_MS);
		}
		getCloudClient().identity.onSessionChange((event, session) => {
			if (event === 'SIGNED_OUT') {
				this.user = null;
				this.tier = 'free';
				this.settleRestore();
				this.onGatewayKey(null, null, null);
				this.onChange();
				return;
			}
			const user = session?.person;
			if (!user) {
				// INITIAL_SESSION with no session: nothing to restore, so stop presenting as if
				// there were. Other eventless-session ticks are already settled and no-op here.
				if (this.settleRestore()) {
					this.onChange();
				}
				return;
			}
			// SIGNED_IN is a fresh authentication (the user just logged in), so always re-adopt: it
			// re-reads the tier from `profiles` and re-mints the gateway key. Without this, signing
			// back into the SAME account after its plan changed (e.g. free -> plus) kept the stale
			// tier until a restart, because the id guard below skipped adopt(). For INITIAL_SESSION
			// (launch) and TOKEN_REFRESHED (background refresh, fires often) we still adopt only on a
			// user change, so routine refreshes don't re-hit profiles / re-mint on every tick.
			if (event === 'SIGNED_IN' || user.id !== this.user?.id) {
				void this.adopt(user)
					.then(() => undefined, () => undefined)
					.then(() => {
						// Settle either way: on success the user is in, and on failure adopt has already
						// fallen back to its safe defaults, so in both cases logged-out is no longer a
						// provisional answer and the UI must stop waiting on us.
						this.settleRestore();
						this.onChange();
					});
			}
		});
		this.onChange();
	}

	/** End the restoring state and cancel its timeout. Returns whether this actually changed
	 *  anything, so callers only re-broadcast when there's news. */
	private settleRestore(): boolean {
		if (this.restoreTimer) {
			clearTimeout(this.restoreTimer);
			this.restoreTimer = null;
		}
		if (!this.restoring) {
			return false;
		}
		this.restoring = false;
		return true;
	}

	/** Pause the client's background token auto-refresh while the OS is asleep. A refresh timer
	 *  that thaws on wake and fires into a still-reconnecting network is the main way a refresh
	 *  response gets lost; retrying the now-rotated token then trips the auth server's reuse detection
	 *  and the whole session is revoked server-side ("Refresh Token Not Found"). Wired to
	 *  `powerMonitor` 'suspend'. Best-effort, and nothing at all when signed out. */
	async onSuspend(): Promise<void> {
		await authOnSuspend(this.wakeHost());
	}

	/** Resume auto-refresh on wake, but only once the auth backend is actually reachable, so the
	 *  first post-sleep refresh doesn't fire into a half-up NIC and lose its response (see
	 *  {@link waitForAuthReachable}). Signed out there is no session to refresh, so a wake contacts
	 *  nobody. Wired to 'resume'. */
	async onResume(): Promise<void> {
		await authOnResume(this.wakeHost());
	}

	private wakeHost(): AuthWakeHost {
		return {
			// A made-up e2e account has no session; a saved one being restored (user not yet set) does.
			hasSession: () => !this.e2eAccount && (this.user !== null || hasPersistedSession()),
			waitForReachable: () => waitForAuthReachable(),
			startAutoRefresh: () => getCloudClient().identity.startAutoRefresh(),
			stopAutoRefresh: async () => { getCloudClient().identity.stopAutoRefresh(); },
		};
	}

	/** E2E ONLY (main installs the caller under the scratch profile alone): present `user` as signed
	 *  in at `tier`, or sign out with null. Nothing is fetched and no gateway key is minted, so the
	 *  account-gated UI renders for a screenshot or a test with no real account behind it. */
	e2eSignIn(user: AuthUser | null, tier: Tier): void {
		this.e2eAccount = user !== null;
		this.user = user;
		this.tier = tier;
		this.settleRestore();
		this.onChange();
	}

	state(): AuthState {
		// Reflect the user's real tier from the `profiles` table (free when signed out). The
		// tier is read by `adopt()` on sign-in/launch and drives the unlocked entitlements.
		const tier: Tier = this.user ? this.tier : 'free';
		// Only ever restoring while signed out — once a user resolves, the state is the answer.
		if (this.adopting) {
			return { user: null, tier: 'free', entitlements: entitlementsForTier('free'), restoring: true };
		}
		return { user: this.user, tier, entitlements: entitlementsForTier(tier), restoring: this.restoring && !this.user };
	}

	/** Begin OAuth in the system browser. EVERY provider takes the same road: our own auth server (snout-auth) at
	 *  `accounts.snoutdata.com`, back to {@link SIGN_IN_RETURN_URL}, and into the app through
	 *  {@link completeSignIn} on the custom protocol.
	 *
	 *  The app holds no OAuth client secret: the browser signs in with the auth server and the
	 *  custom protocol brings the session back (a dev or source build, which registers no protocol,
	 *  takes the 127.0.0.1 loopback return above instead). SAML SSO takes the same
	 *  road (an IdP posts to the auth server, which redirects a browser), so one road serves all three.
	 *
	 *  @param workEmail  only for `sso`: the work email whose DOMAIN picks the identity provider.
	 *                    Ignored by the OAuth providers, which identify themselves by name. */
	async signIn(provider: AuthProviderId, workEmail?: string): Promise<void> {
		this.attempt.begin();
		try {
			await this.startSignIn(provider, workEmail);
		} catch (err) {
			this.attempt.end();
			throw err;
		}
	}

	private async startSignIn(provider: AuthProviderId, workEmail?: string): Promise<void> {
		if (provider === 'sso') {
			await this.startSso(workEmail ?? '');
			return;
		}
		const { data, error } = await getCloudClient().identity.providerSignIn({
			provider,
			options: { redirectTo: await this.returnUrl(), skipBrowserRedirect: true },
		});
		if (error || !data?.url) {
			throw new Error(error?.message ?? 'Could not start sign-in.');
		}
		await openSignInPage(data.url);
	}

	/** Begin SAML single sign-on in the system browser. The same road in a different shape: our
	 *  The auth server hands back the URL to send the browser to, the identity provider posts its assertion
	 *  to our ACS, and the auth server redirects to {@link SIGN_IN_RETURN_URL} with the same `?code=` a PKCE
	 *  OAuth sign-in returns (the client stores a code verifier for `/sso` too under
	 *  `flowType: 'pkce'`), so {@link completeSignIn} needs nothing added for it.
	 *
	 *  Unlike the OAuth call this one is a real round-trip the user waits for before any browser
	 *  opens, so it is bounded and its failures are turned into sentences: a domain whose company
	 *  has never connected a provider is the ORDINARY outcome here, not a fault. */
	private async startSso(workEmail: string): Promise<void> {
		const domain = ssoDomainFromEmail(workEmail);
		if (!domain) {
			throw new Error("Enter your work email address, for example you@yourcompany.com.");
		}
		let data, error;
		try {
			({ data, error } = await withTimeout(
				getCloudClient().identity.ssoSignIn({ domain, options: { redirectTo: await this.returnUrl(), skipBrowserRedirect: true } }),
				SIGN_IN_NETWORK_TIMEOUT_MS,
			));
		} catch (err) {
			throw new Error(`${networkBlockedMessage('the sign-in service', err)} ${signInFailDetail(err)}`);
		}
		if (error) {
			throw new Error(isNetworkError(error)
				? `${networkBlockedMessage('the sign-in service', error)} ${signInFailDetail(error)}`
				: ssoFailureMessage(error, domain));
		}
		if (!data?.url) {
			throw new Error(ssoFailureMessage(null, domain));
		}
		// The address comes from the auth server, not from this app: it is opened only over https,
		// so a bad answer cannot hand the operating system a file:, custom-protocol or plain-http URL.
		await openSignInPage(data.url);
	}

	/** Handle `snoutdata://auth-callback?code=…`:
	 *  exchange the code for a session, adopt the
	 *  user + tier, and notify. A callback without a code (or a malformed URL) is a no-op. */
	async completeSignIn(callbackUrl: string): Promise<void> {
		const callback = readSignInCallback(callbackUrl);
		// A sign-in that FAILED comes back with a reason and no code, and until 2026-09-17 this
		// returned silently on that, leaving the app on "Waiting for the browser sign-in to finish"
		// with nothing ever arriving. The user could only press Cancel and guess. It is not
		// SSO-specific (a declined Google consent screen does the same), but SSO is where it bites,
		// because a misconfigured identity provider is an ordinary Tuesday rather than a rarity.
		//
		// But any web page can open `snoutdata://auth-callback?error_description=<anything>`, so the
		// reason is never shown as the app's words: the person sees a fixed sentence, and only while a
		// sign-in this app started is waiting. What the link said goes to the log.
		if (callback.kind === 'failed') {
			if (!this.attempt.active()) {
				console.warn(`[auth] ignored a sign-in refusal with no sign-in in progress: ${loggableReason(callback.reason)}`);
				return;
			}
			this.attempt.end();
			console.warn(`[auth] sign-in refused: ${loggableReason(callback.reason)}`);
			throw new Error(SIGN_IN_REFUSED);
		}
		if (callback.kind !== 'code') {
			return;
		}
		const code = callback.code;
		let data, error;
		try {
			({ data, error } = await withTimeout(getCloudClient().identity.finishProviderSignIn(code), SIGN_IN_NETWORK_TIMEOUT_MS));
		} catch (err) {
			throw new Error(`${networkBlockedMessage('the sign-in service', err)} ${signInFailDetail(err)}`);
		}
		if (error) {
			throw new Error(isNetworkError(error) ? `${networkBlockedMessage('the sign-in service', error)} ${signInFailDetail(error)}` : error.message);
		}
		this.attempt.end();
		if (data.session?.person) {
			await this.adopt(data.session.person);
		}
		this.onChange();
	}

	/** Re-read the signed-in user's tier from `profiles` and notify if it changed. Called when
	 *  the window regains focus (e.g. the user just upgraded on the website and came back), so a
	 *  plan change is picked up without restarting. A no-op when signed out, and best-effort: a read
	 *  that could not find out (null) leaves the current tier exactly as it was, so a refresh never
	 *  costs a user the plan they are paying for. */
	async refreshTier(): Promise<void> {
		// A made-up e2e account has no profile to read; the backend would answer "free".
		if (!this.user || this.e2eAccount) {
			return;
		}
		const tier = await this.fetchTier();
		if (tier !== null && tier !== this.tier) {
			this.tier = tier;
			this.onChange();
		}
	}

	/** Re-read the tier AND re-sync the gateway key's model access, so both a plan change *and*
	 *  a newly released model (added to `released_models` on the server) show up without a
	 *  restart. The key's allowed-model list is recomputed only when `mint-litellm-key` runs, so
	 *  we re-run it here. Always notifies at the end so the renderer reloads its live model list
	 *  even when the tier itself is unchanged. Drives the manual "Refresh plan" button and the
	 *  background poll in main. A no-op when signed out, and best-effort (never throws). */
	async resyncEntitlements(): Promise<void> {
		if (!this.user) {
			return;
		}
		await this.refreshTier();
		await this.mintGatewayKey();
		this.onChange();
	}

	async signOut(): Promise<void> {
		try {
			// Local scope only: sign this device out without revoking the user's refresh tokens on
			// every other surface. A global sign-out (the client's default) deletes the refresh
			// tokens for all sessions server-side, so signing out on the website (or a prior app
			// instance) would silently kill a still-running/sleeping desktop session — it would wake
			// to "Invalid Refresh Token: Refresh Token Not Found" and force a re-login.
			await getCloudClient().identity.signOff({ scope: 'local' });
		} finally {
			this.user = null;
			this.tier = 'free';
			this.onGatewayKey(null, null, null);
			this.onChange();
		}
	}

	/** Distill the OAuth profile into our {@link AuthUser} and load the user's tier. */
	private async adopt(user: Person): Promise<void> {
		// Re-adopting the SAME person (a launch restore, a re-login) may keep what we already know
		// about their plan when the read fails; a different person may not inherit a word of it.
		const sameUser = this.user?.id === user.id;
		if (!sameUser) {
			this.adopting = true;
		}
		try {
			await this.adoptAs(user, sameUser);
		} finally {
			if (!sameUser) {
				this.adopting = false;
			}
		}
	}

	private async adoptAs(user: Person, sameUser: boolean): Promise<void> {
		const meta = (user.profile_data ?? {}) as Record<string, unknown>;
		const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
		this.user = {
			id: user.id,
			email: user.email,
			name: str(meta.full_name) ?? str(meta.name) ?? str(meta.user_name),
			avatarUrl: str(meta.avatar_url) ?? str(meta.picture),
			// The identity this session actually used, NOT `server_data.provider` (which the auth server
			// writes once, at account creation, and would misreport every linked account and every
			// SSO sign-in). See sessionProvider.
			provider: sessionProvider(user),
			createdAt: str(user.created_at),
		};
		// Best-effort: backfill any team-seat invitation matching this user's email so a team admin
		// sees them as "active" (display only — the tier itself resolves by email regardless). Fired
		// without await so it never delays sign-in/launch.
		void getCloudClient().procedure('claim_my_team_seats').then(() => undefined, () => undefined);
		// Stitch this install to the account now that we have a JWT (record_install reads auth.uid()),
		// so the install -> sign-in funnel resolves immediately instead of on the next launch. Fired
		// without await + best-effort so it never delays sign-in.
		void sendInstallHeartbeat();
		const tier = await this.fetchTier();
		if (!this.user) {
			return; // fetchTier found the session dead and signed us out; there is nobody to adopt.
		}
		this.tier = tier ?? (sameUser ? this.tier : 'free');
		await this.mintGatewayKey();
	}

	/** Mint (or fetch) this user's gateway virtual key via the `mint-litellm-key` Snout
	 *  Function and hand it to the store. The client attaches the user's JWT automatically.
	 *  Best-effort: if the function isn't deployed or is unreachable, leave any existing key
	 *  in place so a manually-set key (dev) still works. */
	private async mintGatewayKey(): Promise<void> {
		try {
			const { data, error } = await withTimeout(getCloudClient().fn.call('mint-litellm-key'), ACCOUNT_RESOLVE_TIMEOUT_MS);
			const payload = data as { key?: string; topupKey?: string } | null;
			const key = payload?.key;
			if (!error && typeof key === 'string' && key.length > 0) {
				// The top-up key is optional: only present once the user has bought credits.
				const topupKey = typeof payload?.topupKey === 'string' && payload.topupKey.length > 0 ? payload.topupKey : null;
				this.onGatewayKey(key, this.user?.id ?? null, topupKey);
			}
		} catch {
			// Snout Function not deployed / offline — keep whatever key is already stored.
		}
	}

	/** Read the user's wallet→credits switch from `ai_preferences` (RLS scopes the row to them).
	 *  Defaults to false (the safe default: AI pauses at the monthly limit rather than spending
	 *  real credit) on any error, a missing row, or when signed out. */
	async getCreditsEnabled(): Promise<boolean> {
		if (!this.user) {
			return false;
		}
		try {
			const { data, error } = await getCloudClient().table('ai_preferences').read('credits_enabled').eq('user_id', this.user.id).maybeSingle();
			if (error || !data) {
				return false;
			}
			return (data as { credits_enabled?: boolean }).credits_enabled === true;
		} catch {
			return false;
		}
	}

	/** Set the wallet→credits switch through the `set-credits-enabled` Snout Function, which saves the
	 *  shared `ai_preferences` row (the same toggle the dashboard shows) and blocks or unblocks the
	 *  top-up key on the gateway at once, so the switch is enforced server-side and not only here.
	 *  Throws only so the caller can surface a failure; a no-op when signed out. */
	async setCreditsEnabled(enabled: boolean): Promise<void> {
		if (!this.user) {
			return;
		}
		const { error } = await withTimeout(getCloudClient().fn.call('set-credits-enabled', { body: { enabled } }), ACCOUNT_RESOLVE_TIMEOUT_MS);
		if (error) {
			throw new Error(error.message);
		}
	}

	/** Read the user's EFFECTIVE tier via the `get_my_effective_tier` RPC: the max of their personal
	 *  `profiles.tier` and any active team they belong to (the team plan composes at read time, so a
	 *  member's seat is never written into their own profile). The RPC scopes to `auth.uid()`, so no
	 *  user id is needed.
	 *
	 *  **Returns null when it could not find out, and that is NOT the same as free.** Answering
	 *  'free' on a failure would REVOKE a paying user's access whenever the read fails (a rejected
	 *  token, a timeout). A failed read is an unknown, the caller keeps the last answer it had, and
	 *  access is granted or withdrawn only by an answer we actually received. */
	private async fetchTier(): Promise<Tier | null> {
		const read = async (): Promise<Tier | null | 'rejected'> => {
			try {
				const { data, error } = await withTimeout(getCloudClient().procedure('get_my_effective_tier'), ACCOUNT_RESOLVE_TIMEOUT_MS);
				if (error) {
					return isRejectedToken(error) ? 'rejected' : null;
				}
				return typeof data === 'string' ? normalizeTier(data) : null;
			} catch {
				return null;
			}
		};
		const first = await read();
		if (first !== 'rejected') {
			return first;
		}
		// The backend refused the token itself. Mint a new one and ask once more (see
		// recoverRejectedSession for why nothing else notices this on its own).
		if (!(await this.recoverRejectedSession())) {
			return null;
		}
		const second = await read();
		return second === 'rejected' ? null : second;
	}

	/** Replace an access token the backend REFUSED, and report whether we now hold a usable one.
	 *
	 *  The client only refreshes a token it believes is expiring: it reads `exp` out of the JWT and
	 *  trusts it. A token that is unexpired but signed by a key the backend does not accept is
	 *  therefore never retried — it is simply used, and refused, for as long as an hour, with every
	 *  call failing and nothing in the client noticing, which is why this asks explicitly rather
	 *  than waiting.
	 *
	 *  If the refresh itself fails for good (a revoked or unknown refresh token, which is what a
	 *  global sign-out elsewhere leaves behind) the client clears the stored session but does NOT
	 *  emit SIGNED_OUT from this path, so we would keep presenting a signed-in user who has no
	 *  session at all. Sign out for real instead, so the UI asks for a sign-in rather than showing a
	 *  plan nobody can verify. A network failure is left alone: the session is still good, the link
	 *  is not, and the next resync will try again. */
	private async recoverRejectedSession(): Promise<boolean> {
		let error: unknown;
		try {
			({ error } = await withTimeout(getCloudClient().identity.renew(), ACCOUNT_RESOLVE_TIMEOUT_MS));
		} catch {
			return false; // timed out: the link is down, not the session.
		}
		if (!error) {
			return true;
		}
		if (!isNetworkError(error)) {
			await this.signOut();
		}
		return false;
	}
}

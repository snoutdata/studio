/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Identity: people, sessions and the token every other product sends.
 *
 * The identity server is at `/v1/identity` (`/auth/v1` in the old vocabulary). A session is an
 * access token (a short-lived JWT that row-level security reads) plus a refresh token that buys
 * the next one. This module keeps the session, stores it where the caller said to (the browser's
 * localStorage by default), renews it before it expires, and tells every listener when it
 * changes, which is how live learns to re-authorise its topics.
 *
 * The routes and fields it sends are the vocabulary's own (`/session?via=password` and
 * `profile_data`, or `/token?grant_type=password` and `data`); a person and a session it hands
 * back carry BOTH names for each renamed field (`person` and `user`, `profile_data` and
 * `user_metadata`, `server_data` and `app_metadata`), whichever the server sent, so code written
 * against either reads them.
 */

import { encodePath, isBrowser, joinUrl, keyHeader, messageOf, readBody, type Fetch, type Vocabulary } from './http.js';

/** One person's account, as the identity server describes it. */
export interface Person {
	id: string;
	aud: string;
	role?: string;
	email?: string;
	phone?: string;
	email_confirmed_at?: string | null;
	phone_confirmed_at?: string | null;
	confirmed_at?: string | null;
	last_sign_in_at?: string | null;
	/** What the person may change about themselves (`changePerson({ profile_data })`). */
	profile_data: Record<string, unknown>;
	/** What only the server key may set (`operator.createUser({ server_data })`). */
	server_data: Record<string, unknown>;
	/** @deprecated Since 0.4.0: `server_data`, the same value. */
	app_metadata: Record<string, unknown>;
	/** @deprecated Since 0.4.0: `profile_data`, the same value. */
	user_metadata: Record<string, unknown>;
	identities?: Record<string, unknown>[];
	created_at: string;
	updated_at?: string;
	is_anonymous?: boolean;
	[field: string]: unknown;
}

/** @deprecated Since 0.4.0: `Person`. */
export type User = Person;

export interface Session {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	/** Seconds since the epoch. */
	expires_at: number;
	person: Person;
	/** @deprecated Since 0.4.0: `person`, the same object. */
	user: Person;
	provider_token?: string | null;
	provider_refresh_token?: string | null;
}

export class AuthError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = 'AuthError';
		this.status = status;
		this.code = code;
	}
}

export type AuthEvent =
	| 'INITIAL_SESSION'
	| 'SIGNED_IN'
	| 'SIGNED_OUT'
	| 'TOKEN_REFRESHED'
	| 'USER_UPDATED'
	| 'PASSWORD_RECOVERY';

export type AuthResult<T> = { data: T; error: null } | { data: { [K in keyof T]: null }; error: AuthError };

/** A result naming one person, under the new name and the old. */
export interface PersonData {
	person: Person | null;
	/** @deprecated Since 0.4.0: `person`, the same object. */
	user: Person | null;
}

/** A result naming a person and a session. */
export interface SessionData extends PersonData {
	session: Session | null;
}

/** Where a session is kept between page loads. `localStorage` fits; so does anything async. */
export interface SessionStorage {
	getItem(key: string): string | null | Promise<string | null>;
	setItem(key: string, value: string): void | Promise<void>;
	removeItem(key: string): void | Promise<void>;
}

export interface AuthOptions {
	/** Keep the session between page loads. Default: true in a browser, false elsewhere. */
	persistSession?: boolean;
	/** Refresh the access token before it expires. Default: true. */
	autoRefreshToken?: boolean;
	/** Finish a sign-in from the URL a redirect landed on. Default: true in a browser. */
	detectSessionInUrl?: boolean;
	/** `pkce` (the default) or `implicit`, for magic links and OAuth redirects. */
	flowType?: 'pkce' | 'implicit';
	storage?: SessionStorage;
	storageKey?: string;
	/**
	 * Told what the session did and why: each refresh and its outcome, a session adopted from
	 * storage because another tab or process refreshed it first, and every sign-out with its
	 * cause. For a log that has to explain an unexpected sign-out after the fact. No token is
	 * ever passed to it.
	 */
	debug?: (...parts: unknown[]) => void;
}

type Listener = (event: AuthEvent, session: Session | null) => void;

/** The identity server's routes, old then new. */
const ROUTES = {
	signup: ['signup', 'register'],
	token: ['token', 'session'],
	logout: ['logout', 'sign-off'],
	user: ['user', 'person'],
	recover: ['recover', 'reset'],
	verify: ['verify', 'confirm'],
	otp: ['otp', 'code'],
	authorize: ['authorize', 'provider/start'],
	sso: ['sso', 'sso/start'],
	people: ['admin/users', 'operator/people']
} as const;

type Route = keyof typeof ROUTES;

/** A `grant_type` whose `via` (new vocabulary) is another word; the rest keep their names. */
const VIA: Record<string, string> = { refresh_token: 'renew' };

/**
 * A person as the server sent it, carrying each renamed field under both names, whichever it
 * was sent under (an old server sends only the old ones, a new one both).
 */
export function toPerson(body: unknown): Person {
	const raw = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
	const profile = (raw.profile_data ?? raw.user_metadata ?? {}) as Record<string, unknown>;
	const server = (raw.server_data ?? raw.app_metadata ?? {}) as Record<string, unknown>;
	return { ...raw, profile_data: profile, user_metadata: profile, server_data: server, app_metadata: server } as Person;
}

/** A session with its person under both names, from one that may carry either (0.3.x stored only `user`). */
function withPerson(session: Session): Session {
	const person = toPerson(session.person ?? session.user);
	return { ...session, person, user: person };
}

function personData(person: Person | null): PersonData {
	return { person, user: person };
}

function sessionData(session: Session | null, person: Person | null = session?.person ?? null): SessionData {
	return { person, user: person, session };
}

/** A fresh empty result each time, so no caller can change another's. */
function noSession(): { person: null; user: null; session: null } {
	return { person: null, user: null, session: null };
}

function noPerson(): { person: null; user: null } {
	return { person: null, user: null };
}

/** Refresh this many seconds before expiry. */
const REFRESH_MARGIN = 60;

function memoryStorage(): SessionStorage {
	const items = new Map<string, string>();
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
		removeItem: (key) => void items.delete(key)
	};
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * A stored PKCE verifier: the bare string (0.2.0-0.2.1), or JSON-encoded, with
 * `/PASSWORD_RECOVERY` appended for a recovery (what this client writes now), so a sign-in
 * started by an older version still completes.
 */
function readVerifier(stored: string | null): string | null {
	if (!stored) {
		return null;
	}
	let value = stored;
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			value = typeof parsed === 'string' ? parsed : value;
		} catch {
			// not JSON after all: use it as it is
		}
	}
	return value.split('/')[0] || null;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** A token response from the auth server, as a session with `expires_at` filled in. */
function toSession(body: Record<string, unknown>): Session | null {
	if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
		return null;
	}
	const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
	return withPerson({
		...(body as unknown as Session),
		expires_in: expiresIn,
		expires_at: typeof body.expires_at === 'number' ? body.expires_at : nowSeconds() + expiresIn
	});
}

export class AuthClient {
	private readonly url: string;
	private readonly key: string;
	private readonly fetch: Fetch;
	private readonly headers: Record<string, string>;
	private readonly storage: SessionStorage;
	private readonly storageKey: string;
	private readonly persist: boolean;
	private readonly autoRefresh: boolean;
	private readonly flowType: 'pkce' | 'implicit';
	private readonly listeners = new Set<Listener>();
	private session: Session | null = null;
	private refreshing: Promise<Session | null> | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Set by stopAutoRefresh and cleared by startAutoRefresh; a sign-in does not re-arm it. */
	private paused = false;
	private readonly debug: (...parts: unknown[]) => void;
	/** A bearer the caller fixed in `global.headers`, used by `currentPerson()` when nobody is signed in. */
	private readonly fixedBearer: string | null;
	private readonly ready: Promise<void>;

	/** The operator half: managing other people's accounts. Needs the server key. */
	readonly operator: AuthAdmin;
	/** @deprecated Since 0.4.0: `operator`, the same object. Removed in 0.5.0. */
	readonly admin: AuthAdmin;
	/** @internal Which names the wire speaks. */
	readonly vocabulary: Vocabulary;

	/** @deprecated Since 0.4.0: use `register()`, the same function. Removed in 0.5.0. */
	declare signUp: AuthClient['register'];
	/** @deprecated Since 0.4.0: use `passwordSignIn()`, the same function. Removed in 0.5.0. */
	declare signInWithPassword: AuthClient['passwordSignIn'];
	/** @deprecated Since 0.4.0: use `codeSignIn()`, the same function. Removed in 0.5.0. */
	declare signInWithOtp: AuthClient['codeSignIn'];
	/** @deprecated Since 0.4.0: use `providerSignIn()`, the same function. Removed in 0.5.0. */
	declare signInWithOAuth: AuthClient['providerSignIn'];
	/** @deprecated Since 0.4.0: use `ssoSignIn()`, the same function. Removed in 0.5.0. */
	declare signInWithSSO: AuthClient['ssoSignIn'];
	/** @deprecated Since 0.4.0: use `guestSignIn()`, the same function. Removed in 0.5.0. */
	declare signInAnonymously: AuthClient['guestSignIn'];
	/** @deprecated Since 0.4.0: use `confirmCode()`, the same function. Removed in 0.5.0. */
	declare verifyOtp: AuthClient['confirmCode'];
	/** @deprecated Since 0.4.0: use `finishProviderSignIn()`, the same function. Removed in 0.5.0. */
	declare exchangeCodeForSession: AuthClient['finishProviderSignIn'];
	/** @deprecated Since 0.4.0: use `signOff()`, the same function. Removed in 0.5.0. */
	declare signOut: AuthClient['signOff'];
	/** @deprecated Since 0.4.0: use `currentSession()`, the same function. Removed in 0.5.0. */
	declare getSession: AuthClient['currentSession'];
	/** @deprecated Since 0.4.0: use `currentPerson()`, the same function. Removed in 0.5.0. */
	declare getUser: AuthClient['currentPerson'];
	/** @deprecated Since 0.4.0: use `renew()`, the same function. Removed in 0.5.0. */
	declare refreshSession: AuthClient['renew'];
	/** @deprecated Since 0.4.0: use `onSessionChange()`, the same function. Removed in 0.5.0. */
	declare onAuthStateChange: AuthClient['onSessionChange'];
	/** @deprecated Since 0.4.0: use `sendReset()`, the same function. Removed in 0.5.0. */
	declare resetPasswordForEmail: AuthClient['sendReset'];
	/** @deprecated Since 0.4.0: use `changePerson()`, the same function. Removed in 0.5.0. */
	declare updateUser: AuthClient['changePerson'];

	constructor(url: string, key: string, fetchImpl: Fetch, headers: Record<string, string>, ref: string, options: AuthOptions = {}, vocabulary: Vocabulary = 'new') {
		this.url = url;
		this.key = key;
		this.vocabulary = vocabulary;
		this.fetch = fetchImpl;
		this.headers = headers;
		const browser = isBrowser();
		this.persist = options.persistSession ?? browser;
		this.autoRefresh = options.autoRefreshToken ?? true;
		this.flowType = options.flowType ?? 'pkce';
		this.storage =
			options.storage ?? (this.persist && typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
		this.storageKey = options.storageKey ?? `snoutdata-${ref}-auth`;
		this.debug = options.debug ?? (() => undefined);
		const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
		this.fixedBearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
		this.operator = new AuthAdmin(this);
		this.admin = this.operator;
		this.ready = this.initialize(options.detectSessionInUrl ?? browser);
	}

	// ---- plumbing ----

	/** @internal A route's path in this client's vocabulary, with `rest` after it. */
	route(name: Route, rest = ''): string {
		return `${ROUTES[name][this.vocabulary === 'old' ? 0 : 1]}${rest}`;
	}

	/** The query that asks the token route for `grant`: `grant_type=` (old) or `via=` (new). */
	private grant(grant: string): Record<string, string> {
		return this.vocabulary === 'old' ? { grant_type: grant } : { via: VIA[grant] ?? grant };
	}

	/**
	 * @internal A person's data fields under this vocabulary's names: `profile_data` and
	 * `server_data`, or the old `oldProfile` (`data` or `user_metadata`) and `app_metadata`.
	 * Absent ones are left out.
	 */
	fields(oldProfile: 'data' | 'user_metadata', profile: unknown, server?: unknown): Record<string, unknown> {
		const old = this.vocabulary === 'old';
		const out: Record<string, unknown> = {};
		if (profile !== undefined) {
			out[old ? oldProfile : 'profile_data'] = profile;
		}
		if (server !== undefined) {
			out[old ? 'app_metadata' : 'server_data'] = server;
		}
		return out;
	}

	/** @internal */
	async call(path: string, init: { method?: string; body?: unknown; token?: string; query?: Record<string, string | undefined> } = {}): Promise<{ body: Record<string, unknown>; error: AuthError | null }> {
		const url = new URL(joinUrl(this.url, path));
		for (const [name, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(name, value);
			}
		}
		const headers: Record<string, string> = {
			...this.headers,
			[keyHeader(this.vocabulary)]: this.key,
			Authorization: `Bearer ${init.token ?? this.key}`
		};
		if (init.body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		let response: Response;
		try {
			response = await this.fetch(url.toString(), {
				method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body)
			});
		} catch (cause) {
			return { body: {}, error: new AuthError(cause instanceof Error ? cause.message : String(cause), 0) };
		}
		const payload = await readBody(response);
		const body = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
		if (!response.ok) {
			const code = typeof body.error_code === 'string' ? body.error_code : typeof body.code === 'string' ? body.code : undefined;
			return { body, error: new AuthError(messageOf(payload, `${response.status} ${response.statusText}`), response.status, code) };
		}
		return { body, error: null };
	}

	/** The session as storage holds it now, or null. Unreadable or shapeless contents are cleared. */
	private async readStored(): Promise<Session | null> {
		let stored: string | null;
		try {
			stored = await this.storage.getItem(this.storageKey);
		} catch {
			return this.session;
		}
		if (!stored) {
			return null;
		}
		try {
			const parsed = JSON.parse(stored) as Session;
			if (typeof parsed?.access_token === 'string' && typeof parsed.refresh_token === 'string' && typeof parsed.expires_at === 'number') {
				return withPerson(parsed);
			}
		} catch {
			// fall through to clearing it
		}
		await this.storage.removeItem(this.storageKey);
		return null;
	}

	/**
	 * Adopts what storage holds when it is not what this client holds. Storage can be shared: two
	 * tabs, two origins reading one cookie, two app instances reading one file. Whoever refreshes
	 * first rotates the refresh token, and a client still holding the old one would present a
	 * spent token and be signed out, taking the shared store with it. So storage is read before
	 * the session is used or refreshed, on every getSession.
	 */
	private async syncFromStorage(): Promise<void> {
		const stored = await this.readStored();
		const current = this.session;
		if (stored?.access_token === current?.access_token && stored?.refresh_token === current?.refresh_token) {
			return;
		}
		this.session = stored;
		this.schedule();
		if (!stored) {
			this.debug('session removed from storage elsewhere: signed out');
			this.emit('SIGNED_OUT');
		} else if (current && stored.person?.id === current.person?.id) {
			this.debug('session refreshed elsewhere: adopted from storage');
			this.emit('TOKEN_REFRESHED');
		} else {
			this.debug('session written elsewhere: adopted from storage');
			this.emit('SIGNED_IN');
		}
	}

	private async initialize(detectInUrl: boolean): Promise<void> {
		this.session = await this.readStored();
		if (detectInUrl && typeof location !== 'undefined') {
			await this.fromUrl().catch(() => undefined);
		}
		if (this.session && this.session.expires_at - REFRESH_MARGIN <= nowSeconds()) {
			await this.refresh(this.session.refresh_token);
		}
		this.schedule();
	}

	/**
	 * Finishes a redirect: `?code=` (PKCE) or `#access_token=` (implicit).
	 *
	 * In PKCE mode only the code exchange establishes a session, since it needs the verifier
	 * this storage holds for a sign-in it started. A fragment is ignored there: anyone can mint
	 * one for their OWN account and link a victim to it, which would silently replace the
	 * victim's session with the attacker's (login CSRF).
	 */
	private async fromUrl(): Promise<void> {
		const url = new URL(location.href);
		const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
		const code = url.searchParams.get('code');
		if (code) {
			const { error } = await this.finishProviderSignIn(code);
			if (!error) {
				url.searchParams.delete('code');
				history.replaceState(history.state, '', url.toString());
			}
			return;
		}
		if (this.flowType !== 'implicit') {
			return;
		}
		const accessToken = hash.get('access_token');
		const refreshToken = hash.get('refresh_token');
		if (accessToken && refreshToken) {
			const { body, error } = await this.call(this.route('user'), { token: accessToken });
			if (error) {
				return;
			}
			const expiresIn = Number(hash.get('expires_in') ?? 3600);
			const person = toPerson(body);
			await this.save({
				access_token: accessToken,
				refresh_token: refreshToken,
				token_type: hash.get('token_type') ?? 'bearer',
				expires_in: expiresIn,
				expires_at: Number(hash.get('expires_at') ?? nowSeconds() + expiresIn),
				person,
				user: person,
				provider_token: hash.get('provider_token'),
				provider_refresh_token: hash.get('provider_refresh_token')
			}, hash.get('type') === 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN');
			history.replaceState(history.state, '', `${url.pathname}${url.search}`);
		}
	}

	private async save(session: Session | null, event: AuthEvent): Promise<void> {
		this.session = session;
		if (session) {
			await this.storage.setItem(this.storageKey, JSON.stringify(session));
		} else {
			await this.storage.removeItem(this.storageKey);
		}
		this.schedule();
		this.emit(event);
	}

	private emit(event: AuthEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event, this.session);
			} catch {
				// A listener that throws does not get to stop the others hearing.
			}
		}
	}

	private schedule(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.autoRefresh || this.paused || !this.session) {
			return;
		}
		const due = Math.max(0, (this.session.expires_at - REFRESH_MARGIN - nowSeconds()) * 1000);
		const refreshToken = this.session.refresh_token;
		this.timer = setTimeout(() => void this.refresh(refreshToken), due);
		// In Node, a pending refresh must not be what keeps a script from exiting.
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** One refresh at a time: two callers asking together share the one request. */
	private refresh(refreshToken: string): Promise<Session | null> {
		if (!this.refreshing) {
			this.refreshing = (async () => {
				// Refreshing our own session: somebody sharing the store may have done it already.
				if (refreshToken === this.session?.refresh_token) {
					await this.syncFromStorage();
					const current = this.session as Session | null;
					if (current && current.refresh_token !== refreshToken && current.expires_at - REFRESH_MARGIN > nowSeconds()) {
						return current;
					}
					if (!current) {
						return null;
					}
					refreshToken = current.refresh_token;
				}
				const { body, error } = await this.call(this.route('token'), { query: this.grant('refresh_token'), body: { refresh_token: refreshToken } });
				const session = error ? null : toSession(body);
				if (session) {
					this.debug('token refreshed');
					await this.save(session, 'TOKEN_REFRESHED');
				} else if (error && error.status >= 400 && error.status < 500) {
					// The refresh token is spent or revoked: the session is over.
					this.debug(`refresh refused (${error.status} ${error.code ?? ''} ${error.message}): removing the session`);
					await this.save(null, 'SIGNED_OUT');
				} else {
					this.debug(`refresh failed, session kept: ${error?.message ?? 'no session in the answer'}`);
				}
				return session;
			})().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async signedIn(body: Record<string, unknown>, error: AuthError | null): Promise<AuthResult<SessionData>> {
		if (error) {
			return { data: noSession(), error };
		}
		const session = toSession(body);
		if (session) {
			await this.save(session, 'SIGNED_IN');
			return { data: sessionData(session), error: null };
		}
		// Registered but not signed in: the address has to be confirmed first.
		return { data: sessionData(null, toPerson(body.person ?? body.user ?? body)), error: null };
	}

	// ---- the session ----

	/** The token to send as `Authorization`: the session's, or the project key when signed out. */
	async getAccessToken(): Promise<string> {
		const { data } = await this.currentSession();
		return data.session?.access_token ?? this.key;
	}

	/** The current session, renewed first if it has expired. Read locally, not verified. */
	async currentSession(): Promise<AuthResult<{ session: Session | null }>> {
		await this.ready;
		await this.syncFromStorage();
		if (this.session &&this.session.expires_at - REFRESH_MARGIN <= nowSeconds()) {
			await this.refresh(this.session.refresh_token);
		}
		return { data: { session: this.session }, error: null };
	}

	/** The signed-in person, as the identity server says it is now. Use this, not the session, to decide. */
	async currentPerson(jwt?: string): Promise<AuthResult<PersonData>> {
		// A server client made to BE a person (`global.headers.Authorization`) asks about that person.
		const token = jwt ?? (await this.currentSession()).data.session?.access_token ?? this.fixedBearer ?? undefined;
		if (!token) {
			return { data: noPerson(), error: new AuthError('Auth session missing', 400, 'session_not_found') };
		}
		const { body, error } = await this.call(this.route('user'), { token });
		return error ? { data: noPerson(), error } : { data: personData(toPerson(body)), error: null };
	}

	/** Adopt a session obtained elsewhere (a server, another tab). */
	async setSession(tokens: { access_token: string; refresh_token: string }): Promise<AuthResult<SessionData>> {
		await this.ready;
		const { body, error } = await this.call(this.route('user'), { token: tokens.access_token });
		if (error) {
			const refreshed = await this.refresh(tokens.refresh_token);
			return refreshed ? { data: sessionData(refreshed), error: null } : { data: noSession(), error };
		}
		const payload = JSON.parse(atob(tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
		const expiresAt = payload.exp ?? nowSeconds() + 3600;
		const person = toPerson(body);
		const session: Session = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			token_type: 'bearer',
			expires_in: expiresAt - nowSeconds(),
			expires_at: expiresAt,
			person,
			user: person
		};
		await this.save(session, 'SIGNED_IN');
		return { data: sessionData(session), error: null };
	}

	/** Renew now, with the stored refresh token or the one given. */
	async renew(current?: { refresh_token: string }): Promise<AuthResult<SessionData>> {
		await this.ready;
		const refreshToken = current?.refresh_token ?? this.session?.refresh_token;
		if (!refreshToken) {
			return { data: noSession(), error: new AuthError('Auth session missing', 400, 'session_not_found') };
		}
		const session = await this.refresh(refreshToken);
		return session
			? { data: sessionData(session), error: null }
			: { data: noSession(), error: new AuthError('The session could not be refreshed', 401, 'refresh_token_not_found') };
	}

	/** Called with every change of session. Returns the handle that stops it. */
	onSessionChange(listener: Listener): { data: { subscription: { unsubscribe: () => void } } } {
		this.listeners.add(listener);
		// A listener added after start-up still hears where things stand.
		void this.ready.then(() => {
			if (this.listeners.has(listener)) {
				listener('INITIAL_SESSION', this.session);
			}
		});
		return { data: { subscription: { unsubscribe: () => void this.listeners.delete(listener) } } };
	}

	// ---- signing in ----

	// `captchaToken`, here and on the other sign-in calls, is accepted so code that passes one
	// still compiles, and is not sent: SnoutData's auth server has no captcha.
	/** A new account. `options.profile_data` (`options.data` before 0.4.0) is the person's own data. */
	async register(credentials: {
		email?: string;
		phone?: string;
		password: string;
		options?: {
			profile_data?: Record<string, unknown>;
			/** @deprecated Since 0.4.0: `profile_data`. */
			data?: Record<string, unknown>;
			emailRedirectTo?: string;
			captchaToken?: string;
		};
	}): Promise<AuthResult<SessionData>> {
		await this.ready;
		const { email, phone, password, options = {} } = credentials;
		const { body, error } = await this.call(this.route('signup'), {
			query: { redirect_to: options.emailRedirectTo },
			body: { email, phone, password, ...this.fields('data', options.profile_data ?? options.data ?? {}) }
		});
		return this.signedIn(body, error);
	}

	async passwordSignIn(credentials: { email?: string; phone?: string; password: string }): Promise<AuthResult<SessionData>> {
		await this.ready;
		const { body, error } = await this.call(this.route('token'), { query: this.grant('password'), body: credentials });
		return this.signedIn(body, error);
	}

	/**
	 * An account with no email or password, which can be upgraded later with `changePerson`. The
	 * person's data goes in `options.profile_data`, as `register` takes it; `options.data` and a
	 * bare `data` are still read, since 0.3.x and earlier took it there.
	 */
	async guestSignIn(
		credentials: {
			options?: {
				profile_data?: Record<string, unknown>;
				/** @deprecated Since 0.4.0: `profile_data`. */
				data?: Record<string, unknown>;
			};
			/** @deprecated Since 0.3.2: `options.profile_data`. */
			data?: Record<string, unknown>;
		} = {}
	): Promise<AuthResult<SessionData>> {
		await this.ready;
		const profile = credentials.options?.profile_data ?? credentials.options?.data ?? credentials.data ?? {};
		const { body, error } = await this.call(this.route('signup'), { body: this.fields('data', profile) });
		return this.signedIn(body, error);
	}

	/** Sends a magic link or a one-time code. The session arrives by `confirmCode` or the redirect. */
	async codeSignIn(credentials: {
		email?: string;
		phone?: string;
		options?: {
			emailRedirectTo?: string;
			shouldCreateUser?: boolean;
			profile_data?: Record<string, unknown>;
			/** @deprecated Since 0.4.0: `profile_data`. */
			data?: Record<string, unknown>;
			channel?: 'sms' | 'whatsapp';
		};
	}): Promise<AuthResult<{ person: null; user: null; session: null }>> {
		await this.ready;
		const { email, phone, options = {} } = credentials;
		let challenge: string | undefined;
		if (email && this.flowType === 'pkce') {
			challenge = await this.startPkce();
		}
		const { error } = await this.call(this.route('otp'), {
			query: { redirect_to: options.emailRedirectTo },
			body: {
				email,
				phone,
				...this.fields('data', options.profile_data ?? options.data ?? {}),
				create_user: options.shouldCreateUser ?? true,
				channel: options.channel,
				code_challenge: challenge,
				code_challenge_method: challenge ? 's256' : undefined
			}
		});
		return { data: noSession(), error };
	}

	/** Confirms a one-time code, or a link's token hash, which signs in. */
	async confirmCode(params: {
		email?: string;
		phone?: string;
		token?: string;
		token_hash?: string;
		type: 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email' | 'sms' | 'phone_change';
	}): Promise<AuthResult<SessionData>> {
		await this.ready;
		const { body, error } = await this.call(this.route('verify'), { body: params });
		const result = await this.signedIn(body, error);
		if (!result.error && params.type === 'recovery') {
			this.emit('PASSWORD_RECOVERY');
		}
		return result;
	}

	/**
	 * The URL that signs in with a provider (GitHub, Google, …). In a browser it navigates
	 * there unless `skipBrowserRedirect`; elsewhere it only returns it.
	 */
	async providerSignIn(credentials: {
		provider: string;
		options?: { redirectTo?: string; scopes?: string; queryParams?: Record<string, string>; skipBrowserRedirect?: boolean };
	}): Promise<AuthResult<{ provider: string; url: string }>> {
		await this.ready;
		const options = credentials.options ?? {};
		const url = new URL(joinUrl(this.url, this.route('authorize')));
		url.searchParams.set('provider', credentials.provider);
		if (options.redirectTo) {
			url.searchParams.set('redirect_to', options.redirectTo);
		}
		if (options.scopes) {
			url.searchParams.set('scopes', options.scopes);
		}
		for (const [name, value] of Object.entries(options.queryParams ?? {})) {
			url.searchParams.set(name, value);
		}
		if (this.flowType === 'pkce') {
			url.searchParams.set('code_challenge', await this.startPkce());
			url.searchParams.set('code_challenge_method', 's256');
		}
		if (isBrowser() && !options.skipBrowserRedirect) {
			location.assign(url.toString());
		}
		return { data: { provider: credentials.provider, url: url.toString() }, error: null };
	}

	/**
	 * Signs in with an ID token the provider handed the app directly (Google One Tap, Sign in
	 * with Apple), with no redirect.
	 */
	async signInWithIdToken(credentials: {
		provider: string;
		token: string;
		access_token?: string;
		nonce?: string;
		options?: { captchaToken?: string };
	}): Promise<AuthResult<SessionData>> {
		await this.ready;
		const { provider, token, access_token, nonce } = credentials;
		const { body, error } = await this.call(this.route('token'), {
			query: this.grant('id_token'),
			body: { provider, id_token: token, access_token, nonce }
		});
		return this.signedIn(body, error);
	}

	/**
	 * The URL that signs in through a SAML identity provider, named by its id or by the email
	 * domain it is registered for. In a browser it navigates there unless
	 * `skipBrowserRedirect`; elsewhere it only returns it. The session arrives by the redirect.
	 */
	async ssoSignIn(
		params: ({ providerId: string } | { domain: string }) & { options?: { redirectTo?: string; captchaToken?: string; skipBrowserRedirect?: boolean } }
	): Promise<AuthResult<{ url: string }>> {
		await this.ready;
		const options = params.options ?? {};
		let challenge: string | undefined;
		if (this.flowType === 'pkce') {
			challenge = await this.startPkce();
		}
		const { body, error } = await this.call(this.route('sso'), {
			body: {
				...('providerId' in params ? { provider_id: params.providerId } : { domain: params.domain }),
				redirect_to: options.redirectTo,
				skip_http_redirect: true,
				code_challenge: challenge,
				code_challenge_method: challenge ? 's256' : undefined
			}
		});
		if (error) {
			await this.storage.removeItem(`${this.storageKey}-code-verifier`);
			return { data: { url: null }, error };
		}
		const url = typeof body.url === 'string' ? body.url : '';
		if (!url) {
			return { data: { url: null }, error: new AuthError('The auth server answered SSO with no URL', 500, 'sso_no_url') };
		}
		if (isBrowser() && !options.skipBrowserRedirect) {
			location.assign(url);
		}
		return { data: { url }, error: null };
	}

	/** Finishes a PKCE sign-in (a provider's, a link's, SSO's) with the `code` the redirect carried. */
	async finishProviderSignIn(code: string): Promise<AuthResult<SessionData>> {
		const key = `${this.storageKey}-code-verifier`;
		const verifier = readVerifier(await this.storage.getItem(key));
		if (!verifier) {
			return { data: noSession(), error: new AuthError('No code verifier is stored for this sign-in', 400, 'pkce_verifier_missing') };
		}
		const { body, error } = await this.call(this.route('token'), { query: this.grant('pkce'), body: { auth_code: code, code_verifier: verifier } });
		await this.storage.removeItem(key);
		return this.signedIn(body, error);
	}

	private async startPkce(): Promise<string> {
		const { verifier, challenge } = await pkcePair();
		// JSON-encoded. Not a nicety: `cookieStorage` reads
		// a value back only if it is JSON, so a bare verifier came back null and every redirect
		// sign-in through a cookie store failed on return (0.2.0-0.2.1, found live 2026-09-26).
		await this.storage.setItem(`${this.storageKey}-code-verifier`, JSON.stringify(verifier));
		return challenge;
	}

	/** Ends the session here (`local`), everywhere (`global`) or everywhere else (`others`). */
	async signOff(options: { scope?: 'global' | 'local' | 'others' } = {}): Promise<{ error: AuthError | null }> {
		await this.ready;
		const scope = options.scope ?? 'global';
		const token = this.session?.access_token;
		if (token) {
			const { error } = await this.call(this.route('logout'), { method: 'POST', token, query: { scope } });
			// A token the server no longer knows is as signed out as it gets.
			if (error && error.status !== 401 && error.status !== 403 && error.status !== 404) {
				return { error };
			}
		}
		if (scope !== 'others') {
			this.debug(`signed out by the app (scope ${scope})`);
			await this.save(null, 'SIGNED_OUT');
		}
		return { error: null };
	}

	// ---- the account ----

	/** Mails a password reset link to `email`. */
	async sendReset(email: string, options: { redirectTo?: string; captchaToken?: string } = {}): Promise<{ data: Record<string, never>; error: AuthError | null }> {
		await this.ready;
		let challenge: string | undefined;
		if (this.flowType === 'pkce') {
			challenge = await this.startPkce();
		}
		const { error } = await this.call(this.route('recover'), {
			query: { redirect_to: options.redirectTo },
			body: {
				email,
				code_challenge: challenge,
				code_challenge_method: challenge ? 's256' : undefined
			}
		});
		return { data: {}, error };
	}

	/** Changes the signed-in person's email, phone, password or `profile_data`. */
	async changePerson(
		attributes: {
			email?: string;
			phone?: string;
			password?: string;
			nonce?: string;
			profile_data?: Record<string, unknown>;
			/** @deprecated Since 0.4.0: `profile_data`. */
			data?: Record<string, unknown>;
		},
		options: { emailRedirectTo?: string } = {}
	): Promise<AuthResult<PersonData>> {
		const { data } = await this.currentSession();
		if (!data.session) {
			return { data: noPerson(), error: new AuthError('Auth session missing', 400, 'session_not_found') };
		}
		const { profile_data, data: oldData, ...rest } = attributes;
		const { body, error } = await this.call(this.route('user'), {
			method: 'PUT',
			token: data.session.access_token,
			query: { redirect_to: options.emailRedirectTo },
			body: { ...rest, ...this.fields('data', profile_data ?? oldData) }
		});
		if (error) {
			return { data: noPerson(), error };
		}
		const person = toPerson(body);
		await this.save({ ...data.session, person, user: person }, 'USER_UPDATED');
		return { data: personData(person), error: null };
	}

	/** Re-sends a confirmation or change email, or a code. */
	async resend(params: { type: 'signup' | 'email_change' | 'sms' | 'phone_change'; email?: string; phone?: string; options?: { emailRedirectTo?: string } }): Promise<{ error: AuthError | null }> {
		const { options, ...body } = params;
		const { error } = await this.call('resend', { query: { redirect_to: options?.emailRedirectTo }, body });
		return { error };
	}

	/**
	 * Stops refreshing the token until `startAutoRefresh`. For scripts that want to exit cleanly,
	 * and for an app going to sleep, which should not refresh into a network that is not back.
	 */
	stopAutoRefresh(): void {
		this.paused = true;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Resumes refreshing: at once if the token is due, otherwise when it will be. */
	async startAutoRefresh(): Promise<void> {
		this.paused = false;
		await this.ready;
		await this.syncFromStorage();
		this.schedule();
	}
}

/** What `admin.generateLink` returns beside the user: the link, and the parts it is made of. */
export interface GenerateLinkProperties {
	action_link: string;
	email_otp: string;
	hashed_token: string;
	redirect_to: string;
	verification_type: string;
}

/** Account management with the server key. Never ship that key to a browser. */
export class AuthAdmin {
	constructor(private readonly auth: AuthClient) {}

	/**
	 * A new account. `profile_data` is the person's own data, `server_data` what only the server
	 * key sets (`user_metadata` and `app_metadata` before 0.4.0).
	 */
	async createUser(attributes: {
		email?: string;
		phone?: string;
		password?: string;
		email_confirm?: boolean;
		phone_confirm?: boolean;
		profile_data?: Record<string, unknown>;
		server_data?: Record<string, unknown>;
		/** @deprecated Since 0.4.0: `profile_data`. */
		user_metadata?: Record<string, unknown>;
		/** @deprecated Since 0.4.0: `server_data`. */
		app_metadata?: Record<string, unknown>;
		ban_duration?: string;
	}): Promise<AuthResult<PersonData>> {
		const { body, error } = await this.auth.call(this.auth.route('people'), { body: this.speak(attributes) });
		return error ? { data: noPerson(), error } : { data: personData(toPerson(body)), error: null };
	}

	/** A page of accounts, as `people` (and `users`, its 0.3.x name). */
	async listUsers(params: { page?: number; perPage?: number } = {}): Promise<AuthResult<{ people: Person[]; /** @deprecated Since 0.4.0: `people`. */ users: Person[] }>> {
		const { body, error } = await this.auth.call(this.auth.route('people'), {
			query: { page: params.page?.toString(), per_page: params.perPage?.toString() }
		});
		if (error) {
			return { data: { people: null, users: null }, error };
		}
		const people = ((body.people ?? body.users ?? []) as unknown[]).map(toPerson);
		return { data: { people, users: people }, error: null };
	}

	async getUserById(id: string): Promise<AuthResult<PersonData>> {
		const { body, error } = await this.auth.call(this.auth.route('people', `/${encodePath(id)}`));
		return error ? { data: noPerson(), error } : { data: personData(toPerson(body)), error: null };
	}

	/** Changes any of `createUser`'s attributes, under either name. */
	async updateUserById(id: string, attributes: Record<string, unknown>): Promise<AuthResult<PersonData>> {
		const { body, error } = await this.auth.call(this.auth.route('people', `/${encodePath(id)}`), { method: 'PUT', body: this.speak(attributes) });
		return error ? { data: noPerson(), error } : { data: personData(toPerson(body)), error: null };
	}

	/** `shouldSoftDelete` keeps the row and scrubs it, so foreign keys to it still hold. */
	async deleteUser(id: string, shouldSoftDelete = false): Promise<AuthResult<PersonData>> {
		const { body, error } = await this.auth.call(this.auth.route('people', `/${encodePath(id)}`), {
			method: 'DELETE',
			body: { should_soft_delete: shouldSoftDelete }
		});
		return error ? { data: noPerson(), error } : { data: personData(toPerson(body)), error: null };
	}

	async inviteUserByEmail(
		email: string,
		options: {
			profile_data?: Record<string, unknown>;
			/** @deprecated Since 0.4.0: `profile_data`. */
			data?: Record<string, unknown>;
			redirectTo?: string;
		} = {}
	): Promise<AuthResult<PersonData>> {
		const { body, error } = await this.auth.call('invite', {
			query: { redirect_to: options.redirectTo },
			body: { email, ...this.auth.fields('data', options.profile_data ?? options.data ?? {}) }
		});
		return error ? { data: noPerson(), error } : { data: personData(toPerson(body)), error: null };
	}

	/** A sign-in, invite or recovery link, returned instead of emailed. */
	async generateLink(params: {
		type: 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change_current' | 'email_change_new';
		email: string;
		password?: string;
		newEmail?: string;
		options?: {
			profile_data?: Record<string, unknown>;
			/** @deprecated Since 0.4.0: `profile_data`. */
			data?: Record<string, unknown>;
			redirectTo?: string;
		};
	}): Promise<AuthResult<{ properties: GenerateLinkProperties; person: Person; /** @deprecated Since 0.4.0: `person`. */ user: Person }>> {
		const { options, newEmail, ...rest } = params;
		const { body, error } = await this.auth.call('admin/generate_link', {
			body: { ...rest, new_email: newEmail, ...this.auth.fields('data', options?.profile_data ?? options?.data), redirect_to: options?.redirectTo }
		});
		if (error) {
			return { data: { properties: null, person: null, user: null }, error };
		}
		const { action_link, email_otp, hashed_token, redirect_to, verification_type, ...user } = body;
		const person = toPerson(user);
		return {
			data: { properties: { action_link, email_otp, hashed_token, redirect_to, verification_type } as GenerateLinkProperties, person, user: person },
			error: null
		};
	}

	/** Attributes with the person's data fields under the vocabulary's names, the new one winning when both are given. */
	private speak(attributes: Record<string, unknown>): Record<string, unknown> {
		const { profile_data, server_data, user_metadata, app_metadata, ...rest } = attributes;
		return { ...rest, ...this.auth.fields('user_metadata', profile_data ?? user_metadata, server_data ?? app_metadata) };
	}
}

// The 0.3.x names, each the same function as its new one, kept for 0.4.x.

AuthClient.prototype.signUp = AuthClient.prototype.register;
AuthClient.prototype.signInWithPassword = AuthClient.prototype.passwordSignIn;
AuthClient.prototype.signInWithOtp = AuthClient.prototype.codeSignIn;
AuthClient.prototype.signInWithOAuth = AuthClient.prototype.providerSignIn;
AuthClient.prototype.signInWithSSO = AuthClient.prototype.ssoSignIn;
AuthClient.prototype.signInAnonymously = AuthClient.prototype.guestSignIn;
AuthClient.prototype.verifyOtp = AuthClient.prototype.confirmCode;
AuthClient.prototype.exchangeCodeForSession = AuthClient.prototype.finishProviderSignIn;
AuthClient.prototype.signOut = AuthClient.prototype.signOff;
AuthClient.prototype.getSession = AuthClient.prototype.currentSession;
AuthClient.prototype.getUser = AuthClient.prototype.currentPerson;
AuthClient.prototype.refreshSession = AuthClient.prototype.renew;
AuthClient.prototype.onAuthStateChange = AuthClient.prototype.onSessionChange;
AuthClient.prototype.resetPasswordForEmail = AuthClient.prototype.sendReset;
AuthClient.prototype.updateUser = AuthClient.prototype.changePerson;

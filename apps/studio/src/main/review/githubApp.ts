/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createSign } from 'node:crypto';

import { netFetch } from '../netFetch';
import { ForgeError } from './forge';

/*---------------------------------------------------------------------------------------------
 *  Posting as Snoutbot rather than as a person: the GitHub App half.
 *
 *  A comment's author is the account whose token posted it, and no token can post under another
 *  name. The only thing GitHub lets speak as a bot is an APP, which authenticates differently
 *  from everything else here: sign a short-lived JWT with the App's private key, exchange it for
 *  an INSTALLATION token, and use that as an ordinary bearer token. Comments then arrive as
 *  `<app-slug>[bot]`, which is what CodeRabbit and every other reviewer of this shape is doing.
 *
 *  **The key stays on this machine.** The App belongs to the user's own organization and its
 *  `.pem` goes in the keychain beside their database passwords: no service of ours holds a
 *  credential that can comment on somebody's repositories, and the review still runs here, with
 *  the user's own credentials, against a database we never see. That is the whole reason this is a
 *  file in the desktop app rather than an endpoint on our gateway.
 *
 *  It is deliberately NOT the only way to post. A personal token still works and stays the
 *  default, because it needs no setup at all; this is the choice a team makes when they want the
 *  reviews to come from a bot. `reviewStore.ts` holds which one a host is using.
 *
 *  Two things about the JWT that are easy to get wrong and fail confusingly:
 *    - `iat` is backdated. GitHub rejects a token whose issue time is in ITS future, and a
 *      workstation clock a few seconds fast is common enough that not backdating means an App
 *      that works on most machines and 401s on some.
 *    - `exp` may be at most 10 minutes out. We use far less, because the JWT is only ever used
 *      to fetch an installation token seconds later.
 *--------------------------------------------------------------------------------------------*/

/** How far back to date `iat`, to survive a workstation clock running fast. */
const CLOCK_SKEW_MS = 60_000;
/** How long the App JWT is good for. GitHub's ceiling is 10 minutes; it is used immediately. */
const JWT_LIFETIME_MS = 8 * 60_000;
/**
 * Refresh an installation token this long before it actually expires.
 *
 * An installation token lasts an hour and a review takes seconds, so the only way to be caught
 * out is to start a review just as one lapses. Renewing a minute early costs one extra request
 * an hour and removes the whole class of "it failed once, at :59".
 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const REQUEST_TIMEOUT_MS = 20_000;

/** What a user has to give us for an App: the two things GitHub shows on its settings page. */
export interface GithubAppConfig {
	/** The numeric App ID. A string because it is copied out of a web page. */
	appId: string;
	/** The `.pem` GitHub generated. Held in the keychain, never on disk in the clear. */
	privateKeyPem: string;
}

/** One place the App has been installed: an organization or a user account. */
export interface GithubInstallation {
	id: number;
	/** The org or user it is installed on, for the picker. */
	account: string;
	/** How many repositories it can see, when GitHub says. */
	repositorySelection?: 'all' | 'selected';
}

/** The App itself, as GitHub describes it. */
export interface GithubAppInfo {
	slug: string;
	name: string;
	/** What its comments are authored by. This is the whole point of the feature. */
	login: string;
}

/**
 * The claims of an App JWT.
 *
 * Pure and exported so the two things that make it fail in the field are testable without a
 * network: the backdated `iat`, and an `exp` inside GitHub's ten-minute ceiling.
 */
export function appJwtClaims(appId: string, now: number): { iat: number; exp: number; iss: string } {
	return {
		iat: Math.floor((now - CLOCK_SKEW_MS) / 1000),
		exp: Math.floor((now + JWT_LIFETIME_MS) / 1000),
		iss: appId,
	};
}

/** base64url, which JWT uses and Node's base64 is not. */
function b64url(input: string | Buffer): string {
	return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign an App JWT with the App's private key.
 *
 * RS256 through `node:crypto`, which is why this feature adds no dependency and no native
 * module (every one of those is a way for a release to ship an app that cannot start).
 */
export function signAppJwt(config: GithubAppConfig, now = Date.now()): string {
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = b64url(JSON.stringify(appJwtClaims(config.appId, now)));
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${payload}`);
	signer.end();
	try {
		return `${header}.${payload}.${b64url(signer.sign(config.privateKeyPem))}`;
	} catch (err) {
		// The single most likely setup mistake, and the raw OpenSSL text for it is unreadable.
		throw new ForgeError(
			`That private key could not be used to sign. Check it is the .pem GitHub generated for the App, pasted whole, including the BEGIN and END lines. (${err instanceof Error ? err.message : String(err)})`,
			0,
			false,
		);
	}
}

/** Does this look like a PEM at all? Checked before it is stored, so the failure is at the file
 *  picker rather than on the first review. */
export function looksLikePrivateKey(text: string): boolean {
	return /-----BEGIN (RSA )?PRIVATE KEY-----/.test(text) && /-----END (RSA )?PRIVATE KEY-----/.test(text);
}

/** Is a cached installation token past using? Pure, so the margin is testable. */
export function tokenExpired(expiresAt: number | undefined, now = Date.now()): boolean {
	return expiresAt === undefined || now >= expiresAt - TOKEN_REFRESH_MARGIN_MS;
}

/**
 * Which installation to use when the user has not chosen one.
 *
 * One is the overwhelmingly common case and picking it silently is right. Several is not
 * guessable — an App installed on two organizations could review either — so it returns nothing
 * and the settings pane asks.
 */
export function defaultInstallation(installations: GithubInstallation[]): number | undefined {
	return installations.length === 1 ? installations[0].id : undefined;
}

/**
 * The App's credentials, turned into bearer tokens on demand.
 *
 * Holds one cached installation token. Everything above it (`GithubClient`) takes a function that
 * returns a token and does not know or care whether it came from here or from the keychain, which
 * is what makes "post as me" and "post as the bot" the same client.
 */
export class GithubAppAuth {
	private cached?: { token: string; expiresAt: number };

	constructor(
		private readonly config: GithubAppConfig,
		private readonly api: string,
		/** Which installation to mint tokens for. Discovered and stored on first use. */
		private installationId?: number,
	) {}

	/** An installation token, minted or reused. */
	async token(): Promise<string> {
		if (this.cached && !tokenExpired(this.cached.expiresAt)) {
			return this.cached.token;
		}
		const installation = this.installationId ?? defaultInstallation(await this.installations());
		if (installation === undefined) {
			throw new ForgeError(
				"Snoutbot is installed on more than one account, so it cannot tell which one to review as. Choose one in Settings.",
				0,
				false,
			);
		}
		this.installationId = installation;
		const body = await this.appRequest(`/app/installations/${installation}/access_tokens`, 'POST');
		const parsed = body as { token?: string; expires_at?: string };
		if (!parsed.token) {
			throw new ForgeError("GitHub did not return an installation token for this App.", 0, false);
		}
		this.cached = {
			token: parsed.token,
			expiresAt: parsed.expires_at ? Date.parse(parsed.expires_at) : Date.now() + 3_600_000,
		};
		return this.cached.token;
	}

	/** Everywhere the App is installed. Empty means it was created but never installed, which is
	 *  a step people miss and which the settings pane has to say out loud. */
	async installations(): Promise<GithubInstallation[]> {
		const body = await this.appRequest('/app/installations', 'GET');
		const rows = Array.isArray(body) ? body : [];
		return rows.map((raw) => {
			const row = raw as { id: number; account?: { login?: string }; repository_selection?: string };
			return {
				id: row.id,
				account: row.account?.login ?? 'an account',
				repositorySelection: row.repository_selection === 'all' ? 'all' : 'selected',
			};
		});
	}

	/** The App itself, and the login its comments will carry. */
	async info(): Promise<GithubAppInfo> {
		const body = (await this.appRequest('/app', 'GET')) as { slug?: string; name?: string };
		const slug = body.slug ?? 'app';
		return { slug, name: body.name ?? slug, login: `${slug}[bot]` };
	}

	/** A call authenticated as the APP (the JWT), not as an installation. */
	private async appRequest(path: string, method: 'GET' | 'POST'): Promise<unknown> {
		const response = await netFetch(`${this.api}${path}`, {
			method,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: {
				Authorization: `Bearer ${signAppJwt(this.config)}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'SnoutData',
			},
		});
		if (!response.ok) {
			throw new ForgeError(await appErrorMessage(response), response.status, response.status >= 500);
		}
		return response.json();
	}
}

/** What went wrong, in words that name the setup step that is missing. */
async function appErrorMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => '');
	if (response.status === 401) {
		return "GitHub rejected the App's credentials. Check the App ID matches the private key, and that this computer's clock is right.";
	}
	if (response.status === 404) {
		return "GitHub does not know that App ID. Check it against the App's settings page.";
	}
	return `GitHub refused the App request (${response.status}). ${text.slice(0, 200)}`.trim();
}

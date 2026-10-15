/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CloudRequestError, type CloudMintedToken } from './cloudApi';
import { cliTokenName, CLI_SIGN_IN_TIMEOUT_MS, type CliSignInAnswer, type CliSignInRequest, type CliTokenFailure, type CliTokenResponse } from '../shared/mcp';

/*
 * The sign-in handoff, as a decision.
 *
 * A program on this computer asks the app's local server whether anybody is signed in, and then
 * asks for a credential of its own. This file is the middle of that: ask the person, and on a yes
 * mint an `sdt_` through the control plane. Everything here is pure and injected, so the four
 * answers that matter (nobody signed in, they said no, the control plane refused, it worked) are
 * provable in a millisecond without a window or a network.
 *
 * The two rules it exists to keep, both of them refusals:
 *
 *   * **MINT, never lend.** The app holds a session and could simply hand it over.
 *     That would give the caller the user's entire login: unlistable, unrevocable, and
 *     indistinguishable from the person on every audit line thereafter. What it hands over instead
 *     is a new `sdt_`, which appears in `snoutdata tokens list`, is revoked from there, and lands
 *     on the audit log as itself. There is no code path in this file that reads a session, and the
 *     `CloudApi` seam it mints through has no method that returns one.
 *   * **The prompt is MANNERS, NOT A BOUNDARY.** Any process running as this user can already
 *     decrypt the app's `safeStorage`: it is DPAPI/Keychain and user-scoped, which is exactly what
 *     holds for the agent console too. So the sentence that stays true is **"the app does not hand
 *     over your session without asking"**, and never "nothing could take it". Every word written
 *     for this feature, here or on screen, says the first.
 *
 * Timing out DECLINES, and so does having no window. An unanswered question is not consent, and
 * the caller is a program that can be told to try again.
 */

/** What this module needs from the rest of main, injected so the decisions stay testable. */
export interface CliSignInDeps {
	/** The signed-in account's email, or null when nobody is. Never a token, never a session. */
	account(): string | null;
	/** This computer's name, which is what the minted token is named after. */
	machine(): string;
	/** Put the question on screen and wait for one of the four outcomes. */
	ask(request: CliSignInRequest): Promise<CliSignInOutcome>;
	/** Mint through the control plane, as the signed-in user. */
	mint(name: string): Promise<CloudMintedToken>;
	/** A fresh id for the request, so a reply can be matched to the question that raised it. */
	nextId(): string;
}

/**
 * How the asking ended. Wider than {@link CliSignInAnswer}, which is only what a person can click:
 * not answering and having nobody to ask are outcomes too, and the caller deserves to be told
 * which of the three it was rather than a flat "no".
 */
export type CliSignInOutcome = CliSignInAnswer | 'timeout' | 'unavailable';

/** What the local server passes through: the caller's own claims about itself. */
export interface CliSignInAsk {
	/** What is asking, as it named itself. A claim, shown as one. */
	client: string;
	/** The command it said it was running, when it said one. */
	command?: string;
}

/**
 * Ask, then mint. The whole handoff, minus the transport.
 *
 * Note the order: the account is checked BEFORE the user is interrupted, because "SnoutData is not
 * signed in either" is an answer the caller can act on and a prompt nobody should have to read.
 */
export async function mintCliToken(deps: CliSignInDeps, asked: CliSignInAsk): Promise<CliTokenResponse> {
	const email = deps.account();
	if (email === null) {
		return { ok: false, code: 'not-signed-in', error: 'Nobody is signed in to SnoutData on this computer.' };
	}
	const machine = deps.machine();
	const tokenName = cliTokenName(machine);
	const request: CliSignInRequest = {
		requestId: deps.nextId(),
		client: asked.client,
		command: asked.command,
		machine,
		email,
		// The card shows the name the token will carry, so "you can take it back" is something the
		// user can go and check rather than something we assert at them.
		tokenName,
		timeoutMs: CLI_SIGN_IN_TIMEOUT_MS,
	};
	const answer = await deps.ask(request);
	if (answer === 'unavailable') {
		return { ok: false, code: 'not-ready', error: 'The SnoutData window is not open, so there was nobody to ask.' };
	}
	if (answer === 'timeout') {
		// An unanswered question is not consent. Said separately from a decline because a caller can
		// reasonably offer to try again after this one, and should not after a no.
		return { ok: false, code: 'timeout', error: 'Nobody answered in SnoutData, so it was not allowed.' };
	}
	if (answer !== 'allow') {
		return { ok: false, code: 'declined', error: 'The person at this computer did not allow it.' };
	}
	try {
		const minted = await deps.mint(tokenName);
		return { ok: true, token: minted.token, name: minted.name, prefix: minted.prefix, expiresAt: minted.expiresAt ?? null };
	} catch (err) {
		return tokenFailure(err);
	}
}

/**
 * A thrown mint, as a result the caller can branch on.
 *
 * The distinction worth keeping is REFUSED versus BROKE: a 4xx is the control plane deciding
 * something (this account may not mint, that name is too long) and retrying will not help, while a
 * 5xx or a dead socket is worth trying again in a minute. `CloudRequestError` carries the status
 * precisely so those two do not arrive looking alike.
 */
export function tokenFailure(err: unknown): CliTokenFailure {
	if (err instanceof CloudRequestError) {
		if (err.refused) {
			return { ok: false, code: 'forbidden', error: err.message };
		}
		// Status 0 is the seam's "no response to read a status off", which is a dead link rather
		// than a server saying something.
		return err.status === 0
			? { ok: false, code: 'network', error: err.message }
			: { ok: false, code: 'server', error: err.message };
	}
	// The seam's own timeout, and anything else that stopped the call completing.
	return { ok: false, code: 'network', error: err instanceof Error ? err.message : String(err) };
}

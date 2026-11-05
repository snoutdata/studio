/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Database tokens for Cloud connections that sign in as the person.
// The connection's user is `snout_token` and its password is a token the issuer signs
// for the signed-in session, for one project, for an hour; the front door logs in as the role it
// names. A pool opens connections for longer than a token lasts, so the driver asks for one per
// connection (`SnoutProtocol.ConnectionPassword`) and this keeps one per project until it is
// near its end, so a pool of ten is one request and not ten.

/** What the issuer answered. */
export interface DatabaseToken {
	accessToken: string;
	/** Seconds the token is good for, from when it was issued. */
	expiresIn: number;
}

/** A token is replaced once less than this is left: a connection opened with it must still be
 *  accepted when the pod reads it, after a wake that can take a minute. */
export const RENEW_BEFORE_MS = 5 * 60_000;

export class DatabaseTokens {
	private readonly held = new Map<string, { token: string; until: number }>();
	private readonly asking = new Map<string, Promise<string>>();

	constructor(
		private readonly issue: (ref: string) => Promise<DatabaseToken>,
		private readonly now: () => number = Date.now,
	) {}

	/** A token for this project with time left on it, asked for only when there is none. */
	get(ref: string): Promise<string> {
		const held = this.held.get(ref);
		if (held && held.until - this.now() > RENEW_BEFORE_MS) {
			return Promise.resolve(held.token);
		}
		const pending = this.asking.get(ref);
		if (pending) {
			return pending;
		}
		const asked = (async () => {
			const started = this.now();
			const answer = await this.issue(ref);
			this.held.set(ref, { token: answer.accessToken, until: started + answer.expiresIn * 1000 });
			return answer.accessToken;
		})().finally(() => this.asking.delete(ref));
		this.asking.set(ref, asked);
		return asked;
	}

	/** Forget every token: on sign-out, or when the account changes. */
	clear(): void {
		this.held.clear();
	}
}

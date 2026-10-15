/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The browser's return from a sign-in, read without Electron so it can be tested: what a callback
// says, whether a sign-in is waiting for one, and the 127.0.0.1 listener a development or source
// build returns through (authStore.ts).
//
// Two things anybody can send, and neither may steer the app. (1) Any web page can open
// `snoutdata://auth-callback?error_description=<text>`, so a refusal is shown in a FIXED sentence,
// and only while a sign-in this app started is waiting; the text it carried goes to the log. (2) Any
// program on this computer can request the loopback listener's port, so the listener answers only
// the request carrying the random `state` it put in the return address, and keeps waiting through
// everything else.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

/** What the person is told when the sign-in service sends a sign-in back refused. */
export const SIGN_IN_REFUSED = "Sign-in did not finish: the sign-in service turned it down. Try again. If you sign in with your company's single sign-on and this keeps happening, your administrator can see why.";

export type SignInCallback = { kind: 'ignore' } | { kind: 'code'; code: string } | { kind: 'failed'; reason: string };

/** Read a `snoutdata://auth-callback?…` link (or the loopback return made into one). */
export function readSignInCallback(callbackUrl: string): SignInCallback {
	let params: URLSearchParams;
	try {
		params = new URL(callbackUrl).searchParams;
	} catch {
		return { kind: 'ignore' };
	}
	const failed = params.get('error_description') ?? params.get('error');
	if (failed) {
		return { kind: 'failed', reason: failed };
	}
	const code = params.get('code');
	return code ? { kind: 'code', code } : { kind: 'ignore' };
}

/** One line of a reason that arrived in a link, safe to write to the log. */
export function loggableReason(reason: string): string {
	return reason.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

/** Is a sign-in this app started still waiting for the browser? Expires after `maxMs`. */
export class SignInAttempt {
	private startedAt: number | null = null;

	constructor(private readonly maxMs: number, private readonly clock: () => number = () => Date.now()) {}

	begin(): void {
		this.startedAt = this.clock();
	}

	end(): void {
		this.startedAt = null;
	}

	active(): boolean {
		return this.startedAt !== null && this.clock() - this.startedAt < this.maxMs;
	}
}

/** A fresh, unguessable value for the loopback return address. */
export function newSignInState(): string {
	return randomBytes(32).toString('base64url');
}

export interface LoopbackListener {
	/** The return address to hand the auth server: `http://127.0.0.1:<port>/callback?state=<state>`. */
	url: string;
	close(): void;
}

function sameState(sent: string | null, expected: string): boolean {
	if (sent === null) {
		return false;
	}
	const a = Buffer.from(sent);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Listen on 127.0.0.1 for the browser's return. Only `/callback` carrying `state` is the return: it
 * closes the listener and is handed to `onReturn` with its query (which keeps the auth server's
 * `code` or `error`). Any other request is answered and ignored, and the listener keeps waiting until
 * the real return arrives or `waitMs` has passed.
 */
export function listenForLoopbackReturn(state: string, waitMs: number, onReturn: (search: string, res: ServerResponse) => void): Promise<LoopbackListener> {
	return new Promise((resolve, reject) => {
		let done = false;
		const close = (): void => {
			done = true;
			clearTimeout(timer);
			server.close();
		};
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname !== '/callback') {
				res.writeHead(404).end();
				return;
			}
			if (done || !sameState(url.searchParams.get('state'), state)) {
				res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('This is not the sign-in this app is waiting for.');
				return;
			}
			close();
			onReturn(url.search, res);
		});
		const timer = setTimeout(close, waitMs);
		timer.unref?.();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				close();
				reject(new Error('Could not open a local port for sign-in.'));
				return;
			}
			resolve({ url: `http://127.0.0.1:${address.port}/callback?state=${encodeURIComponent(state)}`, close });
		});
	});
}

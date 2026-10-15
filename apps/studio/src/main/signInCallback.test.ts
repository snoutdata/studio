/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listenForLoopbackReturn, newSignInState, readSignInCallback, SIGN_IN_REFUSED, SignInAttempt } from './signInCallback';

test('a callback is a code, a refusal or nothing', () => {
	assert.deepEqual(readSignInCallback('snoutdata://auth-callback?code=abc'), { kind: 'code', code: 'abc' });
	assert.deepEqual(readSignInCallback('snoutdata://auth-callback?error=access_denied&error_description=Nope'), { kind: 'failed', reason: 'Nope' });
	assert.deepEqual(readSignInCallback('snoutdata://auth-callback?error=access_denied'), { kind: 'failed', reason: 'access_denied' });
	assert.deepEqual(readSignInCallback('snoutdata://auth-callback'), { kind: 'ignore' });
	assert.deepEqual(readSignInCallback('not a url'), { kind: 'ignore' });
});

test('the message shown for a refusal is fixed, whatever text the link carried', () => {
	assert.doesNotMatch(SIGN_IN_REFUSED, /Nope|https?:/);
	assert.ok(!SIGN_IN_REFUSED.includes('—'), 'no em dash in user-facing text');
});

test('a sign-in is in progress from begin until end, or until it has waited too long', () => {
	let now = 1_000;
	const attempt = new SignInAttempt(60_000, () => now);
	assert.equal(attempt.active(), false, 'nothing started: a link that says it failed is not ours');
	attempt.begin();
	assert.equal(attempt.active(), true);
	now += 59_999;
	assert.equal(attempt.active(), true);
	now += 1;
	assert.equal(attempt.active(), false, 'a browser that never came back does not keep the door open');
	attempt.begin();
	attempt.end();
	assert.equal(attempt.active(), false);
});

async function status(url: string): Promise<number | 'refused'> {
	try {
		return (await fetch(url)).status;
	} catch {
		return 'refused';
	}
}

test('the loopback listener ignores every request but the one carrying its state, and keeps waiting', async () => {
	const state = newSignInState();
	assert.match(state, /^[A-Za-z0-9_-]{32,}$/);
	const returned: string[] = [];
	const listener = await listenForLoopbackReturn(state, 60_000, (search, res) => {
		returned.push(search);
		res.writeHead(200).end('ok');
	});
	try {
		const url = new URL(listener.url);
		assert.equal(url.hostname, '127.0.0.1');
		assert.equal(url.pathname, '/callback');
		assert.equal(url.searchParams.get('state'), state);
		const base = `${url.origin}/callback`;
		assert.equal(await status(`${url.origin}/favicon.ico`), 404);
		assert.equal(await status(base), 400, 'no state: any local program could send this');
		assert.equal(await status(`${base}?error_description=cancelled`), 400);
		assert.equal(await status(`${base}?state=somebody-elses&code=x`), 400);
		assert.equal(await status(`${base}?state=${state.slice(0, -1)}&code=x`), 400);
		assert.deepEqual(returned, [], 'none of those ended the sign-in');
		assert.equal(await status(`${base}?code=abc&state=${state}`), 200);
		assert.equal(returned.length, 1);
		assert.equal(new URLSearchParams(returned[0]).get('code'), 'abc');
		assert.equal(await status(`${base}?code=again&state=${state}`), 'refused', 'one return, then the port is closed');
	} finally {
		listener.close();
	}
});

test('the loopback listener closes when it has waited long enough', async () => {
	const listener = await listenForLoopbackReturn(newSignInState(), 50, () => assert.fail('nothing came back'));
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(await status(listener.url), 'refused');
});

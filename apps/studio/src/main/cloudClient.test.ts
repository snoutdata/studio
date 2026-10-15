/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The four constants that decide whether a shipped build can sign in at all.
//
// This file exists because of a gap rather than a bug: NOTHING anywhere pinned the backend
// URL or the key, so a typo in either would have compiled, passed every suite, packaged, and
// bricked sign-in for everyone who took the update. The desktop auto-updates, so that is not
// a bug you fix in the morning — the updater still works, but every install sits signed out
// until a second release reaches it. The 2026-09-17 backend move changed these values for the first
// time in the product's life, which is exactly when the absence of a test stops being
// theoretical.
//
// It reads the SOURCE rather than importing the module, deliberately: `cloudClient.ts`
// imports `electron`, so it cannot be loaded by `node --test`, and the values are compile-time
// constants anyway. What is asserted is what a build will contain.

// The bundled test does NOT sit beside the source, so the path is resolved from the repo
// rather than from this file's location.
function readSource(): string {
	const candidates = [
		join(process.cwd(), 'src', 'main', 'cloudClient.ts'),
		join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'cloudClient.ts'),
	];
	for (const path of candidates) {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			// Try the next one.
		}
	}
	throw new Error(`could not find cloudClient.ts from ${process.cwd()}`);
}

const source = readSource();

function constant(name: string): string {
	// Matches `const NAME = '...'` and `export const NAME = '...'`.
	const found = new RegExp(`(?:export )?const ${name} = '([^']*)'`).exec(source);
	assert.ok(found, `${name} is not declared as a single-quoted string constant`);
	return found[1];
}

// Same trick for the two regex literals that decide what reaches auth-debug.log. Neither is
// exported (nothing outside needs them), and this file cannot import the module anyway, so the
// literals are lifted out of the source and exercised directly.
function pattern(name: string): RegExp {
	const found = new RegExp(`^const ${name} = /(.+)/([a-z]*);$`, 'm').exec(source);
	assert.ok(found, `${name} is not declared as a single-line regex literal`);
	return new RegExp(found[1], found[2]);
}

test('the backend is the accounts hostname', () => {
	assert.equal(constant('ACCOUNTS_URL'), 'https://accounts.snoutdata.com');
	assert.equal(constant('ACCOUNTS_HOST'), 'accounts.snoutdata.com');
});

test('the URL and the host name the same place', () => {
	// ACCOUNTS_HOST is not decoration: it is the health probe's target (index.ts proxyTest),
	// the domain named in every network-error message, and what resolveProxy is asked about.
	// The two drifting apart would mean diagnostics about a host the app never calls.
	assert.equal(new URL(constant('ACCOUNTS_URL')).host, constant('ACCOUNTS_HOST'));
});

test('the key is an app-key JWT for the accounts backend, not an opaque key', () => {
	const key = constant('ACCOUNTS_APP_KEY');
	// This backend accepts only a JWT: three base64url segments, a header naming its algorithm.
	// An opaque key of any other format fails here, whatever its prefix.
	const segments = key.split('.');
	assert.equal(segments.length, 3, 'expected a JWT (header.payload.signature)');
	const [header, payload] = segments;
	const alg = (JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string }).alg;
	assert.ok(alg, 'expected a JWT header naming its algorithm');
	assert.ok(payload, 'expected a JWT with a payload segment');
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
		role?: string;
		iss?: string;
		ref?: string;
		exp?: number;
	};
	// The app role under our name since the key was re-issued; anything but
	// the app role here bypasses RLS.
	assert.equal(claims.role, 'snout_app', 'expected the app role');
	assert.equal(claims.iss, 'snoutdata', 'our issuer, nobody else\'s');
	assert.equal(claims.ref, undefined, 'no project ref in a key every build ships');
	assert.ok((claims.exp ?? 0) * 1000 > Date.now(), 'the shipped key is already expired');
});

test('the auth log keeps what diagnoses a sign-out and drops the firehose', () => {
	// This file reached 107 MB on a real machine in three months: 839,195 lines, 535,467 of them
	// `#_useSession` / `#__loadSession()` ticks. KEEP matches those because they contain the word
	// "session", and SKIP did not exclude them. It sits in every user's profile and nothing
	// trimmed it, so the filter is worth pinning rather than re-deriving after the next blow-up.
	const KEEP = pattern('KEEP');
	const SKIP = pattern('SKIP');
	const logged = (line: string): boolean => KEEP.test(line) && !SKIP.test(line);
	const prefix = 'AuthClient@positron-db-auth:0 2026-09-17T00:49:32.479Z ';

	// Every one of these was taken from the 107 MB file. They say only "a session was read".
	for (const noise of [
		'#_useSession begin',
		'#_useSession end',
		'#__loadSession() begin',
		'#__loadSession() session has not expired expires_at',
		'#__loadSession() end',
		'#_autoRefreshTokenTick() begin',
		'#_autoRefreshTokenTick() access token expires in 113 ticks, a tick lasts 30000ms',
		'#_startAutoRefresh()',
		'#_stopAutoRefresh()',
		'INITIAL_SESSION callback id session',
		'#_recoverAndRefresh() session has not expired with margin of 90000s',
	]) {
		assert.equal(logged(prefix + noise), false, `should not be logged: ${noise}`);
	}

	// And these are the whole reason the log exists — the lines that say what happened to a
	// session. `_saveSession` in particular is the ONLY thing distinguishing a real sign-in from
	// a restore-from-disk, since the client emits SIGNED_IN for both.
	for (const signal of [
		'#_removeSession()',
		'#_saveSession()',
		'#_notifyAllSubscribers(SIGNED_IN) begin broadcast = true',
		'#_notifyAllSubscribers(SIGNED_OUT) begin broadcast = true',
		'#_notifyAllSubscribers(TOKEN_REFRESHED) begin broadcast = true',
		'#_recoverAndRefresh() session from storage',
		'#_callRefreshToken() refresh failed with a non-retryable error, removing the session',
		'#_recoverAndRefresh() error from storage',
	]) {
		assert.equal(logged(prefix + signal), true, `should be logged: ${signal}`);
	}
});

test('the auth log cannot grow without bound', () => {
	// The filter is a guess about wording; the cap is what makes a wrong guess survivable.
	assert.match(source, /const MAX_LOG_BYTES = /, 'no size ceiling on auth-debug.log');
	assert.match(source, /rollIfTooBig\(path\);/, 'the ceiling is declared but never applied');
});

test('the session store key does NOT follow the URL', () => {
	// Why the desktop survives this move where a web client may not: a cookie store whose name is
	// DERIVED from the project URL is renamed by repointing, which signs everyone out. The desktop
	// names its store outright, so an existing session is still found after the update — which is
	// the difference between an upgrade nobody notices and one that signs out every install.
	assert.equal(constant('AUTH_STORAGE_KEY'), 'positron-db-auth');
});

test('the client speaks the names the accounts backend serves', () => {
	// The client builds from packages/client, whose default is the new layout (`/v1/identity`,
	// `Snout-Key`). Until the new names are live on the control plane that would answer every
	// sign-in with a 404, so the client is told which names to speak, from one constant.
	assert.match(source, /vocabulary: ACCOUNTS_VOCABULARY,/, 'the accounts client does not pass its vocabulary');
	assert.match(source, /\[keyHeader\(ACCOUNTS_VOCABULARY\)\]: ACCOUNTS_APP_KEY/, 'the health probe does not send the key under the backend\'s header');
});

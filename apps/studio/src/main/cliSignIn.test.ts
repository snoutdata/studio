/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { mintCliToken, tokenFailure, type CliSignInDeps, type CliSignInOutcome } from './cliSignIn';
import { CloudRequestError, type CloudMintedToken } from './cloudApi';
import { cliTokenName, type CliSignInRequest } from '../shared/mcp';

// The sign-in handoff's decisions, without a window or a network.
// Everything asserted here is one of the two rules the feature exists to keep: it MINTS rather
// than lends, and it asks first, saying honestly that asking is manners rather than a
// boundary (which is a claim about WORDING and lives in the UI + the docs, so what is
// provable here is the mint half and the four ways the asking can end).

function deps(over: Partial<CliSignInDeps> = {}): CliSignInDeps & { asked: CliSignInRequest[]; minted: string[] } {
	const asked: CliSignInRequest[] = [];
	const minted: string[] = [];
	const base: CliSignInDeps = {
		account: () => 'alex@example.com',
		machine: () => 'alexs-laptop',
		ask: async (request) => { asked.push(request); return 'allow'; },
		mint: async (name): Promise<CloudMintedToken> => {
			minted.push(name);
			return { token: 'sdt_secret', id: 'id-1', name, prefix: 'sdt_abcd', expiresAt: null };
		},
		nextId: () => 'cli-1',
	};
	return { ...base, ...over, asked, minted };
}

test('a yes mints a NEW token; the session is never what comes back', async () => {
	const d = deps();
	const result = await mintCliToken(d, { client: 'snoutdata-cli', command: 'init' });
	assert.equal(result.ok, true);
	assert.deepEqual(result, { ok: true, token: 'sdt_secret', name: 'SnoutData CLI on alexs-laptop', prefix: 'sdt_abcd', expiresAt: null });
	assert.deepEqual(d.minted, ['SnoutData CLI on alexs-laptop']);
});

test('the token is named for where it came from, so a person can decide whether to revoke it', async () => {
	// Name the token so a person can tell where it came from. Someone reading
	// `snoutdata tokens list` a month later has the machine and the fact that the app minted it, which is enough to act on.
	assert.equal(cliTokenName('alexs-laptop'), 'SnoutData CLI on alexs-laptop');
	assert.equal(cliTokenName('   '), 'SnoutData CLI on this computer');
	// cloud-token-create refuses a name over 80 characters, so it can never be asked for one.
	assert.equal(cliTokenName('m'.repeat(200)).length, 80);
});

test('the card is shown the name the token will actually carry', async () => {
	const d = deps();
	await mintCliToken(d, { client: 'snoutdata-cli' });
	assert.equal(d.asked.length, 1);
	assert.equal(d.asked[0].tokenName, 'SnoutData CLI on alexs-laptop');
	assert.equal(d.asked[0].email, 'alex@example.com');
	assert.equal(d.asked[0].machine, 'alexs-laptop');
	assert.equal(d.asked[0].client, 'snoutdata-cli');
});

test('nobody is interrupted when there is no account to hand over', async () => {
	// "SnoutData is not signed in either" is an answer the caller can act on, and a prompt
	// nobody should have to read.
	const d = deps({ account: () => null });
	const result = await mintCliToken(d, { client: 'snoutdata-cli' });
	assert.deepEqual(result, { ok: false, code: 'not-signed-in', error: 'Nobody is signed in to SnoutData on this computer.' });
	assert.equal(d.asked.length, 0);
	assert.equal(d.minted.length, 0);
});

test('a no mints nothing', async () => {
	const d = deps({ ask: async () => 'decline' });
	const result = await mintCliToken(d, { client: 'snoutdata-cli' });
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.code, 'declined');
	assert.equal(d.minted.length, 0);
});

test('not answering is not consent, and is reported as itself', async () => {
	// Said separately from a decline because a caller can reasonably offer to try again after a
	// timeout and should not after a refusal.
	for (const [outcome, code] of [['timeout', 'timeout'], ['unavailable', 'not-ready']] as Array<[CliSignInOutcome, string]>) {
		const d = deps({ ask: async () => outcome });
		const result = await mintCliToken(d, { client: 'snoutdata-cli' });
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.code, code);
		assert.equal(d.minted.length, 0);
	}
});

test('a control plane that REFUSED is told apart from one that BROKE', async () => {
	// The distinction the caller branches on: 4xx will not come good on a retry, 5xx and a dead
	// link might. CloudRequestError carries the status precisely so the two do not look alike.
	assert.deepEqual(tokenFailure(new CloudRequestError('not allowed', 403)), { ok: false, code: 'forbidden', error: 'not allowed' });
	assert.deepEqual(tokenFailure(new CloudRequestError('boom', 500)), { ok: false, code: 'server', error: 'boom' });
	assert.deepEqual(tokenFailure(new CloudRequestError('no answer', 0)), { ok: false, code: 'network', error: 'no answer' });
	assert.deepEqual(tokenFailure(new Error('SnoutData Cloud did not answer in time')), { ok: false, code: 'network', error: 'SnoutData Cloud did not answer in time' });
});

test('a mint that throws after the yes is a result, not an exception', async () => {
	const d = deps({ mint: async () => { throw new CloudRequestError('a token cannot mint a token', 403); } });
	const result = await mintCliToken(d, { client: 'snoutdata-cli' });
	assert.deepEqual(result, { ok: false, code: 'forbidden', error: 'a token cannot mint a token' });
});

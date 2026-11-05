/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseTokens, RENEW_BEFORE_MS } from './cloudDbToken';

function issuer() {
	let clock = 1_000_000;
	const asked: string[] = [];
	const tokens = new DatabaseTokens(async (ref) => {
		asked.push(ref);
		return { accessToken: `${ref}-${asked.length}`, expiresIn: 3600 };
	}, () => clock);
	return { tokens, asked, advance: (ms: number) => { clock += ms; } };
}

test('one token per project serves a whole pool, and is replaced before it runs out', async () => {
	const { tokens, asked, advance } = issuer();
	assert.equal(await tokens.get('a'), 'a-1');
	assert.equal(await tokens.get('a'), 'a-1');
	advance(3600_000 - RENEW_BEFORE_MS - 1);
	assert.equal(await tokens.get('a'), 'a-1');
	advance(2);
	assert.equal(await tokens.get('a'), 'a-2');
	assert.deepEqual(asked, ['a', 'a']);
});

test('ten connections opening at once ask once', async () => {
	const { tokens, asked } = issuer();
	const all = await Promise.all(Array.from({ length: 10 }, () => tokens.get('a')));
	assert.deepEqual(new Set(all), new Set(['a-1']));
	assert.equal(asked.length, 1);
});

test('each project has its own token, and sign-out forgets them all', async () => {
	const { tokens, asked } = issuer();
	assert.equal(await tokens.get('a'), 'a-1');
	assert.equal(await tokens.get('b'), 'b-2');
	tokens.clear();
	assert.equal(await tokens.get('a'), 'a-3');
	assert.deepEqual(asked, ['a', 'b', 'a']);
});

test('a refusal is not remembered: the next connection asks again', async () => {
	let refuse = true;
	const tokens = new DatabaseTokens(async () => {
		if (refuse) {
			throw new Error('no database access');
		}
		return { accessToken: 't', expiresIn: 3600 };
	});
	await assert.rejects(tokens.get('a'), /no database access/);
	refuse = false;
	assert.equal(await tokens.get('a'), 't');
});

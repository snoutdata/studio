/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRefusal, refusalSentence } from './gatewayRefusal';

// The bodies are the gateway's own, as they reached Studio and the dashboard on 2026-10-20.
const body = (code: string, message: string, scope?: string) =>
	JSON.stringify({ error: { message, type: 'rate_limit_error', code, param: null, provider: null, ...(scope ? { scope } : {}) } });

test('a refusal says whose budget it was, never its internal name', () => {
	const own = gatewayRefusal(`OpenAI 429: ${body('budget_exceeded', 'The budget account 4c66ca15 ($0.00 since 2026-06-13) has $0.00 left, and this call could cost up to $0.01.', 'user')}`);
	assert.deepEqual(own, { code: 'budget_exceeded', scope: 'user', retryIn: null });
	assert.match(refusalSentence(own!), /your AI budget/);
	assert.doesNotMatch(refusalSentence(own!), /4c66ca15|account /);

	const team = gatewayRefusal(body('budget_exceeded', 'The budget team 614c6488 ($150.00 a month from the 13th) has $0.00 left.', 'group'));
	assert.match(refusalSentence(team!), /team's shared AI budget/);

	// SnoutData AI's own daily ceiling is ours: the person is told their budget is untouched.
	const ceiling = gatewayRefusal(body('budget_exceeded', 'The budget project day ($200.00 a day) has $0.00 left.', 'project'));
	assert.match(refusalSentence(ceiling!), /ours and not yours/);
	assert.doesNotMatch(refusalSentence(ceiling!), /used up your/);
});

test('a rate limit says when to try again, and is never shown raw', () => {
	const limit = gatewayRefusal(`OpenAI 429: ${body('rate_limit_exceeded', 'The limit account 4c66ca15 (2 requests a minute) is used up; try again in 30s.', 'user')}`);
	assert.deepEqual(limit, { code: 'rate_limit_exceeded', scope: 'user', retryIn: '30s' });
	assert.equal(refusalSentence(limit!), "That's more requests in a minute than your plan allows. Try again in 30s.");
	const busy = gatewayRefusal(body('rate_limit_exceeded', 'The limit everyone (600 requests a minute) is used up; try again in 2m.', 'project'));
	assert.match(refusalSentence(busy!), /busier than it can serve.*in 2m/);
});

test('an older gateway with no scope, text that is not JSON, and other errors', () => {
	const old = gatewayRefusal(body('budget_exceeded', 'The budget x has $0.00 left.'));
	assert.deepEqual(old, { code: 'budget_exceeded', scope: null, retryIn: null });
	assert.match(refusalSentence(old!), /your AI budget/);
	assert.equal(gatewayRefusal('upstream said budget_exceeded, then hung up')?.code, 'budget_exceeded');
	assert.equal(gatewayRefusal(`OpenAI 502: ${body('provider_billing', 'OpenAI has no credit.')}`), null);
	assert.equal(gatewayRefusal('fetch failed'), null);
	// A provider's own rate limit passed on is not Psyche's, and is not read as one.
	assert.equal(gatewayRefusal(`OpenAI 429: ${body('rate_limited', 'Slow down.')}`), null);
});

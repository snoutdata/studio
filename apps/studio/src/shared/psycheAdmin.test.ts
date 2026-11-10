/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PsycheAdmin, PsycheError, modelInput, modelPath, notServing, psycheAdminPathAllowed, psycheAnswer, type Model } from './psycheAdmin';

function model(extra: Partial<Model> = {}): Model {
	return {
		name: 'm', provider: 'openai', upstream: 'gpt', prompt_caching: false, max_output_tokens: null, reasoning: null, embeddings: null,
		own_price: { input: 1, output: 2 }, price: { input: 1, output: 2 }, price_from: 'model', enabled: true, served: true, origin: 'api',
		access: 'granted', grants: 0, edited: false, problem: null, fits: null, ...extra,
	};
}

test('an edit starts from everything the model is, its internet level included', () => {
	const input = modelInput(model({ internet: 'web', max_output_tokens: 900 }));
	assert.deepEqual(input, { provider: 'openai', upstream: 'gpt', prompt_caching: false, enabled: true, access: 'granted', max_output_tokens: 900, price: { input: 1, output: 2 }, internet: 'web' });
});

test('a gateway that reports no internet level is not sent one', () => {
	assert.equal('internet' in modelInput(model()), false);
});

test('a model name keeps its slashes and encodes the rest', () => {
	assert.equal(modelPath('openai/gpt 5:x'), 'openai/gpt%205%3Ax');
});

test('only admin paths with no way back up may be sent', () => {
	assert.ok(psycheAdminPathAllowed('admin/models/openai/gpt-5'));
	assert.ok(psycheAdminPathAllowed('admin/usage?by=day'));
	for (const bad of ['admin/../models', 'chat/completions', '/admin/models', 'admin//x', 'admin/%2e%2e/x', 'admin/a%2Fb', 'admin/x y', 7, null]) {
		assert.equal(psycheAdminPathAllowed(bad), false, String(bad));
	}
});

test('the client names the dashboard calls, and a refusal is Psyche\'s sentence', async () => {
	const calls: unknown[][] = [];
	const admin = new PsycheAdmin(async (method, path, body) => {
		calls.push([method, path, body]);
		return { data: [{ name: 'x' }] };
	});
	assert.deepEqual(await admin.models(), [{ name: 'x' }]);
	await admin.setInternet(model({ name: 'a/b' }), 'none');
	await admin.usage({ by: 'day' });
	assert.deepEqual(calls, [
		['GET', 'admin/models', undefined],
		['PUT', 'admin/models/a/b', { provider: 'openai', upstream: 'gpt', prompt_caching: false, enabled: true, access: 'granted', price: { input: 1, output: 2 }, internet: 'none' }],
		['GET', 'admin/usage?by=day', undefined],
	]);
	assert.throws(() => psycheAnswer({ ok: false, status: 400, body: null, error: 'No such provider.', code: 'bad' }), (e: unknown) => e instanceof PsycheError && e.message === 'No such provider.' && e.code === 'bad');
	assert.ok(notServing(new PsycheError('off', 404)));
	assert.equal(notServing(new PsycheError('no', 403)), false);
});

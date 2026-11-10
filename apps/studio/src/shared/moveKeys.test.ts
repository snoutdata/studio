/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freeProviderName, moveInput, moveKeys, type MoveKeyInput } from './moveKeys';
import { PsycheAdmin, PsycheError } from './psycheAdmin';

function gateway(existing: { providers?: string[]; models?: string[]; refuseCredential?: boolean } = {}): { admin: PsycheAdmin; calls: string[]; bodies: Map<string, unknown> } {
	const calls: string[] = [];
	const bodies = new Map<string, unknown>();
	const admin = new PsycheAdmin(async (method, path, body) => {
		if (method === 'GET' && path === 'admin/providers') {
			return { data: (existing.providers ?? []).map((name) => ({ name })) };
		}
		if (method === 'GET' && path === 'admin/models') {
			return { data: (existing.models ?? []).map((name) => ({ name })) };
		}
		calls.push(`${method} ${path}`);
		bodies.set(`${method} ${path}`, body);
		if (existing.refuseCredential && path.startsWith('admin/credentials/')) {
			throw new PsycheError('The provider refused this key.', 400);
		}
		return {};
	});
	return { admin, calls, bodies };
}

const OPENAI: MoveKeyInput = { source: 'byok-openai', apiKey: 'sk-1', baseUrl: 'https://api.openai.com/v1', models: ['gpt-a', 'gpt-b'] };

test('a key with no models, or no key, is not offered; the active model joins the curated ones', () => {
	assert.equal(moveInput('byok-openai', undefined, { model: 'm', models: [] }), null);
	assert.equal(moveInput('byok-openai', 'k', { model: '', models: [] }), null);
	assert.deepEqual(moveInput('byok-anthropic', 'k', { model: 'c', models: ['a', 'c'] }), { source: 'byok-anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', models: ['a', 'c'] });
	assert.equal(moveInput('byok-openai', 'k', { model: 'm', models: [], baseUrl: ' https://proxy/v1 ' })?.baseUrl, 'https://proxy/v1');
});

test('provider, then models, then the credential, and the assistant goes to the preferred model', async () => {
	const { admin, calls, bodies } = gateway();
	const result = await moveKeys(admin, [OPENAI], 'gpt-b');
	assert.deepEqual(calls, ['PUT admin/providers/openai', 'PUT admin/models/gpt-a', 'PUT admin/models/gpt-b', 'PUT admin/credentials/openai']);
	assert.deepEqual(bodies.get('PUT admin/providers/openai'), { kind: 'openai', base_url: 'https://api.openai.com/v1', credential: 'openai' });
	assert.deepEqual(bodies.get('PUT admin/credentials/openai'), { api_key: 'sk-1' });
	assert.deepEqual(result.switchTo, { model: 'gpt-b', provider: 'openai' });
});

test('nothing in the project is overwritten: a taken provider name changes, a taken model stays', async () => {
	assert.equal(freeProviderName('openai', new Set(['openai', 'openai-studio'])), 'openai-studio-2');
	const { admin, calls } = gateway({ providers: ['openai'], models: ['gpt-a'] });
	const result = await moveKeys(admin, [OPENAI]);
	assert.deepEqual(calls, ['PUT admin/providers/openai-studio', 'PUT admin/models/gpt-b', 'PUT admin/credentials/openai-studio']);
	assert.deepEqual(result.moved, [{ source: 'byok-openai', provider: 'openai-studio', models: ['gpt-b'] }]);
});

test('every model already there means the key is not posted', async () => {
	const { admin, calls } = gateway({ models: ['gpt-a', 'gpt-b'] });
	const result = await moveKeys(admin, [OPENAI]);
	assert.deepEqual(calls, []);
	assert.equal(result.switchTo, null);
});

test('a key the gateway refuses leaves nothing behind and says why', async () => {
	const { admin, calls } = gateway({ refuseCredential: true });
	const result = await moveKeys(admin, [OPENAI]);
	assert.deepEqual(calls.slice(-3), ['DELETE admin/models/gpt-a', 'DELETE admin/models/gpt-b', 'DELETE admin/providers/openai']);
	assert.deepEqual(result.failed, [{ source: 'byok-openai', message: 'The provider refused this key.' }]);
	assert.equal(result.switchTo, null);
});

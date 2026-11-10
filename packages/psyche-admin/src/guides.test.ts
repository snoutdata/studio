/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_SOURCES, connectBodies, modelBody, sourceMatches, suggestModelName } from './guides.ts'

const source = (id: string) => MODEL_SOURCES.find((s) => s.id === id)!

test('a connection belongs to the source with its wire format and address', () => {
	assert.ok(sourceMatches(source('openrouter'), { kind: 'openai', base_url: 'https://openrouter.ai/api/v1/' }))
	assert.ok(!sourceMatches(source('openai'), { kind: 'openai', base_url: 'https://openrouter.ai/api/v1' }))
	assert.ok(sourceMatches(source('ollama'), { kind: 'openai', base_url: 'https://home-ai.snoutdata.com/v1' }))
	assert.ok(!sourceMatches(source('ollama'), { kind: 'openai', base_url: 'https://api.openai.com/v1' }))
	assert.ok(sourceMatches(source('bedrock'), { kind: 'bedrock', base_url: '' }))
	assert.ok(!sourceMatches(source('anthropic'), { kind: 'bedrock', base_url: '' }))
})

test('a caller name is the upstream id made plain', () => {
	assert.equal(suggestModelName('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5-20250929')
	assert.equal(suggestModelName('anthropic/claude-sonnet-4.5'), 'claude-sonnet-4.5')
	assert.equal(suggestModelName('snout-fim:1.0'), 'snout-fim-1.0')
	assert.equal(suggestModelName('mxbai-embed-large'), 'mxbai-embed-large')
})

test('every source has something to say at every step', () => {
	for (const s of MODEL_SOURCES) {
		assert.ok(s.connect.steps.length > 0 && s.model.steps.length > 0 && s.price.steps.length > 0, s.id)
		assert.ok(s.baseUrl || s.editableUrl || s.kind === 'bedrock', `${s.id} has an address`)
	}
})


test('connecting a keyed source names its credential after the provider, and asks for the key', () => {
	assert.deepEqual(connectBodies(source('openai'), 'openai', { baseUrl: 'https://api.openai.com/v1', apiKey: ' sk-1 ' }), {
		provider: { kind: 'openai', base_url: 'https://api.openai.com/v1', credential: 'openai' },
		credential: { api_key: 'sk-1' }
	})
	assert.ok('problem' in connectBodies(source('openai'), 'openai', { baseUrl: 'https://api.openai.com/v1' }))
})

test('Bedrock takes a region and an access key pair, and Ollama needs no key', () => {
	assert.deepEqual(connectBodies(source('bedrock'), 'bedrock', { region: 'us-west-2', aws: true, accessKeyId: 'AK', secretAccessKey: 'SK' }), {
		provider: { kind: 'bedrock', region: 'us-west-2', credential: 'bedrock' },
		credential: { access_key_id: 'AK', secret_access_key: 'SK' }
	})
	assert.ok('problem' in connectBodies(source('bedrock'), 'bedrock', { aws: true, accessKeyId: 'AK', secretAccessKey: 'SK' }))
	assert.deepEqual(connectBodies(source('ollama'), 'home', { baseUrl: 'http://10.0.0.5:11434/v1' }), {
		provider: { kind: 'openai', base_url: 'http://10.0.0.5:11434/v1' },
		credential: null
	})
})

test('a model takes both rates or neither, and a cap only when it is positive', () => {
	assert.deepEqual(modelBody({ provider: 'p', upstream: ' m ', input: '0.15', output: '0.6', maxOutput: '0' }), {
		model: { provider: 'p', upstream: 'm', price: { input: 0.15, output: 0.6 } }
	})
	assert.deepEqual(modelBody({ provider: 'p', upstream: 'm', caching: true, enabled: true, access: 'everyone' }), {
		model: { provider: 'p', upstream: 'm', prompt_caching: true, enabled: true, access: 'everyone' }
	})
	assert.ok('problem' in modelBody({ provider: 'p', upstream: 'm', input: '1' }))
	assert.ok('problem' in modelBody({ provider: 'p', upstream: 'm', input: '-1', output: '1' }))
	assert.ok('problem' in modelBody({ provider: 'p', upstream: ' ' }))
})

// The gateway appends the operation (`messages`, `chat/completions`) to a provider's address, so a
// fixed address is the API's versioned root. Anthropic's was given without `/v1` until 2026-10-20:
// every call 404'd, and so did the key's proof, which takes anything but a 401 or 403 as accepted,
// so a made-up key was stored.
test('a fixed address is the versioned root the gateway appends operations to', () => {
	for (const s of MODEL_SOURCES.filter((one) => one.baseUrl)) {
		assert.match(s.baseUrl!, /\/v1$/, s.id)
	}
})

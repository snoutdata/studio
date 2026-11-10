/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PsycheAdmin, PsycheError, directTransport, dollars, errorFrom, matchUpstream, modelInput, modelPath, queryString, type Model, type Transport } from './index.ts'

function recording(answer: unknown = { data: [] }): { calls: Array<[string, string, unknown]>; send: Transport } {
	const calls: Array<[string, string, unknown]> = []
	return {
		calls,
		send: async (method, path, body) => {
			calls.push([method, path, body])
			return answer
		}
	}
}

test('each call names its method and path, and a model keeps the / in its name', async () => {
	const { calls, send } = recording({ data: [] })
	const admin = new PsycheAdmin(send)
	await admin.models()
	await admin.putModel('openai/gpt 4o', { provider: 'openai' })
	await admin.deleteModel('snout-fim-1.0')
	await admin.putCredential('home ollama', { api_key: 'x' })
	await admin.editBudget('b1', { amount: 5 })
	await admin.usage({ by: 'model', from: '2026-10-01', model: undefined })
	await admin.requests({ limit: 2, before: 123 })
	assert.deepEqual(
		calls.map(([method, path]) => `${method} ${path}`),
		[
			'GET admin/models',
			'PUT admin/models/openai/gpt%204o',
			'DELETE admin/models/snout-fim-1.0',
			'PUT admin/credentials/home%20ollama',
			'PATCH admin/budgets/b1',
			'GET admin/usage?by=model&from=2026-10-01',
			'GET admin/requests?limit=2&before=123'
		]
	)
	assert.deepEqual(calls[3][2], { api_key: 'x' })
})

test('a list without data is empty, not a crash', async () => {
	const admin = new PsycheAdmin(async () => null)
	assert.deepEqual(await admin.keys(), [])
})

test('the helpers', () => {
	assert.equal(modelPath('a/b c'), 'a/b%20c')
	assert.equal(queryString({}), '')
	assert.equal(queryString({ a: '', b: null, c: 0 }), '?c=0')
	assert.equal(dollars('0.004000'), 0.004)
	assert.equal(dollars(null), null)
	assert.equal(dollars('nope'), null)
})

test("a refusal carries Psyche's own sentence and code", () => {
	const error = errorFrom(429, { error: { message: 'The budget "day" has $0.01 left.', code: 'budget_exceeded' } })
	assert.ok(error instanceof PsycheError)
	assert.equal(error.message, 'The budget "day" has $0.01 left.')
	assert.equal(error.code, 'budget_exceeded')
	assert.equal(errorFrom(403, { error: 'Not allowed' }).message, 'Not allowed')
	assert.equal(errorFrom(502, '<html>').message, 'The gateway answered 502.')
})

test('the direct transport sends the token and JSON, and throws a refusal', async () => {
	const seen: Array<{ url: string; init: RequestInit }> = []
	const fake = (async (url: string, init: RequestInit) => {
		seen.push({ url, init })
		if (init.method === 'DELETE') {
			return new Response(JSON.stringify({ error: { message: 'There is no budget with that id.' } }), { status: 404 })
		}
		return init.method === 'GET' ? new Response('{"data":[{"id":"k"}]}', { status: 200 }) : new Response(null, { status: 204 })
	}) as unknown as typeof fetch
	const admin = new PsycheAdmin(directTransport('https://x.example/ai/v1/', () => 'tok', fake))
	assert.deepEqual(await admin.keys(), [{ id: 'k' }])
	await admin.createKey({ name: 'ci' })
	await assert.rejects(admin.deleteBudget('nope'), (e: unknown) => e instanceof PsycheError && e.status === 404)
	assert.equal(seen[0].url, 'https://x.example/ai/v1/admin/keys')
	assert.equal((seen[0].init.headers as Record<string, string>).authorization, 'Bearer tok')
	assert.equal(seen[1].init.body, '{"name":"ci"}')
})

test('an edit starts from everything the model is, so the PUT resets nothing', () => {
	const model: Model = {
		name: 'luna', provider: 'bedrock', upstream: 'us.openai.gpt-5.6-luna', prompt_caching: false,
		max_output_tokens: null, reasoning: 'effort', embeddings: null, own_price: { input: 0.22, output: 1.32 },
		price: { input: 0.22, output: 1.32 }, price_from: 'model', enabled: false, served: false, origin: 'api',
		edited: false, access: 'granted', grants: 2, problem: null
	}
	assert.deepEqual(modelInput(model), {
		provider: 'bedrock', upstream: 'us.openai.gpt-5.6-luna', prompt_caching: false, enabled: false,
		access: 'granted', reasoning: 'effort', price: { input: 0.22, output: 1.32 }
	})
})

test('a provider\'s own models: a saved one by name, an unsaved one by POST; a picker matches every word', async () => {
	const { calls, send } = recording({ data: [{ id: 'gpt-5-mini', kind: 'chat' }] })
	const admin = new PsycheAdmin(send)
	assert.deepEqual(await admin.upstreamModels('open ai'), [{ id: 'gpt-5-mini', kind: 'chat' }])
	const unsaved = { provider: { kind: 'openai' as const, base_url: 'https://api.openai.com/v1' }, credential: { api_key: 'k' } }
	await admin.upstreamModels(unsaved)
	assert.deepEqual(calls.map(([method, path]) => `${method} ${path}`), ['GET admin/providers/open%20ai/upstream-models', 'POST admin/upstream-models'])
	assert.deepEqual(calls[1][2], unsaved)
	const models = [{ id: 'us.openai.gpt-5.6-luna', name: 'US GPT Luna' }, { id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }]
	assert.deepEqual(matchUpstream(models, 'gpt luna').map((m) => m.id), ['us.openai.gpt-5.6-luna'])
	assert.deepEqual(matchUpstream(models, '').length, 3)
	assert.deepEqual(matchUpstream(models, 'GPT', 1).map((m) => m.id), ['us.openai.gpt-5.6-luna'])
})

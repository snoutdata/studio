/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AiError, snout, type AiChatChunk } from './index.js';
import { fakeFetch, type Sent } from './testing.js';

const URL_ = 'https://abc123.api.snoutdata.com';

function client(answer: (request: Sent) => { status?: number; body?: unknown; headers?: Record<string, string> }, vocabulary?: 'old') {
	const { fetch, sent } = fakeFetch(answer);
	const db = snout(URL_, 'app-key', { vocabulary, global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
	return { db, sent };
}

function sse(...events: string[]): string {
	return events.map((data) => `data: ${data}\n\n`).join('');
}

test('the gateway is at /ai/v1 in both vocabularies', () => {
	assert.equal(client(() => ({})).db.aiUrl, `${URL_}/ai/v1`);
	assert.equal(client(() => ({}), 'old').db.aiUrl, `${URL_}/ai/v1`);
});

test('models lists what the project serves, with the key and a Bearer token', async () => {
	const { db, sent } = client(() => ({ body: { object: 'list', data: [{ id: 'fast', object: 'model' }] } }));
	const { data, error } = await db.ai.models();
	assert.equal(error, null);
	assert.deepEqual(data, [{ id: 'fast', object: 'model' }]);
	assert.equal(new URL(sent[0].url).pathname, '/ai/v1/models');
	assert.equal(sent[0].method, 'GET');
	assert.equal(sent[0].headers['snout-key'], 'app-key');
	assert.match(sent[0].headers.authorization ?? '', /^Bearer /);
});

test('chat posts the request as written, never as a stream', async () => {
	const reply = { id: 'c1', object: 'chat.completion', created: 1, model: 'fast', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] };
	const { db, sent } = client(() => ({ body: reply }));
	const { data, error } = await db.ai.chat({ model: 'fast', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, stream: true });
	assert.equal(error, null);
	assert.equal(data?.choices[0].message.content, 'hi');
	assert.equal(new URL(sent[0].url).pathname, '/ai/v1/chat/completions');
	assert.equal(sent[0].headers['content-type'], 'application/json');
	assert.deepEqual(JSON.parse(String(sent[0].body)), { model: 'fast', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, stream: false });
});

test("a refusal is an AiError with the gateway's sentence, code and status", async () => {
	const { db } = client(() => ({
		status: 429,
		body: { error: { message: "This user's budget for today is spent.", type: 'insufficient_quota', code: 'budget_exceeded' } }
	}));
	const { data, error } = await db.ai.chat({ model: 'fast', messages: [] });
	assert.equal(data, null);
	assert.ok(error instanceof AiError);
	assert.equal(error.message, "This user's budget for today is spent.");
	assert.equal(error.status, 429);
	assert.equal(error.code, 'budget_exceeded');
	assert.equal(error.type, 'insufficient_quota');
});

test('a refusal with no body still says what happened', async () => {
	const { db } = client(() => ({ status: 502 }));
	const { error } = await db.ai.models();
	assert.equal(error?.message, 'The AI gateway answered 502');
	assert.equal(error?.code, undefined);
});

test('stream asks for the usage and hands back the chunks up to [DONE]', async () => {
	const chunk = (content: string, usage?: object): string =>
		JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'fast', choices: [{ index: 0, delta: { content }, finish_reason: null }], ...(usage ? { usage } : {}) });
	const { db, sent } = client(() => ({
		body: sse(chunk('Hel'), chunk('lo'), chunk('', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }), '[DONE]', chunk('never')),
		headers: { 'content-type': 'text/event-stream' }
	}));
	const { data, error } = await db.ai.stream({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] });
	assert.equal(error, null);
	const seen: AiChatChunk[] = [];
	for await (const one of data!) {
		seen.push(one);
	}
	assert.equal(seen.map((one) => one.choices[0].delta.content).join(''), 'Hello');
	assert.equal(seen.at(-1)?.usage?.total_tokens, 5);
	const body = JSON.parse(String(sent[0].body));
	assert.equal(body.stream, true);
	assert.deepEqual(body.stream_options, { include_usage: true });
});

test('a stream refused before it began is an error, not a loop', async () => {
	const { db } = client(() => ({ status: 404, body: { error: { message: 'No model named nope.', code: 'model_not_found' } } }));
	const { data, error } = await db.ai.stream({ model: 'nope', messages: [] });
	assert.equal(data, null);
	assert.equal(error?.code, 'model_not_found');
});

test('a stream that fails after it began throws from the loop', async () => {
	const { db } = client(() => ({
		body: sse(JSON.stringify({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'fast', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }), JSON.stringify({ error: { message: 'The provider stopped.', code: 'upstream_error' } })),
		headers: { 'content-type': 'text/event-stream' }
	}));
	const { data } = await db.ai.stream({ model: 'fast', messages: [] });
	await assert.rejects(
		(async () => {
			for await (const _ of data!) {
				// read on
			}
		})(),
		(error: unknown) => error instanceof AiError && error.code === 'upstream_error'
	);
});

test('embed posts to /ai/v1/embeddings', async () => {
	const { db, sent } = client(() => ({ body: { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'vec' } }));
	const { data } = await db.ai.embed({ model: 'vec', input: 'hello' });
	assert.deepEqual(data?.data[0].embedding, [0.1, 0.2]);
	assert.equal(new URL(sent[0].url).pathname, '/ai/v1/embeddings');
	assert.deepEqual(JSON.parse(String(sent[0].body)), { model: 'vec', input: 'hello' });
});

test('a fetch that throws is an error with status 0', async () => {
	const db = snout(URL_, 'app-key', {
		global: {
			fetch: async () => {
				throw new Error('offline');
			}
		},
		auth: { persistSession: false, autoRefreshToken: false }
	});
	const { error } = await db.ai.models();
	assert.equal(error?.message, 'offline');
	assert.equal(error?.status, 0);
});

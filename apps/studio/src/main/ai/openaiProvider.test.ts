/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OpenAiProvider } from './openaiProvider';

// OpenAiProvider is the wire implementation behind the positron-cloud gateway. A mock
// server speaks the OpenAI-compatible surface it uses: streaming /chat/completions (SSE),
// the legacy /completions (FIM), and /models. It returns 500 when the model is "boom".
let server: Server;
let port = 0;
let lastFim: { model?: string; prompt?: string; suffix?: string; max_tokens?: number; stop?: string[] } = {};
// The most recent /chat/completions body, so tests can assert how messages were translated
// onto the wire (e.g. cache_control breakpoint placement).
let lastChat: { model?: string; messages?: { role: string; content: unknown }[] } = {};

function sse(res: import('node:http').ServerResponse, lines: string[]): void {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	res.end(lines.join('\n') + '\n');
}

before(async () => {
	server = createServer((req, res) => {
		if (req.url === '/chat/completions') {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				const parsed = JSON.parse(body || '{}') as { model?: string; messages?: { role: string; content: unknown }[] };
				lastChat = parsed;
				if (parsed.model === 'boom') {
					res.writeHead(500);
					res.end('kaboom');
					return;
				}
				if (parsed.model === 'splittool') {
					// A gateway (LiteLLM -> Bedrock) that streams the tool name with an index but DROPS
					// the index on the arguments continuation fragment. The accumulator must still
					// attribute the args to the same call, not a stray bucket.
					sse(res, [
						'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"describe_table","arguments":""}}]}}]}',
						'',
						'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"name\\":\\"user\\"}"}}]}}]}',
						'',
						'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
						'',
						'data: [DONE]',
					]);
					return;
				}
				sse(res, [
					'data: {"choices":[{"delta":{"content":"Hello "}}]}',
					'',
					'data: {"choices":[{"delta":{"content":"world"}}]}',
					'',
					'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
					'',
					'data: [DONE]',
				]);
			});
			return;
		}
		if (req.url === '/completions') {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				lastFim = JSON.parse(body || '{}');
				if (lastFim.model === 'boom') {
					res.writeHead(500);
					res.end('kaboom');
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ choices: [{ text: `[mid:${lastFim.prompt}|${lastFim.suffix}]` }] }));
			});
			return;
		}
		if (req.url === '/models') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
});

after(() => server.close());

describe('OpenAiProvider', () => {
	function make(model: string): OpenAiProvider {
		return new OpenAiProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model });
	}

	test('streams deltas and reports usage from the final chunk', async () => {
		const deltas: string[] = [];
		const { usage } = await make('gpt-4o').chat([{ role: 'user', content: 'hi' }], { onDelta: (t) => deltas.push(t) });
		assert.equal(deltas.join(''), 'Hello world');
		assert.deepEqual(usage, { promptTokens: 5, completionTokens: 3, totalTokens: 8 });
	});

	test('keeps tool-call arguments when the gateway drops the index on continuation fragments', async () => {
		const { toolCalls } = await make('splittool').chat([{ role: 'user', content: 'hi' }], { onDelta: () => undefined, tools: [{ name: 'describe_table', description: '', parameters: { type: 'object', properties: {} } }] });
		assert.equal(toolCalls.length, 1);
		assert.equal(toolCalls[0].name, 'describe_table');
		assert.deepEqual(toolCalls[0].arguments, { name: 'user' });
	});

	test('places cache_control breakpoints on the system prefix and the last message on tool-enabled (agent) turns', async () => {
		const provider = new OpenAiProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'gpt-4o', cacheControl: true });
		await provider.chat(
			[
				{ role: 'system', content: 'big stable schema prefix' },
				{ role: 'user', content: 'list tables' },
				{ role: 'tool', content: 'tables: users, orders', toolCallId: 'call_1' },
			],
			{ onDelta: () => undefined, tools: [{ name: 'list_tables', description: '', parameters: { type: 'object', properties: {} } }] },
		);
		const msgs = lastChat.messages ?? [];
		// System anchor: content became a text-part array carrying the breakpoint.
		assert.deepEqual(msgs[0].content, [{ type: 'text', text: 'big stable schema prefix', cache_control: { type: 'ephemeral' } }]);
		// Middle message untouched (plain string).
		assert.equal(msgs[1].content, 'list tables');
		// Rolling breakpoint on the last message (here a tool result).
		assert.deepEqual(msgs[2].content, [{ type: 'text', text: 'tables: users, orders', cache_control: { type: 'ephemeral' } }]);
	});

	test('does NOT cache a toolless "ask" turn even when cache_control is enabled', async () => {
		const provider = new OpenAiProvider({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'gpt-4o', cacheControl: true });
		// No tools → single ask call whose prefix is never re-read; caching would be pure write cost.
		await provider.chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], { onDelta: () => undefined });
		const msgs = lastChat.messages ?? [];
		assert.equal(msgs[0].content, 'sys');
		assert.equal(msgs[1].content, 'hi');
	});

	test('leaves content as plain strings when cache_control is off (default / BYOK)', async () => {
		await make('gpt-4o').chat(
			[{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
			{ onDelta: () => undefined, tools: [{ name: 'x', description: '', parameters: { type: 'object', properties: {} } }] },
		);
		const msgs = lastChat.messages ?? [];
		assert.equal(msgs[0].content, 'sys');
		assert.equal(msgs[1].content, 'hi');
	});

	test('lists models', async () => {
		assert.deepEqual(await make('gpt-4o').listModels(), ['gpt-4o', 'gpt-4o-mini']);
	});

	test('throws on a non-OK response', async () => {
		await assert.rejects(() => make('boom').chat([{ role: 'user', content: 'hi' }], { onDelta: () => undefined }));
	});

	test('fim assembles FIM tokens into the prompt (no suffix field — the gateway drops it)', async () => {
		const middle = await make('snout-fim-1.0').fim({ prefix: 'SELECT ', suffix: ' FROM t' });
		assert.equal(lastFim.model, 'snout-fim-1.0');
		// prefix/suffix are wrapped in the model's own FIM markers, sent as one prompt.
		assert.equal(lastFim.prompt, '<|fim_prefix|>SELECT <|fim_suffix|> FROM t<|fim_middle|>');
		assert.equal(lastFim.suffix, undefined);
		assert.equal(middle, `[mid:${lastFim.prompt}|undefined]`);
		// Tight token cap + FIM/EOS stop strings keep it snappy and prevent runaway output.
		assert.equal(lastFim.max_tokens, 128);
		assert.ok((lastFim.stop ?? []).includes('<|fim_middle|>'));
	});

	test('fim throws on a non-OK response', async () => {
		await assert.rejects(() => make('boom').fim({ prefix: 'a', suffix: 'b' }));
	});
});

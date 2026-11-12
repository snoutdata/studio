/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readChatStream, toOpenAiMessages } from './stream.ts';

function sse(chunks: unknown[], split = 7): ReadableStream<Uint8Array> {
	const text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
	const bytes = new TextEncoder().encode(text);
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(at, at + split));
			at += split;
		}
	});
}

test('prose streams and tool calls assemble from their pieces, split anywhere', async () => {
	const seen: string[] = [];
	const turn = await readChatStream(
		sse([
			{ id: 'r1', choices: [{ delta: { content: 'Let me ' } }] },
			{ choices: [{ delta: { content: 'look.' } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_', arguments: '{"na' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'functions', arguments: 'me":"x"}' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'get_project', arguments: '' } }] } }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
			'[DONE]'
		]),
		(t) => seen.push(t)
	);
	assert.equal(seen.join(''), 'Let me look.');
	assert.equal(turn.text, 'Let me look.');
	assert.equal(turn.responseId, 'r1');
	assert.deepEqual(turn.toolCalls, [
		{ id: 'c1', name: 'list_functions', arguments: { name: 'x' } },
		{ id: 'c2', name: 'get_project', arguments: {} }
	]);
	assert.deepEqual(turn.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test('a broken argument object is kept for the tool to refuse, not thrown', async () => {
	const turn = await readChatStream(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'apply_sql', arguments: '{"sql":' } }] } }] }]), () => {});
	assert.deepEqual(turn.toolCalls[0].arguments, { _unparsed: '{"sql":' });
});

test('a conversation with tools becomes the OpenAI shape', () => {
	const out = toOpenAiMessages([
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'get_project', arguments: { ref: 'abc' } }] },
		{ role: 'tool', content: 'ok', toolCallId: 'c' }
	]);
	assert.deepEqual(out[1], { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_project', arguments: '{"ref":"abc"}' } }] });
	assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'c', content: 'ok' });
});

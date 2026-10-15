/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage, ToolCall, ToolResult } from '../../shared/ai';
import type { ChatOptions, ChatTurnResult, ModelProvider } from './modelProvider';
import { runAgentLoop } from './agent';

/** A scripted provider: each chat() returns the next pre-baked turn, streaming its text. */
class ScriptedProvider implements ModelProvider {
	calls = 0;
	seen: ChatMessage[][] = [];
	constructor(private readonly turns: ChatTurnResult[]) {}
	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult> {
		this.seen.push(messages.map((m) => ({ ...m })));
		const turn = this.turns[Math.min(this.calls, this.turns.length - 1)];
		this.calls++;
		if (turn.text) {
			opts.onDelta(turn.text);
		}
		return turn;
	}
	async listModels(): Promise<string[]> {
		return [];
	}
}

const SPEC = [{ name: 'list_tables', description: '', parameters: { type: 'object' } }];

describe('runAgentLoop', () => {
	test('runs a tool, feeds the result back, then returns the final answer', async () => {
		const provider = new ScriptedProvider([
			{ text: 'Let me look…', toolCalls: [{ id: 'c1', name: 'list_tables', arguments: {} }], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
			{ text: 'Here you go.', toolCalls: [], usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
		]);
		const ran: ToolCall[] = [];
		const runTool = async (c: ToolCall): Promise<ToolResult> => { ran.push(c); return { callId: c.id, content: 'orders, customers' }; };
		const deltas: string[] = [];

		const result = await runAgentLoop(provider, [{ role: 'user', content: 'what tables?' }], SPEC, runTool, { onDelta: (t) => deltas.push(t) }, 8);

		assert.equal(provider.calls, 2);
		assert.equal(ran.length, 1);
		assert.equal(ran[0].name, 'list_tables');
		assert.equal(deltas.join(''), 'Let me look…Here you go.');
		assert.deepEqual(result.usage, { promptTokens: 15, completionTokens: 5, totalTokens: 20 });

		// The second turn must carry the assistant tool-call turn + the tool result.
		const second = provider.seen[1];
		assert.ok(second.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'list_tables'));
		assert.ok(second.some((m) => m.role === 'tool' && m.content === 'orders, customers' && m.toolCallId === 'c1'));
	});

	test('stops at maxSteps and forces a final tool-banning turn', async () => {
		// Always asks for a tool — the loop must cut it off and ask once more, banning calls.
		const provider = new ScriptedProvider([
			{ text: '', toolCalls: [{ id: 'c1', name: 'list_tables', arguments: {} }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
		]);
		let lastTools: unknown;
		let lastToolChoice: unknown;
		const probing: ModelProvider = {
			...provider,
			chat: async (messages, opts) => { lastTools = opts.tools; lastToolChoice = opts.toolChoice; return provider.chat(messages, opts); },
			listModels: () => provider.listModels(),
		};
		const runTool = async (c: ToolCall): Promise<ToolResult> => ({ callId: c.id, content: 'x' });

		await runAgentLoop(probing, [{ role: 'user', content: 'go' }], SPEC, runTool, { onDelta: () => undefined }, 2);

		// 2 loop steps + 1 forced conclusion = 3 calls. The final call still DECLARES the tools
		// (Bedrock rejects the tool-call history otherwise) but bans new calls via tool_choice.
		assert.equal(provider.calls, 3);
		assert.deepEqual(lastTools, SPEC);
		assert.equal(lastToolChoice, 'none');
	});

	test('a final answer with no tool calls ends the loop immediately', async () => {
		const provider = new ScriptedProvider([{ text: 'Hi.', toolCalls: [], usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }]);
		const result = await runAgentLoop(provider, [{ role: 'user', content: 'hi' }], SPEC, async (c) => ({ callId: c.id, content: '' }), { onDelta: () => undefined }, 8);
		assert.equal(provider.calls, 1);
		assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 1, totalTokens: 3 });
	});
});

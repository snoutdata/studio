/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, TokenUsage, ToolCall, ToolResult, ToolSpec } from '../../shared/ai';
import type { ModelProvider } from './modelProvider';
import { ToolMarkupStream, hasToolMarkup, parseJsonToolCalls, parseNaturalLanguageToolCalls, parseTextToolCalls, stripToolMarkup } from './textToolCalls';

export interface AgentLoopHooks {
	/** Forwarded to the provider for live text streaming. */
	onDelta(text: string): void;
	signal?: AbortSignal;
}

/** What one agent run yields the caller: the summed token usage and the final turn's
 *  provider response id (the reward-signal join key). */
export interface AgentLoopResult {
	usage?: TokenUsage;
	/** The response id of the turn that produced the final answer (last provider call). */
	responseId?: string;
}

/** Sum two best-effort usage reports (either may be missing). */
function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	const sum: TokenUsage = {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
	};
	// Carry the cache tallies only when a side actually reported them, so summing two
	// non-caching turns leaves them absent rather than fabricating zeros.
	if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
		sum.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
	}
	if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
		sum.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
	}
	return sum;
}

/**
 * The agent loop: the model talks to the database through tools until it produces a final
 * answer. Each turn the provider streams any prose (via `onDelta`) and returns the tools it
 * wants run; we execute them with `runTool`, feed the results back, and repeat — bounded by
 * `maxSteps`. On hitting the cap we ask once more with no tools, forcing a conclusion.
 *
 * Returns the summed token usage across every turn. The provider streams text, so the
 * caller sees the reply build live; this function only orchestrates the tool round-trips.
 */
export async function runAgentLoop(
	provider: ModelProvider,
	messages: ChatMessage[],
	tools: ToolSpec[],
	runTool: (call: ToolCall) => Promise<ToolResult>,
	hooks: AgentLoopHooks,
	maxSteps: number,
): Promise<AgentLoopResult> {
	let total: TokenUsage | undefined;
	// The latest turn's response id; the last one set is the final answer's join key.
	let responseId: string | undefined;
	const convo: ChatMessage[] = [...messages];

	const toolNames = tools.map((t) => t.name);
	for (let step = 0; step < maxSteps; step++) {
		// Filter the stream so tool-call markup a model emits as text (XML or a bare JSON object)
		// never reaches the user.
		const stream = new ToolMarkupStream(hooks.onDelta, toolNames);
		const turn = await provider.chat(convo, { onDelta: (t) => stream.push(t), signal: hooks.signal, tools });
		const { text, toolCalls, usage, reasoningContent } = turn;
		stream.finish();
		total = addUsage(total, usage);
		responseId = turn.responseId ?? responseId;

		// Prefer native tool calls; otherwise honour ones the model wrote as text (the stream
		// kept that markup hidden), so models without working native tools still work.
		let calls = toolCalls;
		let content = text;
		if (calls.length === 0 && hasToolMarkup(text)) {
			const parsed = parseTextToolCalls(text);
			if (parsed.length > 0) {
				calls = parsed;
				content = stripToolMarkup(text);
			}
		}
		if (calls.length === 0) {
			// Some models (qwen2.5-coder via Ollama) emit the call as a bare JSON object,
			// `{"name":"list_tables","arguments":{}}`, with no native tool_calls. Recover those,
			// anchored to the real tool names so ordinary JSON in a reply isn't mistaken for one.
			const js = parseJsonToolCalls(text, toolNames);
			if (js.length > 0) {
				calls = js;
				content = '';
			}
		}
		if (calls.length === 0) {
			// Small models often emit `Tool Call: list_tables()` as prose instead of issuing a
			// structured tool call. Catch those (anchored to the real tool names so we don't
			// false-match the model casually mentioning a tool) so the loop still advances.
			const nl = parseNaturalLanguageToolCalls(text, toolNames);
			if (nl.length > 0) {
				calls = nl;
				content = stripToolMarkup(text);
			}
		}
		if (calls.length === 0) {
			return { usage: total, responseId };
		}
		// Record the assistant's tool-call turn, then run the tools and feed results back.
		// reasoningContent is carried so reasoning models (DeepSeek) can continue the turn.
		convo.push({ role: 'assistant', content, toolCalls: calls, reasoningContent });
		for (const call of calls) {
			if (hooks.signal?.aborted) {
				return { usage: total, responseId };
			}
			const result = await runTool(call);
			convo.push({ role: 'tool', content: result.content, toolCallId: result.callId });
		}
	}

	// Step cap reached: one final turn that forbids further tool use, so the model must answer
	// now. We still DECLARE the tools (with `tool_choice: 'none'`) rather than dropping them: by
	// this point `convo` carries assistant tool_calls + tool results, and a Bedrock-routed model
	// (via the LiteLLM gateway) rejects that history unless a `tools=` param is present. Declaring
	// them while banning new calls satisfies that and still forces a prose conclusion.
	// Still filter the stream, in case it leaks a textual tool call instead of concluding.
	const stream = new ToolMarkupStream(hooks.onDelta);
	const final = await provider.chat(
		[...convo, { role: 'user', content: 'You have reached the tool-use limit. Give your best final answer now using what you have gathered.' }],
		{ onDelta: (t) => stream.push(t), signal: hooks.signal, tools, toolChoice: 'none' },
	);
	stream.finish();
	return { usage: addUsage(total, final.usage), responseId: final.responseId ?? responseId };
}

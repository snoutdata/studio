/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// One OpenAI-shaped chat-completions stream, read into a ChatTurnResult: the prose (streamed out
// as it arrives), the tool calls (assembled from their deltas, which arrive in pieces keyed by
// `index`), the usage from the final chunk, and the completion's id.
//
// Uses only what every runtime has (ReadableStream, TextDecoder), so the dashboard, Studio and
// the lab read a stream with the same code.

import type { ChatMessage, ChatTurnResult, ToolCall } from './types.ts';

interface Delta {
	content?: string | null;
	reasoning_content?: string | null;
	tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface Chunk {
	id?: string;
	choices?: Array<{ delta?: Delta }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** A tool call being assembled from its deltas. */
interface Partial {
	id: string;
	name: string;
	args: string;
}

function parseArguments(text: string): Record<string, unknown> {
	if (!text.trim()) {
		return {};
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
	} catch {
		// Half a JSON object (the model stopped mid-call). The tool will refuse it by its own rules.
		return { _unparsed: text };
	}
}

/** Read a whole stream. `onDelta` gets each piece of prose as it arrives. */
export async function readChatStream(
	body: ReadableStream<Uint8Array>,
	onDelta: (text: string) => void,
	/** Each tool call's arguments as they arrive, so a surface can show a file being written. */
	onToolDelta?: (call: { index: number; id: string; name: string; arguments: string }) => void
): Promise<ChatTurnResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let reasoning = '';
	let responseId: string | undefined;
	let usage: ChatTurnResult['usage'];
	const calls = new Map<number, Partial>();

	const take = (payload: string) => {
		if (payload === '[DONE]') {
			return;
		}
		let chunk: Chunk;
		try {
			chunk = JSON.parse(payload) as Chunk;
		} catch {
			// A partial or unexpected line. Dropping it loses a token; throwing would lose the answer.
			return;
		}
		responseId = chunk.id ?? responseId;
		const delta = chunk.choices?.[0]?.delta;
		if (delta?.content) {
			text += delta.content;
			onDelta(delta.content);
		}
		if (delta?.reasoning_content) {
			reasoning += delta.reasoning_content;
		}
		for (const piece of delta?.tool_calls ?? []) {
			const index = piece.index ?? calls.size;
			const call = calls.get(index) ?? { id: '', name: '', args: '' };
			call.id = piece.id || call.id;
			call.name += piece.function?.name ?? '';
			call.args += piece.function?.arguments ?? '';
			calls.set(index, call);
			onToolDelta?.({ index, id: call.id, name: call.name, arguments: call.args });
		}
		if (chunk.usage?.total_tokens) {
			usage = {
				promptTokens: chunk.usage.prompt_tokens ?? 0,
				completionTokens: chunk.usage.completion_tokens ?? 0,
				totalTokens: chunk.usage.total_tokens
			};
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		// SSE events are separated by a blank line; the tail is kept for the next chunk.
		const events = buffer.split(/\r?\n\r?\n/);
		buffer = events.pop() ?? '';
		for (const event of events) {
			for (const line of event.split(/\r?\n/)) {
				if (line.startsWith('data:')) {
					take(line.slice(5).trim());
				}
			}
		}
	}
	for (const line of buffer.split(/\r?\n/)) {
		if (line.startsWith('data:')) {
			take(line.slice(5).trim());
		}
	}

	const toolCalls: ToolCall[] = [...calls.entries()]
		.sort(([a], [b]) => a - b)
		.filter(([, call]) => call.name)
		.map(([index, call]) => ({ id: call.id || `call_${index}`, name: call.name, arguments: parseArguments(call.args) }));
	return { text, toolCalls, usage, reasoningContent: reasoning || undefined, responseId };
}

/** A conversation as the OpenAI chat API wants it (tool calls and tool results included). */
export function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
	return messages.map((m) => {
		if (m.role === 'assistant' && m.toolCalls?.length) {
			return {
				role: 'assistant',
				content: m.content || null,
				tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
				...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {})
			};
		}
		if (m.role === 'tool') {
			return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
		}
		return { role: m.role, content: m.content };
	});
}

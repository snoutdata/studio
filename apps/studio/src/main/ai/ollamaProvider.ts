/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, ToolCall, TokenUsage } from '../../shared/ai';
import type { ChatOptions, ChatTurnResult, FimRequest, ModelProvider } from './modelProvider';
import { asFunctionTools, parseToolArgs } from './toolUtil';
import { netFetch } from '../netFetch';

/** An Ollama tool call as it appears in a streamed message. Args arrive as an object on
 *  recent builds, but older ones (and some models) send a JSON string. */
interface OllamaToolCall {
	function?: { name?: string; arguments?: Record<string, unknown> | string };
}

/** A `-base` model is a raw completion model with no chat template; Ollama's /api/chat then
 *  has no roles to apply and the model just free-associates off the end of the prompt. Detect
 *  it so chat() can route through a primed text completion instead (see {@link OllamaProvider.baseChat}). */
function isBaseModel(model: string): boolean {
	return /-base\b/i.test(model) || /:base\b/i.test(model);
}

/** Flatten chat messages into one completion prompt a `-base` code model will continue
 *  correctly: the system grounding verbatim, any prior turns as labelled comments, then the
 *  latest question primed to continue as a single statement inside a ```sql fence — which the
 *  stop token closes. Mirrors how the FIM path feeds these models (schema as comments). */
function toBasePrompt(messages: ChatMessage[]): string {
	const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
	const convo = messages.filter((m) => m.role !== 'system');
	const last = convo[convo.length - 1];
	const parts: string[] = [];
	if (system) {
		parts.push(system);
	}
	for (const m of convo.slice(0, -1)) {
		parts.push(`-- ${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
	}
	parts.push(`-- Task: ${last ? last.content : ''}`);
	parts.push('-- A single SQL query answering the task:');
	parts.push('```sql');
	return `${parts.join('\n')}\n`;
}

/** Translate our neutral messages to Ollama's wire shape (it mirrors OpenAI's, but tool
 *  call arguments are an object and tool turns carry no call id). */
function toOllamaMessages(messages: ChatMessage[]): Record<string, unknown>[] {
	return messages.map((m) => {
		if (m.role === 'tool') {
			return { role: 'tool', content: m.content };
		}
		if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
			return {
				role: 'assistant',
				content: m.content,
				tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
			};
		}
		return { role: m.role, content: m.content };
	});
}

/**
 * An Ollama server, streaming NDJSON from /api/chat. Defaults to http://localhost:11434, but the
 * endpoint is just a URL: a GPU box on the LAN or a VM in the user's own cloud works the same, and
 * that is how a generation flow gets real throughput.
 *
 * `apiKey` is optional because Ollama itself has no authentication. A server exposed beyond
 * localhost is normally put behind a reverse proxy that wants one, so the token rides as a bearer
 * header when it is set and nothing is sent when it is not.
 */
export class OllamaProvider implements ModelProvider {
	constructor(private readonly endpoint: string, private readonly model: string, private readonly apiKey?: string) {}

	private base(): string {
		return this.endpoint.replace(/\/+$/, '');
	}

	/** JSON headers, plus the bearer token when the server is behind an authenticating proxy. */
	private headers(): Record<string, string> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (this.apiKey) {
			headers.authorization = `Bearer ${this.apiKey}`;
		}
		return headers;
	}

	/** Whether the endpoint is on this machine. A remote server is reached over a real network, so
	 *  the model-list probe has to allow for latency that localhost never has. */
	private isLoopback(): boolean {
		try {
			const host = new URL(this.base()).hostname;
			return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
		} catch {
			return true;
		}
	}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult> {
		// -base models can't follow a chat prompt; serve them via a primed completion instead.
		if (isBaseModel(this.model)) {
			return this.baseChat(messages, opts);
		}
		const body: Record<string, unknown> = { model: this.model, messages: toOllamaMessages(messages), stream: true };
		// Ollama has no `tool_choice`, so the only way to forbid a new call on the concluding turn
		// is to not declare tools at all (it doesn't choke on tool-call history the way Bedrock does).
		if (opts.tools && opts.tools.length > 0 && opts.toolChoice !== 'none') {
			body.tools = asFunctionTools(opts.tools);
		}
		const response = await netFetch(`${this.base()}/api/chat`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: opts.signal,
		});
		if (!response.ok || !response.body) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`Ollama ${response.status}: ${detail}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let usage: TokenUsage | undefined;
		let text = '';
		const rawCalls: OllamaToolCall[] = [];
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) {
					continue;
				}
				const event = JSON.parse(line) as { message?: { content?: string; tool_calls?: OllamaToolCall[] }; error?: string; done?: boolean; prompt_eval_count?: number; eval_count?: number };
				if (event.error) {
					throw new Error(`Ollama: ${event.error}`);
				}
				if (event.message?.content) {
					text += event.message.content;
					opts.onDelta(event.message.content);
				}
				if (event.message?.tool_calls) {
					rawCalls.push(...event.message.tool_calls);
				}
				// The final event (done:true) carries the token counts for the turn.
				if (event.done && (event.prompt_eval_count !== undefined || event.eval_count !== undefined)) {
					const prompt = event.prompt_eval_count ?? 0;
					const completion = event.eval_count ?? 0;
					usage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
				}
			}
		}
		const toolCalls: ToolCall[] = rawCalls
			.filter((c) => c.function?.name)
			.map((c, i) => ({
				id: `call_${i}`,
				name: c.function!.name as string,
				arguments: typeof c.function!.arguments === 'string' ? parseToolArgs(c.function!.arguments) : (c.function!.arguments ?? {}),
			}));
		return { text, toolCalls, usage };
	}

	/**
	 * Chat for a `-base` model: route through /api/generate with a primed completion prompt
	 * (see {@link toBasePrompt}) rather than /api/chat, since these models have no chat
	 * template. A low temperature + a `` ``` `` stop token keep it to one statement, and the
	 * reply is wrapped back into a ```sql block so the chat UI renders + extracts it the same
	 * as any other model's. Tools are ignored (base models can't issue structured calls).
	 */
	private async baseChat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult> {
		const response = await netFetch(`${this.base()}/api/generate`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({
				model: this.model,
				prompt: toBasePrompt(messages),
				stream: true,
				options: { temperature: 0.1, num_predict: 512, stop: ['```'] },
			}),
			signal: opts.signal,
		});
		if (!response.ok || !response.body) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`Ollama ${response.status}: ${detail}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let usage: TokenUsage | undefined;
		let sql = '';
		// Open the fence up front so the streamed reply renders as a SQL block in the UI.
		opts.onDelta('```sql\n');
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) {
					continue;
				}
				const event = JSON.parse(line) as { response?: string; error?: string; done?: boolean; prompt_eval_count?: number; eval_count?: number };
				if (event.error) {
					throw new Error(`Ollama: ${event.error}`);
				}
				if (event.response) {
					sql += event.response;
					opts.onDelta(event.response);
				}
				if (event.done && (event.prompt_eval_count !== undefined || event.eval_count !== undefined)) {
					const prompt = event.prompt_eval_count ?? 0;
					const completion = event.eval_count ?? 0;
					usage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
				}
			}
		}
		opts.onDelta('\n```');
		return { text: `\`\`\`sql\n${sql.trim()}\n\`\`\``, toolCalls: [], usage };
	}

	/**
	 * Fill-in-the-middle via /api/generate: Ollama wraps `prompt`/`suffix` in the model's
	 * own FIM tokens (`<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`), so we send raw code,
	 * not chat. Low temperature + a token cap keep it snappy for inline use.
	 */
	async fim(req: FimRequest): Promise<string> {
		const response = await netFetch(`${this.base()}/api/generate`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({
				model: this.model,
				prompt: req.prefix,
				suffix: req.suffix,
				stream: false,
				options: { temperature: 0.1, num_predict: 256 },
			}),
			signal: req.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`Ollama ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as { response?: string };
		return data.response ?? '';
	}

	/** Embed a batch through `/api/embed`, which takes an array and returns vectors in order. */
	async embedMany(req: { inputs: string[]; model: string; signal?: AbortSignal }): Promise<number[][]> {
		if (req.inputs.length === 0) {
			return [];
		}
		const response = await netFetch(`${this.base()}/api/embed`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ model: req.model, input: req.inputs }),
			signal: req.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`Ollama ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as { embeddings?: number[][] };
		const vectors = data.embeddings ?? [];
		if (vectors.length !== req.inputs.length || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
			throw new Error('Ollama did not return a vector for every input. Is this an embeddings model?');
		}
		return vectors;
	}

	async listModels(): Promise<string[]> {
		// 4s is plenty for localhost and far too tight for a server across the internet.
		const response = await netFetch(`${this.base()}/api/tags`, { headers: this.headers(), signal: AbortSignal.timeout(this.isLoopback() ? 4000 : 20000) });
		if (!response.ok) {
			return [];
		}
		const data = (await response.json()) as { models?: { name: string }[] };
		return (data.models ?? []).map((m) => m.name);
	}
}

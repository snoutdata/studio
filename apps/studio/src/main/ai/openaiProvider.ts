/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AiBudgetStatus, AiModelCost, ChatMessage, ToolCall, TokenUsage } from '../../shared/ai';
import type { ChatOptions, ChatTurnResult, FimRequest, ModelProvider } from './modelProvider';
import { netFetch } from '../netFetch';
import { asFunctionTools, parseToolArgs } from './toolUtil';
import { sseData } from './sse';

export interface OpenAiAuth {
	/** API base including any version segment, e.g. https://api.openai.com/v1. */
	baseUrl: string;
	apiKey: string;
	model: string;
	/** Optional OpenAI `user` field — the signed-in account's user id (opaque, never the email),
	 *  so the gateway can attribute each request to an account (LiteLLM's "End User" column). */
	endUser?: string;
	/** Place Anthropic-style `cache_control` breakpoints on the prompt prefix so repeated
	 *  prefixes (the stable system+schema block, and the growing tool-loop history) are served
	 *  from the provider's prompt cache. Enabled only on our gateway (LiteLLM forwards it to the
	 *  Bedrock/Anthropic models and silently drops it for local models). Left OFF for BYOK, where
	 *  the request hits the user's raw OpenAI/OpenRouter endpoint, which would reject the field. */
	cacheControl?: boolean;
}

/** A text content part, optionally carrying a cache breakpoint. The array form of `content` is
 *  how the OpenAI wire shape (and LiteLLM) expresses Anthropic `cache_control`. */
interface OpenAiTextPart {
	type: 'text';
	text: string;
	cache_control?: { type: 'ephemeral' };
}

/** An OpenAI chat message after translating our neutral {@link ChatMessage} shape. `content`
 *  is normally a plain string; it becomes a one-element text-part array when we attach a cache
 *  breakpoint to it (see {@link markCacheBreakpoint}). */
interface OpenAiMessage {
	role: string;
	content: string | null | OpenAiTextPart[];
	tool_call_id?: string;
	tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

/** Convert a message's string `content` into the text-part array form with a `cache_control`
 *  breakpoint, so the prefix up to and including this message is cached. No-op if the content
 *  isn't a non-empty string (e.g. an assistant turn that is only tool calls) — there's nothing
 *  to anchor the breakpoint on, and a later message will carry the rolling one instead. */
function markCacheBreakpoint(message: OpenAiMessage): void {
	if (typeof message.content === 'string' && message.content.length > 0) {
		message.content = [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
	}
}

/** Translate our neutral messages to OpenAI's wire shape (assistant tool calls + `tool`
 *  role results included). */
function toOpenAiMessages(messages: ChatMessage[], cacheControl?: boolean): OpenAiMessage[] {
	const out: OpenAiMessage[] = messages.map((m) => {
		if (m.role === 'tool') {
			return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
		}
		if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
			return {
				role: 'assistant',
				content: m.content || null,
				tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
			};
		}
		return { role: m.role, content: m.content };
	});
	if (cacheControl && out.length > 0) {
		// Two breakpoints (well within the 4-per-request limit). The ANCHOR caches the stable
		// prefix — tools + system, which holds the schema and is byte-identical across a whole
		// agent loop. The ROLLING one on the last message caches the entire conversation up to
		// here, so each tool round-trip re-reads the prior history instead of reprocessing the
		// growing tool results at full price.
		// Caveat: the cache lookback only walks back ~20 content blocks. A single turn that
		// appends >20 tool results (very wide parallel tool use) could outrun it and miss the
		// anchor; the rolling breakpoint still re-establishes the cache on the next turn.
		const system = out.find((m) => m.role === 'system');
		if (system) {
			markCacheBreakpoint(system);
		}
		markCacheBreakpoint(out[out.length - 1]);
	}
	return out;
}

/** Accumulator for streamed tool-call fragments, keyed by the delta's `index`. */
interface PartialCall {
	id: string;
	name: string;
	args: string;
}

/**
 * OpenAI Chat Completions. Streams SSE deltas — both text and `tool_calls` fragments
 * (which arrive split across chunks and are reassembled by index) — and asks for a
 * trailing usage object via `stream_options.include_usage`. Also implements {@link fim}
 * via the gateway's legacy `/completions` endpoint, so code models served behind the
 * gateway get true fill-in-the-middle rather than chat-prompting.
 */
export class OpenAiProvider implements ModelProvider {
	constructor(private readonly auth: OpenAiAuth) {}

	private base(): string {
		return this.auth.baseUrl.replace(/\/+$/, '');
	}

	/** The gateway's management root (no `/v1` version segment). LiteLLM serves the OpenAI
	 *  surface under `/v1` but its management endpoints (e.g. `/key/info`) at the root, so we
	 *  strip a trailing version segment from {@link base}. */
	private managementBase(): string {
		return this.base().replace(/\/v\d+$/, '');
	}

	private headers(): Record<string, string> {
		return { 'content-type': 'application/json', authorization: `Bearer ${this.auth.apiKey}` };
	}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult> {
		// Only place cache breakpoints on tool-enabled turns. Caching pays off when the prefix is
		// re-READ, which only happens inside the agent tool loop (each round-trip re-sends the
		// growing prefix). A toolless "ask" turn (AiService.oneShot) is a single call whose prefix
		// is never read again — caching it would just pay the ~1.25x write premium for nothing.
		const cache = !!this.auth.cacheControl && (opts.tools?.length ?? 0) > 0;
		const body: Record<string, unknown> = {
			model: this.auth.model,
			messages: toOpenAiMessages(messages, cache),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (this.auth.endUser) {
			body.user = this.auth.endUser;
		}
		if (opts.tools && opts.tools.length > 0) {
			body.tools = asFunctionTools(opts.tools);
			// `tool_choice: 'none'` keeps the declaration but bans new calls. The agent loop's
			// concluding turn uses it so a Bedrock-routed model still gets a `tools=` param (its
			// tool-call history is otherwise rejected) while being forced to answer in prose.
			if (opts.toolChoice) {
				body.tool_choice = opts.toolChoice;
			}
		}
		const response = await netFetch(`${this.base()}/chat/completions`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: opts.signal,
		});
		if (!response.ok || !response.body) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`OpenAI ${response.status}: ${detail}`);
		}
		let usage: TokenUsage | undefined;
		let responseId: string | undefined;
		let text = '';
		const partials = new Map<number, PartialCall>();
		// The index of the tool call currently streaming, so an index-less continuation fragment
		// (some gateways drop it) is appended to the right call instead of a stray bucket.
		let lastToolIndex = 0;
		for await (const payload of sseData(response.body)) {
			const event = JSON.parse(payload) as {
				id?: string;
				choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
				usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
				error?: { message?: string };
			};
			if (event.error) {
				throw new Error(`OpenAI: ${event.error.message ?? 'stream error'}`);
			}
			// Every chunk carries the completion id; keep the first we see (the gateway logs the
			// same id, so the app can report the reward signal against it).
			if (event.id && !responseId) {
				responseId = event.id;
			}
			const delta = event.choices?.[0]?.delta;
			if (delta?.content) {
				text += delta.content;
				opts.onDelta(delta.content);
			}
			for (const fragment of delta?.tool_calls ?? []) {
				// OpenAI streams a per-call `index` on every fragment; some gateways (LiteLLM routing
				// Bedrock/Anthropic) omit it on continuation fragments. Falling back to a separate
				// `undefined` bucket would split a call's name from its arguments — and since we only
				// keep buckets that carry a name, the args-bearing bucket gets dropped (empty args).
				// So attribute an index-less fragment to the call currently being streamed.
				const index = fragment.index ?? lastToolIndex;
				lastToolIndex = index;
				const partial = partials.get(index) ?? { id: '', name: '', args: '' };
				if (fragment.id) {
					partial.id = fragment.id;
				}
				if (fragment.function?.name) {
					partial.name = fragment.function.name;
				}
				if (fragment.function?.arguments) {
					partial.args += fragment.function.arguments;
				}
				partials.set(index, partial);
			}
			// The final chunk (after include_usage) carries token counts with empty choices.
			if (event.usage) {
				const prompt = event.usage.prompt_tokens ?? 0;
				const completion = event.usage.completion_tokens ?? 0;
				usage = { promptTokens: prompt, completionTokens: completion, totalTokens: event.usage.total_tokens ?? prompt + completion };
				// Cache fields only when the backend reports them (the gateway's Bedrock/Anthropic
				// models). Left absent for local/plain models that don't cache, so usage stays clean.
				if (event.usage.cache_read_input_tokens !== undefined) {
					usage.cacheReadTokens = event.usage.cache_read_input_tokens;
				}
				if (event.usage.cache_creation_input_tokens !== undefined) {
					usage.cacheWriteTokens = event.usage.cache_creation_input_tokens;
				}
			}
		}
		const toolCalls: ToolCall[] = [...partials.entries()]
			.sort((a, b) => a[0] - b[0])
			.filter(([, p]) => p.name)
			.map(([index, p]) => ({ id: p.id || `call_${index}`, name: p.name, arguments: parseToolArgs(p.args) }));
		return { text, toolCalls, usage, responseId };
	}

	/**
	 * Fill-in-the-middle via the gateway's legacy text-completion endpoint (`/completions`).
	 *
	 * We assemble the code model's own FIM tokens into a single `prompt` rather than sending the
	 * OpenAI `suffix` field: the gateway does NOT forward `suffix` to the model (verified — it's
	 * silently dropped), so the suffix would be lost. The completion model must therefore be
	 * served by a raw text-completion route, which leaves these tokens untouched instead of
	 * wrapping them in a chat template. The FIM/EOS markers double as stop
	 * strings so a base text-completer (no natural EOS) doesn't run past the gap.
	 */
	async fim(req: FimRequest): Promise<string> {
		const prompt = `<|fim_prefix|>${req.prefix}<|fim_suffix|>${req.suffix}<|fim_middle|>`;
		const body: Record<string, unknown> = {
			model: this.auth.model,
			prompt,
			max_tokens: 128,
			temperature: 0.1,
			stream: false,
			stop: ['<|endoftext|>', '<|fim_pad|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|file_sep|>', '<|repo_name|>'],
		};
		if (this.auth.endUser) {
			body.user = this.auth.endUser;
		}
		const response = await netFetch(`${this.base()}/completions`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: req.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`OpenAI ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as { choices?: { text?: string }[] };
		return data.choices?.[0]?.text ?? '';
	}

	/**
	 * Embed text into a vector via the OpenAI-compatible `/embeddings` endpoint.
	 * `req.model` is the embeddings model id (overriding this provider's chat `model`), so one gateway
	 * key can reach both chat and embeddings models. Throws on a non-OK response (e.g. the gateway has
	 * no embeddings model configured yet) so the caller surfaces a clean error.
	 */
	async embeddings(req: { input: string; model: string; signal?: AbortSignal }): Promise<number[]> {
		const body: Record<string, unknown> = { model: req.model, input: req.input };
		if (this.auth.endUser) {
			body.user = this.auth.endUser;
		}
		const response = await netFetch(`${this.base()}/embeddings`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: req.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`OpenAI ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as { data?: { embedding?: number[] }[] };
		const vector = data.data?.[0]?.embedding;
		if (!Array.isArray(vector)) {
			throw new Error('The embeddings response did not contain a vector.');
		}
		return vector;
	}

	/** Batch form of {@link embeddings}: `/embeddings` takes an array and answers with an `index`
	 *  per vector, which is what puts them back in input order. */
	async embedMany(req: { inputs: string[]; model: string; signal?: AbortSignal }): Promise<number[][]> {
		if (req.inputs.length === 0) {
			return [];
		}
		const body: Record<string, unknown> = { model: req.model, input: req.inputs };
		if (this.auth.endUser) {
			body.user = this.auth.endUser;
		}
		const response = await netFetch(`${this.base()}/embeddings`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body),
			signal: req.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`${response.status}: ${detail}`);
		}
		const data = (await response.json()) as { data?: { embedding?: number[]; index?: number }[] };
		const vectors: number[][] = new Array(req.inputs.length);
		(data.data ?? []).forEach((entry, position) => {
			if (Array.isArray(entry.embedding)) {
				vectors[entry.index ?? position] = entry.embedding;
			}
		});
		for (let i = 0; i < req.inputs.length; i++) {
			if (!Array.isArray(vectors[i])) {
				throw new Error('The embeddings response did not contain a vector for every input.');
			}
		}
		return vectors;
	}

	async listModels(): Promise<string[]> {
		const response = await netFetch(`${this.base()}/models`, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`OpenAI ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as { data?: { id: string }[] };
		return (data.data ?? []).map((m) => m.id);
	}

	/**
	 * This key's live spend vs. budget, via LiteLLM's `GET /key/info`. A non-admin virtual
	 * key may query its own info with no params (the auth header identifies it), so this needs
	 * only the stored key. An unmetered key (no `max_budget`, i.e. free / local-only) comes
	 * back as `metered: false`. Throws on a non-OK response so the caller can degrade quietly.
	 */
	async keyInfo(): Promise<AiBudgetStatus> {
		const response = await netFetch(`${this.managementBase()}/key/info`, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`OpenAI ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as {
			info?: { spend?: number; max_budget?: number | null; soft_budget?: number | null; budget_reset_at?: string | null };
		};
		const info = data.info ?? {};
		const spend = typeof info.spend === 'number' ? info.spend : 0;
		const maxBudget = typeof info.max_budget === 'number' ? info.max_budget : undefined;
		const softBudget = typeof info.soft_budget === 'number' ? info.soft_budget : undefined;
		const metered = maxBudget !== undefined && maxBudget > 0;
		return {
			metered,
			spend,
			maxBudget,
			softBudget,
			percentUsed: metered ? Math.min(100, Math.round((spend / maxBudget!) * 1000) / 10) : undefined,
			resetAt: info.budget_reset_at ?? undefined,
		};
	}

	/**
	 * The per-model cost classification for the models this key can reach, via LiteLLM's
	 * `GET /model/info`. The proxy filters the list to the key's allowed models, and each row
	 * carries the configured per-token price; a model priced at $0 does not debit the wallet,
	 * anything priced (the self-hosted local models included, since 2026-06-06) is metered. Throws on a non-OK
	 * response so the caller can degrade quietly (the Account screen just omits the breakdown).
	 */
	async modelCosts(): Promise<AiModelCost[]> {
		const response = await netFetch(`${this.managementBase()}/model/info`, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
		if (!response.ok) {
			const detail = await response.text().catch(() => response.statusText);
			throw new Error(`OpenAI ${response.status}: ${detail}`);
		}
		const data = (await response.json()) as {
			data?: { model_name?: string; model_info?: { input_cost_per_token?: number | null; output_cost_per_token?: number | null } }[];
		};
		const seen = new Set<string>();
		const costs: AiModelCost[] = [];
		for (const row of data.data ?? []) {
			const model = row.model_name;
			if (typeof model !== 'string' || !model || seen.has(model)) {
				continue;
			}
			seen.add(model);
			const input = typeof row.model_info?.input_cost_per_token === 'number' ? row.model_info.input_cost_per_token : 0;
			const output = typeof row.model_info?.output_cost_per_token === 'number' ? row.model_info.output_cost_per_token : 0;
			costs.push({ model, metered: input > 0 || output > 0, outputPerMTok: output * 1_000_000, inputPerMTok: input * 1_000_000 });
		}
		return costs;
	}
}

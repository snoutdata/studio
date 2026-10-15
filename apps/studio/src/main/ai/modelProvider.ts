/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, ToolCall, ToolSpec, TokenUsage } from '../../shared/ai';

export interface ChatOptions {
	/** Called with each text delta as the model streams its reply. */
	onDelta(text: string): void;
	signal?: AbortSignal;
	/** Tools the model may call this turn. When present, the provider surfaces any tool
	 *  calls the model makes in the returned {@link ChatTurnResult}. */
	tools?: ToolSpec[];
	/** How the model may use {@link tools} this turn. `'none'` forbids new calls (forcing a
	 *  text answer) while still declaring the tools — Bedrock-backed models (served via the
	 *  LiteLLM gateway) reject a request whose history carries tool calls unless `tools=` is
	 *  present, so the concluding turn keeps the declaration and just bans further calls. */
	toolChoice?: 'auto' | 'none';
}

/**
 * One model turn. `text` is the prose the model produced (also streamed via onDelta);
 * `toolCalls` are the tools it wants run (empty ⇒ a final answer). The agent loop uses
 * `toolCalls` to decide whether to continue, and records `text` back into the convo.
 */
export interface ChatTurnResult {
	text: string;
	toolCalls: ToolCall[];
	usage?: TokenUsage;
	/** Reasoning-model chain-of-thought (DeepSeek `reasoning_content`), when the model
	 *  emits it. Thinking-mode tool loops must echo it back on the assistant turn. */
	reasoningContent?: string;
	/** The provider/gateway's id for this completion (OpenAI `id`). The gateway logs the same
	 *  id, so it's the join key the app reports the reward signal against. Absent for providers
	 *  that don't surface one (e.g. Ollama). */
	responseId?: string;
}

/** A fill-in-the-middle request: the model predicts the text between prefix and suffix. */
export interface FimRequest {
	prefix: string;
	suffix: string;
	signal?: AbortSignal;
}

/**
 * One interface, implementations behind it (Ollama, the OpenAI-compatible gateway) —
 * mirrors the DatabaseDriver seam so the assistant never special-cases a backend.
 */
export interface ModelProvider {
	/** Stream a chat completion, invoking `opts.onDelta` for each chunk. Resolves with the
	 *  turn's text, any tool calls (when `opts.tools` was given), and token usage. */
	chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult>;
	/** Best-effort list of available model ids (empty when unsupported). */
	listModels(): Promise<string[]>;
	/**
	 * Fill-in-the-middle completion — the right path for code models (and the only one
	 * that works for `-base` models, which have no chat template). Optional: providers
	 * without it (the gateway's chat models) fall back to the chat-based completion path.
	 */
	fim?(req: FimRequest): Promise<string>;
	/**
	 * Embed text into a vector via the provider's embeddings model (the
	 * vector-DB "find similar to X" path). Optional: only the gateway provider implements it, and
	 * only once an embeddings model is configured on the gateway. `model` overrides the provider's
	 * default chat model with the embeddings model id.
	 */
	embeddings?(req: { input: string; model: string; signal?: AbortSignal }): Promise<number[]>;
	/** Embed several texts in one round-trip, vectors in input order. */
	embedMany?(req: { inputs: string[]; model: string; signal?: AbortSignal }): Promise<number[][]>;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage } from '../../shared/ai';
import type { ChatOptions, ChatTurnResult, FimRequest, ModelProvider } from './modelProvider';
import { logAiRoundTrip } from './debugLog';

/**
 * Decorator that logs every model round-trip a {@link ModelProvider} makes, then delegates
 * to the wrapped provider. Sitting at the provider seam — the one place every path funnels
 * through — it captures one-shot chat, each agent-loop step, completion, and edits
 * identically, with zero duplication of the prompt-building logic. The app wraps the real
 * provider with this in dev (see AiService.setDebugEnabled); in production the provider is
 * used bare and nothing is logged.
 */
export class LoggingProvider implements ModelProvider {
	constructor(private readonly inner: ModelProvider, private readonly label: { provider: string; model: string }) {
		// Expose fim only when the inner provider has it: AiService.complete branches on
		// `provider.fim` being truthy, so a wrapper that always defined it would wrongly
		// steer the no-FIM providers (the gateway's chat models) down the code-model path.
		if (inner.fim) {
			this.fim = (req) => this.loggedFim(req);
		}
	}

	fim?: (req: FimRequest) => Promise<string>;

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult> {
		const ts = Date.now();
		try {
			const result = await this.inner.chat(messages, opts);
			logAiRoundTrip({
				ts,
				kind: 'chat',
				...this.label,
				messages,
				reply: result.text,
				toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
				reasoningContent: result.reasoningContent,
				usage: result.usage,
				ms: Date.now() - ts,
				ok: true,
			});
			return result;
		} catch (err) {
			logAiRoundTrip({ ts, kind: 'chat', ...this.label, messages, reply: '', ms: Date.now() - ts, ok: false, error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}

	private async loggedFim(req: FimRequest): Promise<string> {
		const ts = Date.now();
		try {
			const text = await this.inner.fim!(req);
			logAiRoundTrip({ ts, kind: 'fim', ...this.label, fim: { prefix: req.prefix, suffix: req.suffix }, reply: text, ms: Date.now() - ts, ok: true });
			return text;
		} catch (err) {
			logAiRoundTrip({ ts, kind: 'fim', ...this.label, fim: { prefix: req.prefix, suffix: req.suffix }, reply: '', ms: Date.now() - ts, ok: false, error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}

	listModels(): Promise<string[]> {
		return this.inner.listModels();
	}
}

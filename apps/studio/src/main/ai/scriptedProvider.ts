/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A model that answers from a script. E2E ONLY.
 *
 *  Installed by the main-process e2e hook (`__snoutE2E.setModelScript`), which exists only under
 *  the scratch profile (`SNOUT_E2E_USERDATA`) — a normal launch can never reach this file.
 *
 *  It sits at the `ModelProvider` seam, which is the one funnel every AI path in the app goes
 *  through, so a test gets the REAL prompt building, the real streaming callbacks, the real audit
 *  record and the real error handling, with the one part that cannot be deterministic replaced.
 *  Faking further out (handing the flow runner a stub `extract`) would skip all of that, which is
 *  precisely the wiring an e2e is for.
 *
 *  A script that runs out THROWS, deliberately: "the model stopped answering half way through" is
 *  a case the app has to handle, and a test that wants it just supplies one reply too few.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, ToolCall } from '../../shared/ai';
import type { ChatOptions, ChatTurnResult, FimRequest, ModelProvider } from './modelProvider';

/**
 * One scripted turn. A bare string is the common case (text, no tools); the object form covers
 * the two things a string cannot say:
 *
 * - `toolCalls` — the NATIVE tool calls a gateway model surfaces, which is what drives the agent
 *   loop for real. (A model that writes its call as text instead is the fallback path, and
 *   `textToolCalls.test.ts` owns that.)
 * - `hang` — stream the text, then never finish until the caller's `AbortSignal` fires. That is
 *   the only way to test anything about CANCELLING: a reply that resolves immediately gives a
 *   test nothing to cancel.
 */
export type ScriptedReply = string | {
	text?: string;
	toolCalls?: ToolCall[];
	hang?: boolean;
};

/** Reject when `signal` aborts (or at once, if it already has). Never resolves. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		if (!signal) {
			// A hanging reply with nothing able to stop it would wedge the suite until Playwright's
			// timeout, and the failure would name the wrong thing.
			reject(new Error('The scripted model was told to hang, but the caller passed no AbortSignal.'));
			return;
		}
		const stop = (): void => reject(new Error('The scripted model was aborted.'));
		if (signal.aborted) {
			stop();
			return;
		}
		signal.addEventListener('abort', stop, { once: true });
	});
}

export class ScriptedProvider implements ModelProvider {
	/** Every chat prompt this provider was given, so a test can assert what was actually sent.
	 *  `system`/`user` are the two roles most assertions want; `messages` is the whole conversation
	 *  as sent, which is the only way to see a TOOL result being fed back to the model. */
	readonly prompts: { system: string; user: string; messages: { role: string; content: string }[] }[] = [];
	/** Every fill-in-the-middle request, likewise: inline completion sends the editor's own text,
	 *  so what it carries is a data-boundary question as much as the chat prompt is. */
	readonly fimRequests: { prefix: string; suffix: string }[] = [];

	constructor(private readonly replies: ScriptedReply[]) {}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult> {
		this.prompts.push({
			system: messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
			user: messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n'),
			messages: messages.map((message) => ({ role: message.role, content: message.content })),
		});
		const reply = this.replies.shift();
		if (reply === undefined) {
			throw new Error('The scripted model has no more replies.');
		}
		const turn = typeof reply === 'string' ? { text: reply } : reply;
		const text = turn.text ?? '';
		// Streamed rather than returned whole: every caller reads the deltas, and a provider that
		// only resolved would leave that half of them untested.
		opts.onDelta(text);
		if (turn.hang) {
			await untilAborted(opts.signal);
		}
		return {
			text,
			toolCalls: turn.toolCalls ?? [],
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		};
	}

	async listModels(): Promise<string[]> {
		return ['snout-e2e'];
	}

	async fim(req: FimRequest): Promise<string> {
		this.fimRequests.push({ prefix: req.prefix, suffix: req.suffix });
		const reply = this.replies.shift();
		// Unlike chat, an exhausted script answers EMPTY here rather than throwing: "no suggestion"
		// is what an inline completion does when it has nothing, and it must never be an error.
		if (reply === undefined) {
			return '';
		}
		const turn = typeof reply === 'string' ? { text: reply } : reply;
		if (turn.hang) {
			await untilAborted(req.signal);
		}
		return turn.text ?? '';
	}
}

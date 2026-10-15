/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// App-shell contracts (renderer <-> main) for the assistant's chat history. Persisted
// as JSON in the app data dir (see src/main/chatStore.ts), mirroring the query stores.

import type { DocumentAttachment, TokenUsage } from './ai';

/** A single stored chat turn. The grounding system prompt is rebuilt per request and
 *  never persisted, so only the visible user/assistant turns are kept. */
export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
	/** On a user turn: documents attached as context (already extracted + capped). Persisted so a
	 *  reopened session shows its attachment chips and can keep sending them in later turns. */
	attachments?: DocumentAttachment[];
}

/** A persisted conversation, listed in the assistant's history. */
export interface ChatSession {
	id: string;
	/** Derived from the first user message. */
	title: string;
	/** Epoch ms. */
	createdAt: number;
	updatedAt: number;
	/** The connection the chat was grounded in, for display only. */
	connectionId?: string;
	connectionLabel?: string;
	messages: ChatTurn[];
	/** Cumulative token usage across the conversation's turns. */
	tokens: TokenUsage;
}

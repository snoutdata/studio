/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The contract every SnoutData assistant runs on, in Studio and on the Cloud dashboard. Pure types. The shapes are Studio's
// (`apps/studio/src/shared/ai.ts`), which this package took over, so Studio's own types stay
// structurally the same and nothing there had to change.

/** One message in a conversation the model reads. */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** On an assistant turn: the tools the model asked to call this turn. */
	toolCalls?: ToolCall[];
	/** On a tool turn: which {@link ToolCall} this message answers. */
	toolCallId?: string;
	/** On an assistant turn from a reasoning model: the chain-of-thought some APIs require echoed back. */
	reasoningContent?: string;
}

/** What the model is told about one tool. */
export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema (an object schema) describing the tool's arguments. */
	parameters: Record<string, unknown>;
}

/** The model's request to call a tool: one step of the agent loop. */
export interface ToolCall {
	/** Provider-assigned id, used to match the result back to the call. */
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** The outcome fed back to the model for a {@link ToolCall}. */
export interface ToolResult {
	callId: string;
	/** Serialized result the model reads (a text table, DDL, or an error message). */
	content: string;
	isError?: boolean;
}

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface ChatOptions {
	/** Called with each text delta as the model streams its reply. */
	onDelta(text: string): void;
	signal?: AbortSignal;
	/** Tools the model may call this turn. */
	tools?: ToolSpec[];
	/** `'none'` forbids new calls while still declaring the tools (some gateways reject a history
	 *  with tool calls in it unless `tools` is present). */
	toolChoice?: 'auto' | 'none';
}

/** One model turn: its prose (also streamed through `onDelta`) and the tools it wants run. */
export interface ChatTurnResult {
	text: string;
	toolCalls: ToolCall[];
	usage?: TokenUsage;
	reasoningContent?: string;
	/** The provider's id for this completion, when it gives one. */
	responseId?: string;
}

/** The one thing the loop needs from a model. Studio's `ModelProvider` is one; so is the dashboard's
 *  call to `cloud-assistant`. */
export interface ChatProvider {
	chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatTurnResult>;
}

/**
 * A tool as an app registers it: what the model is told, plus what the harness needs to know to
 * decide whether it may run without asking. Studio's `CapabilityDescriptor` carries the same
 * `mutates` / `domain` pair.
 */
export interface ToolDefinition {
	spec: ToolSpec;
	/** The area of the product it belongs to (`database`, `functions`, `navigation`, ...). */
	domain: string;
	/** True when running it changes something. A mutating tool is a proposal until the person allows it. */
	mutates: boolean;
	/**
	 * For a mutating tool: whether THIS call must be asked about even when the person has granted
	 * the tool (D2: destructive SQL, anything on a production project). Absent means a grant covers it.
	 */
	alwaysAsk?(args: Record<string, unknown>, context: GrantContext): string | null;
}

/** What a grant decision may depend on, besides the call itself. */
export interface GrantContext {
	/** The project the tool acts on is marked production. */
	production: boolean;
}

/** How a person answered a proposal. `dismiss` is a no; the rest run it. */
export type ProposalAnswer = 'once' | 'chat' | 'always' | 'dismiss';

/** A proposal card: exactly what a mutating call would do, for the person to answer. */
export interface ProposalCard {
	callId: string;
	tool: string;
	/** One line: "Create table public.todos", "Deploy function send-mail". */
	title: string;
	/** What will change, in a sentence or two. */
	body?: string;
	/** The exact SQL, the files, the setting: what the person is agreeing to. */
	code?: Array<{ label: string; language: string; text: string }>;
	/** Shown when it cannot be undone. */
	irreversible?: boolean;
	/** Set when a standing grant was not enough for this call, and why (`alwaysAsk`). */
	askedBecause?: string;
	/** Which answers to offer. A call that `alwaysAsk`s offers only once and dismiss. */
	answers: ProposalAnswer[];
	/** Fields the person fills in on the card (a secret's value), which the model never sees. */
	inputs?: Array<{ name: string; label: string; secret: boolean }>;
}

/** A person's answer to a card, with what they typed into its fields. */
export interface ProposalReply {
	answer: ProposalAnswer;
	inputs?: Record<string, string>;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Read is free, change is asked.
//
// A tool that only reads runs at once. A tool that changes something becomes a proposal card,
// and the person answers it: Allow once, Allow for this chat, Always allow, or Dismiss. A grant
// for this chat lives in memory and ends with the conversation; an always-grant is the app's to
// store (the dashboard keeps it on `ai_preferences`, per person, per project, per tool) and is
// handed back in here as `always`.
//
// Two kinds of call ask whatever the grant says, because a standing grant for them is how one
// bad answer becomes an incident: what the tool's own `alwaysAsk` names (destructive SQL), and
// any write on a production project. Those cards offer Allow once and Dismiss only.

import type { GrantContext, ProposalAnswer, ProposalCard, ProposalReply, ToolCall, ToolDefinition, ToolResult } from './types.ts';

/** The grants a conversation is running under. */
export interface GrantState {
	/** Tools allowed for the rest of this conversation. */
	chat: Set<string>;
	/** Tools the person always allows on this project (read from where the app keeps them). */
	always: Set<string>;
}

export function emptyGrants(always: Iterable<string> = []): GrantState {
	return { chat: new Set(), always: new Set(always) };
}

/** Why this call must be asked about even with a grant, or null when a grant covers it. */
export function mustAsk(tool: ToolDefinition, args: Record<string, unknown>, context: GrantContext): string | null {
	if (!tool.mutates) {
		return null;
	}
	const own = tool.alwaysAsk?.(args, context) ?? null;
	if (own) {
		return own;
	}
	return context.production ? 'production' : null;
}

/** Run, or ask first. */
export function decide(tool: ToolDefinition, args: Record<string, unknown>, grants: GrantState, context: GrantContext): 'run' | 'ask' {
	if (!tool.mutates) {
		return 'run';
	}
	if (mustAsk(tool, args, context)) {
		return 'ask';
	}
	return grants.chat.has(tool.spec.name) || grants.always.has(tool.spec.name) ? 'run' : 'ask';
}

/** The answers a card for this call offers. */
export function answersFor(tool: ToolDefinition, args: Record<string, unknown>, context: GrantContext): ProposalAnswer[] {
	return mustAsk(tool, args, context) ? ['once', 'dismiss'] : ['once', 'chat', 'always', 'dismiss'];
}

/** Record an answer. Returns true when the call should now run. */
export function applyAnswer(grants: GrantState, tool: string, answer: ProposalAnswer): boolean {
	if (answer === 'chat') {
		grants.chat.add(tool);
	}
	if (answer === 'always') {
		grants.always.add(tool);
	}
	return answer !== 'dismiss';
}

/** What the model reads when the person said no. Plain, so it neither retries nor argues. */
export const DECLINED = 'The person declined this. Nothing was changed. Do not try it again unless they ask; say what you would have done and let them decide.';

/** What a gated runner needs from the app. */
export interface GatedRunnerOptions {
	tools: Map<string, ToolDefinition>;
	grants: GrantState;
	context(call: ToolCall): GrantContext;
	/** Build the card for a mutating call (the app knows how to describe its own tools). */
	card(call: ToolCall, tool: ToolDefinition): Omit<ProposalCard, 'answers' | 'askedBecause' | 'callId' | 'tool'>;
	/** Show the card and wait for the person's answer (and what they typed into its fields). */
	ask(card: ProposalCard): Promise<ProposalAnswer | ProposalReply>;
	/** Called after an `always` answer, so the app can store the grant. */
	onAlways?(tool: string): void | Promise<void>;
	/** Actually run the tool. `inputs` are the card's fields, when it had any and was answered. */
	run(call: ToolCall, tool: ToolDefinition, inputs?: Record<string, string>): Promise<ToolResult>;
}

/**
 * Wrap an app's tools in the grant rules, for {@link runAgentLoop}'s `runTool`. An unknown tool is
 * an error result, not a throw: a model handles "no such tool" and stalls on an exception.
 */
export function gatedRunner(options: GatedRunnerOptions): (call: ToolCall) => Promise<ToolResult> {
	return async (call) => {
		const tool = options.tools.get(call.name);
		if (!tool) {
			return { callId: call.id, content: `There is no tool called ${call.name}.`, isError: true };
		}
		const context = options.context(call);
		let inputs: Record<string, string> | undefined;
		// A card with fields (a secret's value) is shown every time: a grant cannot type a value.
		const drafted = tool.mutates ? options.card(call, tool) : null;
		if (decide(tool, call.arguments, options.grants, context) === 'ask' || drafted?.inputs?.length) {
			const card: ProposalCard = {
				...(drafted ?? options.card(call, tool)),
				callId: call.id,
				tool: call.name,
				answers: answersFor(tool, call.arguments, context),
				askedBecause: mustAsk(tool, call.arguments, context) ?? undefined
			};
			const reply = await options.ask(card);
			const answer = typeof reply === 'string' ? reply : reply.answer;
			inputs = typeof reply === 'string' ? undefined : reply.inputs;
			if (!card.answers.includes(answer) || !applyAnswer(options.grants, call.name, answer)) {
				return { callId: call.id, content: DECLINED };
			}
			if (answer === 'always') {
				await options.onAlways?.(call.name);
			}
		}
		try {
			return await options.run(call, tool, inputs);
		} catch (e) {
			return { callId: call.id, content: `${call.name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
		}
	};
}

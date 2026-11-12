/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The trace: one record per model round and per tool call, as the lab reads it.
//
// Meta-Harness's finding is that a proposer that reads FULL traces beats one that reads scores, so
// a trace keeps everything a round saw and did. That is also why production never writes one: a
// trace holds the person's schema and rows. The dashboard and Studio write traces only into a
// sink a developer or the lab hands them (`TraceSink`); with none, nothing is kept.

import type { ChatMessage, ProposalAnswer, ProposalCard, TokenUsage, ToolCall, ToolResult, ToolSpec } from './types.ts';

export type TraceRecord =
	| {
			kind: 'round';
			at: string;
			step: number;
			model?: string;
			/** The system prompt in full: the lab diffs it between candidates. */
			system?: string;
			messages: ChatMessage[];
			tools: ToolSpec[];
			text: string;
			toolCalls: ToolCall[];
			usage?: TokenUsage;
			ms: number;
	  }
	| { kind: 'tool'; at: string; call: ToolCall; result: ToolResult; ms: number }
	| { kind: 'proposal'; at: string; card: ProposalCard; answer: ProposalAnswer }
	| { kind: 'end'; at: string; reply: string; steps: number; usage?: TokenUsage };

export interface TraceSink {
	write(record: TraceRecord): void;
}

/** A sink that keeps records in memory (tests, and the lab's runner before it writes a file). */
export function memorySink(): TraceSink & { records: TraceRecord[] } {
	const records: TraceRecord[] = [];
	return { records, write: (record) => records.push(record) };
}

/** One JSON line per record, the lab's file format. */
export function toJsonl(records: TraceRecord[]): string {
	return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

export function now(): string {
	return new Date().toISOString();
}

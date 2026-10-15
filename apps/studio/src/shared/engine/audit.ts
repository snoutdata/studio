/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * What the engine records when it mediates an action.
 *
 * The engine decides WHAT is worth recording; the host provides the durable sink (see
 * `host.ts`). Keeping the shape here rather than in main is what makes "one audit trail"
 * enforceable: every mediated path produces this same record, so a new path cannot invent
 * its own half-populated log format.
 *
 * Model round-trips (chat/completion/edit) are recorded separately as `AiAuditEntry` — that
 * predates this and already flows through the same store.
 */

/**
 * Where a mediated action came from. This matters more than it looks: `mcp` is an EXTERNAL
 * agent driving the user's databases with the least human supervision of any path, so being
 * able to filter the log down to it is the point of tagging at all. `review` is Snoutbot's
 * optional prose pass over a finished pull-request review, which runs on a poller with nobody
 * watching and spends the user's own AI allowance.
 */
export type ActionOrigin = 'chat' | 'mcp' | 'flow' | 'review';

/** One tool or capability invocation, as the audit records it. */
export interface ToolAuditRecord {
	/** The originating tool-call id, so a record can be tied back to the turn that caused it. */
	callId: string;
	/** The tool or capability name, after alias normalisation (the name that actually ran). */
	tool: string;
	origin: ActionOrigin;
	/** Whether this invocation could change something, and therefore needed approval. */
	mutates: boolean;
	/** The arguments the model supplied. Structured-clone-safe by construction. */
	arguments: Record<string, unknown>;
	/** True when the invocation completed without an error. */
	ok: boolean;
	/** One-line human description of what happened (the same text the tool step shows). */
	summary: string;
	/** Populated when `ok` is false. */
	error?: string;
	/** Wall-clock duration of the invocation. */
	durationMs: number;
	/** The connection it was grounded in, when any. */
	connectionId?: string;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChatMessage, TokenUsage, ToolCall } from '../../shared/ai';

/**
 * One model round-trip captured for tuning — the blackbox view of what actually went over
 * the wire, regardless of which path produced it (one-shot Ask, an agent-loop step,
 * completion, or a Ctrl+K edit). Unlike the audit log this keeps the FULL system prompt
 * and is gated on a dev flag rather than the user's tier, so we can see exactly what each
 * model was asked and how it answered. Written one-JSON-per-line to
 * userData/aiDebug.jsonl, beside the dev-only /ai/benchmark endpoint (aiDebugServer.ts).
 */
export interface AiDebugEntry {
	/** Epoch ms when the round-trip started. */
	ts: number;
	kind: 'chat' | 'fim';
	/** The provider+model that served it (resolved, including any benchmark override). */
	provider: string;
	model: string;
	/** Chat round-trip: the full conversation sent (system prompt included). */
	messages?: ChatMessage[];
	/** FIM round-trip: the prefix/suffix sent to the code model. */
	fim?: { prefix: string; suffix: string };
	/** The model's reply text. */
	reply: string;
	/** Tool calls the model asked for this turn (agent loop), when any. */
	toolCalls?: ToolCall[];
	/** Reasoning-model chain-of-thought, when emitted. */
	reasoningContent?: string;
	usage?: TokenUsage;
	ms: number;
	ok: boolean;
	error?: string;
}

/** The environment variable that switches the blackbox log and the tuning endpoint on in a dev run. */
export const AI_DEBUG_ENV = 'SNOUT_AI_DEBUG';

/**
 * Whether this run logs every model round-trip and starts the tuning endpoint: only a dev run
 * (never a packaged build) that asked for it with `SNOUT_AI_DEBUG=1`. It used to be every
 * unpackaged run, so `npm run dev` wrote each prompt and reply, schema and rows included, to a
 * plaintext file that only grew, and opened a local endpoint, for anyone who built from source.
 */
export function aiDebugRequested(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
	return !isPackaged && env[AI_DEBUG_ENV] === '1';
}

/** Past this size the log is moved aside to `aiDebug.1.jsonl` (replacing the one there) and begun again. */
export const AI_DEBUG_LOG_MAX_BYTES = 20 * 1024 * 1024;

let enabled = false;
let logDir: string | null = null;
/** Appends run one after another, so a rotation never races a write. */
let queue: Promise<void> = Promise.resolve();

/** Turn blackbox round-trip logging on or off (see {@link aiDebugRequested}). `dir` is where the
 *  log goes, userData unless a test says otherwise. */
export function setAiDebugEnabled(on: boolean, dir?: string): void {
	enabled = on;
	logDir = dir ?? null;
}

export function aiDebugEnabled(): boolean {
	return enabled;
}

function logPath(): string {
	return join(logDir ?? app.getPath('userData'), 'aiDebug.jsonl');
}

/** Append one line to `path`, first moving the file aside when the line would take it past `max`. */
export async function appendCapped(path: string, line: string, max: number = AI_DEBUG_LOG_MAX_BYTES): Promise<void> {
	let size = 0;
	try {
		size = (await stat(path)).size;
	} catch {
		size = 0;
	}
	if (size > 0 && size + Buffer.byteLength(line) > max) {
		await rename(path, path.replace(/\.jsonl$/, '.1.jsonl'));
	}
	await appendFile(path, line);
}

/** Record one round-trip: a concise line to the dev console (visible in `npm run dev`'s
 *  output) plus the full entry appended to aiDebug.jsonl, which never grows past
 *  {@link AI_DEBUG_LOG_MAX_BYTES} (one older file is kept). Best-effort: a logging failure
 *  must never break the chat it's recording. No-op when disabled. Resolves once written. */
export function logAiRoundTrip(entry: AiDebugEntry): Promise<void> {
	if (!enabled) {
		return Promise.resolve();
	}
	const tokens = entry.usage ? ` ${entry.usage.promptTokens}/${entry.usage.completionTokens}tok` : '';
	const tail = entry.ok ? '' : ` ERROR ${entry.error ?? ''}`;
	console.log(`[ai-debug] ${entry.provider}:${entry.model} ${entry.kind} ${entry.ms}ms${tokens}${tail}`);
	const path = logPath();
	const line = `${JSON.stringify(entry)}\n`;
	queue = queue.then(() => appendCapped(path, line)).catch(() => {
		// Debug logging is non-essential; never surface a write failure.
	});
	return queue;
}

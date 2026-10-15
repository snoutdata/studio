/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AiAuditEntry, AiAuditSource } from '../shared/ai';
import { maskUriPasswords } from '../shared/connectionUri';
import type { ToolAuditRecord } from '../shared/engine';

// Append-only audit log of every LLM interaction (chat, completion, edit), persisted as
// JSON in the app data dir, newest-first and capped. Mirrors chatStore.ts. Lets the user
// review when each call happened, which model served it, and the full exchange.

/** What a model was actually asked and what it said, for an action one of our models served. */
export interface AuditedExchange {
	systemPrompt?: string;
	user: string;
	reply: string;
}

const MAX_ENTRIES = 500;
/** Hard cap on any single text field, so one giant prompt/reply can't bloat the file. */
const MAX_FIELD_CHARS = 20000;
/** How long appends are batched before the file is rewritten. */
const FLUSH_DELAY_MS = 1000;

export class AuditStore {
	private filePath(): string {
		return join(app.getPath('userData'), 'aiAudit.json');
	}

	private read(): AiAuditEntry[] {
		const path = this.filePath();
		if (!existsSync(path)) {
			return [];
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: AiAuditEntry[] };
			return raw.entries ?? [];
		} catch {
			return [];
		}
	}

	private write(entries: AiAuditEntry[]): void {
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ entries }, null, 2), 'utf8');
	}

	/**
	 * The in-memory view of the log, so an append doesn't have to re-read the file. Loaded
	 * lazily on first use and authoritative from then on (this process is the only writer).
	 */
	private cache: AiAuditEntry[] | null = null;

	private entries(): AiAuditEntry[] {
		if (this.cache === null) {
			this.cache = this.read();
		}
		return this.cache;
	}

	/** Set when entries have changed but not yet been written; see {@link scheduleFlush}. */
	private flushTimer: NodeJS.Timeout | null = null;

	/**
	 * Coalesce writes. Previously every append re-read the whole file, re-serialized up to 500
	 * entries and wrote them back synchronously — tolerable at one write per chat turn, not at
	 * one per tool call now that capability invocations are recorded too (an agent turn can fire
	 * a dozen). Entries are kept in memory and the file is rewritten at most once a second.
	 *
	 * The timer is `unref()`d so a pending log write never holds the process open; `flush()` on
	 * quit covers the shutdown case. (This was briefly suspected of dropping writes during the
	 * 2026-07-19 verification and removed — wrongly. The writes were landing all along, in
	 * `%APPDATA%\snoutdata-dev`; the checker was reading the packaged app's file. Verified
	 * working with unref in place.)
	 */
	private scheduleFlush(): void {
		if (this.flushTimer !== null) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, FLUSH_DELAY_MS);
		this.flushTimer.unref?.();
	}

	/** Write pending entries now. Called on the timer and on app quit. */
	flush(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.cache !== null) {
			this.write(this.cache);
		}
	}

	/** Dev diagnostic: how many entries are held in memory and whether a write is pending.
	 *  Surfaced on /ai/info so "nothing reached the log" can be told apart from "the write
	 *  never fired" without guessing. */
	pending(): { cached: number | null; flushScheduled: boolean } {
		return { cached: this.cache === null ? null : this.cache.length, flushScheduled: this.flushTimer !== null };
	}

	/** Entries, newest first. */
	list(): AiAuditEntry[] {
		return [...this.entries()].sort((a, b) => b.timestamp - a.timestamp);
	}

	/** Record one interaction (clipping oversized text) and trim to the cap. */
	append(entry: AiAuditEntry): void {
		const trimmed: AiAuditEntry = {
			...entry,
			messages: entry.messages.map((m) => ({ ...m, content: clip(m.content) })),
			response: clip(entry.response),
			systemPrompt: entry.systemPrompt === undefined ? undefined : clip(entry.systemPrompt),
			error: entry.error === undefined ? undefined : clip(entry.error),
		};
		this.cache = [trimmed, ...this.entries()].slice(0, MAX_ENTRIES);
		this.scheduleFlush();
	}

	/**
	 * Patch an entry already recorded, in place. Used for facts that only become known after the
	 * round-trip finished — an inline completion is written when the model answers, but whether
	 * the user took it arrives later, from the renderer. A no-op when the entry has since been
	 * trimmed out of the log or auditing is off; measurement must never resurrect a dropped entry.
	 */
	annotate(id: string, patch: (entry: AiAuditEntry) => AiAuditEntry): void {
		const entries = this.entries();
		const index = entries.findIndex((e) => e.id === id);
		if (index < 0) {
			return;
		}
		const next = [...entries];
		next[index] = patch(entries[index]);
		this.cache = next;
		this.scheduleFlush();
	}

	/**
	 * Record one mediated action (a tool or capability invocation) from the engine's record.
	 * The engine decides what is worth recording; this only shapes it for the store, so the
	 * call and its outcome land in the generic fields the audit viewer already renders.
	 *
	 * `exchange` is for an action a MODEL of ours served (a Data Flow's extraction stage). Those
	 * are the actions where record content left the machine, so the log holds what was sent and
	 * what came back, exactly as it does for a chat turn, rather than the tool's own summary.
	 */
	recordAction(record: ToolAuditRecord, provider: AiAuditSource, model: string, exchange?: AuditedExchange): void {
		this.append({
			id: `${record.callId}:${record.origin}`,
			timestamp: Date.now(),
			kind: 'action',
			provider,
			model,
			connectionId: record.connectionId,
			systemPrompt: exchange?.systemPrompt,
			messages: exchange
				? [{ role: 'user', content: exchange.user }]
				: [{ role: 'assistant', content: `${record.tool}(${JSON.stringify(record.arguments)})` }],
			response: exchange && record.ok ? exchange.reply : record.ok ? record.summary : (record.error ?? record.summary),
			ok: record.ok,
			error: record.error,
			durationMs: record.durationMs,
			action: { tool: record.tool, origin: record.origin, mutates: record.mutates, durationMs: record.durationMs },
		});
	}

	clear(): void {
		this.cache = [];
		this.flush();
	}
}

/** A field as the log keeps it: a connection string's password masked, and capped. */
function clip(text: string): string {
	const masked = maskUriPasswords(text);
	return masked.length > MAX_FIELD_CHARS ? `${masked.slice(0, MAX_FIELD_CHARS)}…[truncated]` : masked;
}

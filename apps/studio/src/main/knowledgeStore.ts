/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { KnowledgeNote } from '../shared/knowledge';
import { GLOBAL_CONNECTION } from '../shared/knowledge';

// The on-disk document: the notes plus a one-time flag marking that the legacy freeform
// "AI instructions" textarea has been folded into a global note.
interface KnowledgeDoc {
	notes: KnowledgeNote[];
	instructionsMigrated?: boolean;
}

// Two facts are "the same" when their significant words overlap this much (overlap coefficient =
// shared / smaller set). The distiller rewords the same fact across turns, so exact matching lets
// near-duplicates through; 0.6 catches rewordings without merging genuinely distinct facts.
const SIMILARITY_THRESHOLD = 0.6;

/** Significant lowercased word tokens of a note (drops punctuation + short filler ≤2 chars). */
function tokenize(text: string): Set<string> {
	const set = new Set<string>();
	for (const w of text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/)) {
		if (w.length > 2) {
			set.add(w);
		}
	}
	return set;
}

/** True when `text` is a near-duplicate of any string in `others` (token overlap coefficient). */
function similarToAny(text: string, others: string[]): boolean {
	const a = tokenize(text);
	if (a.size === 0) {
		return false;
	}
	for (const other of others) {
		const b = tokenize(other);
		if (b.size === 0) {
			continue;
		}
		let inter = 0;
		for (const w of a) {
			if (b.has(w)) {
				inter++;
			}
		}
		if (inter / Math.min(a.size, b.size) >= SIMILARITY_THRESHOLD) {
			return true;
		}
	}
	return false;
}

// Per-connection knowledge base, persisted as JSON in the app data dir. Mirrors chatStore.ts.
// Notes are user-authored domain prose (not secret) → plaintext, NOT secretStore. They ARE sent
// to the gateway inside the prompt, exactly like schema is today.

export class KnowledgeStore {
	/** Base dir override for tests (so they never touch Electron's `app`); defaults to userData. */
	constructor(private readonly baseDir?: string) {}

	private filePath(): string {
		return join(this.baseDir ?? app.getPath('userData'), 'knowledge.json');
	}

	private readDoc(): KnowledgeDoc {
		const path = this.filePath();
		if (!existsSync(path)) {
			return { notes: [] };
		}
		try {
			const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<KnowledgeDoc>;
			return { notes: raw.notes ?? [], instructionsMigrated: raw.instructionsMigrated };
		} catch {
			return { notes: [] };
		}
	}

	private read(): KnowledgeNote[] {
		return this.readDoc().notes;
	}

	/** Persist `notes`, preserving the sibling `instructionsMigrated` flag. */
	private write(notes: KnowledgeNote[]): void {
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ ...this.readDoc(), notes }, null, 2), 'utf8');
	}

	/** Active/suggested notes for one connection, newest-updated first (dismissed are hidden — they
	 *  exist only to suppress re-proposing). A `suggested` note that's a near-duplicate of an already
	 *  ACTIVE note is also hidden: once you've Remembered the fact, its reworded twin shouldn't keep
	 *  nagging you. This is the management/list surface; injection uses notesFor(). Does NOT fold in
	 *  global notes — pass GLOBAL_CONNECTION to see those. */
	list(connectionId: string): KnowledgeNote[] {
		const notes = this.read()
			.filter((n) => n.connectionId === connectionId && (n.status ?? 'active') !== 'dismissed')
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const activeTexts = notes.filter((n) => (n.status ?? 'active') === 'active').map((n) => n.text);
		return notes.filter((n) => n.status !== 'suggested' || !similarToAny(n.text, activeTexts));
	}

	/** Suggested (observer-proposed, not-yet-approved) notes for one connection, newest first. */
	listSuggested(connectionId: string): KnowledgeNote[] {
		return this.list(connectionId).filter((n) => n.status === 'suggested');
	}

	/** Upsert by id; stamps updatedAt. */
	save(note: KnowledgeNote): KnowledgeNote {
		const stamped: KnowledgeNote = { ...note, updatedAt: Date.now() };
		const rest = this.read().filter((n) => n.id !== note.id);
		this.write([stamped, ...rest]);
		return stamped;
	}

	delete(id: string): void {
		this.write(this.read().filter((n) => n.id !== id));
	}

	setEnabled(id: string, enabled: boolean): void {
		const notes = this.read();
		const note = notes.find((n) => n.id === id);
		if (!note) {
			return;
		}
		note.enabled = enabled;
		note.updatedAt = Date.now();
		this.write(notes);
	}

	/** Promote an observer-suggested note to an injected fact ("Remember"). */
	approve(id: string): void {
		this.setStatus(id, 'active');
	}

	/** Decline a suggested note (the "✕"): remove it outright. We deliberately do NOT keep a
	 *  `dismissed` tombstone — a persisted, invisible suppressor silently blocked re-learning forever
	 *  with no way to see or undo it. If the fact is genuinely useful and recurs, the observer may
	 *  offer it again (one tap to decline). Legacy `dismissed` notes are ignored by dedup (below). */
	dismiss(id: string): void {
		this.delete(id);
	}

	private setStatus(id: string, status: KnowledgeNote['status']): void {
		const notes = this.read();
		const note = notes.find((n) => n.id === id);
		if (!note) {
			return;
		}
		note.status = status;
		note.updatedAt = Date.now();
		this.write(notes);
	}

	/** Every note text relevant to a connection (its own + globals) that should suppress a new
	 *  proposal: the observer dedups against notes the user actively keeps (`active`) or has pending
	 *  (`suggested`), NOT against `dismissed` legacy tombstones — those must never silently block
	 *  re-learning. */
	private relevantTexts(connectionId: string): string[] {
		return this.read()
			.filter((n) => (n.connectionId === connectionId || n.connectionId === GLOBAL_CONNECTION) && (n.status ?? 'active') !== 'dismissed')
			.map((n) => n.text);
	}

	/** Record a background-observer proposal as a `suggested` glossary note (per-connection), unless
	 *  a NEAR-duplicate already exists/was declined for this connection. Dedup is fuzzy (token
	 *  overlap), because the distiller rewords the same fact across turns ("sale date" vs "sale
	 *  completion date") and exact matching would let those slip through. Returns the saved note, or
	 *  null when deduped away. Never injects until the user approves ("never silent"). */
	suggest(connectionId: string, text: string): KnowledgeNote | null {
		const trimmed = text.trim();
		if (!trimmed || similarToAny(trimmed, this.relevantTexts(connectionId))) {
			return null;
		}
		const now = Date.now();
		return this.save({
			id: randomUUID(),
			connectionId,
			scope: 'glossary',
			text: trimmed,
			enabled: true,
			status: 'suggested',
			source: 'chat',
			createdAt: now,
			updatedAt: now,
		});
	}

	/** One-time: fold the legacy freeform "AI instructions" into a single GLOBAL glossary
	 *  note so the retired textarea's content keeps being injected everywhere. Idempotent via the
	 *  `instructionsMigrated` flag. Returns true when it ran (so the caller can clear the textarea). */
	migrateInstructions(text: string): boolean {
		const doc = this.readDoc();
		if (doc.instructionsMigrated) {
			return false;
		}
		const trimmed = text.trim();
		const notes = [...doc.notes];
		if (trimmed) {
			const now = Date.now();
			notes.unshift({
				id: randomUUID(),
				connectionId: GLOBAL_CONNECTION,
				scope: 'glossary',
				text: trimmed,
				enabled: true,
				status: 'active',
				source: 'manual',
				createdAt: now,
				updatedAt: now,
			});
		}
		const path = this.filePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ notes, instructionsMigrated: true }, null, 2), 'utf8');
		return true;
	}

	/** The retrieval shape the prompt path consumes. Enabled notes only. */
	notesFor(connectionId: string): {
		glossary: KnowledgeNote[];
		byTable: Map<string, KnowledgeNote[]>;
		pinnedTables: Set<string>;
	} {
		const glossary: KnowledgeNote[] = [];
		const byTable = new Map<string, KnowledgeNote[]>();
		const pinnedTables = new Set<string>();
		for (const note of this.read()) {
			const isGlobal = note.connectionId === GLOBAL_CONNECTION;
			// Only THIS connection's notes, plus GLOBAL glossary notes (which apply everywhere).
			if (!isGlobal && note.connectionId !== connectionId) {
				continue;
			}
			// Never inject unless enabled AND approved (suggested/dismissed stay out — "never silent").
			if (!note.enabled || (note.status ?? 'active') !== 'active') {
				continue;
			}
			// A global note only contributes to the always-injected glossary (table/column targets
			// are schema-specific and meaningless across connections).
			if (isGlobal || note.scope === 'glossary') {
				glossary.push(note);
				continue;
			}
			// table/column notes key on the table name (a column target is "table.column").
			const table = (note.target ?? '').split('.')[0].toLowerCase();
			if (!table) {
				continue;
			}
			const list = byTable.get(table) ?? [];
			list.push(note);
			byTable.set(table, list);
			if (note.pinned) {
				pinnedTables.add(table);
			}
		}
		return { glossary, byTable, pinnedTables };
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { KnowledgeNote, KnowledgeScope } from '../../../shared/knowledge';
import { GLOBAL_CONNECTION } from '../../../shared/knowledge';
import type { CapabilityHandler } from './registry';

/**
 * The knowledge capability: lets the assistant itself offer to remember a durable fact about
 * the user's database, instead of only the background observer proposing one after a SQL
 * turn. It is `mutates` ⇒ the agent shows the "the assistant wants to remember this (…)"
 * approval card first, so nothing is ever learned silently, which is the feature's #1
 * principle. The saved note is a normal `KnowledgeNote`: same store, same Settings →
 * Knowledge list, same injection path.
 */

/** A remembered fact is one sentence, not a transcript. Longer text wastes the prompt budget on
 *  every later turn, so the model is told to condense rather than have us silently clip it. */
const MAX_TEXT = 400;

/** Comparison form for "we already know this": case/punctuation-insensitive. Deliberately exact
 *  on words (the store's fuzzy dedup is for the observer's reworded drafts); the approval card is
 *  the real guard here, this only stops the model re-saving its own note verbatim. */
function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export const knowledgeCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'remember_this',
			consentLabel: 'Remember a fact about your database for future conversations.',
			description: 'Durably remember one fact about the user\'s database so you still know it in future conversations (e.g. "there is no sales table; sales live in customer_order, fulfilled_date is the sale date"). Use it when the user teaches you something or corrects you about their data model, naming, or conventions. Write one self-contained sentence that will still make sense with no conversation around it. Do NOT use it for one-off requests, for anything already obvious from the schema, or for facts you were only told inside this turn\'s question.',
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'The fact, as one plain-language sentence.' },
					table: { type: 'string', description: 'Optional: the table this fact is about, when it is specific to one table.' },
					column: { type: 'string', description: 'Optional: the column this fact is about. Requires `table`.' },
					applies_everywhere: { type: 'boolean', description: 'Optional: true when it is a general rule about how to answer (a style or convention), not a fact about this one database. Cannot be combined with table/column.' },
				},
				required: ['text'],
			},
			domain: 'knowledge',
			mutates: true,
			implicitConnection: 'activeTab',
			returnsData: 'none',
		},
		run: async (args, ctx) => {
			const text = String(args.text ?? '').trim();
			if (!text) {
				return { ok: false, summary: '', error: 'Provide the fact to remember, as one plain sentence.' };
			}
			if (text.length > MAX_TEXT) {
				return { ok: false, summary: '', error: `That is ${text.length} characters; condense it to one sentence under ${MAX_TEXT}.` };
			}
			const everywhere = args.applies_everywhere === true;
			const table = String(args.table ?? '').trim().toLowerCase();
			const column = String(args.column ?? '').trim().toLowerCase();
			if (column && !table) {
				return { ok: false, summary: '', error: 'Pass the `table` this column belongs to as well.' };
			}
			if (everywhere && table) {
				return { ok: false, summary: '', error: 'A table or column fact belongs to one database. Either drop `table`/`column`, or drop `applies_everywhere`.' };
			}
			const connectionId = everywhere ? GLOBAL_CONNECTION : ctx.snapshot().activeConnectionId;
			if (!connectionId) {
				return { ok: false, summary: '', error: 'No database is selected, so there is nothing to attach this to. Pass applies_everywhere: true to save it as a general rule instead.' };
			}
			const scope: KnowledgeScope = column ? 'column' : table ? 'table' : 'glossary';
			const target = column ? `${table}.${column}` : table || undefined;

			// Already known? Check this connection's notes plus the global rules that also apply to
			// it, so the model can't re-save what it is already being told every turn.
			const [own, global] = await Promise.all([
				ctx.api.knowledgeNotes(connectionId),
				everywhere ? Promise.resolve([] as KnowledgeNote[]) : ctx.api.knowledgeNotes(GLOBAL_CONNECTION),
			]);
			const wanted = normalize(text);
			if ([...own, ...global].some((n) => normalize(n.text) === wanted)) {
				return { ok: true, summary: 'Already remembered, nothing to change', data: { saved: false } };
			}

			const now = Date.now();
			await ctx.api.saveKnowledgeNote({
				id: crypto.randomUUID(),
				connectionId,
				scope,
				target,
				text,
				enabled: true,
				// The user just approved it on the card, so it is active (injected) immediately —
				// unlike an observer proposal, which lands as `suggested` and waits.
				status: 'active',
				// Match the manual editor: a table/column fact pins its table into the schema slice,
				// so the note and the columns it talks about arrive together.
				pinned: scope === 'glossary' ? undefined : true,
				source: 'chat',
				createdAt: now,
				updatedAt: now,
			});
			ctx.app.notifyKnowledgeChanged();
			const where = everywhere ? 'for every database' : target ? `about ${target}` : 'about this database';
			return { ok: true, summary: `Remembered ${where}`, data: { saved: true, scope, target } };
		},
	},
];

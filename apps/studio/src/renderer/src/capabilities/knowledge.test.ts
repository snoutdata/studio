/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { KnowledgeNote } from '../../../shared/knowledge';
import { GLOBAL_CONNECTION } from '../../../shared/knowledge';
import type { CapabilityContext } from './registry';
import { knowledgeCapabilities } from './knowledge';

const remember = knowledgeCapabilities.find((h) => h.spec.name === 'remember_this')!;

/** A fake context: the capability reaches the app only through ctx.api.knowledgeNotes (dedup),
 *  ctx.api.saveKnowledgeNote (persist), ctx.snapshot() (which DB is selected) and the bridge's
 *  notifyKnowledgeChanged. We capture what it tries to save. */
function ctxWith(activeConnectionId: string | undefined, existing: KnowledgeNote[] = []): { ctx: CapabilityContext; saved: KnowledgeNote[]; notified: () => number } {
	const saved: KnowledgeNote[] = [];
	let notifications = 0;
	const ctx = {
		api: {
			knowledgeNotes: async (connectionId: string) => existing.filter((n) => n.connectionId === connectionId),
			saveKnowledgeNote: async (note: KnowledgeNote) => {
				saved.push(note);
				return note;
			},
		},
		app: { notifyKnowledgeChanged: () => { notifications++; } },
		snapshot: () => ({ connections: [], activeConnectionId, tabs: [], appSettings: {} }),
	} as unknown as CapabilityContext;
	return { ctx, saved, notified: () => notifications };
}

function note(over: Partial<KnowledgeNote>): KnowledgeNote {
	return { id: 'n1', connectionId: 'c1', scope: 'glossary', text: 'x', enabled: true, status: 'active', source: 'manual', createdAt: 1, updatedAt: 1, ...over };
}

describe('remember_this capability', () => {
	test('is approval-gated, so nothing is ever learned silently', () => {
		assert.equal(remember.spec.mutates, true);
	});

	test('saves a glossary note against the selected connection, active immediately', async () => {
		const { ctx, saved, notified } = ctxWith('c1');
		const result = await remember.run({ text: 'There is no sales table; sales live in customer_order.' }, ctx);
		assert.equal(result.ok, true);
		assert.equal(saved.length, 1);
		assert.equal(saved[0].connectionId, 'c1');
		assert.equal(saved[0].scope, 'glossary');
		assert.equal(saved[0].status, 'active');
		assert.equal(saved[0].enabled, true);
		assert.equal(saved[0].source, 'chat');
		assert.equal(saved[0].target, undefined);
		assert.equal(notified(), 1);
	});

	test('a table fact scopes to that table and pins it into the schema slice', async () => {
		const { ctx, saved } = ctxWith('c1');
		const result = await remember.run({ text: 'fulfilled_date is the sale date.', table: 'Customer_Order' }, ctx);
		assert.equal(result.ok, true);
		assert.equal(saved[0].scope, 'table');
		assert.equal(saved[0].target, 'customer_order');
		assert.equal(saved[0].pinned, true);
	});

	test('a column fact targets table.column', async () => {
		const { ctx, saved } = ctxWith('c1');
		await remember.run({ text: 'Stored in cents.', table: 'orders', column: 'Total' }, ctx);
		assert.equal(saved[0].scope, 'column');
		assert.equal(saved[0].target, 'orders.total');
	});

	test('applies_everywhere saves a global rule, even with no connection selected', async () => {
		const { ctx, saved } = ctxWith(undefined);
		const result = await remember.run({ text: 'Always alias aggregate columns.', applies_everywhere: true }, ctx);
		assert.equal(result.ok, true);
		assert.equal(saved[0].connectionId, GLOBAL_CONNECTION);
		assert.equal(saved[0].scope, 'glossary');
	});

	test('refuses without a selected connection unless it is a global rule', async () => {
		const { ctx, saved } = ctxWith(undefined);
		const result = await remember.run({ text: 'Sales live in customer_order.' }, ctx);
		assert.equal(result.ok, false);
		assert.equal(saved.length, 0);
		assert.match(result.error ?? '', /applies_everywhere/);
	});

	test('refuses a column without its table, and a table fact marked global', async () => {
		const { ctx, saved } = ctxWith('c1');
		assert.equal((await remember.run({ text: 'In cents.', column: 'total' }, ctx)).ok, false);
		assert.equal((await remember.run({ text: 'In cents.', table: 'orders', applies_everywhere: true }, ctx)).ok, false);
		assert.equal(saved.length, 0);
	});

	test('refuses empty text and an over-long transcript', async () => {
		const { ctx, saved } = ctxWith('c1');
		assert.equal((await remember.run({ text: '   ' }, ctx)).ok, false);
		const long = await remember.run({ text: 'a'.repeat(401) }, ctx);
		assert.equal(long.ok, false);
		assert.match(long.error ?? '', /condense/);
		assert.equal(saved.length, 0);
	});

	test('does not re-save what it already knows (its own note or a global rule)', async () => {
		const existing = [
			note({ id: 'a', connectionId: 'c1', text: 'Sales live in customer_order.' }),
			note({ id: 'b', connectionId: GLOBAL_CONNECTION, text: 'Always alias aggregate columns.' }),
		];
		const { ctx, saved, notified } = ctxWith('c1', existing);
		// Same fact, different punctuation/case: still already known.
		const dup = await remember.run({ text: 'sales live in customer_order' }, ctx);
		assert.equal(dup.ok, true);
		assert.deepEqual(dup.data, { saved: false });
		const global = await remember.run({ text: 'Always alias aggregate columns.' }, ctx);
		assert.deepEqual(global.data, { saved: false });
		assert.equal(saved.length, 0);
		assert.equal(notified(), 0);
	});
});

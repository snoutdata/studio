/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { KnowledgeStore } from './knowledgeStore';
import type { KnowledgeNote } from '../shared/knowledge';

/** A store rooted in a fresh temp dir, so tests never touch Electron's `app`. */
function freshStore(): { store: KnowledgeStore; base: string } {
	const base = mkdtempSync(join(tmpdir(), 'snout-kb-'));
	return { store: new KnowledgeStore(base), base };
}

function note(partial: Partial<KnowledgeNote> & Pick<KnowledgeNote, 'connectionId'>): KnowledgeNote {
	return {
		id: partial.id ?? `id-${Math.random().toString(36).slice(2)}`,
		connectionId: partial.connectionId,
		scope: partial.scope ?? 'glossary',
		target: partial.target,
		text: partial.text ?? 'a fact',
		enabled: partial.enabled ?? true,
		status: partial.status,
		pinned: partial.pinned,
		source: partial.source ?? 'manual',
		createdAt: partial.createdAt ?? 1,
		updatedAt: partial.updatedAt ?? 1,
	};
}

test('save / list round-trips and stamps updatedAt', () => {
	const { store, base } = freshStore();
	try {
		const saved = store.save(note({ id: 'a', connectionId: 'c1', text: 'sales is in customer_order' }));
		assert.ok(saved.updatedAt >= 1);
		const listed = store.list('c1');
		assert.equal(listed.length, 1);
		assert.equal(listed[0].text, 'sales is in customer_order');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('list filters by connection', () => {
	const { store, base } = freshStore();
	try {
		store.save(note({ id: 'a', connectionId: 'c1' }));
		store.save(note({ id: 'b', connectionId: 'c2' }));
		assert.deepEqual(store.list('c1').map((n) => n.id), ['a']);
		assert.deepEqual(store.list('c2').map((n) => n.id), ['b']);
		assert.equal(store.list('c3').length, 0);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('save upserts by id', () => {
	const { store, base } = freshStore();
	try {
		store.save(note({ id: 'a', connectionId: 'c1', text: 'first' }));
		store.save(note({ id: 'a', connectionId: 'c1', text: 'second' }));
		const listed = store.list('c1');
		assert.equal(listed.length, 1);
		assert.equal(listed[0].text, 'second');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('delete and setEnabled', () => {
	const { store, base } = freshStore();
	try {
		store.save(note({ id: 'a', connectionId: 'c1' }));
		store.setEnabled('a', false);
		assert.equal(store.list('c1')[0].enabled, false);
		store.delete('a');
		assert.equal(store.list('c1').length, 0);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('corrupt file reads back as empty, not a throw', () => {
	const { store, base } = freshStore();
	try {
		writeFileSync(join(base, 'knowledge.json'), '{ not valid json', 'utf8');
		assert.deepEqual(store.list('c1'), []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('notesFor buckets enabled notes into glossary / byTable / pinnedTables', () => {
	const { store, base } = freshStore();
	try {
		store.save(note({ id: 'g', connectionId: 'c1', scope: 'glossary', text: 'active = order in 90d' }));
		store.save(note({ id: 't', connectionId: 'c1', scope: 'table', target: 'customer_order', text: 'the sales table', pinned: true }));
		store.save(note({ id: 'col', connectionId: 'c1', scope: 'column', target: 'customer_order.fulfilled_date', text: 'sale date' }));
		store.save(note({ id: 'off', connectionId: 'c1', scope: 'glossary', text: 'disabled', enabled: false }));
		store.save(note({ id: 'other', connectionId: 'c2', scope: 'glossary', text: 'wrong connection' }));

		const kb = store.notesFor('c1');
		assert.deepEqual(kb.glossary.map((n) => n.id), ['g']);
		// table + column notes both key on the table name.
		assert.deepEqual((kb.byTable.get('customer_order') ?? []).map((n) => n.id).sort(), ['col', 't']);
		assert.ok(kb.pinnedTables.has('customer_order'));
		// A disabled note and a different connection's note are both excluded.
		assert.equal(kb.glossary.find((n) => n.id === 'off'), undefined);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

// --- global sentinel, suggested lifecycle, migration ---

test('a global (*) glossary note injects on every connection', () => {
	const { store, base } = freshStore();
	try {
		store.save(note({ id: 'rule', connectionId: '*', scope: 'glossary', text: 'always use CTEs' }));
		store.save(note({ id: 'local', connectionId: 'c1', scope: 'glossary', text: 'c1 only' }));
		// c1 sees both the global and its own; c2 sees only the global.
		assert.deepEqual(store.notesFor('c1').glossary.map((n) => n.id).sort(), ['local', 'rule']);
		assert.deepEqual(store.notesFor('c2').glossary.map((n) => n.id), ['rule']);
		// A global note never contributes to table/column buckets even if mis-scoped.
		store.save(note({ id: 'gt', connectionId: '*', scope: 'table', target: 't', text: 'x' }));
		assert.equal(store.notesFor('c2').byTable.size, 0);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('suggested notes never inject until approved; dismiss removes', () => {
	const { store, base } = freshStore();
	try {
		const s = store.suggest('c1', 'sales live in customer_order');
		assert.ok(s && s.status === 'suggested');
		// Not injected while suggested.
		assert.equal(store.notesFor('c1').glossary.length, 0);
		// Visible in the suggested list, not yet the injected set.
		assert.deepEqual(store.listSuggested('c1').map((n) => n.text), ['sales live in customer_order']);
		// Approve -> injected.
		store.approve(s!.id);
		assert.deepEqual(store.notesFor('c1').glossary.map((n) => n.text), ['sales live in customer_order']);
		assert.equal(store.listSuggested('c1').length, 0);
		// A second, then dismiss -> removed from the list + never injected.
		const s2 = store.suggest('c1', 'refunds are amount < 0');
		store.dismiss(s2!.id);
		assert.equal(store.list('c1').some((n) => n.id === s2!.id), false);
		assert.equal(store.notesFor('c1').glossary.length, 1);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('suggest dedups against existing / global text (not against dismissed)', () => {
	const { store, base } = freshStore();
	try {
		assert.ok(store.suggest('c1', 'Sales live in customer_order'));
		// Same fact (case-insensitive) is not re-proposed while it's still pending.
		assert.equal(store.suggest('c1', 'sales live in customer_order'), null);
		// A dismissed fact is NOT permanently suppressed — declining removes it, so if the fact
		// recurs the observer may offer it again (no invisible black hole).
		const s = store.suggest('c1', 'refunds are amount < 0');
		store.dismiss(s!.id);
		assert.ok(store.suggest('c1', 'refunds are amount < 0'));
		// A global rule blocks re-proposing the same text per-connection.
		store.save(note({ id: 'g', connectionId: '*', scope: 'glossary', text: 'always use CTEs' }));
		assert.equal(store.suggest('c1', 'always use CTEs'), null);
		// Empty text proposes nothing.
		assert.equal(store.suggest('c1', '   '), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('a legacy dismissed note does not suppress re-learning', () => {
	const { store, base } = freshStore();
	try {
		// Simulate the old behavior's leftover: a persisted dismissed tombstone.
		store.save(note({ id: 'old', connectionId: 'c1', status: 'dismissed', text: 'sales live in customer_order' }));
		// It must NOT block the observer from proposing the same fact again.
		assert.ok(store.suggest('c1', 'sales live in customer_order'));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('near-duplicate (reworded) facts are deduped and hidden once learned', () => {
	const { store, base } = freshStore();
	try {
		// The distiller's first wording, approved by the user.
		const v1 = store.suggest('c1', 'Sales are recorded in customer_order; fulfilled_date is the sale date.');
		store.approve(v1!.id);
		// A later turn rewords the SAME fact — must NOT be proposed again (fuzzy, not exact).
		const v2 = store.suggest('c1', 'Sales are recorded in the customer_order table; fulfilled_date is the sale completion date.');
		assert.equal(v2, null);
		// A genuinely different fact IS still proposed.
		assert.ok(store.suggest('c1', 'prices are stored in cents'));
		// And a suggested note that duplicates an already-active one is hidden from the list.
		store.save(note({ id: 'stale', connectionId: 'c1', status: 'suggested', text: 'sales live in customer_order, fulfilled_date is the sale date' }));
		assert.equal(store.listSuggested('c1').some((n) => n.id === 'stale'), false);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('migrateInstructions folds text into one global note, idempotently', () => {
	const { store, base } = freshStore();
	try {
		assert.equal(store.migrateInstructions('always explain your SQL'), true);
		const globals = store.list('*');
		assert.equal(globals.length, 1);
		assert.equal(globals[0].connectionId, '*');
		assert.equal(globals[0].scope, 'glossary');
		assert.equal(globals[0].text, 'always explain your SQL');
		// The migrated note injects on any connection.
		assert.deepEqual(store.notesFor('anyconn').glossary.map((n) => n.text), ['always explain your SQL']);
		// Re-running is a no-op (no duplicate), even with different text.
		assert.equal(store.migrateInstructions('different now'), false);
		assert.equal(store.list('*').length, 1);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('migrateInstructions with empty text still marks done (no note)', () => {
	const { store, base } = freshStore();
	try {
		assert.equal(store.migrateInstructions('   '), true);
		assert.equal(store.list('*').length, 0);
		assert.equal(store.migrateInstructions('too late'), false);
		assert.equal(store.list('*').length, 0);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

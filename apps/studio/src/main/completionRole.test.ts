/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isCompletionModel, isEmbeddingModel, preferredCompletionModel } from './completionRole';
import type { ModelMeta } from './modelCatalog';

function catalog(entries: Record<string, ModelMeta>): Map<string, ModelMeta> {
	return new Map(Object.entries(entries));
}

test('isCompletionModel trusts the server role when present', () => {
	const c = catalog({ 'snout-fim-1.0': { role: 'completion' }, 'coder-chat-30b': { role: 'chat' } });
	assert.ok(isCompletionModel('snout-fim-1.0', c));
	assert.ok(!isCompletionModel('coder-chat-30b', c));
});

test('isCompletionModel falls back to the hard-coded set when the model is untagged', () => {
	// A model the catalog has no row for (offline / not yet tagged): use the COMPLETION_ONLY_MODELS
	// fallback so classification still works cold. snout-fim-1.0 is in that set; a chat model isn't.
	const empty = catalog({});
	assert.ok(isCompletionModel('snout-fim-1.0', empty));
	assert.ok(!isCompletionModel('coder-chat-30b', empty));
});

test('isEmbeddingModel: the role decides, and untagged only the gateway embedding model is one', () => {
	const c = catalog({ 'mxbai-embed-large': { role: 'embedding' }, 'snout-fim-1.0': { role: 'completion' } });
	assert.ok(isEmbeddingModel('mxbai-embed-large', c));
	assert.ok(!isEmbeddingModel('snout-fim-1.0', c));
	assert.ok(!isCompletionModel('mxbai-embed-large', c));
	const empty = catalog({});
	assert.ok(isEmbeddingModel('mxbai-embed-large', empty));
	assert.ok(!isEmbeddingModel('gpt-5.6-luna', empty));
});

test('preferredCompletionModel picks recommended, then sort_order, then lexical', () => {
	assert.equal(preferredCompletionModel(catalog({})), undefined);
	// recommended wins over a lower sort_order (e.g. a newer finetune marked recommended)
	assert.equal(
		preferredCompletionModel(catalog({
			'snout-fim-1.1': { role: 'completion', recommended: true, sortOrder: 5 },
			'snout-fim-1.0': { role: 'completion', sortOrder: 1 },
		})),
		'snout-fim-1.1',
	);
	// no recommended → lowest sort_order wins
	assert.equal(
		preferredCompletionModel(catalog({
			'b-model': { role: 'completion', sortOrder: 2 },
			'a-model': { role: 'completion', sortOrder: 1 },
		})),
		'a-model',
	);
	// chat-role models are never considered
	assert.equal(
		preferredCompletionModel(catalog({
			'snout-fim-1.0': { role: 'completion' },
			'coder-chat-30b': { role: 'chat' },
		})),
		'snout-fim-1.0',
	);
});

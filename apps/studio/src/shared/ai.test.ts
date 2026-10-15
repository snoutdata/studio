/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYOK_ANTHROPIC_MODELS, COMPLETION_MODEL_RENAMES, DEFAULT_AI_SETTINGS, isCompletionOnlyModel, isReasoningModel, observerModelFor, supportsPromptCaching } from './ai';

// The provider arg is ignored — the model-name heuristic drives everything — so these
// pass model names that arrive via the gateway under the positron-cloud provider id.
test('flags the cross-vendor reasoning families', () => {
	assert.ok(isReasoningModel('positron-cloud', 'o1'));
	assert.ok(isReasoningModel('positron-cloud', 'o3-mini'));
	assert.ok(isReasoningModel('positron-cloud', 'o4-mini'));
	assert.ok(isReasoningModel('positron-cloud', 'deepseek-reasoner'));
	assert.ok(isReasoningModel('ollama', 'deepseek-r1:8b'));
	assert.ok(isReasoningModel('ollama', 'qwq:32b'));
	assert.ok(isReasoningModel('ollama', 'qwen3:8b-thinking'));
});

test('does not flag plain chat / code models', () => {
	assert.ok(!isReasoningModel('positron-cloud', 'gpt-4o'));
	assert.ok(!isReasoningModel('positron-cloud', 'gpt-4o-mini'));
	assert.ok(!isReasoningModel('positron-cloud', 'deepseek-chat'));
	assert.ok(!isReasoningModel('ollama', 'qwen2.5-coder:7b'));
	assert.ok(!isReasoningModel('ollama', 'llama3.1:8b'));
	assert.ok(!isReasoningModel('positron-cloud', 'claude-3-5-sonnet-20241022'));
});

test('is case-insensitive', () => {
	assert.ok(isReasoningModel('positron-cloud', 'O3-MINI'));
	assert.ok(isReasoningModel('ollama', 'DeepSeek-R1'));
});

// The completion model's earlier ids map to snout-fim-1.0, served from Qwen2.5-Coder with
// fill-in-the-middle.
// AiSettingsStore.get() applies COMPLETION_MODEL_RENAMES to a stored completion override so
// existing ai.json files migrate; these assert the rename contract that migration depends on (the store itself imports
// electron's `app` and can't be loaded in a node:test bundle).
test('old FIM ids migrate to the current versioned id', () => {
	assert.equal(COMPLETION_MODEL_RENAMES['qwen2.5-coder-3b'], 'snout-fim-1.0');
	assert.equal(COMPLETION_MODEL_RENAMES['snout-fim-1'], 'snout-fim-1.0');
	// The target of the rename is the current default + a completion-only model.
	assert.equal(DEFAULT_AI_SETTINGS.completion?.model, 'snout-fim-1.0');
	assert.ok(isCompletionOnlyModel('snout-fim-1.0'));
	assert.ok(!isCompletionOnlyModel('qwen2.5-coder-3b'));
});

test('prompt caching is opted into by family, never assumed', () => {
	// The Anthropic models on the gateway: caching is real and worth having.
	assert.ok(supportsPromptCaching('claude-sonnet-5.5'));
	assert.ok(supportsPromptCaching('claude-sonnet-5'));
	assert.ok(supportsPromptCaching('claude-opus-4.8'));
	// The regression this exists for. An OpenAI-family model whose host rejects a cache_control
	// block fails the whole turn with a 500, so a wrong TRUE here
	// costs the user their message rather than a cost saving.
	assert.ok(!supportsPromptCaching('gpt-5.6-luna'));
	// Anything unrecognised stays off: the failure direction matters more than the saving.
	assert.ok(!supportsPromptCaching('coder-chat-30b'));
	assert.ok(!supportsPromptCaching('snout-fim-1.0'));
	assert.ok(!supportsPromptCaching('some-future-model'));
});

test('the knowledge observer is OFF in an open build until the user names a model, and unchanged in the official one', () => {
	const chat = () => 'flagship-chat';
	// Open build: never the chat model behind the user's back.
	assert.equal(observerModelFor(false, 'positron-cloud', '', '', chat), '');
	assert.equal(observerModelFor(false, 'byok-openai', '', '  ', chat), '');
	assert.equal(observerModelFor(false, 'byok-openai', '', 'gpt-small', chat), 'gpt-small');
	assert.equal(DEFAULT_AI_SETTINGS.behavior.observerModel, '');
	// Official build: its own inexpensive gateway model, else the chat model, whatever the setting says.
	assert.equal(observerModelFor(true, 'positron-cloud', 'cheap-observer', 'ignored', chat), 'cheap-observer');
	assert.equal(observerModelFor(true, 'byok-openai', 'cheap-observer', 'ignored', chat), 'flagship-chat');
	assert.equal(observerModelFor(true, 'positron-cloud', '', '', chat), 'flagship-chat');
});

test('the Anthropic models offered for a BYOK key are current ids, none of them retired', () => {
	assert.deepEqual([...BYOK_ANTHROPIC_MODELS], ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
	for (const id of BYOK_ANTHROPIC_MODELS) {
		assert.doesNotMatch(id, /^claude-3|-latest$/, id);
	}
});

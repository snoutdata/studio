/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_REVIEW_METHOD, reviewBoundary, reviewMethodFromLegacy, type ReviewMethod } from './review';

/*
 * The review method: the four rungs, and the sentence each one puts in front of the user.
 *
 * The sentence is the reason this is a function rather than a label on a screen, so it is what is
 * pinned. A rung whose copy says "nothing is sent anywhere" while the code sends it somewhere is
 * this project's worst defect class, and the ollama arm is where it would happen.
 */

describe('reviewMethodFromLegacy', () => {
	test('the rules alone is the default, and an unset profile lands there', () => {
		// Not a preference: a model must never start writing on somebody's pull request, or start
		// spending their allowance, because they updated the app.
		assert.deepEqual(reviewMethodFromLegacy(undefined), DEFAULT_REVIEW_METHOD);
		assert.deepEqual(reviewMethodFromLegacy('off'), { kind: 'deterministic' });
	});

	test('a stored snoutdata keeps its rung exactly', () => {
		assert.deepEqual(reviewMethodFromLegacy('snoutdata'), { kind: 'snoutAi', consent: true });
	});

	test('byok comes forward needing a model, because the old value never recorded one', () => {
		// The lossy one, and deliberately not guessed at: `byok` used to mean "whichever vendor key
		// you already had", with no provider stored anywhere to recover.
		const method = reviewMethodFromLegacy('byok');
		assert.equal(method.kind, 'byok');
		assert.equal(method.kind === 'byok' && method.model, '');
	});
});

describe('reviewBoundary', () => {
	test('the rules alone call nobody, and say so without hedging', () => {
		const { boundary, sentence } = reviewBoundary({ kind: 'deterministic' });
		assert.equal(boundary, 'local');
		assert.match(sentence, /no model is called/i);
	});

	test('the model on this computer is local', () => {
		assert.equal(reviewBoundary({ kind: 'localEngine' }).boundary, 'local');
	});

	test('our AI says it is ours AND that it costs the allowance', () => {
		const { boundary, sentence } = reviewBoundary({ kind: 'snoutAi', consent: true });
		assert.equal(boundary, 'ourServers');
		assert.match(sentence, /our servers/i);
		assert.match(sentence, /allowance/i);
	});

	test('an Ollama on THIS machine is local; the same Ollama on the network is not', () => {
		// The whole reason the boundary is computed. One of these two sentences is a lie if both
		// rungs share a label, and which one depends on a field the label cannot see.
		const here: ReviewMethod = { kind: 'byok', provider: 'ollama', model: 'qwen', host: 'http://127.0.0.1:11434', consent: true };
		const there: ReviewMethod = { kind: 'byok', provider: 'ollama', model: 'qwen', host: 'http://10.0.0.4:11434', consent: true };
		assert.equal(reviewBoundary(here).boundary, 'local');
		assert.equal(reviewBoundary(there).boundary, 'theirNetwork');
		assert.match(reviewBoundary(there).sentence, /10\.0\.0\.4/);
	});

	test('an Ollama with no host stated is this machine, which is what no host means', () => {
		assert.equal(reviewBoundary({ kind: 'byok', provider: 'ollama', model: 'qwen', consent: true }).boundary, 'local');
	});

	test('a vendor key is a third party, and it is NAMED', () => {
		const { boundary, sentence } = reviewBoundary({ kind: 'byok', provider: 'anthropic', model: 'claude', consent: true });
		assert.equal(boundary, 'thirdParty');
		assert.match(sentence, /Anthropic/);
		assert.match(sentence, /do not reach us/i);
	});

	test('every rung that sends anything names WHAT it sends, findings included', () => {
		// "Your files are sent" would be the wrong sentence here: what leaves is somebody's changed
		// SQL and the measurements taken from their database, and a user would not think of either
		// as a file they handed over.
		for (const method of [
			{ kind: 'snoutAi', consent: true } as const,
			{ kind: 'byok', provider: 'openai', model: 'x', consent: true } as const,
			{ kind: 'byok', provider: 'ollama', model: 'x', host: 'http://10.0.0.4:11434', consent: true } as const,
		]) {
			assert.match(reviewBoundary(method).sentence, /findings taken from your database/i, method.kind);
		}
	});

	test('no user-facing sentence carries an em dash', () => {
		// A house rule for UI copy, and this file is UI copy that happens to live in a contract.
		const all: ReviewMethod[] = [
			{ kind: 'deterministic' },
			{ kind: 'localEngine' },
			{ kind: 'snoutAi', consent: true },
			{ kind: 'byok', provider: 'ollama', model: 'x', consent: true },
			{ kind: 'byok', provider: 'openrouter', model: 'x', consent: true },
		];
		for (const method of all) {
			assert.ok(!reviewBoundary(method).sentence.includes('—'), method.kind);
		}
	});
});

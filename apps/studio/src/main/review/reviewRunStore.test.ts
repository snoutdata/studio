/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseRun } from './reviewRunStore';

/*
 * Reading the review history back off disk.
 *
 * The history is a JSON file in the user's profile, which means it is a file somebody can edit, a
 * file written by an older version of the app, and a file that can be half-written when a machine
 * loses power. None of those are the type it is declared as, so every field is checked. The rule
 * throughout: a review that cannot be trusted is DROPPED, never repaired into something plausible,
 * because a review is a record of what was said on somebody's pull request and a guessed one is
 * worse than a missing one.
 */

/** The smallest thing that is still a review. */
function stored(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'acme/api#7@abcdef1~deterministic',
		repoId: 'acme/api',
		prNumber: 7,
		body: '<!-- snoutbot:review v1 -->',
		at: 1_700_000_000_000,
		...extra,
	};
}

describe('normaliseRun', () => {
	test('a review with the four things that identify it is kept', () => {
		const run = normaliseRun(stored());
		assert.ok(run);
		assert.equal(run.id, 'acme/api#7@abcdef1~deterministic');
		assert.equal(run.prNumber, 7);
	});

	test('anything without an id, a repo, a number or a body is DROPPED', () => {
		// Not defaulted. A review with no body is not a review, and a card that opens onto nothing
		// is worse than a history with a hole in it.
		assert.equal(normaliseRun(stored({ id: undefined })), null);
		assert.equal(normaliseRun(stored({ id: '' })), null);
		assert.equal(normaliseRun(stored({ repoId: 42 })), null);
		assert.equal(normaliseRun(stored({ prNumber: '7' })), null);
		assert.equal(normaliseRun(stored({ body: undefined })), null);
	});

	test('the counts a card shows default to zero rather than to undefined', () => {
		// The list prints "1 blocker, 2 warnings". `undefined` there renders as a hole in a
		// sentence; zero is both true and printable, and the summary leaves zeros out anyway.
		const run = normaliseRun(stored());
		assert.deepEqual([run?.blockers, run?.warnings, run?.notes], [0, 0, 0]);
	});

	test('a host it does not recognise is GitHub, and gitlab survives', () => {
		assert.equal(normaliseRun(stored())?.forge, 'github');
		assert.equal(normaliseRun(stored({ forge: 'bitbucket' }))?.forge, 'github');
		assert.equal(normaliseRun(stored({ forge: 'gitlab' }))?.forge, 'gitlab');
	});

	test('awaiting approval is only true when it is exactly true', () => {
		// This one decides whether the tray says something is waiting and whether the view offers
		// to post it. A truthy string must not turn into an offer to comment on a pull request.
		assert.equal(normaliseRun(stored())?.awaitingApproval, false);
		assert.equal(normaliseRun(stored({ awaitingApproval: 'yes' }))?.awaitingApproval, false);
		assert.equal(normaliseRun(stored({ awaitingApproval: true }))?.awaitingApproval, true);
	});

	test('a review written before the rungs existed reads as the rules alone', () => {
		// The honest answer for a history that never recorded a method. Not a guess at what the
		// repository is set to NOW, which is a different question and would be wrong twice: the
		// setting may have changed, and a one-off override was never the setting in the first place.
		assert.deepEqual(normaliseRun(stored())?.method, { kind: 'deterministic' });
		assert.deepEqual(normaliseRun(stored({ method: 'snoutdata' }))?.method, { kind: 'deterministic' });
	});

	test('a stored rung comes back whole, host and all', () => {
		const run = normaliseRun(stored({
			method: { kind: 'byok', provider: 'ollama', model: 'qwen', host: 'http://10.0.0.4:11434' },
		}));
		assert.deepEqual(run?.method, {
			kind: 'byok', provider: 'ollama', model: 'qwen', host: 'http://10.0.0.4:11434', consent: true,
		});
	});

	test('a byok rung naming a provider we do not have falls back rather than being kept', () => {
		// It would otherwise be handed to the resolver, which has no arm for it.
		assert.deepEqual(normaliseRun(stored({ method: { kind: 'byok', provider: 'some-vendor' } }))?.method, { kind: 'deterministic' });
	});

	test('the depth is one of the three, and an unknown one is the most cautious reading', () => {
		// `connected` is the default because that is what the field meant before it was validated,
		// and a history that says "measured" about a review that was measured stays true.
		assert.equal(normaliseRun(stored())?.depth, 'connected');
		assert.equal(normaliseRun(stored({ depth: 'static' }))?.depth, 'static');
		assert.equal(normaliseRun(stored({ depth: 'schema' }))?.depth, 'schema');
		assert.equal(normaliseRun(stored({ depth: 'nonsense' }))?.depth, 'connected');
	});

	test('a repository label falls back to its id, so a card is never nameless', () => {
		assert.equal(normaliseRun(stored())?.repoLabel, 'acme/api');
		assert.equal(normaliseRun(stored({ repoLabel: 'acme/api' }))?.repoLabel, 'acme/api');
	});
});

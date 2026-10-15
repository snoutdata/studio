/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { depthLine, finishedToast, findingsSummary, replacesToast, reviewNotice, runLabel, startedToast } from './reviewRuns';
import type { ReviewRun } from '../../shared/review';

function run(partial: Partial<ReviewRun> = {}): ReviewRun {
	return {
		id: 'acme/api#12@abc1234',
		repoId: 'acme/api',
		forge: 'github',
		repoLabel: 'acme/api',
		prNumber: 12,
		headSha: 'abc1234def',
		body: '<!-- snoutbot:review v1 -->',
		depth: 'connected',
		blockers: 0,
		warnings: 0,
		notes: 0,
		awaitingApproval: false,
		method: { kind: 'deterministic' },
		at: Date.parse('2026-08-28T09:00:00.000Z'),
		...partial,
	};
}

describe('findingsSummary', () => {
	test('leaves out the zero counts rather than saying them', () => {
		assert.equal(findingsSummary({ blockers: 2, warnings: 0, notes: 1 }), '2 blockers, 1 note');
		assert.equal(findingsSummary({ blockers: 1, warnings: 1, notes: 1 }), '1 blocker, 1 warning, 1 note');
	});

	test('a clean review says so in words, not as an empty string', () => {
		assert.equal(findingsSummary({ blockers: 0, warnings: 0, notes: 0 }), 'nothing to flag');
	});
});

describe('depthLine', () => {
	// Never imply the static tier checked the database.
	test('the static tier says the database was not consulted', () => {
		assert.equal(depthLine({ depth: 'static' }), "Read the diff only, the database was not consulted");
		// Even if a destination is somehow named, static did not look at it.
		assert.match(depthLine({ depth: 'static', destinationName: 'staging' }), /not consulted/);
	});

	// Never print a number without what it was measured on.
	test('the deeper tiers name what they were measured on', () => {
		assert.equal(depthLine({ depth: 'connected', destinationName: 'staging' }), 'Measured against staging');
		assert.equal(depthLine({ depth: 'schema', destinationName: 'staging' }), 'Read the schema of staging, ran no queries');
	});

	test('and say so honestly when the destination has no name', () => {
		assert.equal(depthLine({ depth: 'connected' }), "Measured against the bound database");
		assert.equal(depthLine({ depth: 'schema' }), "Read the schema, ran no queries");
	});
});

describe('reviewNotice', () => {
	test('a review waiting for approval always speaks, and says nothing has gone out', () => {
		const notice = reviewNotice(run({ awaitingApproval: true, warnings: 1, destinationName: 'staging' }));
		assert.equal(notice?.severity, 'warn');
		assert.equal(notice?.title, "Snoutbot has a review of acme/api #12 for you to read");
		assert.match(notice!.detail, /Nothing is posted to GitHub until you say so/);
		// The counts never travel without what they were measured on.
		assert.match(notice!.detail, /Measured against staging/);
	});

	test('a clean review that posted itself says nothing at all', () => {
		// It happens on every push to every watched pull request; announcing it teaches people to
		// dismiss the notification that mattered.
		assert.equal(reviewNotice(run()), null);
	});

	test('a blocker is worth interrupting for; warnings and notes are not', () => {
		assert.equal(reviewNotice(run({ blockers: 1 }))?.severity, 'warn');
		assert.equal(reviewNotice(run({ blockers: 2 }))?.title, "Snoutbot found 2 blockers in acme/api #12");
		assert.equal(reviewNotice(run({ warnings: 3 }))?.severity, 'info');
		assert.equal(reviewNotice(run({ notes: 1 }))?.severity, 'info');
	});

	test('a review that broke is an error carrying what broke', () => {
		const notice = reviewNotice(run({ error: 'Bad credentials' }));
		assert.deepEqual([notice?.severity, notice?.detail], ['error', 'Bad credentials']);
	});
});

describe('runLabel', () => {
	test('names the repository and the pull request', () => {
		assert.equal(runLabel({ repoLabel: 'acme/api', prNumber: 7 }), 'acme/api #7');
	});
});

describe('the toast', () => {
	test('a review that started says which one, and never auto-resolves itself', () => {
		const t = startedToast({ repoId: 'acme/api', forge: 'github', repoLabel: 'acme/api', prNumber: 12 });
		assert.equal(t.phase, 'running');
		assert.equal(t.label, 'acme/api #12');
	});

	test('a CLEAN posted review gets a card even though it leaves no notification', () => {
		// The two answers differ on purpose. The centre stays quiet because this happens on every
		// push; the card speaks because somebody who just pressed "Check now" is owed an answer.
		assert.equal(reviewNotice(run()), null);
		const t = finishedToast(run());
		assert.equal(t.phase, 'done');
		assert.deepEqual([t.phase === 'done' && t.text, t.phase === 'done' && t.tone], ['nothing to flag, posted', 'ok']);
	});

	test('a blocker is amber, and an unposted review says it is waiting', () => {
		const blocked = finishedToast(run({ blockers: 2 }));
		assert.equal(blocked.phase === 'done' && blocked.tone, 'warn');
		const waiting = finishedToast(run({ awaitingApproval: true, warnings: 1 }));
		assert.match(waiting.phase === 'done' ? waiting.text : '', /waiting for you to post it/);
		assert.equal(waiting.phase === 'done' && waiting.awaiting, true);
	});

	test('a review that broke is the error, in the card', () => {
		const t = finishedToast(run({ error: 'Bad credentials' }));
		assert.deepEqual([t.phase === 'done' && t.text, t.phase === 'done' && t.tone], ['Bad credentials', 'error']);
	});

	test('a result is never overwritten by its own start arriving late', () => {
		// A fast review can finish before the renderer has drawn the running card, and putting the
		// spinner back over the answer is the one ordering that reads as a hang.
		const done = finishedToast(run());
		const started = startedToast({ repoId: 'acme/api', forge: 'github', repoLabel: 'acme/api', prNumber: 12 });
		assert.equal(replacesToast(done, started), false);
		// A DIFFERENT review starting does replace it, and the result always replaces the spinner.
		assert.equal(replacesToast(done, startedToast({ repoId: 'a/b', forge: 'github', repoLabel: 'a/b', prNumber: 1 })), true);
		assert.equal(replacesToast(started, done), true);
		assert.equal(replacesToast(null, done), true);
	});
});

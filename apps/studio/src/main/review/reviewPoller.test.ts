/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewCommand } from '@snout/review-core';

import type { Forge, ForgeAuthor, IssueComment, PullRequestRef } from './forge';
import { ReviewPoller } from './reviewPoller';
import type { ReviewRunner } from './reviewRunner';
import type { ReviewStore, WatchedRepo } from './reviewStore';

/*
 * Who may make the reviewer act.
 *
 * A review reads the database bound to the repository and posts under the user's own name. So a
 * review command is obeyed only from somebody who can WRITE to the repository, and a pull request
 * is reviewed without being asked only when it comes from inside the repository or from somebody
 * who can write there, unless the user turned outsiders on for that repository. Everybody else is
 * ignored without a reply.
 */

function repo(extra: Partial<WatchedRepo> = {}): WatchedRepo {
	return {
		id: 'acme/api',
		forge: 'github',
		owner: 'acme',
		name: 'api',
		connectionId: 'c1',
		auto: 'always',
		depth: 'connected',
		approveBeforePosting: false,
		method: { kind: 'deterministic' },
		reviewOutsiders: false,
		enabled: true,
		...extra,
	} as WatchedRepo;
}

function pr(number: number, extra: Partial<PullRequestRef> = {}): PullRequestRef {
	return {
		number,
		title: `PR ${number}`,
		headSha: `sha${number}`,
		baseRef: 'main',
		draft: false,
		authorLogin: 'insider',
		authorIsBot: false,
		fromFork: false,
		updatedAt: '2026-10-14T10:00:00Z',
		htmlUrl: `https://github.com/acme/api/pull/${number}`,
		...extra,
	};
}

function comment(id: number, login: string, body: string, extra: Partial<IssueComment> = {}): IssueComment {
	return {
		id,
		body,
		authorLogin: login,
		authorIsBot: false,
		createdAt: '2026-10-14T10:00:00Z',
		updatedAt: '2026-10-14T10:00:00Z',
		htmlUrl: '',
		...extra,
	};
}

interface Harness {
	poller: ReviewPoller;
	runs: { pr: number; command: ReviewCommand; commentId?: number }[];
	helps: number[];
	asked: ForgeAuthor[];
	/** Head sha of every "it changed since" note the runner was asked to post. */
	moved: string[];
}

interface HarnessOptions {
	/** What the host says about when the head arrived. Default: well before every comment, as
	 *  GitLab would; `null` is a host with no record, as GitHub. */
	headSince?: string | null;
}

function harness(watched: WatchedRepo, pulls: PullRequestRef[], comments: Record<number, IssueComment[]>, writers: string[], options: HarnessOptions = {}): Harness {
	const runs: Harness['runs'] = [];
	const helps: number[] = [];
	const asked: ForgeAuthor[] = [];
	const moved: string[] = [];
	const store = {
		activeRepos: () => [watched],
		loginFor: () => 'me',
		alreadyReviewed: () => false,
		recordPoll: (_id: string, _at: number, _cursor?: string, heads?: WatchedRepo['heads']) => {
			watched.heads = heads;
		},
		recordReviewed: () => undefined,
		isEnabled: () => true,
		config: () => ({ pollSeconds: 60 }),
	} as unknown as ReviewStore;
	const runner = {
		run: async (_r: WatchedRepo, p: PullRequestRef, command: ReviewCommand, commentId?: number) => {
			runs.push({ pr: p.number, command, commentId });
			return {};
		},
		postHelp: async (_r: WatchedRepo, n: number) => {
			helps.push(n);
			return 1;
		},
		postMoved: async (_r: WatchedRepo, _n: number, sha: string) => {
			moved.push(sha);
			return 1;
		},
	} as unknown as ReviewRunner;
	const forge = {
		kind: 'github',
		openPullRequests: async () => pulls,
		comments: async (_o: string, _n: string, number: number) => comments[number] ?? [],
		canWrite: async (_o: string, _n: string, author: ForgeAuthor) => {
			asked.push(author);
			return writers.includes(author.login);
		},
		headSince: async () => (options.headSince === null ? undefined : options.headSince ?? '2026-10-14T09:00:00Z'),
	} as unknown as Forge;
	const poller = new ReviewPoller({ store, runner, forge: async () => forge });
	return { poller, runs, helps, asked, moved };
}

describe('review commands are obeyed only from people who can write to the repository', () => {
	test("a stranger's `@snoutbot review --on prod` is ignored, and nothing is said back", async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1, { fromFork: true, authorLogin: 'stranger' })], {
			1: [comment(10, 'stranger', '@snoutbot review --on prod')],
		}, ['maintainer']);
		const actions = await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
		assert.deepEqual(h.helps, []);
		assert.deepEqual(actions, []);
	});

	test('a stranger asking for help is ignored too', async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1)], { 1: [comment(10, 'stranger', '@snoutbot help')] }, []);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.helps, []);
	});

	test("a maintainer's command runs, with the comment it answers", async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1)], { 1: [comment(11, 'maintainer', '@snoutbot review --deep')] }, ['maintainer']);
		await h.poller.pollOnce(true);
		assert.equal(h.runs.length, 1);
		assert.equal(h.runs[0].commentId, 11);
		assert.equal(h.runs[0].command.deep, true);
	});

	test("a stranger's newer comment does not hide a maintainer's older one", async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1)], {
			1: [comment(11, 'maintainer', '@snoutbot review'), comment(12, 'stranger', '@snoutbot review --on prod')],
		}, ['maintainer']);
		await h.poller.pollOnce(true);
		assert.equal(h.runs.length, 1);
		assert.equal(h.runs[0].commentId, 11);
		assert.equal(h.runs[0].command.destination, undefined);
	});

	test('what the host told us about the commenter reaches the permission check', async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1)], {
			1: [comment(11, 'maintainer', '@snoutbot review', { authorId: 42, authorAssociation: 'MEMBER' })],
		}, ['maintainer']);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.asked[0], { login: 'maintainer', id: 42, association: 'MEMBER' });
	});
});

describe('automatic reviews are for changes from inside the repository', () => {
	test('a branch in the repository is reviewed without asking anybody anything', async () => {
		const h = harness(repo(), [pr(1)], {}, []);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs.map((r) => r.pr), [1]);
		assert.deepEqual(h.asked, []);
	});

	test("a stranger's fork is not reviewed automatically", async () => {
		const h = harness(repo(), [pr(2, { fromFork: true, authorLogin: 'stranger' })], {}, ['maintainer']);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
	});

	test('on the default, sql-only, either', async () => {
		const h = harness(repo({ auto: 'sql-only' }), [pr(2, { fromFork: true, authorLogin: 'stranger' })], {}, []);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
	});

	test('a fork opened by somebody who can write here is reviewed', async () => {
		const h = harness(repo(), [pr(3, { fromFork: true, authorLogin: 'maintainer' })], {}, ['maintainer']);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs.map((r) => r.pr), [3]);
	});

	test('outsiders are reviewed when the user turned that on for this repository', async () => {
		const h = harness(repo({ reviewOutsiders: true }), [pr(2, { fromFork: true, authorLogin: 'stranger' })], {}, []);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs.map((r) => r.pr), [2]);
	});

	test('the permission answer is remembered, so a quiet fork does not cost a call per poll', async () => {
		const h = harness(repo(), [pr(2, { fromFork: true, authorLogin: 'stranger' })], {}, []);
		await h.poller.pollOnce(true);
		await h.poller.pollOnce(true);
		assert.equal(h.asked.length, 1);
	});
});

describe('a review command is bound to the commit that was there when it was written', () => {
	const ask = (at: string) => ({ 1: [comment(11, 'maintainer', '@snoutbot review', { createdAt: at, updatedAt: at })] });

	test('a push the host records after the comment is not reviewed, and the note is said once', async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1, { fromFork: true, authorLogin: 'stranger' })], ask('2026-01-14T10:00:00Z'), ['maintainer'], {
			headSince: '2026-01-14T10:05:00Z',
		});
		const actions = await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
		assert.equal(actions[0].ran, false);
		assert.deepEqual(h.moved, ['sha1']);
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
		assert.deepEqual(h.moved, ['sha1']);
	});

	test('a head the host records before the comment is reviewed', async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1, { fromFork: true })], ask('2026-01-14T10:00:00Z'), ['maintainer'], {
			headSince: '2026-01-14T09:59:00Z',
		});
		await h.poller.pollOnce(true);
		assert.equal(h.runs.length, 1);
		assert.deepEqual(h.moved, []);
	});

	test('with no host record, a head no poll saw before the comment is not reviewed', async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1, { fromFork: true })], ask('2026-01-14T10:00:00Z'), ['maintainer'], { headSince: null });
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
		assert.deepEqual(h.moved, ['sha1']);
	});

	test('with no host record, a head a poll saw before the comment is reviewed', async () => {
		const watched = repo({ auto: 'mention', heads: { 1: { sha: 'sha1', since: '2026-01-14T09:00:00.000Z' } } });
		const h = harness(watched, [pr(1, { fromFork: true })], ask('2026-01-14T10:00:00Z'), ['maintainer'], { headSince: null });
		await h.poller.pollOnce(true);
		assert.equal(h.runs.length, 1);
		assert.deepEqual(watched.heads?.['1'], { sha: 'sha1', since: '2026-01-14T09:00:00.000Z' });
	});

	test('a force push to a head the poll had not seen starts the clock again', async () => {
		const watched = repo({ auto: 'mention', heads: { 1: { sha: 'old', since: '2026-01-14T09:00:00.000Z' } } });
		const h = harness(watched, [pr(1, { fromFork: true })], ask('2026-01-14T10:00:00Z'), ['maintainer'], { headSince: null });
		await h.poller.pollOnce(true);
		assert.deepEqual(h.runs, []);
		assert.equal(watched.heads?.['1'].sha, 'sha1');
		assert.ok(Date.parse(watched.heads?.['1'].since ?? '') > Date.parse('2026-01-14T10:00:00Z'));
	});

	test('help is not a review, so it is answered whatever the head', async () => {
		const h = harness(repo({ auto: 'mention' }), [pr(1)], { 1: [comment(10, 'maintainer', '@snoutbot help')] }, ['maintainer'], { headSince: null });
		await h.poller.pollOnce(true);
		assert.deepEqual(h.helps, [1]);
		assert.deepEqual(h.moved, []);
	});
});

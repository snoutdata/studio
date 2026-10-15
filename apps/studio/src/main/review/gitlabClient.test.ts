/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleDiff, gitlabFromFork, gitlabHeadSince, isBotAuthor, isDraft } from './gitlabClient';
import { splitProjectPath } from './forge';
import { parseRepoRef } from './reviewStore';

/*
 * The parts of the GitLab client that can be wrong SILENTLY.
 *
 * A wrong URL or a bad token fails loudly on the first call and the hand test finds it. These
 * four cannot: a diff assembled slightly wrong parses into the wrong line numbers, a draft not
 * recognised means commenting on work in progress, a bot not recognised means answering another
 * bot, and a project path split wrongly means watching a repository that does not exist. All
 * four are pure, so they are tested here rather than discovered on somebody's GitLab.
 */

describe('assembleDiff', () => {
	// GitLab returns per-file hunks and no headers; review-core's diff reader is the same code
	// for both hosts, so what comes out of here has to be a real unified diff.
	test('a modified file gets the headers GitLab leaves out', () => {
		const diff = assembleDiff([
			{ old_path: 'db/migrate/007.sql', new_path: 'db/migrate/007.sql', diff: '@@ -1,2 +1,3 @@\n context\n+DROP TABLE legacy;\n' },
		]);
		assert.equal(diff, [
			'diff --git a/db/migrate/007.sql b/db/migrate/007.sql',
			'--- a/db/migrate/007.sql',
			'+++ b/db/migrate/007.sql',
			'@@ -1,2 +1,3 @@',
			' context',
			'+DROP TABLE legacy;',
			'',
		].join('\n'));
	});

	test('a new file says /dev/null on the left, a deleted one on the right', () => {
		const added = assembleDiff([{ new_path: 'a.sql', new_file: true, diff: '@@ -0,0 +1 @@\n+SELECT 1;\n' }]);
		assert.match(added, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/a\.sql/);
		const gone = assembleDiff([{ old_path: 'b.sql', deleted_file: true, diff: '@@ -1 +0,0 @@\n-SELECT 1;\n' }]);
		assert.match(gone, /deleted file mode 100644\n--- a\/b\.sql\n\+\+\+ \/dev\/null/);
	});

	test('a change with no content is left out rather than emitted headerless', () => {
		// A pure rename or a mode change. An entry with no hunk would produce a file header with
		// nothing under it, which the diff reader would read as a file that changed nothing.
		assert.equal(assembleDiff([{ old_path: 'a.sql', new_path: 'b.sql', renamed_file: true, diff: '' }]), '');
		assert.equal(assembleDiff([]), '');
	});

	test('several files run together as one diff', () => {
		const diff = assembleDiff([
			{ old_path: 'a.sql', new_path: 'a.sql', diff: '@@ -1 +1 @@\n-SELECT 1;\n+SELECT 2;\n' },
			{ old_path: 'b.sql', new_path: 'b.sql', diff: '@@ -1 +1 @@\n-SELECT 3;\n+SELECT 4;\n' },
		]);
		assert.equal(diff.match(/^diff --git/gm)?.length, 2);
	});
});

describe('isDraft', () => {
	test('all three ways GitLab says draft mean the same thing', () => {
		// `draft` is current, `work_in_progress` is what older instances send, and plenty of teams
		// only ever put it in the title. The reviewer stays quiet for all three.
		assert.equal(isDraft({ draft: true, title: 'Add orders index' }), true);
		assert.equal(isDraft({ work_in_progress: true, title: 'Add orders index' }), true);
		assert.equal(isDraft({ title: 'Draft: add orders index' }), true);
		assert.equal(isDraft({ title: 'WIP: add orders index' }), true);
	});

	test('a finished merge request is not a draft', () => {
		assert.equal(isDraft({ title: 'Add orders index' }), false);
		assert.equal(isDraft({ draft: false, title: 'Redraft the schema' }), false);
	});
});

describe('isBotAuthor', () => {
	test('a flagged bot and a project access token both count', () => {
		assert.equal(isBotAuthor({ username: 'renovate', bot: true }), true);
		// A project or group access token acts as a user named like this, and nothing flags it.
		assert.equal(isBotAuthor({ username: 'project_1234_bot' }), true);
		assert.equal(isBotAuthor({ username: 'group_9_bot2' }), true);
	});

	test('a person whose name merely contains the letters is not a bot', () => {
		assert.equal(isBotAuthor({ username: 'abbott' }), false);
		assert.equal(isBotAuthor({ username: 'robotics-jane' }), false);
		assert.equal(isBotAuthor(undefined), false);
	});
});

describe('splitProjectPath', () => {
	test('a nested group keeps its whole path as the owner', () => {
		// The one shape GitHub never has. `acme/backend` is the group, `api` the project.
		assert.deepEqual(splitProjectPath('acme/backend/api'), { owner: 'acme/backend', name: 'api' });
		assert.deepEqual(splitProjectPath('acme/api'), { owner: 'acme', name: 'api' });
	});

	test('anything without both halves is refused', () => {
		assert.equal(splitProjectPath('api'), undefined);
		assert.equal(splitProjectPath('/api'), undefined);
		assert.equal(splitProjectPath(''), undefined);
	});
});

describe('parseRepoRef', () => {
	test('a plain path, on either host', () => {
		assert.deepEqual(parseRepoRef('acme/api'), { owner: 'acme', name: 'api' });
		assert.deepEqual(parseRepoRef('acme/backend/api'), { owner: 'acme/backend', name: 'api' });
	});

	test('a browser URL from any host, self-hosted GitLab included', () => {
		assert.deepEqual(parseRepoRef('https://github.com/acme/api'), { owner: 'acme', name: 'api' });
		assert.deepEqual(parseRepoRef('https://gitlab.com/acme/backend/api'), { owner: 'acme/backend', name: 'api' });
		// The host is deliberately not matched: a company instance is the whole point.
		assert.deepEqual(parseRepoRef('https://gitlab.internal.acme.com/team/api'), { owner: 'team', name: 'api' });
	});

	test('a URL pointing at a page inside the repository still names the repository', () => {
		assert.deepEqual(parseRepoRef('https://github.com/acme/api/pull/7'), { owner: 'acme', name: 'api' });
		// GitLab hangs its own pages off `/-/`.
		assert.deepEqual(parseRepoRef('https://gitlab.com/acme/api/-/merge_requests/7'), { owner: 'acme', name: 'api' });
		assert.deepEqual(parseRepoRef('https://gitlab.com/acme/group/api/-/tree/main'), { owner: 'acme/group', name: 'api' });
	});

	test('git remotes, both kinds', () => {
		assert.deepEqual(parseRepoRef('git@gitlab.com:acme/backend/api.git'), { owner: 'acme/backend', name: 'api' });
		assert.deepEqual(parseRepoRef('https://github.com/acme/api.git'), { owner: 'acme', name: 'api' });
	});

	test('a scheme-less host is not mistaken for an owner', () => {
		// `gitlab.acme.com/team/api` is a host and two segments, not a nested group.
		assert.deepEqual(parseRepoRef('gitlab.acme.com/team/api'), { owner: 'team', name: 'api' });
	});

	test('nonsense is refused rather than watched', () => {
		assert.equal(parseRepoRef(''), undefined);
		assert.equal(parseRepoRef('api'), undefined);
		assert.equal(parseRepoRef('not a repo'), undefined);
	});
});

describe('gitlabFromFork', () => {
	// An automatic review runs the change's SQL past the bound database, so a merge request from
	// another project (anybody's fork) is not reviewed on its own unless its author can write here.
	test('a branch in the same project is not a fork', () => {
		assert.equal(gitlabFromFork({ source_project_id: 7, target_project_id: 7 }), false);
	});

	test('another project is a fork, and so is one the host did not name', () => {
		assert.equal(gitlabFromFork({ source_project_id: 9, target_project_id: 7 }), true);
		assert.equal(gitlabFromFork({ target_project_id: 7 }), true);
	});
});

describe('gitlabHeadSince', () => {
	// What binds `@snoutbot review` to the commit it was written about on GitLab: the push that
	// made this sha the head, by GitLab's clock, never a commit date its author chose.
	test('the head arrived with the newest version', () => {
		const versions = [
			{ head_commit_sha: 'b', created_at: '2026-10-14T10:05:00Z' },
			{ head_commit_sha: 'a', created_at: '2026-10-14T09:00:00Z' },
		];
		assert.equal(gitlabHeadSince(versions, 'b'), '2026-10-14T10:05:00Z');
	});

	test('a head pushed back again counts from the push that brought it back', () => {
		const versions = [
			{ head_commit_sha: 'a', created_at: '2026-10-14T09:00:00Z' },
			{ head_commit_sha: 'a', created_at: '2026-10-14T11:00:00Z' },
			{ head_commit_sha: 'b', created_at: '2026-10-14T10:00:00Z' },
		];
		assert.equal(gitlabHeadSince(versions, 'a'), '2026-10-14T11:00:00Z');
	});

	test('a head GitLab has not recorded yet has no time', () => {
		assert.equal(gitlabHeadSince([{ head_commit_sha: 'a', created_at: '2026-10-14T09:00:00Z' }], 'b'), undefined);
		assert.equal(gitlabHeadSince([], 'a'), undefined);
	});
});

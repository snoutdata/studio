/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { associationCanWrite, checkedRepoPath, ForgeError, githubFromFork, githubWriteRole } from './forge';

/*
 * A pull request's file paths are the PR author's to choose, and both clients build a URL from
 * one that carries the user's token. The URL parser resolves `..`, so a path is checked first.
 */

describe('checkedRepoPath', () => {
	test('the reason it exists: `..` survives encoding and the URL parser resolves it', () => {
		const path = '../../../../user';
		const built = `https://api.github.com/repos/o/r/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
		assert.equal(new URL(built).pathname, '/user');
		assert.throws(() => checkedRepoPath(path), ForgeError);
	});

	test('ordinary repository paths pass unchanged', () => {
		for (const path of ['db/migrate/001.sql', 'a b/c%20d.sql', 'migrations/..sql', 'x/.hidden/y.sql', 'ünïcode/q.sql']) {
			assert.equal(checkedRepoPath(path), path);
		}
	});

	test('dot segments, empty segments, absolute paths and control characters are refused', () => {
		for (const path of [
			'..',
			'.',
			'db/../../user',
			'db/./x.sql',
			'db\\..\\..\\user',
			'db//x.sql',
			'/etc/passwd',
			'\\x.sql',
			'C:/x.sql',
			'db/x.sql\n',
			'db/\u0000x.sql',
			'db/\u007fx.sql',
			'',
			'a/'.repeat(3000),
		]) {
			assert.throws(() => checkedRepoPath(path), ForgeError, JSON.stringify(path));
		}
	});
});

describe('githubWriteRole: who may command the reviewer', () => {
	test('write, maintain and admin may', () => {
		for (const role_name of ['write', 'maintain', 'admin']) {
			assert.equal(githubWriteRole({ role_name }), true, role_name);
		}
	});

	test('triage and read may not, even though the old field folds triage into read and maintain into write', () => {
		assert.equal(githubWriteRole({ role_name: 'triage', permission: 'read' }), false);
		assert.equal(githubWriteRole({ role_name: 'read', permission: 'read' }), false);
		assert.equal(githubWriteRole({ permission: 'none' }), false);
		assert.equal(githubWriteRole({}), false);
	});

	test("an organization's custom role is judged by its base permission", () => {
		assert.equal(githubWriteRole({ role_name: 'release-manager', permission: 'write' }), true);
		assert.equal(githubWriteRole({ role_name: 'auditor', permission: 'read' }), false);
	});
});

describe('githubFromFork', () => {
	test('a branch in the same repository is not a fork, whatever the case', () => {
		assert.equal(githubFromFork({ head: { repo: { full_name: 'Acme/api' } }, base: { repo: { full_name: 'acme/api' } } }), false);
	});

	test('another repository, a deleted fork, or no answer at all is a fork', () => {
		assert.equal(githubFromFork({ head: { repo: { full_name: 'stranger/api' } }, base: { repo: { full_name: 'acme/api' } } }), true);
		assert.equal(githubFromFork({ head: { repo: null }, base: { repo: { full_name: 'acme/api' } } }), true);
		assert.equal(githubFromFork({ head: {}, base: {} }), true);
	});
});

describe('associationCanWrite (the fallback when the permission API cannot be asked)', () => {
	test('only the repository owner passes', () => {
		assert.equal(associationCanWrite('OWNER'), true);
		assert.equal(associationCanWrite('owner'), true);
	});

	test('an organisation member or an outside collaborator does not: neither proves write access', () => {
		for (const association of ['MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '']) {
			assert.equal(associationCanWrite(association), false, association);
		}
		assert.equal(associationCanWrite(undefined), false);
	});
});

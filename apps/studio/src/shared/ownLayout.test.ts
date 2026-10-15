/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNTS_VOCABULARY, CLOUD_VOCABULARY, DB_LAYOUT_SQL, keyHeader, LOCAL_VOCABULARY, platformSql, prefix, stackVocabulary, vocabularyFor, wirePath } from './ownLayout';

test('every path Studio sends, in the earlier layout', () => {
	const cases: Array<[string, string]> = [
		['/v1/identity/operator/people', '/auth/v1/admin/users'],
		['/v1/identity/operator/people?page=1&per_page=1', '/auth/v1/admin/users?page=1&per_page=1'],
		['/v1/identity/operator/people/abc', '/auth/v1/admin/users/abc'],
		['/v1/files/space', '/storage/v1/bucket'],
		['/v1/files/space/avatars/empty', '/storage/v1/bucket/avatars/empty'],
		['/v1/files/file/avatars/a%20b.png', '/storage/v1/object/avatars/a%20b.png'],
		['/v1/files/file/list/avatars', '/storage/v1/object/list/avatars'],
		// A space named like a route word is still a space.
		['/v1/files/file/member/x.png', '/storage/v1/object/member/x.png'],
		['/v1/files/file/signed/x.png', '/storage/v1/object/signed/x.png'],
		['/v1/data/notes?select=*&limit=5', '/rest/v1/notes?select=*&limit=5'],
		['/v1/data/', '/rest/v1/'],
		['/v1/graph', '/graphql/v1'],
		['/v1/live/signal', '/realtime/v1/api/broadcast'],
		['/v1/live/websocket', '/realtime/v1/websocket'],
		['/v1/fn/hello', '/functions/v1/hello'],
		['/v1/identity/provider/return', '/auth/v1/callback'],
	];
	for (const [ours, earlier] of cases) {
		assert.equal(wirePath(ours, 'old'), earlier, ours);
		assert.equal(wirePath(ours, 'new'), ours, ours);
	}
});

test('only a whole segment is translated', () => {
	assert.equal(wirePath('/v1/datastore/x', 'old'), '/v1/datastore/x');
	assert.equal(wirePath('/v1/files/spaces', 'old'), '/storage/v1/spaces');
	assert.equal(wirePath('/v1/files/filex/a', 'old'), '/storage/v1/filex/a');
	// Anything not ours is left for the caller's allowlist to refuse.
	assert.equal(wirePath('/rest/v1/notes', 'old'), '/rest/v1/notes');
	assert.equal(wirePath('http://evil/v1/data/', 'old'), 'http://evil/v1/data/');
});

test('prefixes and the key header, both ways', () => {
	assert.equal(prefix('data', 'new'), '/v1/data');
	assert.equal(prefix('data', 'old'), '/rest/v1');
	assert.equal(prefix('fn', 'old'), '/functions/v1');
	assert.equal(keyHeader('new'), 'Snout-Key');
	assert.equal(keyHeader('old'), 'apikey');
});

test('every door is spoken to in our names, and a local project in its own stack\'s', () => {
	// The control plane and the fleet serve the new names since 2026-10-15, and so does the stack
	// Studio pins (snout-stack 0.1.7).
	assert.equal(ACCOUNTS_VOCABULARY, 'new');
	assert.equal(CLOUD_VOCABULARY, 'new');
	assert.equal(LOCAL_VOCABULARY, 'new');
	assert.equal(vocabularyFor('local'), LOCAL_VOCABULARY);
	assert.equal(vocabularyFor('local', 'old'), 'old');
	assert.equal(vocabularyFor('cloud', 'old'), CLOUD_VOCABULARY);
});

test('a snout-stack before 0.1.6 serves only the earlier names', () => {
	for (const tag of ['0.1.0', '0.1.4', '0.1.5', '0.0.9']) {
		assert.equal(stackVocabulary(tag), 'old', tag);
	}
	for (const tag of ['0.1.6', '0.1.7', '0.1.10', '0.2.0', '1.0.0']) {
		assert.equal(stackVocabulary(tag), 'new', tag);
	}
	for (const tag of [null, undefined, '', 'latest', '0.1.7-rc1']) {
		assert.equal(stackVocabulary(tag), LOCAL_VOCABULARY, String(tag));
	}
});

test("the platform's tables are spelled for the database's own layout", () => {
	const sql = 'select u.id from snout_identity.people u join snout_identity.provider_links l on l.user_id = u.id, snout_files.files o, snout_files.spaces b, snout_live.listeners s';
	assert.equal(platformSql(sql, 'new'), sql);
	assert.equal(platformSql(sql, 'old'), 'select u.id from auth.users u join auth.identities l on l.user_id = u.id, storage.objects o, storage.buckets b, realtime.subscription s');
	// A longer name, a quoted one or a column of the same spelling is left alone.
	assert.equal(platformSql('select 1 from snout_identity.peoples, "snout_identity.people", x.snout_files.files', 'old'), 'select 1 from snout_identity.peoples, "snout_identity.people", x.snout_files.files');
	assert.match(DB_LAYOUT_SQL, /to_regnamespace\('snout_identity'\)/);
});

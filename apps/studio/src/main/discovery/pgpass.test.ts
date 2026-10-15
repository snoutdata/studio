/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePgpass } from './pgpass';
import { fixtureBytes } from './testFixtures';

const found = parsePgpass('/home/me/.pgpass', fixtureBytes('pgpass').toString('utf8'));

test('entries become connections with their passwords; wildcard hosts and users are skipped', () => {
	assert.equal(found.length, 3, 'the *:*:*:postgres line and the short line are skipped');
	const app = found[0];
	assert.deepEqual([app.values.host, app.values.port, app.values.database, app.values.username, app.values.password], ['localhost', 5432, 'app', 'app_user', 's3cr3t']);
	assert.equal(app.importsPassword, true);
	assert.equal(app.sourceName, 'app_user@localhost/app');
});

test('escapes are undone, a wildcard port is 5432, a wildcard database is none', () => {
	const reader = found[1];
	assert.equal(reader.values.password, 'with:colon\\slash');
	assert.equal(reader.values.port, 5432);
	assert.equal(reader.values.database, undefined);
	assert.match(reader.note ?? '', /default/);
});

test('a socket entry is listed but not importable', () => {
	const socket = found[2];
	assert.equal(socket.supported, false);
	assert.equal(socket.importsPassword, false);
});

test('the ref is the entry without its password', () => {
	assert.equal(found[0].ref.connId, 'localhost:5432:app:app_user');
	assert.ok(!found[0].ref.connId.includes('s3cr3t'));
});

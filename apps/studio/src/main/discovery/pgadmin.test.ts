/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePgadminRows, parsePgadminServersJson } from './pgadmin';
import { fixtureBytes } from './testFixtures';

test('server rows: old ssl_mode column and new connection_params both read', () => {
	const found = parsePgadminRows('pgadmin4.db', [
		{ id: 1, name: 'Old', host: 'db1', port: 5432, maintenance_db: 'postgres', username: 'postgres', ssl_mode: 'require', password: 'ENCRYPTED' },
		{ id: 2, name: 'New', host: 'db2', port: 5433, maintenance_db: 'app', username: 'me', connection_params: '{"sslmode":"verify-full"}', use_ssh_tunnel: 1, tunnel_host: 'jump', tunnel_port: 2222, tunnel_username: 'u', tunnel_identity_file: '/k' },
		{ id: 3, name: 'Service', host: null, port: 5432, service: 'reporting' },
	]);
	const [old, fresh, svc] = found;
	assert.deepEqual([old.values.ssl, old.values.sslMode, old.values.password], [true, 'insecure', undefined], 'the encrypted password is never taken');
	assert.equal(old.importsPassword, false);
	assert.match(old.note ?? '', /master password/);
	assert.deepEqual([fresh.values.port, fresh.values.sslMode, fresh.ref.connId], [5433, 'system', '2']);
	assert.deepEqual(fresh.values.ssh, { host: 'jump', port: 2222, username: 'u', privateKeyPath: '/k', keepAlive: true });
	assert.equal(svc.supported, false);
	assert.match(svc.note ?? '', /reporting/);
});

test('servers.json export', () => {
	const found = parsePgadminServersJson('servers.json', fixtureBytes('pgadmin-servers.json').toString('utf8'));
	assert.equal(found.length, 3);
	assert.deepEqual([found[0].sourceName, found[0].values.ssl], ['Local Postgres', false], 'prefer is not a promise of TLS');
	assert.equal(found[1].values.ssh?.host, 'bastion.example.com');
	assert.equal(found[1].values.sslMode, 'insecure');
	assert.equal(found[2].supported, false);
	assert.deepEqual(parsePgadminServersJson('x', 'nope'), []);
});

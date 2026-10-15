/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseWorkbenchXml } from './mysqlWorkbench';
import { fixtureBytes } from './testFixtures';

const found = parseWorkbenchXml('connections.xml', fixtureBytes('workbench-connections.xml').toString('utf8'));

test('reads every db.mgmt.Connection, through the nested parameterValues dict', () => {
	assert.equal(found.length, 3);
	const local = found[0];
	assert.equal(local.sourceName, "Local instance 3306");
	assert.equal(local.values.host, '127.0.0.1');
	assert.equal(local.values.port, 3306);
	assert.equal(local.values.database, 'shop');
	assert.equal(local.values.username, 'root');
	assert.equal(local.values.ssl, false, '"if available" is not a promise of TLS');
	assert.equal(local.ref.connId, '7C4B1A2E-1111-4B4B-9C0D-000000000001');
	assert.equal(local.importsPassword, false);
});

test('an SSH connection carries the tunnel, and useSSL 4 verifies', () => {
	const ssh = found[1];
	assert.equal(ssh.sourceName, "Prod & replica (via bastion)");
	assert.equal(ssh.values.database, undefined, 'an empty schema is no database');
	assert.deepEqual(ssh.values.ssh, { host: 'bastion.example.com', port: 2222, username: 'deploy', privateKeyPath: '/Users/dev/.ssh/id_ed25519', keepAlive: true });
	assert.equal(ssh.values.ssl, true);
	assert.equal(ssh.values.sslMode, 'system');
});

test('a socket connection is imported as TCP on localhost, and says so', () => {
	const socket = found[2];
	assert.equal(socket.values.host, 'localhost');
	assert.equal(socket.values.port, 3306);
	assert.equal(socket.supported, true);
	assert.match(socket.note ?? '', /socket/);
});

test('garbage is no connections, not a throw', () => {
	assert.deepEqual(parseWorkbenchXml('x', '<data><value type="list"'), []);
	assert.deepEqual(parseWorkbenchXml('x', 'not xml at all'), []);
});

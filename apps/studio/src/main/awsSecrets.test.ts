/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConnectionConfig } from '../shared/connection';
import { mergeSecretFields } from './awsSecrets';

function connection(over: Partial<ConnectionConfig>): ConnectionConfig {
	return { id: 'c1', label: 'Orders', driver: 'postgres', host: '', port: 0, username: '', ...over } as ConnectionConfig;
}

const RDS = { username: 'app', password: 'pw', host: 'orders.abc123.us-east-1.rds.amazonaws.com', port: 5432, database: 'orders' };

describe('where a secret\'s credentials are sent', () => {
	test('a secret that names a host is where the credentials go, port included', () => {
		const merged = mergeSecretFields(connection({ port: 6543 }), RDS, 'prod/orders');
		assert.equal(merged.host, RDS.host);
		assert.equal(merged.port, 5432);
		assert.equal(merged.username, 'app');
		assert.equal(merged.password, 'pw');
		assert.equal(merged.database, 'orders');
	});

	test('a connection that names a different host is refused, not redirected', () => {
		assert.throws(
			() => mergeSecretFields(connection({ host: 'collector.attacker.example', port: 5432, ssl: false }), RDS, 'prod/orders'),
			/secret "prod\/orders" is for the database at "orders\.abc123[^"]*", but this connection points at "collector\.attacker\.example"/,
		);
	});

	test('the same host, written differently, is the same host', () => {
		const merged = mergeSecretFields(connection({ host: ' Orders.ABC123.us-east-1.rds.amazonaws.com. ', port: 5432 }), RDS, 'prod/orders');
		assert.equal(merged.host, RDS.host);
		assert.equal(merged.password, 'pw');
	});

	test('a credentials-only secret leaves the connection\'s address alone', () => {
		const merged = mergeSecretFields(connection({ host: 'db.internal', port: 5433, database: 'app' }), { username: 'u', password: 'p' }, 'creds');
		assert.equal(merged.host, 'db.internal');
		assert.equal(merged.port, 5433);
		assert.equal(merged.database, 'app');
	});

	test('the connection\'s own database is kept: it does not change where the credentials go', () => {
		const merged = mergeSecretFields(connection({ host: RDS.host, database: 'reporting' }), RDS, 'prod/orders');
		assert.equal(merged.database, 'reporting');
	});

	test('a secret with neither a username nor a password is refused', () => {
		assert.throws(() => mergeSecretFields(connection({}), { host: 'x' }, 'empty'), /no "username" or "password"/);
	});
});

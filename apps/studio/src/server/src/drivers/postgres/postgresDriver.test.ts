/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';

import type { ConnectionConfig } from '../../../../shared/connection';
import { postgresPoolConfig } from './postgresDriver';
import { setPasswordSource } from '../passwordSource';

const saved: ConnectionConfig = { id: 'c1', label: 'Shop', driver: 'postgres', host: 'db.internal', port: 5432, username: 'app', database: 'shop' };

/** The password pg would send, read the way pg reads it before answering the server's challenge. */
function passwordPgWouldSend(config: ConnectionConfig): Promise<string | null> {
	const client = new Client(postgresPoolConfig(config, config.host, config.port)) as Client & { _getPassword(cb: () => void): void; password: string | null };
	return new Promise((resolve) => client._getPassword(() => resolve(client.password)));
}

const ENV = ['PGPASSWORD', 'PGPASSFILE', 'PGSSLMODE'] as const;
const before = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
let scratch: string | undefined;

afterEach(() => {
	for (const name of ENV) {
		if (before[name] === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = before[name];
		}
	}
	if (scratch) {
		rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
	}
});

describe('a Postgres connection takes its password and TLS from the connection, never the environment', () => {
	test('with no saved password, PGPASSWORD is not sent', async () => {
		process.env.PGPASSWORD = 'from-the-environment';
		assert.equal(await passwordPgWouldSend(saved), '');
		assert.equal(await passwordPgWouldSend({ ...saved, password: '' }), '');
	});

	test('with no saved password, a pgpass file is not read', async () => {
		delete process.env.PGPASSWORD;
		scratch = mkdtempSync(join(tmpdir(), 'pgpass-'));
		const file = join(scratch, 'pgpass');
		writeFileSync(file, '*:*:*:*:from-pgpass\n', { mode: 0o600 });
		process.env.PGPASSFILE = file;
		assert.equal(await passwordPgWouldSend(saved), '');
	});

	test('a saved password is sent as it is', async () => {
		process.env.PGPASSWORD = 'from-the-environment';
		assert.equal(await passwordPgWouldSend({ ...saved, password: 'typed' }), 'typed');
	});

	test('TLS off stays off whatever PGSSLMODE says', () => {
		process.env.PGSSLMODE = 'require';
		assert.equal(postgresPoolConfig(saved, saved.host, saved.port).ssl, false);
		assert.deepEqual(postgresPoolConfig({ ...saved, ssl: true }, saved.host, saved.port).ssl, { rejectUnauthorized: true });
	});
});

describe('a Cloud connection that signs in as the person', () => {
	afterEach(() => setPasswordSource(undefined));

	test('asks for its password on every new connection, for itself, and never uses a stored one', async () => {
		const asked: string[] = [];
		let n = 0;
		setPasswordSource(async (connectionId) => {
			asked.push(connectionId);
			n += 1;
			return `token-${n}`;
		});
		const person: ConnectionConfig = { ...saved, username: 'snout_token', password: 'stale', cloudProjectRef: 'b7kq2m9xt4rvz', cloudTokenSignIn: true };
		assert.equal(await passwordPgWouldSend(person), 'token-1');
		assert.equal(await passwordPgWouldSend(person), 'token-2');
		assert.deepEqual(asked, ['c1', 'c1']);
	});

	test('with nobody to ask, the connection fails with a sentence rather than an empty password', async () => {
		const person: ConnectionConfig = { ...saved, username: 'snout_token', cloudProjectRef: 'b7kq2m9xt4rvz', cloudTokenSignIn: true };
		// pg emits the rejection as the connection's error, which is what the person then reads.
		const password = postgresPoolConfig(person, person.host, person.port).password as () => Promise<string>;
		await assert.rejects(password(), /signs in with your SnoutData account/);
	});

	test('an ordinary connection never asks', async () => {
		setPasswordSource(async () => { throw new Error('asked'); });
		assert.equal(await passwordPgWouldSend({ ...saved, password: 'kept' }), 'kept');
	});
});

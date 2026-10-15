/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { toolEnv, type PgAccess } from './env.js';

const ACCESS: PgAccess = {
	host: 'db.example',
	port: 5432,
	user: 'app',
	password: null,
	database: 'app',
	sslmode: 'require',
	caPem: null
};

const USER_SHELL = {
	PATH: '/usr/bin',
	PGPASSWORD: 'from-the-shell',
	PGPASSFILE: '/home/me/.pgpass',
	PGSSLCERT: '/home/me/.postgresql/postgresql.crt',
	PGSSLKEY: '/home/me/.postgresql/postgresql.key',
	PGSSLROOTCERT: '/home/me/.postgresql/root.crt',
	PGSERVICE: 'prod',
	PGSERVICEFILE: '/home/me/.pg_service.conf',
	PGSYSCONFDIR: '/etc/postgresql-common'
};

test('nothing from the shell or from libpq\'s default files can offer a credential', () => {
	const { env, dispose } = toolEnv(ACCESS, USER_SHELL);
	try {
		assert.equal(env.PATH, '/usr/bin');
		assert.equal(env.PGPASSWORD, undefined, 'an inherited PGPASSWORD reached the tool');
		assert.equal(env.PGSERVICE, undefined);
		for (const name of ['PGPASSFILE', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLROOTCERT', 'PGSERVICEFILE']) {
			const value = env[name];
			assert.ok(value && !value.startsWith('/home/me') && !value.startsWith('/etc'), `${name} = ${value}`);
			assert.equal(existsSync(value), false, `${name} names a file that exists`);
			assert.equal(existsSync(dirname(value)), true, `${name} is not inside the private directory`);
		}
		assert.equal(env.PGSYSCONFDIR, dirname(env.PGPASSFILE!));
		assert.equal(env.PGGSSENCMODE, 'disable');
		assert.equal(env.PGREQUIREAUTH, '!gss,!sspi');
	} finally {
		dispose();
	}
});

test('the spec\'s own password and certificates are the ones offered', () => {
	const { env, dispose } = toolEnv({ ...ACCESS, password: 'from-the-spec', sslmode: 'verify-full', caPem: '-----BEGIN CERTIFICATE-----\n' }, USER_SHELL);
	try {
		assert.equal(env.PGPASSWORD, 'from-the-spec');
		assert.ok(env.PGSSLROOTCERT?.endsWith('roots.pem'));
		assert.equal(existsSync(env.PGSSLROOTCERT!), true);
	} finally {
		dispose();
	}
});

test('dispose removes the private directory, and a refused env leaves none behind', () => {
	const { env, dispose } = toolEnv(ACCESS, {});
	const dir = env.PGSYSCONFDIR!;
	assert.equal(existsSync(dir), true);
	dispose();
	assert.equal(existsSync(dir), false);
	assert.throws(() => toolEnv({ ...ACCESS, sslmode: 'verify-full', caPem: null }, {}), /No certificates/);
});

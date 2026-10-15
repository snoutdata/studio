/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEIDI_REGISTRY, decodeHeidiPassword, heidiSessionsToFound, parsePortableSettings, parseRegQuery } from './heidisql';
import { fixtureBytes } from './testFixtures';

test('the password obfuscation reverses: hex pairs minus the shift in the last digit', () => {
	assert.equal(decodeHeidiPassword('7668667568773'), 'secret');
	assert.equal(decodeHeidiPassword('4'), undefined, 'no pairs');
	assert.equal(decodeHeidiPassword('7668x'), undefined, 'no shift digit');
	assert.equal(decodeHeidiPassword(''), undefined);
	assert.equal(decodeHeidiPassword(undefined), undefined);
});

test('reg query output: one map per session key, DWORDs as numbers, folders kept apart', () => {
	const sessions = parseRegQuery(fixtureBytes('heidisql-reg.txt').toString('utf8'));
	assert.deepEqual([...sessions.keys()], ['Local MySQL', 'Work', 'Work\\SQL Server box', 'Work\\Pg', 'Work\\Fire']);
	assert.equal(sessions.get('Local MySQL')?.get('NetType'), '0');
	assert.equal(sessions.get('Work\\Fire')?.get('NetType'), '13');
	assert.equal(sessions.get('Work\\SQL Server box')?.get('User'), '');
});

const reg = heidiSessionsToFound(HEIDI_REGISTRY, parseRegQuery(fixtureBytes('heidisql-reg.txt').toString('utf8')));

test('sessions become connections, with the decoded password, and the folder is not one', () => {
	assert.deepEqual(reg.map((f) => f.sourceName), ['Local MySQL', 'SQL Server box', 'Pg', 'Fire']);
	const mysql = reg[0];
	assert.equal(mysql.values.driver, 'mariadb', 'the version it last saw says MariaDB');
	assert.deepEqual([mysql.values.host, mysql.values.port, mysql.values.database, mysql.values.username], ['127.0.0.1', 3306, 'shop', 'root']);
	assert.equal(mysql.values.password, 'secret');
	assert.equal(mysql.importsPassword, true);
	assert.deepEqual(mysql.ref, { file: HEIDI_REGISTRY, connId: 'Local MySQL' });
});

test('NetType maps: 3-7 SQL Server (Windows auth noted), 8 Postgres, anything else unsupported', () => {
	const [, mssql, pg, fire] = reg;
	assert.equal(mssql.values.driver, 'sqlserver');
	assert.equal(mssql.values.host, 'sqlbox\\REPORTS');
	assert.equal(mssql.values.username, '');
	assert.equal(mssql.importsPassword, false);
	assert.match(mssql.note ?? '', /Windows authentication/);
	assert.deepEqual([pg.values.driver, pg.values.ssl], ['postgres', true]);
	assert.equal(fire.supported, false);
	assert.match(fire.note ?? '', /13/);
});

test('portable settings: the same sessions, an SSH tunnel, and SQLite as a file', () => {
	const found = heidiSessionsToFound('portable_settings.txt', parsePortableSettings(fixtureBytes('heidisql-portable.txt').toString('utf8')));
	assert.equal(found.length, 2, 'LastSessions is not under Servers');
	const [portable, lite] = found;
	assert.equal(portable.values.password, 'secret');
	assert.deepEqual(portable.values.ssh, { host: 'jump.example', port: 2200, username: 'tunnel', privateKeyPath: 'C:\\keys\\jump.ppk', keepAlive: true });
	assert.equal(lite.values.driver, 'sqlite');
	assert.equal(lite.values.database, 'C:\\data\\app.db');
	assert.equal(lite.supported, true);
});

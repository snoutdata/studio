/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeText } from './common';
import { parseSqlServerInstance, parseSsmsUserSettings } from './ssms';
import { fixtureBytes } from './testFixtures';

test('instance strings: host, host,port, host\\NAME, prefixes, the local aliases', () => {
	assert.deepEqual(parseSqlServerInstance('db01'), { host: 'db01', port: undefined, instance: undefined });
	assert.deepEqual(parseSqlServerInstance('db01,14330'), { host: 'db01', port: 14330, instance: undefined });
	assert.deepEqual(parseSqlServerInstance('db01\\SQLEXPRESS'), { host: 'db01\\SQLEXPRESS', instance: 'SQLEXPRESS' });
	assert.deepEqual(parseSqlServerInstance('tcp:db01\\NAMED,1500'), { host: 'db01', port: 1500, instance: 'NAMED' }, 'a port wins over the instance name');
	assert.deepEqual(parseSqlServerInstance('.'), { host: 'localhost', port: undefined, instance: undefined });
	assert.deepEqual(parseSqlServerInstance('(local)\\MSSQLSERVER'), { host: 'localhost', port: undefined, instance: 'MSSQLSERVER' }, 'the default instance is just the host');
});

test('the fixture is UTF-16 with a BOM, as SSMS writes it, and decodes', () => {
	const bytes = fixtureBytes('ssms-UserSettings.xml');
	assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
	assert.match(decodeText(bytes), /^<\?xml/);
});

const found = parseSsmsUserSettings('UserSettings.xml', decodeText(fixtureBytes('ssms-UserSettings.xml')));

test('one row per Database Engine instance and login; other server types are skipped', () => {
	assert.deepEqual(found.map((f) => f.values.host), ['SQLPROD01\\REPORTING', 'SQLPROD01\\REPORTING', '10.1.2.3']);
	const [reader, sa] = found;
	assert.equal(reader.values.username, 'report_reader');
	assert.equal(reader.values.database, undefined, '<default> is no database');
	assert.equal(sa.values.username, 'sa');
	assert.equal(sa.values.database, 'Finance');
	assert.ok(found.every((f) => f.values.driver === 'sqlserver' && !f.importsPassword));
});

test('Windows authentication has no username to import, and says so', () => {
	const win = found[2];
	assert.equal(win.values.port, 14330);
	assert.equal(win.values.username, '');
	assert.match(win.note ?? '', /Windows authentication/);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAzureDataStudioSettings, parseJsonc } from './azureDataStudio';
import { fixtureBytes } from './testFixtures';

test('JSONC: comments and trailing commas go, and a // inside a string stays', () => {
	assert.deepEqual(parseJsonc('{ // c\n "a": "x // y", /* b */ "b": [1, 2,], }'), { a: 'x // y', b: [1, 2] });
	assert.deepEqual(parseJsonc('{"q": "say \\"hi\\", ok",}'), { q: 'say "hi", ok' });
	assert.throws(() => parseJsonc('{ nope'));
});

const found = parseAzureDataStudioSettings('settings.json', fixtureBytes('ads-settings.json').toString('utf8'));

test('reads MSSQL and PGSQL connections from datasource.connections', () => {
	assert.equal(found.length, 4);
	const sales = found[0];
	assert.equal(sales.values.driver, 'sqlserver');
	assert.equal(sales.values.host, 'sql01.corp.example');
	assert.equal(sales.values.port, 14330, 'host,port');
	assert.equal(sales.values.database, 'Sales');
	assert.equal(sales.values.username, 'reporter');
	assert.equal(sales.sourceName, "Sales // reporting");
	assert.deepEqual([sales.values.ssl, sales.values.sslMode], [true, 'insecure'], 'encrypt, but trust the certificate');
	assert.equal(sales.importsPassword, false);
});

test('a named instance keeps its name for the driver to resolve, and Windows auth is noted', () => {
	const express = found[1];
	assert.equal(express.values.host, 'DESKTOP-1\\SQLEXPRESS');
	assert.equal(express.values.username, '');
	assert.match(express.note ?? '', /Windows authentication/);
	assert.equal(express.sourceName, 'DESKTOP-1\\SQLEXPRESS', 'no connection name: named after the server');
});

test('a PGSQL connection uses the Postgres option names', () => {
	const pg = found[2];
	assert.deepEqual([pg.values.driver, pg.values.host, pg.values.port, pg.values.database, pg.values.username], ['postgres', 'localhost', 5433, 'analytics', 'postgres']);
	assert.deepEqual([pg.values.ssl, pg.values.sslMode], [true, 'system']);
});

test('another provider is listed, unsupported', () => {
	assert.equal(found[3].supported, false);
	assert.match(found[3].note ?? '', /KUSTO/);
});

test('settings without connections, or unreadable, are nothing', () => {
	assert.deepEqual(parseAzureDataStudioSettings('s', '{ "editor.fontSize": 14 }'), []);
	assert.deepEqual(parseAzureDataStudioSettings('s', '{'), []);
});

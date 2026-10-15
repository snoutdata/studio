/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConnectionConfig } from '../../shared/connection';
import { decodeText, pickResolved, sslFromLibpqMode, toScanResult, type Found } from './common';

const found: Found[] = [
	{ ref: { file: 'f', connId: 'b' }, values: { label: 'b', driver: 'postgres', host: 'h', port: 5432, username: 'u', password: 'secret', ssl: false, readOnly: false, ssh: { host: 's', username: 'x', password: 'sshpw' } }, sourceName: 'Beta', supported: true, importsPassword: true },
	{ ref: { file: 'f', connId: 'a' }, values: { label: 'a', driver: 'postgres', host: '', port: 5432, username: '', ssl: false, readOnly: false }, sourceName: 'Alpha', supported: false, importsPassword: false },
	{ ref: { file: 'f', connId: 'c' }, values: { label: 'c', driver: 'postgres', host: 'h2', port: 5432, username: '', ssl: false, readOnly: false }, sourceName: 'Aardvark', supported: true, importsPassword: false, tentative: true },
];

test('the renderer never gets a secret; supported first, guesses after; duplicates marked', () => {
	const existing = [{ id: '1', label: 'x', driver: 'postgres', host: 'h', port: 5432, username: 'u', ssl: false, readOnly: false }] as unknown as ConnectionConfig[];
	const scan = toScanResult('pgpass', ['f'], found, existing);
	assert.deepEqual(scan.items.map((i) => i.sourceName), ['Beta', 'Aardvark', 'Alpha']);
	assert.equal(scan.items[0].values.password, undefined);
	assert.equal(scan.items[0].values.ssh?.password, undefined);
	assert.equal(scan.items[0].duplicate, true);
	assert.equal(scan.items[1].tentative, true);
	assert.deepEqual(scan.items.map((i) => i.key), ['0', '1', '2']);
	assert.ok(!JSON.stringify(scan).includes('secret'));
});

test('apply takes supported refs only, with their secrets', () => {
	const values = pickResolved(found, [{ file: 'f', connId: 'b' }, { file: 'f', connId: 'a' }, { file: 'other', connId: 'b' }]);
	assert.equal(values.length, 1);
	assert.equal(values[0].password, 'secret');
});

test('libpq sslmode: require encrypts without verifying, verify-* verifies, the rest is off', () => {
	assert.deepEqual(sslFromLibpqMode('require'), { ssl: true, sslMode: 'insecure' });
	assert.deepEqual(sslFromLibpqMode('verify-full'), { ssl: true, sslMode: 'system' });
	assert.deepEqual(sslFromLibpqMode('prefer'), { ssl: false });
	assert.deepEqual(sslFromLibpqMode(undefined), { ssl: false });
});

test('text decodes through a UTF-8 BOM, UTF-16 LE and UTF-16 BE', () => {
	assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'a');
	assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')])), 'hé');
	const be = Buffer.from('hé', 'utf16le');
	be.swap16();
	assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'hé');
	assert.equal(decodeText(Buffer.from('plain')), 'plain');
});

test('a connection saved at 127.0.0.1 is the one discovery finds at localhost', () => {
	const existing = [{ id: '1', label: 'local-test', driver: 'postgres', host: '127.0.0.1', port: 54342, database: 'r', username: 'r_owner', ssl: false, readOnly: false }] as unknown as ConnectionConfig[];
	const scan = toScanResult('docker', ['s'], [{ ref: { file: 's', connId: 'c' }, values: { label: 'x', driver: 'postgres', host: 'localhost', port: 54342, database: 'r', username: 'r_owner', ssl: false, readOnly: false }, sourceName: 'x', supported: true, importsPassword: true }], existing);
	assert.equal(scan.items[0].duplicate, true);
});

test('the same server and database saved under another user is still the same database', () => {
	const existing = [{ id: '1', label: 'MySQL - dev', driver: 'mysql-aurora', host: 'localhost', port: 3306, database: 'shop_dev', username: 'shop', ssl: false, readOnly: false }] as unknown as ConnectionConfig[];
	const scan = toScanResult('dbeaver', ['f'], [{ ref: { file: 'f', connId: 'c' }, values: { label: 'localhost', driver: 'mysql-aurora', host: 'localhost', port: 3306, database: 'shop_dev', username: 'root', ssl: false, readOnly: false }, sourceName: 'localhost', supported: true, importsPassword: true }], existing);
	assert.equal(scan.items[0].duplicate, true);
});

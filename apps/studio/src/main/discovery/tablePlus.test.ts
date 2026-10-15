/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parsePlistXml, scanTablePlus, tablePlusToFound } from './tablePlus';
import { fixtureBytes, fixturePath } from './testFixtures';

test('an XML property list decodes to values', () => {
	assert.deepEqual(parsePlistXml('<plist><dict><key>a</key><integer>3</integer><key>b</key><array><true/><string>x &amp; y</string></array></dict></plist>'), { a: 3, b: [true, 'x & y'] });
	assert.equal(parsePlistXml('not a plist'), null);
});

const found = tablePlusToFound('Connections.plist', parsePlistXml(fixtureBytes('tableplus-Connections.plist').toString('utf8')));

test('connections read with the keys TablePlus really writes', () => {
	assert.equal(found.length, 4);
	const staging = found[0];
	assert.deepEqual([staging.values.driver, staging.values.host, staging.values.port, staging.values.database, staging.values.username], ['postgres', 'staging.db.example.com', 6432, 'app', 'app_rw']);
	assert.equal(staging.values.environment, 'stage', 'from the misspelled Enviroment key');
	assert.deepEqual(staging.values.ssh, { host: 'bastion.example.com', port: 22, username: 'ubuntu', privateKeyPath: '/Users/me/.ssh/id_rsa', keepAlive: true });
	assert.deepEqual([staging.values.ssl, staging.values.sslMode], [true, 'insecure']);
	assert.equal(staging.importsPassword, false);
});

test('a blank port falls back to the engine default; SQLite is a file; Redis is unsupported', () => {
	assert.deepEqual([found[1].values.driver, found[1].values.port, found[1].values.ssh], ['mysql-aurora', 3306, undefined]);
	assert.deepEqual([found[2].values.driver, found[2].values.database, found[2].supported], ['sqlite', '/Users/me/notes.sqlite', true]);
	assert.equal(found[3].supported, false);
});

test('a binary plist is converted with plutil (macOS only)', { skip: process.platform !== 'darwin' }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tp-'));
	try {
		const bin = join(dir, 'Connections.plist');
		execFileSync('plutil', ['-convert', 'binary1', '-o', bin, fixturePath('tableplus-Connections.plist')]);
		const scan = await scanTablePlus([], [bin]);
		assert.equal(scan.items.length, 4);
		assert.equal(scan.items.find((i) => i.sourceName === 'Staging Postgres')?.values.host, 'staging.db.example.com');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

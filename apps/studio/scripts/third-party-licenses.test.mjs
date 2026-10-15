/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test scripts/third-party-licenses.test.mjs
// The pure half of the licence generator: which files are a package's licence, what a package.json's
// licence field says, which lines are copyright lines, and the file's shape (order, de-duplication,
// the fallback for a package with no licence file, the Codicons note).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyrightLines, formatReport, isCopyrightLine, licenceId, packageDirOf, pickLicenceFiles } from './third-party-licenses.mjs';

test('picks licence and notice files, licence first, and nothing that is code', () => {
	const names = ['README.md', 'ThirdPartyNotices.txt', 'NOTICE', 'LICENSE-CODE', 'LICENSE', 'license.js', 'package.json', 'COPYING.txt', 'licence.md', 'LICENSES.chromium.html', 'index.d.ts'];
	assert.deepEqual(pickLicenceFiles(names), ['COPYING.txt', 'LICENSE', 'LICENSE-CODE', 'licence.md', 'NOTICE', 'ThirdPartyNotices.txt']);
	assert.deepEqual(pickLicenceFiles(['index.js', 'README']), []);
});

test("reads every shape of package.json's licence field", () => {
	assert.equal(licenceId({ license: 'MIT' }), 'MIT');
	assert.equal(licenceId({ license: { type: 'BSD-2-Clause', url: 'x' } }), 'BSD-2-Clause');
	assert.equal(licenceId({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), '(MIT OR Apache-2.0)');
	assert.equal(licenceId({ licenses: [{ type: 'ISC' }] }), 'ISC');
	assert.equal(licenceId({}), 'UNKNOWN');
});

test('copyright lines are statements, not licence prose or templates', () => {
	assert.ok(isCopyrightLine('Copyright (c) Example Corp.'));
	assert.ok(isCopyrightLine('Copyright Brian White. All rights reserved.'));
	assert.ok(isCopyrightLine('(c) 2015 Someone'));
	assert.ok(!isCopyrightLine('Copyright {yyyy} {name of copyright owner}'));
	assert.ok(!isCopyrightLine('(c) You must retain, in the Source form of any Derivative Works'));
	assert.ok(!isCopyrightLine('copyright and certain other rights. Our licenses are'));
	assert.ok(!isCopyrightLine('Copyright and Similar Rights means copyright and/or similar rights'));
	assert.ok(!isCopyrightLine('COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM'));
	assert.deepEqual(copyrightLines(['MIT\n\n  Copyright (c) 2020 A\nCopyright (c) 2020 A\n', 'Copyright 2021 B']), ['Copyright (c) 2020 A', 'Copyright 2021 B']);
});

test('finds the package a bundled source came from, after the last node_modules', () => {
	assert.deepEqual(packageDirOf('/app/node_modules/react/cjs/react.production.min.js'), { dir: '/app/node_modules/react', name: 'react' });
	assert.deepEqual(packageDirOf('/app/node_modules/a/node_modules/@scope/b/lib/x.js'), { dir: '/app/node_modules/a/node_modules/@scope/b', name: '@scope/b' });
	assert.equal(packageDirOf('/app/src/renderer/src/App.tsx'), null);
	assert.equal(packageDirOf('/app/node_modules/@scope'), null);
});

test('the file is in a fixed order, prints a shared text once, and never leaves a package without its terms', () => {
	const mit = 'MIT License\r\n\r\nCopyright (c) 2020 Zed\r\n\r\nPermission is hereby granted';
	const entries = [
		{ name: 'zed', version: '1.0.0', licence: 'MIT', files: [{ name: 'LICENSE', text: mit }] },
		{ name: '@vscode/codicons', version: '0.0.45', licence: 'CC-BY-4.0', files: [{ name: 'LICENSE', text: 'Attribution 4.0 International' }, { name: 'LICENSE-CODE', text: mit }] },
		{ name: 'bare', version: '2.0.0', licence: 'ISC', files: [] },
	];
	const a = formatReport(entries, { version: '9.9.9' });
	assert.equal(a, formatReport([...entries].reverse(), { version: '9.9.9' }), 'input order must not change the file');
	assert.match(a, /^Third-party software in SnoutData Studio 9\.9\.9\n/);
	assert.match(a, /3 third-party packages/);
	const order = [...a.matchAll(/^(\S+) \d+\.\d+\.\d+$/gm)].map((m) => m[1]);
	assert.deepEqual(order, ['@vscode/codicons', 'bare', 'zed']);
	assert.equal(a.split('Permission is hereby granted').length, 2, 'an identical licence text is printed once');
	assert.match(a, /\(The same text as @vscode\/codicons 0\.0\.45's LICENSE-CODE above\.\)/);
	assert.match(a, /Copyright \(c\) 2020 Zed/);
	assert.ok(!a.includes('\r'), 'line endings are normalised');
	assert.match(a, /CC BY 4\.0, https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
	assert.match(a, /bare 2\.0\.0\nLicence: ISC\n\nThis package carries no licence file\. It is distributed under ISC \(https:\/\/spdx\.org\/licenses\/ISC\.html\)/);
});

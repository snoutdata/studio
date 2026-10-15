/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { fileSaveRoots, ImportGrants, isInsideRoot, PathGrants } from './pathGrants';

const ROOT = resolve('/tmp/snout-workspace');
const DATA = resolve('/tmp/snout-userdata');

describe('PathGrants', () => {
	test('a path from the page is refused unless main granted it on that channel', () => {
		const grants = new PathGrants('linux');
		const picked = resolve('/home/u/orders.csv');
		assert.equal(grants.allowed('sql:bulkLoad', picked), false);
		grants.grant('sql:bulkLoad', picked);
		assert.equal(grants.allowed('sql:bulkLoad', picked), true);
		// Grants are per channel: a file picked for loading is not one the editor may overwrite.
		assert.equal(grants.allowed('file:save', picked), false);
		assert.equal(grants.allowed('workspace:importPaths', picked), false);
	});

	test('a path under one of the channel roots is allowed, and `..` cannot climb out', () => {
		const grants = new PathGrants('linux');
		assert.equal(grants.allowed('file:save', join(ROOT, 'q.sql'), [ROOT, DATA]), true);
		assert.equal(grants.allowed('file:save', join(ROOT, 'sub', 'q.sql'), [ROOT]), true);
		assert.equal(grants.allowed('file:save', `${ROOT}/../../etc/passwd`, [ROOT, DATA]), false);
		assert.equal(grants.allowed('file:save', `${ROOT}-evil/q.sql`, [ROOT]), false);
		assert.equal(grants.allowed('file:save', resolve('/Users/u/Library/LaunchAgents/x.plist'), [ROOT, DATA]), false);
	});

	test('relative, empty, non-string and NUL-carrying paths are refused outright', () => {
		const grants = new PathGrants('linux');
		grants.grant('file:save', 'q.sql');
		for (const bad of ['q.sql', '', `${ROOT}/q\0.sql`, 42, null, undefined]) {
			assert.equal(grants.allowed('file:save', bad, [ROOT]), false, String(bad));
		}
	});

	test('case-insensitive file systems compare case-insensitively', () => {
		const grants = new PathGrants('darwin');
		grants.grant('file:save', '/Users/u/Q.sql');
		assert.equal(grants.allowed('file:save', '/users/u/q.SQL'), true);
		const linux = new PathGrants('linux');
		linux.grant('file:save', '/home/u/Q.sql');
		assert.equal(linux.allowed('file:save', '/home/u/q.sql'), false);
	});

	test('isInsideRoot accepts the root itself and a file named like a parent reference', () => {
		assert.equal(isInsideRoot(ROOT, ROOT, 'linux'), true);
		assert.equal(isInsideRoot(ROOT, join(ROOT, '..notes.sql'), 'linux'), true);
		assert.equal(isInsideRoot(ROOT, resolve(ROOT, '..'), 'linux'), false);
	});

	test('file:save never writes into the app data folder without a dialog, outside the workspace', () => {
		const grants = new PathGrants('linux');
		const home = resolve('/home/u');
		const userData = join(home, '.config', 'snoutdata');
		const save = (workspace: string, path: string): boolean => {
			const { roots, denied } = fileSaveRoots(workspace, userData);
			return grants.allowed('file:save', path, roots, denied);
		};
		// The default workspace lives inside userData, and its scripts save straight.
		const defaultWorkspace = join(userData, 'workspace');
		assert.equal(save(defaultWorkspace, join(defaultWorkspace, 'q.sql')), true);
		// Everything else in userData is main's own state: refused, whatever the workspace is.
		for (const target of ['mcp.json', 'review.json', join('components', 'db2', 'index.js'), join('agent-console', 'mcp.json')]) {
			assert.equal(save(defaultWorkspace, join(userData, target)), false, target);
			// A workspace the person set to their home contains userData, and still does not reach it.
			assert.equal(save(home, join(userData, target)), false, `home workspace: ${target}`);
		}
		assert.equal(save(home, join(home, 'q.sql')), true);
		// A workspace pointed at userData itself is not a way in either.
		assert.equal(save(userData, join(userData, 'mcp.json')), false);
		// A path the Save dialog returned is the person's own choice, wherever it is.
		grants.grant('file:save', join(userData, 'chosen.sql'));
		assert.equal(save(defaultWorkspace, join(userData, 'chosen.sql')), true);
	});
});

describe('ImportGrants', () => {
	const dbeaverFile = resolve('/home/u/.local/share/DBeaverData/workspace6/General/.dbeaver/data-sources.json');
	const scan = { sourceId: 'dbeaver', items: [{ ref: { file: dbeaverFile, connId: 'pg-1' } }, { ref: { file: dbeaverFile, connId: 'pg-2' } }] };

	test('import:apply re-reads only a file a scan main ran listed, for that source', () => {
		const grants = new ImportGrants('linux');
		const forged = { file: resolve('/home/u/.ssh/config'), connId: 'x' };
		// Nothing has been scanned: every file ref from the page is refused.
		assert.deepEqual(grants.allowedRefs('dbeaver', [{ file: dbeaverFile, connId: 'pg-1' }]), []);
		grants.grantScan(scan);
		assert.deepEqual(grants.allowedRefs('dbeaver', [{ file: dbeaverFile, connId: 'pg-1' }, forged]), [{ file: dbeaverFile, connId: 'pg-1' }]);
		// Listed for DBeaver is not listed for another source that would read it differently.
		assert.deepEqual(grants.allowedRefs('pgpass', [{ file: dbeaverFile, connId: 'h:5432:db:u' }]), []);
		// A non-path ref (a container engine socket name, a host) is matched as written.
		grants.grantScan({ sourceId: 'local', items: [{ ref: { file: '127.0.0.1', connId: 'postgres:5432' } }] });
		assert.equal(grants.allowedRefs('local', [{ file: '127.0.0.1', connId: 'postgres:5432' }]).length, 1);
		assert.equal(grants.allowedRefs('local', [{ file: 'attacker.example', connId: 'postgres:5432' }]).length, 0);
	});

	test('malformed refs are dropped, and SnoutData Cloud refs (the account\'s own projects) need no scan', () => {
		const grants = new ImportGrants('linux');
		grants.grantScan(scan);
		assert.deepEqual(grants.allowedRefs('dbeaver', 'nope'), []);
		assert.deepEqual(grants.allowedRefs('dbeaver', [null, 7, { file: 3, connId: 'a' }, { file: `${dbeaverFile}\0`, connId: 'a' }]), []);
		assert.deepEqual(grants.allowedRefs('snoutdata-cloud', [{ file: 'snoutdata-cloud', connId: 'abcdefghijklm' }]), [{ file: 'snoutdata-cloud', connId: 'abcdefghijklm' }]);
	});
});

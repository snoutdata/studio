/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanDbeaverScripts } from './dbeaverImport';

// Every script the scan lists may be copied into the workspace, where an agent reads files without
// asking, so a DBeaver folder someone hands the user must not be able to list a file from elsewhere.

test('the script scan lists regular .sql files and follows no link', (t) => {
	const base = mkdtempSync(join(tmpdir(), 'snout-dbeaver-'));
	const workspace = join(base, 'workspace6', 'General', 'Scripts');
	const home = mkdtempSync(join(tmpdir(), 'snout-home-'));
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(home, '.aws'), { recursive: true });
	writeFileSync(join(home, '.aws', 'credentials'), 'aws_secret_access_key = SECRET');
	writeFileSync(join(workspace, 'Script.sql'), 'SELECT 1;');
	try {
		try {
			symlinkSync(join(home, '.aws', 'credentials'), join(workspace, 'creds.sql'));
			symlinkSync(join(home, '.aws'), join(workspace, 'aws'), 'dir');
		} catch {
			t.skip('this machine cannot make a link');
			return;
		}
		writeFileSync(join(home, '.aws', 'config.sql'), 'region = us-east-1');
		if (process.platform !== 'win32') {
			execFileSync('mkfifo', [join(workspace, 'pipe.sql')]);
		}
		const scan = scanDbeaverScripts(base);
		assert.deepEqual(scan.scripts.map((script) => script.name), ['Script.sql']);
	} finally {
		rmSync(base, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

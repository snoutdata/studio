/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { LocalProgress, LocalSetupForm } from '../../shared/localStack';
import { STACK_SOURCE } from './plan';
import { FUNCTION_TREE_MAX_BYTES, FUNCTION_TREE_MAX_FILES, LocalStackService, readFunctionTree, type LocalStackDeps } from './service';

// The install's first step: a stack file that is not the pinned one is refused before the
// project folder is made, so nothing is written and Docker is never asked to run it.

function deps(root: string, fetcher: typeof fetch): LocalStackDeps {
	return {
		userDataDir: join(root, 'userData'),
		home: root,
		platform: process.platform,
		env: {},
		userPath: async () => '',
		fetch: fetcher,
		copy: () => undefined,
		addConnection: () => { throw new Error("no connection may be added"); },
		connectionsOf: () => [],
		updateConnection: () => undefined,
		removeConnection: async () => undefined,
		openPath: async () => undefined,
	};
}

const form = (folder: string): LocalSetupForm => ({
	name: "Tampered",
	folder,
	apiPort: 61871,
	dbPort: 61872,
	exposeApi: false,
	siteUrl: 'http://localhost:3000',
	autoconfirm: true,
	disableSignup: false,
	bundledStorage: true,
	images: false,
	addConnection: false,
});

test('a changed compose.yaml is refused and the project folder is never made', async () => {
	const root = mkdtempSync(join(tmpdir(), 'snout-stack-'));
	try {
		const asked: string[] = [];
		const fake = (async (url: string) => {
			asked.push(url);
			return new Response('services:\n  evil:\n    image: ghcr.io/snoutdata/snout-stack:0.1.4\n');
		}) as unknown as typeof fetch;
		const service = new LocalStackService(deps(root, fake));
		const folder = join(root, 'project');
		const progress: LocalProgress[] = [];
		const outcome = await service.install(form(folder), 'install-1', (p) => progress.push(p));
		assert.equal(outcome.ok, false);
		assert.match(outcome.message, /compose\.yaml is not the published snout-stack file/);
		assert.equal(existsSync(folder), false, 'nothing is written');
		assert.equal(existsSync(join(root, 'userData', 'localProjects.json')), false, 'nothing is listed');
		assert.deepEqual(asked, [`${STACK_SOURCE}/compose.yaml`]);
		assert.deepEqual(progress.map((p) => p.step), ['download', 'failed']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// A function's folder is read for a copy to SnoutData Cloud. A link inside it, or a `_shared` that
// is a link, would carry whatever it points at (another project, a home folder) into the upload,
// and an unbounded tree would read all of it before anything said no.

test('a function tree refuses links at every level, the root included', () => {
	const root = mkdtempSync(join(tmpdir(), 'snout-fn-'));
	try {
		const outside = join(root, 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'secret.txt'), 'not yours\n');
		const fn = join(root, 'fn');
		mkdirSync(join(fn, 'lib'), { recursive: true });
		writeFileSync(join(fn, 'index.ts'), 'export {};\n');
		assert.deepEqual(readFunctionTree(fn).map((f) => f.path), ['index.ts']);

		symlinkSync(outside, join(fn, 'lib', 'linked'), 'dir');
		assert.throws(() => readFunctionTree(fn), /lib\/linked is a link/);
		unlinkSync(join(fn, 'lib', 'linked'));
		symlinkSync(join(outside, 'secret.txt'), join(fn, 'secret.txt'), 'file');
		assert.throws(() => readFunctionTree(fn), /secret\.txt is a link/);

		const shared = join(root, '_shared');
		symlinkSync(outside, shared, 'dir');
		assert.throws(() => readFunctionTree(shared), /is a link/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a function tree stops at the bundle limits, with a sentence', () => {
	const root = mkdtempSync(join(tmpdir(), 'snout-fn-'));
	try {
		const many = join(root, 'many');
		mkdirSync(many);
		for (let i = 0; i <= FUNCTION_TREE_MAX_FILES; i++) {
			writeFileSync(join(many, `f${i}.ts`), 'export {};\n');
		}
		assert.throws(() => readFunctionTree(many), /more than 200 files/);

		const big = join(root, 'big');
		mkdirSync(big);
		writeFileSync(join(big, 'a.ts'), 'x'.repeat(FUNCTION_TREE_MAX_BYTES));
		writeFileSync(join(big, 'b.ts'), 'x');
		assert.throws(() => readFunctionTree(big), /more than 2048 KB/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

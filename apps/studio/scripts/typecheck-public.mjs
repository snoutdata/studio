/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// `npm run typecheck:public`: compile Studio the way the open-source tree compiles it, against the
// stubs (tsconfig.web.public.json, tsconfig.node.public.json), so an import the stubs do not provide
// fails here rather than in a stranger's clone.
//
// In the open-source tree that is all there is to it. In the tree it is cut from, the private files
// still sit beside the open ones, so they are left out of the program: the cut's own list says which
// they are, and the exclude is generated from it into out/ for this run. The public configs name no
// private file themselves.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CUT = resolve(APP, '../../scripts/open-source/lib.mjs');
const CONFIGS = ['tsconfig.web.public.json', 'tsconfig.node.public.json'];
const TSC = resolve(APP, 'node_modules/typescript/bin/tsc');

function walk(dir, out = []) {
	if (!existsSync(dir)) {
		return out;
	}
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== 'node_modules') {
				walk(p, out);
			}
		} else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) {
			out.push(relative(APP, p).split('\\').join('/'));
		}
	}
	return out;
}

async function closedFiles() {
	if (!existsSync(CUT)) {
		return [];
	}
	const { isClosedAppFile } = await import(pathToFileURL(CUT).href);
	return [...walk(join(APP, 'src')), ...walk(join(APP, 'scripts'))].filter((f) => isClosedAppFile(f)).sort();
}

const closed = await closedFiles();
const genDir = join(APP, 'out', 'typecheck-public');
let failed = false;
for (const config of CONFIGS) {
	let project = join(APP, config);
	if (closed.length) {
		mkdirSync(genDir, { recursive: true });
		project = join(genDir, config);
		const toApp = relative(genDir, APP).split('\\').join('/');
		writeFileSync(project, JSON.stringify({ extends: `${toApp}/${config}`, exclude: closed.map((f) => `${toApp}/${f}`) }, null, '\t') + '\n');
	}
	const r = spawnSync(process.execPath, [TSC, '-p', project, '--noEmit'], { cwd: APP, stdio: 'inherit' });
	if (r.status !== 0) {
		failed = true;
	}
}
process.exit(failed ? 1 : 0);

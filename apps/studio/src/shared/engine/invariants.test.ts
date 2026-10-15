/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/*
 * The engine's invariants, enforced rather than documented.
 *
 * These are the tests behind the engine's boundary claims. If one of them fails,
 * the failure is the point: something reached around the boundary, and the external story
 * ("one audited layer", "passwords never reach the model") is no longer true.
 *
 * This file reads the SOURCE tree, not the bundle, because the boundary is a property of how
 * the code is written. It is bundled to CJS by esbuild before `node --test` sees it, so
 * `import.meta.url` is not available here; it locates the tree from the working directory
 * instead (`npm test` runs from `apps/studio`).
 */

/** `apps/studio/src`, found by walking up from the working directory. */
function findSrcRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, 'src', 'shared', 'engine', 'index.ts');
		try {
			statSync(candidate);
			return join(dir, 'src');
		} catch {
			// keep walking up
		}
		dir = dirname(dir);
	}
	throw new Error(`could not locate apps/studio/src from ${process.cwd()}`);
}

const SRC = findSrcRoot();
const ENGINE = join(SRC, 'shared', 'engine');

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(full));
		} else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
			out.push(full);
		}
	}
	return out;
}

/** Every `from '...'` specifier in a source file. */
function importsOf(file: string): string[] {
	const text = readFileSync(file, 'utf8');
	return [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
}

const isTest = (f: string) => f.endsWith('.test.ts') || f.endsWith('.test.tsx');

describe('engine invariants', () => {
	// The engine runs in the renderer, in main, and in the server child. The moment a module
	// under here reaches for the filesystem or Electron, that stops being true and the guard
	// can no longer give instant feedback in the UI from the same code that enforces in main.
	test('purity: no engine module imports node, fs, path, or electron', () => {
		const offenders: string[] = [];
		for (const file of walk(ENGINE)) {
			if (isTest(file)) {
				continue; // tests are allowed to read the tree; this file does exactly that
			}
			for (const spec of importsOf(file)) {
				if (/^(node:|fs$|fs\/|path$|electron$|electron\/)/.test(spec)) {
					offenders.push(`${relative(SRC, file)} imports '${spec}'`);
				}
			}
		}
		assert.deepEqual(offenders, [], `engine must stay pure:\n${offenders.join('\n')}`);
	});

	// `shared/engine/index.ts` is the enforcement point. Deep imports are what let a call site
	// quietly bypass a module it should have gone through, so the surface has to be the only door.
	test('no bypass: outside code imports shared/engine, never a deep path into it', () => {
		const offenders: string[] = [];
		for (const file of walk(SRC)) {
			if (file.startsWith(ENGINE + sep) || isTest(file)) {
				continue;
			}
			for (const spec of importsOf(file)) {
				const deep = spec.match(/(?:^|\/)shared\/engine\/(.+)$/);
				// `shared/engine/pro` is the one other door: the surface plus Data Flows' own modules,
				// for Data Flows' code.
				if (deep && deep[1] !== 'pro') {
					offenders.push(`${relative(SRC, file)} imports 'shared/engine/${deep[1]}'`);
				}
			}
		}
		assert.deepEqual(offenders, [], `import from 'shared/engine' instead:\n${offenders.join('\n')}`);
	});

	// The engine may know a credential EXISTS; it may never be handed the value. This asserts
	// against the host interfaces, which is where such a leak would have to be declared first.
	test('secrets never cross: the host surface exposes presence, not values', () => {
		const host = readFileSync(join(ENGINE, 'host.ts'), 'utf8');
		const presence = host.slice(host.indexOf('interface SecretPresence'));
		const body = presence.slice(0, presence.indexOf('}'));
		assert.match(body, /has\(/, 'SecretPresence should expose a presence check');
		assert.doesNotMatch(body, /\bget\b|\bresolve\b|\breveal\b|=>\s*string/, 'SecretPresence must not return a secret value');
	});
});

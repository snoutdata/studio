/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The package runs in a browser, in Electron and in a Deno Snout Function: nothing in it may reach
// for Node, the DOM or Deno. Tests may use node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = here.endsWith('dist') ? join(here, '..', 'src') : here;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
	});
}

test('no node:, fs, electron, window, document or Deno in the package', () => {
	for (const file of walk(src)) {
		const text = readFileSync(file, 'utf8');
		for (const bad of [/from ['"]node:/, /require\(/, /from ['"]electron['"]/, /\bwindow\./, /\bdocument\./, /\bDeno\.\w+\(/, /from ['"]fs['"]/]) {
			assert.doesNotMatch(text.replace(/\/\/.*$/gm, ''), bad, `${file} uses ${bad}`);
		}
	}
});

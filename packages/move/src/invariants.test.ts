/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The core is imported by the desktop renderer as well as by main and the CLI, so it may not
// reach for Node. The runner lives in `src/runner/`, which this deliberately does not scan.
test('the core imports nothing from node', () => {
	const src = new URL('../src/', import.meta.url);
	for (const file of readdirSync(src)) {
		if (!file.endsWith('.ts') || file.endsWith('.test.ts')) {
			continue;
		}
		const text = readFileSync(new URL(file, src), 'utf8');
		assert.doesNotMatch(text, /from ['"]node:/, `${file} imports from node`);
	}
});

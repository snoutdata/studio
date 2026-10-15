/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiDebugRequested, appendCapped, logAiRoundTrip, setAiDebugEnabled } from './debugLog';

describe('the AI blackbox log', () => {
	test('is off in a dev run unless SNOUT_AI_DEBUG=1, and off in a packaged build whatever is set', () => {
		assert.equal(aiDebugRequested(false, {}), false, 'npm run dev on its own logs nothing and opens no endpoint');
		assert.equal(aiDebugRequested(false, { SNOUT_AI_DEBUG: '0' }), false);
		assert.equal(aiDebugRequested(false, { SNOUT_AI_DEBUG: '1' }), true);
		assert.equal(aiDebugRequested(true, { SNOUT_AI_DEBUG: '1' }), false);
		assert.equal(aiDebugRequested(true, { POSITRON_AI_DEBUG: '1' }), false);
	});

	test('never grows past its cap: the full file is moved aside and one older file is kept', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ai-debug-'));
		try {
			const path = join(dir, 'aiDebug.jsonl');
			const line = `${'x'.repeat(99)}\n`;
			for (let i = 0; i < 25; i++) {
				await appendCapped(path, line, 1000);
			}
			assert.ok(statSync(path).size <= 1000, 'the live file stays under the cap');
			assert.ok(statSync(join(dir, 'aiDebug.1.jsonl')).size <= 1000, 'the moved file was under the cap too');
			// A line larger than the cap on its own still lands, in a file of its own.
			writeFileSync(path, line);
			await appendCapped(path, `${'y'.repeat(2000)}\n`, 1000);
			assert.equal(readFileSync(path, 'utf8').startsWith('y'), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('writes nothing while switched off', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ai-debug-'));
		try {
			const entry = { ts: 1, kind: 'chat' as const, provider: 'p', model: 'm', reply: 'r', ms: 1, ok: true };
			const log = console.log;
			console.log = () => undefined;
			try {
				setAiDebugEnabled(false, dir);
				await logAiRoundTrip(entry);
				assert.equal(existsSync(join(dir, 'aiDebug.jsonl')), false);
				setAiDebugEnabled(true, dir);
				await logAiRoundTrip(entry);
				assert.equal(readFileSync(join(dir, 'aiDebug.jsonl'), 'utf8').trim(), JSON.stringify(entry));
			} finally {
				console.log = log;
				setAiDebugEnabled(false);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

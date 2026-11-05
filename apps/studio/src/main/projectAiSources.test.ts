/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAiSources, parseAiSources } from './projectAiSources';

test('parseAiSources keeps well-formed rows and a paused project as null models', () => {
	const parsed = parseAiSources({ projects: [
		{ ref: 'a1', name: 'A', state: 'running', models: [{ id: 'm', owned_by: 'openai', vendor: 'OpenAI' }, { id: '' }, null] },
		{ ref: 'b2', name: 'B', state: 'paused', models: null },
		{ ref: 'bad:ref', name: 'X', state: 'running', models: [] },
		{ name: 'no ref' },
	] });
	assert.deepEqual(parsed, [
		{ ref: 'a1', name: 'A', state: 'running', models: [{ id: 'm', owned_by: 'openai', vendor: 'OpenAI' }] },
		{ ref: 'b2', name: 'B', state: 'paused', models: null },
	]);
	assert.deepEqual(parseAiSources(null), []);
	assert.deepEqual(parseAiSources({ error: 'nope' }), []);
});

test('the list is cached for a minute, a failure is not cached, and clear() forgets it', async () => {
	let clock = 0;
	let calls = 0;
	let fail = false;
	const sources = createProjectAiSources(async () => {
		calls++;
		if (fail) {
			throw new Error('offline');
		}
		return { projects: [{ ref: 'a1', name: 'A', state: 'running', models: [] }] };
	}, () => clock);
	assert.equal((await sources.list()).length, 1);
	clock = 59_000;
	await sources.list();
	assert.equal(calls, 1);
	clock = 61_000;
	fail = true;
	assert.deepEqual(await sources.list(), []);
	assert.equal(calls, 2);
	fail = false;
	await sources.list();
	assert.equal(calls, 3);
	sources.clear();
	await sources.list();
	assert.equal(calls, 4);
	await sources.list(true);
	assert.equal(calls, 5);
	// Two asks at once share one call.
	sources.clear();
	await Promise.all([sources.list(), sources.list()]);
	assert.equal(calls, 6);
});

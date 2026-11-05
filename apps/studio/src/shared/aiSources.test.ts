/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AI_SETTINGS, type AiModelInfo } from './ai';
import { billedBy, chatSelection, groupPickerModels, modelKey, normalizeProjectSelection, parseModelKey, projectModelInfos, projectRefusal, projectRelayBase, resolveStoredProvider, type ProjectAiSource } from './aiSources';

const SOURCES: ProjectAiSource[] = [
	{ ref: 'x8catwwkz44dn', name: 'Shop', state: 'running', models: [{ id: 'gpt-6-astra', owned_by: 'openai', vendor: 'OpenAI' }, { id: 'claude-x', owned_by: 'anthropic' }] },
	{ ref: 'pausedref00001', name: 'Old', state: 'paused', models: null },
	{ ref: 'e02txse0mf595', name: '', state: 'running', models: [{ id: 'gpt-5.6-luna' }] },
];

test('a project model and a SnoutData model with the same id are two keys, and both parse back', () => {
	const cloud = { provider: 'positron-cloud' as const, model: 'gpt-5.6-luna' };
	const project = { provider: 'snout-project' as const, model: 'gpt-5.6-luna', projectRef: 'e02txse0mf595' };
	assert.notEqual(modelKey(cloud), modelKey(project));
	assert.deepEqual(parseModelKey(modelKey(cloud)), cloud);
	assert.deepEqual(parseModelKey(modelKey(project)), project);
	// A model id with a colon (Ollama's tags) survives both forms.
	assert.deepEqual(parseModelKey('ollama:qwen2.5-coder:7b'), { provider: 'ollama', model: 'qwen2.5-coder:7b' });
	assert.deepEqual(parseModelKey('snout-project:abc:qwen:7b'), { provider: 'snout-project', projectRef: 'abc', model: 'qwen:7b' });
	assert.equal(parseModelKey('snout-project:abc'), null);
	assert.equal(parseModelKey('snout-project::m'), null);
	assert.equal(parseModelKey('nocolon'), null);
});

test('a stored project selection is kept only with a project and a model; otherwise SnoutData AI', () => {
	const project = normalizeProjectSelection({ ref: 'x8catwwkz44dn', model: 'gpt-6-astra', name: 'Shop', vendor: 'OpenAI' });
	assert.deepEqual(project, { ref: 'x8catwwkz44dn', model: 'gpt-6-astra', name: 'Shop', ownedBy: undefined, vendor: 'OpenAI' });
	assert.equal(normalizeProjectSelection({ ref: 'x', model: '' }), undefined);
	assert.equal(normalizeProjectSelection({ ref: 'a:b', model: 'm' }), undefined);
	assert.equal(normalizeProjectSelection(null), undefined);
	assert.equal(resolveStoredProvider('snout-project', project, 'positron-cloud'), 'snout-project');
	assert.equal(resolveStoredProvider('snout-project', undefined, 'positron-cloud'), 'positron-cloud');
	// Existing settings files carry no project and keep their provider.
	assert.equal(resolveStoredProvider('byok-openai', undefined, 'positron-cloud'), 'byok-openai');
	assert.equal(resolveStoredProvider('ollama', undefined, 'positron-cloud'), 'ollama');
	assert.equal(resolveStoredProvider('bedrock', undefined, 'positron-cloud'), 'positron-cloud');
	assert.equal(resolveStoredProvider(undefined, undefined, 'positron-cloud'), 'positron-cloud');
});

test('chatSelection reads the pair for every source', () => {
	assert.deepEqual(chatSelection(DEFAULT_AI_SETTINGS), { provider: 'positron-cloud', model: DEFAULT_AI_SETTINGS['positron-cloud'].model });
	const withProject = { ...DEFAULT_AI_SETTINGS, provider: 'snout-project' as const, project: { ref: 'r1', model: 'm1' } };
	assert.deepEqual(chatSelection(withProject), { provider: 'snout-project', model: 'm1', projectRef: 'r1' });
	const byok = { ...DEFAULT_AI_SETTINGS, provider: 'byok-anthropic' as const, byok: { ...DEFAULT_AI_SETTINGS.byok, 'byok-anthropic': { model: 'claude-opus-5-5', models: [] } } };
	assert.deepEqual(chatSelection(byok), { provider: 'byok-anthropic', model: 'claude-opus-5-5' });
});

test('project models: a paused project gives none, hidden ones are flagged off', () => {
	const infos = projectModelInfos(SOURCES, new Set(['snout-project:x8catwwkz44dn:claude-x']));
	assert.deepEqual(infos.map((m) => modelKey(m)), ['snout-project:x8catwwkz44dn:gpt-6-astra', 'snout-project:x8catwwkz44dn:claude-x', 'snout-project:e02txse0mf595:gpt-5.6-luna']);
	assert.deepEqual(infos.map((m) => m.enabled), [true, false, true]);
	// A project with no name is titled by its ref.
	assert.equal(infos[2].projectName, 'e02txse0mf595');
	assert.equal(billedBy(infos[0]), 'OpenAI');
	assert.equal(billedBy(infos[1]), 'Anthropic');
	assert.equal(billedBy(infos[2]), undefined);
});

test('groups: SnoutData AI, then each project in order, then your keys; who bills each is said', () => {
	const cloud: AiModelInfo = { provider: 'positron-cloud', model: 'gpt-5.6-luna', enabled: true, reasoning: false };
	const byok: AiModelInfo = { provider: 'byok-openai', model: 'gpt-4o', enabled: true, reasoning: false };
	const byok2: AiModelInfo = { provider: 'byok-anthropic', model: 'claude-opus-5-5', enabled: true, reasoning: false };
	const groups = groupPickerModels([byok, ...projectModelInfos(SOURCES), cloud, byok2]);
	assert.deepEqual(groups.map((g) => [g.title, g.subtitle]), [
		['SnoutData AI', 'Uses your balance'],
		['Shop', "Your project's keys, billed by OpenAI and Anthropic"],
		['e02txse0mf595', "Your project's keys"],
		['Your keys', 'Billed by OpenAI and Anthropic'],
	]);
	assert.deepEqual(groups[0].models, [cloud]);
	assert.equal(groupPickerModels([]).length, 0);
	const local: AiModelInfo = { provider: 'ollama', model: 'qwen2.5-coder:7b', enabled: true, reasoning: false };
	assert.deepEqual(groupPickerModels([local]).map((g) => g.subtitle), ['Runs on your computer']);
});

test('the relay base and its refusals', () => {
	assert.equal(projectRelayBase('https://accounts.snoutdata.com/functions/v1/', 'x8catwwkz44dn'), 'https://accounts.snoutdata.com/functions/v1/cloud-project-ai/x8catwwkz44dn/v1');
	assert.match(projectRefusal('OpenAI 404: {"error":{"message":"AI is off","code":"ai-off"}}', 'Shop') ?? '', /AI gateway of Shop is switched off/);
	assert.match(projectRefusal('OpenAI 403: {"error":{"message":"no"}}', 'Shop') ?? '', /may not use the AI of Shop/);
	assert.equal(projectRefusal('OpenAI 429: {"error":{"message":"budget spent","code":"budget_exceeded"}}', 'Shop'), "Shop's AI gateway refused the request: budget spent");
	assert.equal(projectRefusal('fetch failed', 'Shop'), null);
});

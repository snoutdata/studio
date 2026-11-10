/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_AI_SETTINGS, type AiSettings } from '../shared/ai';
import { localAiRef } from '../shared/aiSources';
import { ProjectAi, type ProjectAiDeps } from './projectAi';

function setup(overrides: Partial<ProjectAiDeps> = {}): { ai: ProjectAi; targets: unknown[]; active: unknown[]; forgotten: () => number; stored: Map<string, string>; minted: () => number } {
	const targets: unknown[] = [];
	const active: unknown[] = [];
	const stored = new Map<string, string>();
	let forgotten = 0;
	let minted = 0;
	const settings: AiSettings = {
		...DEFAULT_AI_SETTINGS,
		provider: 'byok-openai',
		byok: { ...DEFAULT_AI_SETTINGS.byok, 'byok-openai': { model: 'gpt-a', models: ['gpt-a'] } },
	};
	const ai = new ProjectAi({
		psyche: async (target, method, path) => {
			targets.push(target);
			if (method === 'GET') {
				return { ok: true, status: 200, body: { data: [] } };
			}
			if (path === 'admin/keys') {
				minted++;
				return { ok: true, status: 200, body: { key: `psy_${minted}` } };
			}
			return { ok: true, status: 200, body: {} };
		},
		sources: async () => [
			{ ref: 'abcdefghijklm', name: 'Cloud', state: 'ready', models: [{ id: 'm' }] },
			{ ref: 'pausedprojecx', name: 'Paused', state: 'paused', models: null },
			{ ref: localAiRef('id-1'), name: 'Here', state: 'running', models: [] },
		],
		settings: {
			get: () => settings,
			byokKey: (p) => (p === 'byok-openai' ? 'sk-1' : undefined),
			setActive: (_p, model, project) => {
				active.push({ model, ...project });
				return settings;
			},
		},
		secrets: { get: (id) => stored.get(id), store: (id, _k, value) => void stored.set(id, value) },
		byokAllowed: () => true,
		forgetSources: () => {
			forgotten++;
		},
		...overrides,
	});
	return { ai, targets, active, forgotten: () => forgotten, stored, minted: () => minted };
}

test('a paused project is no target; a Local one is', async () => {
	const { ai } = setup();
	assert.deepEqual(await ai.moveTargets(), [
		{ ref: 'abcdefghijklm', name: 'Cloud', local: false },
		{ ref: localAiRef('id-1'), name: 'Here', local: true },
	]);
});

test('the keys go to the chosen project and the assistant follows', async () => {
	const { ai, targets, active, forgotten } = setup();
	const result = await ai.moveKeys(localAiRef('id-1'), 'Here');
	assert.equal(result.moved.length, 1);
	assert.deepEqual(targets[0], { kind: 'local', id: 'id-1' });
	assert.deepEqual(active, [{ model: 'gpt-a', ref: localAiRef('id-1'), name: 'Here', ownedBy: 'openai' }]);
	assert.equal(forgotten(), 1);
});

test('without the entitlement there is nothing to preview or move', async () => {
	const { ai } = setup({ byokAllowed: () => false });
	assert.deepEqual(ai.movePreview(), []);
	await assert.rejects(ai.moveKeys('abcdefghijklm', 'Cloud'));
});

test('the agents\' key is made once, kept, and replaced when asked', async () => {
	const { ai, minted, stored } = setup();
	assert.equal(await ai.agentKey('abcdefghijklm', false), 'psy_1');
	assert.equal(await ai.agentKey('abcdefghijklm', false), 'psy_1');
	assert.equal(minted(), 1);
	assert.equal(await ai.agentKey('abcdefghijklm', true), 'psy_2');
	assert.equal(stored.get('__agent_ai_abcdefghijklm__'), 'psy_2');
});

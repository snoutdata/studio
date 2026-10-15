/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import { LIBY_AVAILABLE } from '@snout/liby/studio';
import { ASSISTANT_NAME } from '../../../shared/assistant';
import assert from 'node:assert/strict';

import type { CapabilityContext } from './registry';
import { appStateCapabilities } from './appState';

const getShortcuts = appStateCapabilities.find((h) => h.spec.name === 'get_shortcuts')!;

function ctxWith(shortcuts: { id: string; label: string; keys: string }[]): CapabilityContext {
	return {
		snapshot: () => ({ connections: [], tabs: [], appSettings: {}, shortcuts }),
	} as unknown as CapabilityContext;
}

describe('get_shortcuts capability', () => {
	test('the shortcuts as bound now, and how to call the assistant up with the keys the user has', async () => {
		const result = await getShortcuts.run({}, ctxWith([
			{ id: 'commandPalette', label: 'Command palette', keys: '⇧⌘P' },
			{ id: 'libyHelp', label: `${ASSISTANT_NAME}: help with what I am doing`, keys: '⌃⌥L' },
			{ id: 'run', label: 'Run query', keys: '⌘↵' },
		]));
		assert.equal(result.ok, true);
		const data = result.data as { shortcuts: { action: string; keys: string }[]; callAssistantHelp: string[] };
		assert.deepEqual(data.shortcuts[2], { action: 'Run query', keys: '⌘↵' });
		// Her own sentence in a build that has her; the plain one in the open-source build.
		assert.match(data.callAssistantHelp[1], LIBY_AVAILABLE ? new RegExp(`^⌃⌥L, which brings ${ASSISTANT_NAME} onto`) : /^⌃⌥L, which opens this panel/);
		assert.ok(data.callAssistantHelp[2].includes(`(⇧⌘P), command "${ASSISTANT_NAME}: Help Me Here"`));
		assert.ok(!JSON.stringify(data).includes('—'));
	});

	test('read-only and asked for only when it matters', () => {
		assert.equal(getShortcuts.spec.mutates, false);
		assert.match(getShortcuts.spec.description, /Call this when asked for a shortcut/);
	});
});

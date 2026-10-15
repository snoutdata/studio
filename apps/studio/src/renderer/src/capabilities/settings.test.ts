/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { settingsCapabilities } from './settings';
import type { CapabilityContext } from './registry';

/*
 * `set_setting` is a whitelist of preferences. A guard is not a preference: the production
 * confirmation is what stands between a model and a destructive statement on production, so an
 * agent must not be able to switch it off.
 */

const setSetting = settingsCapabilities.find((h) => h.spec.name === 'set_setting')!;

function ctx(set: [string, unknown][]): CapabilityContext {
	return { app: { setAppSetting: (key: string, value: unknown) => set.push([key, value]), setTheme: () => undefined } } as unknown as CapabilityContext;
}

test('confirmOnProd cannot be changed by the agent', async () => {
	const set: [string, unknown][] = [];
	const result = await setSetting.run({ key: 'confirmOnProd', value: false }, ctx(set));
	assert.equal(result.ok, false);
	assert.deepEqual(set, []);
	assert.doesNotMatch(setSetting.spec.description, /confirmOnProd/);
});

test('an ordinary preference still can, and the action is never standing-approvable', async () => {
	const set: [string, unknown][] = [];
	const result = await setSetting.run({ key: 'fontSize', value: 14 }, ctx(set));
	assert.equal(result.ok, true);
	assert.deepEqual(set, [['fontSize', 14]]);
	assert.equal(setSetting.spec.destructive, true);
});

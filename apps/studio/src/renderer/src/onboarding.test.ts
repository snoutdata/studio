/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onboardingFromStorage } from './onboarding';

test('a fresh install has not seen the discovery popup', () => {
	assert.equal(onboardingFromStorage(null).discoverySeen, false);
	assert.equal(onboardingFromStorage(null).tourSeen, false);
});

test('stored state from before the popup existed counts as seen, so an upgrade never shows it', () => {
	const existing = JSON.stringify({ tourSeen: true, checklistDismissed: false, tasks: { run: true } });
	const state = onboardingFromStorage(existing);
	assert.equal(state.discoverySeen, true);
	assert.equal(state.tasks.run, true);
	assert.equal(state.tasks.save, false);
});

test('an explicit answer is kept either way', () => {
	assert.equal(onboardingFromStorage(JSON.stringify({ discoverySeen: false })).discoverySeen, false);
	assert.equal(onboardingFromStorage(JSON.stringify({ discoverySeen: true })).discoverySeen, true);
});

test('malformed storage is a fresh install', () => {
	assert.equal(onboardingFromStorage('{not json').discoverySeen, false);
});

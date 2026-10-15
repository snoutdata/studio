/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_APP_SETTINGS, adoptSyncedAppSettings, syncedAppSettings } from './appSettings';

test('hiding the mascot never goes into the synced settings', () => {
	const synced = syncedAppSettings({ ...DEFAULT_APP_SETTINGS, disableMascot: true });
	assert.equal('disableMascot' in synced, false);
	assert.equal(synced.fontSize, DEFAULT_APP_SETTINGS.fontSize);
});

test('a synced blob that says the mascot is hidden does not hide it on this machine', () => {
	// What an e2e run against the signed-in profile pushed to the account, or an older client's row.
	const remote = { ...DEFAULT_APP_SETTINGS, disableMascot: true, fontSize: 16 };
	const local = { ...DEFAULT_APP_SETTINGS, disableMascot: false };
	const adopted = adoptSyncedAppSettings(local, remote);
	assert.equal(adopted.disableMascot, false);
	assert.equal(adopted.fontSize, 16);
});

test('a machine where she was hidden keeps her hidden whatever the account says', () => {
	const remote = { ...DEFAULT_APP_SETTINGS, disableMascot: false };
	const local = { ...DEFAULT_APP_SETTINGS, disableMascot: true };
	assert.equal(adoptSyncedAppSettings(local, remote).disableMascot, true);
});

test('a partial blob is filled from the defaults, never from a stale local copy', () => {
	const local = { ...DEFAULT_APP_SETTINGS, fontSize: 20 };
	const adopted = adoptSyncedAppSettings(local, { wordWrap: true });
	assert.equal(adopted.wordWrap, true);
	assert.equal(adopted.fontSize, DEFAULT_APP_SETTINGS.fontSize);
	assert.equal(adopted.disableMascot, false);
});

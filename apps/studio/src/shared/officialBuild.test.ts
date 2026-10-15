/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPingAllowed, ISSUES_URL, REPOSITORY_URL, minimumVersionCheckAllowed, OPEN_BUILD_PROFILE, registersAuthProtocol, signInReturn, updateCheckRoute } from './officialBuild';

test('an open build never sends the install heartbeat or the activity ping', () => {
	for (const packaged of [true, false]) {
		for (const telemetry of [true, false]) {
			assert.equal(installPingAllowed({ official: false, packaged, telemetry }), false);
		}
	}
});

test('the official build pings only when packaged and telemetry is on', () => {
	assert.equal(installPingAllowed({ official: true, packaged: true, telemetry: true }), true);
	assert.equal(installPingAllowed({ official: true, packaged: false, telemetry: true }), false);
	assert.equal(installPingAllowed({ official: true, packaged: true, telemetry: false }), false);
});

test('an open build never checks the feed, on any platform, packaged or not', () => {
	for (const platform of ['win32', 'darwin', 'linux']) {
		for (const packaged of [true, false]) {
			assert.equal(updateCheckRoute({ official: false, packaged, platform }), 'from-source');
		}
	}
});

test('the official build checks the feed exactly as before', () => {
	assert.equal(updateCheckRoute({ official: true, packaged: true, platform: 'win32' }), 'feed');
	assert.equal(updateCheckRoute({ official: true, packaged: true, platform: 'darwin' }), 'feed');
	assert.equal(updateCheckRoute({ official: true, packaged: true, platform: 'linux' }), 'up-to-date');
	assert.equal(updateCheckRoute({ official: true, packaged: false, platform: 'win32' }), 'up-to-date');
});

test('an open build never enforces the minimum version', () => {
	for (const packaged of [true, false]) {
		for (const devOverride of [true, false]) {
			assert.equal(minimumVersionCheckAllowed({ official: false, packaged, devOverride }), false);
		}
	}
	assert.equal(minimumVersionCheckAllowed({ official: true, packaged: true, devOverride: false }), true);
	assert.equal(minimumVersionCheckAllowed({ official: true, packaged: false, devOverride: true }), true);
	assert.equal(minimumVersionCheckAllowed({ official: true, packaged: false, devOverride: false }), false);
});

test('an open build signs in over the loopback, packaged or not, and never registers snoutdata://', () => {
	assert.equal(signInReturn({ official: false, packaged: true }), 'loopback');
	assert.equal(signInReturn({ official: false, packaged: false }), 'loopback');
	assert.equal(registersAuthProtocol(false), false);
});

test('the official build signs in exactly as before', () => {
	assert.equal(signInReturn({ official: true, packaged: true }), 'site');
	assert.equal(signInReturn({ official: true, packaged: false }), 'loopback');
	assert.equal(registersAuthProtocol(true), true);
});

test("an open build's profile is not the official app's", () => {
	assert.notEqual(OPEN_BUILD_PROFILE, 'snoutdata');
	assert.notEqual(OPEN_BUILD_PROFILE, 'snoutdata-dev');
});

test('both builds report issues to, and star, the one Studio repository', () => {
	assert.equal(REPOSITORY_URL, 'https://github.com/snoutdata/studio');
	assert.equal(ISSUES_URL, 'https://github.com/snoutdata/studio/issues');
});

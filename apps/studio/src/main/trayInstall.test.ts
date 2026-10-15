/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTrayInstall, trayInstallBlocker, TRAY_INSTALL_QUIET_MS, TRAY_INSTALL_SCHEDULE_MARGIN_MS, type BackgroundActivity } from './trayInstall';

const NOW = 1_700_000_000_000;

function idle(patch: Partial<BackgroundActivity> = {}): BackgroundActivity {
	return {
		windowVisible: false,
		flowRuns: 0,
		nextScheduledRunInMs: null,
		queries: 0,
		reviewing: false,
		moveRuns: 0,
		modelJobs: 0,
		agentConsoles: 0,
		aiStreams: 0,
		...patch,
	};
}

test('an idle app in the tray has nothing blocking it', () => {
	assert.equal(trayInstallBlocker(idle()), null);
});

test('every kind of work in flight blocks, and so does an open window', () => {
	const busy: Array<Partial<BackgroundActivity>> = [
		{ windowVisible: true },
		{ flowRuns: 1 },
		{ nextScheduledRunInMs: 0 },
		{ nextScheduledRunInMs: TRAY_INSTALL_SCHEDULE_MARGIN_MS },
		{ queries: 1 },
		{ reviewing: true },
		{ moveRuns: 1 },
		{ modelJobs: 1 },
		{ agentConsoles: 1 },
		{ aiStreams: 1 },
	];
	for (const patch of busy) {
		assert.notEqual(trayInstallBlocker(idle(patch)), null, JSON.stringify(patch));
	}
});

test('a schedule further out than the margin does not block', () => {
	assert.equal(trayInstallBlocker(idle({ nextScheduledRunInMs: TRAY_INSTALL_SCHEDULE_MARGIN_MS + 1 })), null);
});

test('the first quiet tick starts the clock and does not install', () => {
	const decision = decideTrayInstall(idle(), null, NOW);
	assert.deepEqual(decision, { install: false, quietSince: NOW, blocker: null });
});

test('it installs only once the quiet stretch is long enough', () => {
	assert.equal(decideTrayInstall(idle(), NOW, NOW + TRAY_INSTALL_QUIET_MS - 1).install, false);
	const ready = decideTrayInstall(idle(), NOW, NOW + TRAY_INSTALL_QUIET_MS);
	assert.equal(ready.install, true);
	assert.equal(ready.quietSince, NOW);
});

test('any work resets the stretch', () => {
	const busy = decideTrayInstall(idle({ queries: 1 }), NOW, NOW + TRAY_INSTALL_QUIET_MS * 2);
	assert.deepEqual(busy, { install: false, quietSince: null, blocker: '1 query(ies) in flight' });
	// And the next quiet tick starts over rather than remembering the old start.
	assert.equal(decideTrayInstall(idle(), busy.quietSince, NOW + TRAY_INSTALL_QUIET_MS * 2).install, false);
});

test('a clock that moved backwards restarts the stretch', () => {
	const decision = decideTrayInstall(idle(), NOW + 60_000, NOW);
	assert.deepEqual(decision, { install: false, quietSince: NOW, blocker: null });
});

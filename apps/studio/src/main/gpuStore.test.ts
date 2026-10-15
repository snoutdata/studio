/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import {
	__resetGpuStoreForTests,
	hardwareAccelerationAutoDisabled,
	hardwareAccelerationEnabled,
	recordGpuCrash,
	setHardwareAccelerationEnabled,
} from './gpuStore';

// The auto-disable only triggers on hardware whose GPU driver is failing, which we can't reproduce
// on demand — so the decision logic is pinned here instead. What matters: a single hiccup must not
// downgrade anyone's rendering, and a real burst must flip the flag BEFORE Chromium gives up and
// kills the app (the EXCEPTION_BREAKPOINT crash this exists to prevent).

let dir: string;

function stateOnDisk(): { enabled?: boolean; autoDisabled?: boolean; crashes?: number } {
	return JSON.parse(readFileSync(join(dir, 'gpu.json'), 'utf8')) as Record<string, never>;
}

describe('gpuStore', () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'snout-gpu-'));
		__resetGpuStoreForTests(dir);
	});

	it('defaults to enabled when nothing is saved', () => {
		assert.equal(hardwareAccelerationEnabled(), true);
		assert.equal(hardwareAccelerationAutoDisabled(), false);
	});

	it('reads a corrupt file as enabled rather than stranding the user in software rendering', () => {
		writeFileSync(join(dir, 'gpu.json'), '{ not json', 'utf8');
		assert.equal(hardwareAccelerationEnabled(), true);
	});

	it('keeps acceleration on after a single GPU crash', () => {
		assert.equal(recordGpuCrash(), false);
		assert.equal(hardwareAccelerationEnabled(), true, 'one hiccup must not downgrade rendering');
		assert.equal(stateOnDisk().crashes, 1);
	});

	it('turns acceleration off after a burst in one session', () => {
		recordGpuCrash();
		assert.equal(recordGpuCrash(), true, 'second crash in a session should trip the threshold');
		assert.equal(hardwareAccelerationEnabled(), false);
		assert.equal(hardwareAccelerationAutoDisabled(), true);
		// Must be on disk already: Chromium's fatal abort gives us no chance to save on the way out.
		assert.equal(stateOnDisk().enabled, false);
		assert.equal(stateOnDisk().autoDisabled, true);
	});

	it('does not report an auto-disable when the user turned it off themselves', () => {
		setHardwareAccelerationEnabled(false);
		recordGpuCrash();
		recordGpuCrash();
		assert.equal(hardwareAccelerationEnabled(), false);
		assert.equal(hardwareAccelerationAutoDisabled(), false, 'their choice must not be blamed on us');
		// The tally still advances, so the file stays honest.
		assert.equal(stateOnDisk().crashes, 2);
	});

	it('lets the user overrule the auto-disable with a clean slate', () => {
		recordGpuCrash();
		recordGpuCrash();
		assert.equal(hardwareAccelerationEnabled(), false);

		setHardwareAccelerationEnabled(true);
		assert.equal(hardwareAccelerationEnabled(), true);
		assert.equal(hardwareAccelerationAutoDisabled(), false);
		// The old crashes must not immediately re-disable them: one new crash is not a burst.
		assert.equal(recordGpuCrash(), false);
		assert.equal(hardwareAccelerationEnabled(), true);
	});

	it('still re-disables if the GPU keeps crashing after the user overrules', () => {
		setHardwareAccelerationEnabled(true);
		assert.equal(recordGpuCrash(), false);
		assert.equal(recordGpuCrash(), true);
		assert.equal(hardwareAccelerationEnabled(), false);
	});
});

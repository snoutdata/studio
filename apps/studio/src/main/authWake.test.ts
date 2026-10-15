/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authOnResume, authOnSuspend, type AuthWakeHost } from './authWake';

function host(signedIn: boolean, reachable = true): { host: AuthWakeHost; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		host: {
			hasSession: () => signedIn,
			waitForReachable: async () => {
				calls.push('health');
				if (!reachable) {
					throw new Error('Auth backend not reachable.');
				}
			},
			startAutoRefresh: async () => { calls.push('start'); },
			stopAutoRefresh: async () => { calls.push('stop'); },
		},
	};
}

test('signed out, a wake contacts nobody and a sleep touches nothing', async () => {
	const { host: h, calls } = host(false);
	await authOnSuspend(h);
	await authOnResume(h);
	assert.deepEqual(calls, []);
});

test('signed in, a wake waits for the auth backend before restarting the refresh', async () => {
	const { host: h, calls } = host(true);
	await authOnSuspend(h);
	await authOnResume(h);
	assert.deepEqual(calls, ['stop', 'health', 'start']);
});

test('signed in, a wake whose network never settles still restarts the refresh', async () => {
	const { host: h, calls } = host(true, false);
	await authOnResume(h);
	assert.deepEqual(calls, ['health', 'start']);
});

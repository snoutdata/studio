/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportSignInTimezone, systemTimezone } from './signInTimezone';

test('a sign-in sends this computer\'s timezone, and a refusal or a throw is only logged', async () => {
	const sent: string[] = [];
	const logged: string[] = [];
	const ok = async (tz: string): Promise<{ error: { message: string } | null }> => { sent.push(tz); return { error: null }; };
	const refused = async (): Promise<{ error: { message: string } | null }> => ({ error: { message: 'unknown timezone Mars/Olympus' } });
	await reportSignInTimezone(ok, 'America/Toronto', (m) => logged.push(m));
	assert.deepEqual(sent, ['America/Toronto']);
	assert.equal(logged.length, 0);

	await reportSignInTimezone(refused, 'Mars/Olympus', (m) => logged.push(m));
	await reportSignInTimezone(async (): Promise<{ error: null }> => { throw new Error('offline'); }, 'Europe/London', (m) => logged.push(m));
	assert.equal(logged.length, 2);
	assert.match(logged[0] ?? '', /unknown timezone/);
	assert.match(logged[1] ?? '', /offline/);
});

test('no timezone sends nothing', async () => {
	let called = false;
	await reportSignInTimezone(async (): Promise<{ error: null }> => { called = true; return { error: null }; }, null);
	assert.equal(called, false);
	assert.equal(typeof (systemTimezone() ?? ''), 'string');
});

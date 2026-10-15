/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { CapabilityContext } from './registry';
import { logCapabilities } from './logs';
import { recordError } from './lastError';

const getLastError = logCapabilities.find((h) => h.spec.name === 'get_last_error')!;

// A snapshot stub so the capability can resolve a connection label from its id.
function ctxWith(connections: { id: string; label: string }[]): CapabilityContext {
	return {
		snapshot: () => ({ connections, tabs: [], appSettings: {} }),
	} as unknown as CapabilityContext;
}

describe('get_last_error capability', () => {
	test('reports the latest error with its connection id + label', async () => {
		recordError({ ts: 1, title: 'Connection failed', detail: 'getaddrinfo ENOTFOUND localhost2', source: 'connection', connectionId: 'c1', connectionLabel: 'Postgres' });
		const result = await getLastError.run({}, ctxWith([{ id: 'c1', label: 'Postgres' }]));
		assert.equal(result.ok, true);
		const data = result.data as Record<string, unknown>;
		assert.equal(data.connectionId, 'c1');
		assert.equal(data.connectionLabel, 'Postgres');
		assert.match(data.detail as string, /localhost2/);
		assert.match(result.summary, /Postgres/);
	});

	test('falls back to the live snapshot when no label was recorded', async () => {
		recordError({ ts: 2, title: 'Connection failed', connectionId: 'c2' });
		const result = await getLastError.run({}, ctxWith([{ id: 'c2', label: 'Aurora' }]));
		const data = result.data as Record<string, unknown>;
		assert.equal(data.connectionLabel, 'Aurora');
	});
});

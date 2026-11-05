/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { AiService } from './aiService';
import type { AiSettingsStore } from './aiSettingsStore';
import type { AuditStore } from './auditStore';
import type { ConnectionManager } from './connectionManager';
import type { KnowledgeStore } from './knowledgeStore';
import type { ModelMeta } from './modelCatalog';
import type { QueryStore } from './queryStore';
import { DEFAULT_AI_SETTINGS } from '../shared/ai';

/*
 * What the assistant panel's first question costs a signed-out user.
 *
 * The panel asks for the provider status on mount, and it is open on a fresh profile. Signed out,
 * the gateway cannot be used, so the model catalog (read from the accounts backend) has nothing to
 * decorate: the app must answer from what it holds and ask nobody. Signed in, the catalog is read
 * exactly as before.
 */

function settingsStore(): AiSettingsStore {
	return {
		get: () => DEFAULT_AI_SETTINGS,
		byokKey: () => undefined,
	} as unknown as AiSettingsStore;
}

function service(catalogReads: string[]): AiService {
	const catalog = async (): Promise<Map<string, ModelMeta>> => {
		catalogReads.push('read');
		return new Map();
	};
	return new AiService(
		settingsStore(),
		{} as ConnectionManager,
		{} as QueryStore,
		{} as AuditStore,
		{} as KnowledgeStore,
		catalog,
	);
}

describe('AiService.providerStatus', () => {
	let fetched: string[];
	let realFetch: typeof fetch;

	beforeEach(() => {
		fetched = [];
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			fetched.push(String(input instanceof Request ? input.url : input));
			throw new Error('no network in this test');
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test('signed out, it reads no catalog and makes no request', async () => {
		const reads: string[] = [];
		const ai = service(reads);
		ai.setSignedIn(false);
		const statuses = await ai.providerStatus();
		assert.deepEqual(reads, [], 'the model catalog was read while signed out');
		assert.deepEqual(fetched, [], 'a request went out while signed out');
		const gateway = statuses.find((s) => s.provider === 'positron-cloud');
		assert.ok(gateway);
		assert.equal(gateway.reachable, false);
		assert.deepEqual(gateway.models, []);
		assert.deepEqual(gateway.completionModels, []);
		assert.equal(gateway.configured, false);
	});

	test('signed in, the catalog is read as before', async () => {
		const reads: string[] = [];
		const ai = service(reads);
		ai.setSignedIn(true);
		const statuses = await ai.providerStatus();
		assert.deepEqual(reads, ['read']);
		// No key to add: the gateway is the account's, so signed in it counts as configured, and
		// here (no network) it is simply unreachable.
		const gateway = statuses.find((s) => s.provider === 'positron-cloud');
		assert.equal(gateway?.configured, true);
		assert.equal(gateway?.reachable, false);
		assert.match(gateway?.detail ?? '', /^Offline: can't reach the gateway/);
	});
});

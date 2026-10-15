/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConnectionConfig } from '../shared/connection';
import type { CloudApi, CloudProjectSummary } from './cloudApi';
import { syncCloudConnections } from './cloudSync';

// Cloud projects → connections. Adds what this account has never seen, and nothing else.

function project(ref: string, over: Partial<CloudProjectSummary> = {}): CloudProjectSummary {
	return {
		ref, name: ref, region: 'us-west-2', production: false, state: 'ready', desiredState: 'running',
		host: `${ref}.db.snoutdata.com`, database: ref, user: `${ref}_owner`, wakesInstantly: true, readOnly: false,
		...over,
	};
}

function api(projects: CloudProjectSummary[], account: string | null = 'alex@example.com'): CloudApi {
	const unused = async (): Promise<never> => { throw new Error('not used'); };
	return {
		account: async () => account, list: async () => projects,
		connection: unused, pause: unused, resume: unused, mintToken: unused, create: unused,
		requestExport: unused, exportStatus: unused, remove: unused, request: unused,
	};
}

function connection(ref: string): ConnectionConfig {
	return { id: ref, label: ref, driver: 'postgres', host: 'h', port: 5432, database: 'd', username: 'u', cloudProjectRef: ref } as ConnectionConfig;
}

test('a project never seen and not connected is added, and everything listed is remembered', async () => {
	const added: string[][] = [];
	const result = await syncCloudConnections(api([project('a'), project('b')]), [connection('b')], () => [], async (refs) => { added.push(refs); });
	assert.deepEqual(added, [['a']]);
	assert.deepEqual(result.seen.sort(), ['a', 'b']);
});

test('a project seen before is not added again, so deleting its connection sticks', async () => {
	let called = false;
	const result = await syncCloudConnections(api([project('a')]), [], () => ['a'], async () => { called = true; });
	assert.equal(called, false);
	assert.deepEqual(result.added, []);
});

test('deleted and deleting projects are never added', async () => {
	let called = false;
	await syncCloudConnections(api([project('a', { state: 'deleted' }), project('b', { desiredState: 'deleted' })]), [], () => [], async () => { called = true; });
	assert.equal(called, false);
});

test('signed out does nothing and remembers nothing', async () => {
	const result = await syncCloudConnections(api([project('a')], null), [], () => [], async () => { throw new Error('must not add'); });
	assert.deepEqual(result, { account: null, added: [], seen: [] });
});

test('seen refs are per account', async () => {
	const seenFor = (account: string): string[] => account === 'other@example.com' ? ['a'] : [];
	const result = await syncCloudConnections(api([project('a')]), [], seenFor, async () => undefined);
	assert.deepEqual(result.added, ['a']);
});

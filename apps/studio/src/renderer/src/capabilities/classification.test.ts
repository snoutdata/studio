/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { asksEveryTime, type CapabilitySpec } from '../../../shared/capabilities';
import { CapabilityRegistry, classificationProblem, implicitConnections, type CapabilityContext, type CapabilityHandler } from './registry';
import { recordError } from './lastError';

/*
 * Every capability says which connection it acts on without being told (`implicitConnection`) and
 * what it returns from a database (`returnsData`). That classification is what main holds an
 * external agent to (src/main/mcpCapabilityScope.test.ts checks every classification is enforced);
 * this file checks every capability HAS one, and that the ones that matter have the right one.
 */

/** Every always-registered capability. Loaded after a bare `window`, which a module reads at load. */
async function staticHandlers(): Promise<CapabilityHandler[]> {
	const host = globalThis as unknown as { window?: unknown };
	host.window ??= { sqlApi: {} };
	const { staticCapabilities } = await import('./index');
	return staticCapabilities;
}

function ctxWith(over: { active?: string; result?: string }): CapabilityContext {
	return {
		api: {} as CapabilityContext['api'],
		app: { resultConnectionId: () => over.result } as unknown as CapabilityContext['app'],
		snapshot: () => ({ connections: [], activeConnectionId: over.active, tabs: [], appSettings: {} as never, shortcuts: [] }),
	};
}

describe('capability classification', () => {
	test('every capability is classified, and a target one can resolve its connections', async () => {
		const problems = (await staticHandlers()).map(classificationProblem).filter((problem) => problem !== undefined);
		assert.deepEqual(problems, []);
	});

	test('the ones that reach a database without naming it say so', async () => {
		const byName = new Map((await staticHandlers()).map((handler) => [handler.spec.name, handler.spec]));
		const expected: Record<string, Pick<CapabilitySpec, 'implicitConnection' | 'returnsData'>> = {
			run_current: { implicitConnection: 'activeTab', returnsData: 'none' },
			insert_sql: { implicitConnection: 'activeTab', returnsData: 'none' },
			remember_this: { implicitConnection: 'activeTab', returnsData: 'none' },
			get_query_result: { implicitConnection: 'result', returnsData: 'values' },
			get_last_error: { implicitConnection: 'lastError', returnsData: 'values' },
			get_recent_logs: { implicitConnection: 'perItem', returnsData: 'values' },
			list_db_users: { implicitConnection: 'none', returnsData: 'schema' },
			orbit_neighbourhood: { implicitConnection: 'none', returnsData: 'schema' },
			get_cloud_project: { implicitConnection: 'target', returnsData: 'none' },
			get_cloud_cluster: { implicitConnection: 'target', returnsData: 'schema' },
		};
		for (const [name, want] of Object.entries(expected)) {
			const spec = byName.get(name);
			assert.ok(spec, name);
			assert.deepEqual({ implicitConnection: spec.implicitConnection, returnsData: spec.returnsData }, want, name);
		}
		assert.equal(asksEveryTime(byName.get('run_current')!), true, 'running the editor is asked about every time');
		const flow = byName.get('run_data_flow');
		if (flow) {
			assert.equal(asksEveryTime(flow), true, 'running a flow is asked about every time');
			assert.equal(flow.implicitConnection, 'target');
		}
	});

	test('a capability without a classification cannot be registered', () => {
		const registry = new CapabilityRegistry();
		const bare = { spec: { name: 'bare', description: '', parameters: {}, domain: 'test', mutates: false }, run: () => ({ ok: true, summary: '' }) } as unknown as CapabilityHandler;
		assert.throws(() => registry.register(bare), /does not say which connection/);
		const target: CapabilityHandler = { spec: { name: 'target', description: '', parameters: {}, domain: 'test', mutates: false, implicitConnection: 'target', returnsData: 'none' }, run: () => ({ ok: true, summary: '' }) };
		assert.throws(() => registry.register(target), /cannot resolve them/);
		const values: CapabilityHandler = { spec: { name: 'values', description: '', parameters: {}, domain: 'test', mutates: false, implicitConnection: 'none', returnsData: 'values' }, run: () => ({ ok: true, summary: '' }) };
		assert.throws(() => registry.register(values), /does not say which connection it comes from/);
	});

	test('the app resolves an implicit connection the way the capability would act on it', async () => {
		const handler = (implicitConnection: CapabilitySpec['implicitConnection']): CapabilityHandler => ({
			spec: { name: 'x', description: '', parameters: {}, domain: 'test', mutates: false, implicitConnection, returnsData: 'none' },
			run: () => ({ ok: true, summary: '' }),
			...(implicitConnection === 'target' ? { connections: () => ['a', 'a', 'b'] } : {}),
		});
		const ctx = ctxWith({ active: 'tab-conn', result: 'grid-conn' });
		recordError({ ts: 1, title: 'Query failed', connectionId: 'err-conn' });
		assert.deepEqual(await implicitConnections(handler('activeTab'), {}, ctx), ['tab-conn']);
		assert.deepEqual(await implicitConnections(handler('result'), {}, ctx), ['grid-conn']);
		assert.deepEqual(await implicitConnections(handler('lastError'), {}, ctx), ['err-conn']);
		assert.deepEqual(await implicitConnections(handler('target'), {}, ctx), ['a', 'b']);
		assert.deepEqual(await implicitConnections(handler('none'), {}, ctx), []);
		assert.deepEqual(await implicitConnections(handler('activeTab'), {}, ctxWith({})), []);
	});

	test('a pinned call is refused when what it acts on changed while it waited', async () => {
		const registry = new CapabilityRegistry();
		let ran = 0;
		registry.register({
			spec: { name: 'run_here', description: '', parameters: {}, domain: 'test', mutates: true, implicitConnection: 'activeTab', returnsData: 'none' },
			run: () => {
				ran += 1;
				return { ok: true, summary: 'ran' };
			},
		});
		const resolved = await registry.invoke({ id: '1', name: 'run_here', arguments: {}, resolveConnections: true }, ctxWith({ active: 'dev' }));
		assert.deepEqual(resolved.connectionIds, ['dev']);
		assert.equal(ran, 0, 'resolving runs nothing');
		const switched = await registry.invoke({ id: '2', name: 'run_here', arguments: {}, expectConnections: ['dev'] }, ctxWith({ active: 'prod' }));
		assert.equal(switched.ok, false);
		assert.equal(switched.refused, true);
		assert.equal(ran, 0);
		const same = await registry.invoke({ id: '3', name: 'run_here', arguments: {}, expectConnections: ['dev'] }, ctxWith({ active: 'dev' }));
		assert.equal(same.ok, true);
		assert.deepEqual(same.connectionIds, ['dev']);
		assert.equal(ran, 1);
	});
});

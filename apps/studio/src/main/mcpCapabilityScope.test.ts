/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalMcpServer, type McpConnectionRef } from './mcpServer';
import { CAPABILITY_DATA, IMPLICIT_CONNECTIONS, type CapabilityResult, type CapabilitySpec } from '../shared/capabilities';

/*
 * The invariant behind agent access, over EVERY way a capability can be classified: whatever
 * connection it acts on (named, or implied by the active tab, the result grid, the last error or the
 * thing it names) and whatever it hands back from a database, an external agent gets neither for a
 * connection the user has not exposed to it. Every published capability carries one of these
 * classifications (the type requires it, the registry refuses one without it, and
 * renderer/src/capabilities/classification.test.ts checks every one), so a classification main does
 * not enforce fails here, and a new kind fails the build at mcpServer's exhaustive switch.
 */

const TOKEN = 'scope-test-token';
const MARKER = 'ada@example.com-SECRET';
const HIDDEN: McpConnectionRef = { id: 'prod-1', label: 'Billing prod', driver: 'postgres', allowed: false, writes: false, readOnlyBy: 'the statement check' };
const SHOWN: McpConnectionRef = { id: 'dev-1', label: 'Local dev', driver: 'postgres', allowed: true, writes: false, readOnlyBy: 'the statement check' };

/** Every combination a spec can be published with. */
function everyClassification(): CapabilitySpec[] {
	const specs: CapabilitySpec[] = [];
	for (const implicitConnection of IMPLICIT_CONNECTIONS) {
		for (const returnsData of CAPABILITY_DATA) {
			for (const named of [false, true]) {
				for (const mutates of [false, true]) {
					specs.push({
						name: `probe_${implicitConnection}_${returnsData}_${named ? 'named' : 'unnamed'}_${mutates ? 'w' : 'r'}`,
						description: 'A probe.',
						parameters: { type: 'object', properties: named ? { connectionId: { type: 'string' } } : {}, ...(named ? { required: ['connectionId'] } : {}) },
						domain: 'probe',
						mutates,
						implicitConnection,
						returnsData,
					});
				}
			}
		}
	}
	return specs;
}

/** What a capability would hand back if it read the hidden connection: the marker everywhere. */
function leakingResult(spec: CapabilitySpec, ok: boolean): CapabilityResult {
	const data = spec.implicitConnection === 'perItem'
		? [{ ts: 1, level: 'error', message: MARKER, connectionId: HIDDEN.id }, { ts: 2, level: 'error', message: MARKER }]
		: { detail: MARKER, rows: [[MARKER]] };
	return ok
		? { ok: true, summary: MARKER, data, dataConnectionId: HIDDEN.id }
		: { ok: false, summary: MARKER, error: MARKER, errorFromDatabase: true, dataConnectionId: HIDDEN.id };
}

async function call(port: number, name: string, args: Record<string, unknown>): Promise<string> {
	const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
	});
	const body = await res.json() as { result: { content: { text: string }[] } };
	return body.result.content[0].text;
}

test('no classification reaches, or hands back, a connection that is not exposed to agents', async () => {
	for (const spec of everyClassification()) {
		for (const ok of [true, false]) {
			const invoked: string[] = [];
			const server = new LocalMcpServer({
				serverInfo: { name: 'snoutdata', version: '9.9.9' },
				token: () => TOKEN,
				connections: () => [HIDDEN, SHOWN],
				resolveSchema: async () => null,
				execute: async () => ({ ok: false, error: 'not used' }),
				log: () => undefined,
				capabilities: () => [spec],
				allowMutatingCapabilities: () => true,
				autoApprovedCapabilities: () => [spec.name],
				invokeCapability: async (name) => {
					invoked.push(name);
					return leakingResult(spec, ok);
				},
				resolveCapabilityConnections: async () => ({ ok: true, summary: '', connectionIds: [HIDDEN.id] }),
			});
			const port = await server.start(0);
			try {
				const named = spec.name.includes('_named_');
				const text = await call(port, spec.name, named ? { connectionId: HIDDEN.label } : {});
				const scoped = named || spec.implicitConnection !== 'none' || spec.returnsData !== 'none';
				if (!scoped) {
					// Touches no connection and returns nothing from one: nothing to hold it to.
					assert.deepEqual(invoked, [spec.name]);
					continue;
				}
				// Content is only judged when the spec says it returns some; one that says 'none' and
				// acts on a connection is held before it runs, below.
				if (spec.returnsData !== 'none' || spec.implicitConnection !== 'perItem') {
					assert.equal(text.includes(MARKER), false, `${spec.name} (${ok ? 'ok' : 'failed'}) handed on content from a connection that is not exposed`);
				}
				// Checked BEFORE it runs wherever the connection can be known before it runs.
				if (named || !['none', 'perItem'].includes(spec.implicitConnection)) {
					assert.deepEqual(invoked, [], `${spec.name} ran against a connection that is not exposed`);
				}
			} finally {
				await server.stop();
			}
		}
	}
});

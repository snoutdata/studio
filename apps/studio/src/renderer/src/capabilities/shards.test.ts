/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CloudProjectRow } from '../../../shared/cloudProjects';
import type { CapabilityContext } from './registry';
import { proposalArg, shardsCapabilities } from './shards';
import { takeShardsProposal } from '../shardsProposal';

// The assistant's cluster tools. The rule they keep: no tool runs an operation. Propose plans it,
// leaves it for the Cluster section and opens it; only a person's Run sends anything but a plan.

const tool = (name: string) => shardsCapabilities.find((h) => h.spec.name === name)!;
const REF = 'qwertyzxcv123';

function row(): CloudProjectRow {
	return {
		ref: REF, name: 'Orders', region: 'us-west-2', production: false, state: 'ready', busy: false,
		readOnly: false, wakesInstantly: true, sizeBytes: 100, host: `${REF}.db.snoutdata.com`, database: REF,
		user: `${REF}_owner`, createdAt: null, lastConnectionAt: null, canPause: true, canResume: false, canDelete: true,
	};
}

function ctxWith(answer: (body: Record<string, unknown>) => unknown, sent: Record<string, unknown>[] = [], opened: unknown[] = []): CapabilityContext {
	return {
		api: {
			cloudProjects: async () => ({ account: 'you@example.com', projects: [row()] }),
			cloudProject: async (op: string, body: Record<string, unknown>) => {
				assert.equal(op, 'shards');
				sent.push(body);
				const data = answer(body);
				return data instanceof Error ? { ok: false, refused: true, message: data.message } : { ok: true, data };
			},
		},
		app: { openCloudProject: (...a: unknown[]) => { opened.push(a); } },
		snapshot: () => ({ connections: [], tabs: [], appSettings: {} }),
	} as unknown as CapabilityContext;
}

const PLAN = { op: 'range.move', steps: [{ kind: 'transfer', args: {} }], moves: [], cutovers: 1, estimated_rows: 10, estimated_bytes: 100, estimated_copy_seconds: 1, expected_pause_ms: 50, max_write_pause_ms: 2000, warnings: [] };

test('no shards tool runs an operation, so none needs a consent card', () => {
	for (const h of shardsCapabilities) {
		assert.equal(h.spec.mutates, false, h.spec.name);
	}
});

test('propose plans it, leaves it for the section, opens the section, and runs nothing', async () => {
	const sent: Record<string, unknown>[] = [];
	const opened: unknown[] = [];
	const result = await tool('propose_cloud_cluster_operation').run(
		{ project: 'orders', action: 'move', request: { keyspace: 'acct', range: '-9223372036854775808', to: 'n2' }, reason: 'n1 is full' },
		ctxWith(() => PLAN, sent, opened),
	);
	assert.equal(result.ok, true);
	assert.deepEqual(sent, [{ ref: REF, action: 'move', request: { keyspace: 'acct', range: '-9223372036854775808', to: 'n2' }, plan: true }]);
	assert.deepEqual(opened, [[REF, 'Orders', 'shards']]);
	assert.deepEqual(takeShardsProposal(REF), { action: 'move', request: { keyspace: 'acct', range: '-9223372036854775808', to: 'n2' }, reason: 'n1 is full' });
	assert.match(result.summary, /nothing runs until the user presses Run/);
});

test('a proposal the router refuses comes back in its words, and nothing is opened', async () => {
	const opened: unknown[] = [];
	const result = await tool('propose_cloud_cluster_operation').run({ project: 'Orders', action: 'merge', request: { keyspace: 'k', a: '1', b: '9' } }, ctxWith(() => new Error('those ranges are not adjacent'), [], opened));
	assert.deepEqual({ ok: result.ok, error: result.error, refused: result.refused }, { ok: false, error: 'those ranges are not adjacent', refused: true });
	assert.deepEqual(opened, []);
});

test('an advisor operation is taken as it is, and a 64-bit bound that lost digits is refused', () => {
	assert.deepEqual(proposalArg({ operation: { op: 'range.split', keyspace: 'k', range: '5' } }), { action: 'split', request: { keyspace: 'k', range: '5' } });
	assert.match(String(proposalArg({ action: 'split', request: { range: 4611686018427387904 } })), /as a string/);
	assert.match(String(proposalArg({ action: 'teleport' })), /action must be one of/);
});

test('an unsharded project says whether the account has a project slot for a node', async () => {
	const result = await tool('get_cloud_cluster').run({ project: 'Orders' }, ctxWith(() => ({ ref: REF, sharded: false, projectsUsed: 1, maxProjects: 2, tier: 'plus', pods: [], cluster: null, routerError: null, desiredNodes: 1 })));
	assert.equal(result.ok, true);
	assert.match(String((result.data as { next: string }).next), /1 spare project slot.*propose action enable/);
	const full = await tool('get_cloud_cluster').run({ project: 'Orders' }, ctxWith(() => ({ ref: REF, sharded: false, projectsUsed: 2, maxProjects: 2, tier: 'plus', pods: [], cluster: null, routerError: null, desiredNodes: 1 })));
	assert.match(String((full.data as { next: string }).next), /no spare project slot/);
});

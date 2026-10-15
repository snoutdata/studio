/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	failoverStep, nextRange, nodePods, nodeShade, planIsSentence, planSentence, proposalFromRequest, rangeShares, ranSentence, replicaBlocked, replicaPods, replicaStanding,
	replicaWords, shardsOffered, shortBound, slotsSentence, spareSlots, splitAlerts, type ShardPod,
} from './cloudShards';

// The Shards section's arithmetic and words. A range drawn the wrong width is a cluster misread,
// and an advisor request that does not become the same proposal is an operation nobody asked for.

const MIN = '-9223372036854775808';
const MAX = '9223372036854775807';

test('two even ranges are half the bar each, on exact 64-bit bounds', () => {
	const shares = rangeShares([{ lo: '0', hi: MAX, node: 2 }, { lo: MIN, hi: '-1', node: 1 }]);
	assert.deepEqual(shares.map((s) => [s.range.node, s.percent]), [[1, 50], [2, 50]]);
});

test('a range too thin to see keeps a sliver, so no owner vanishes from the bar', () => {
	const shares = rangeShares([{ lo: MIN, hi: '9223372036854775000', node: 1 }, { lo: '9223372036854775001', hi: MAX, node: 2 }]);
	assert.ok(shares[1].percent > 0 && shares[0].percent > 99);
});

test('merge joins a range with the next by lower bound', () => {
	const keyspace = { name: 'k', key_type: 'bigint', seed: '1', pins: [], ranges: [{ lo: '0', hi: MAX, node: 2 }, { lo: MIN, hi: '-1', node: 1 }] };
	assert.equal(nextRange(keyspace, keyspace.ranges[1])?.lo, '0');
	assert.equal(nextRange(keyspace, keyspace.ranges[0]), null);
});

test('an advisor request becomes a proposal with its op as the action and its fields untouched', () => {
	assert.deepEqual(proposalFromRequest({ op: 'range.split', keyspace: 'k', range: MIN }, 'node 2 is full'), {
		action: 'split', request: { keyspace: 'k', range: MIN }, reason: 'node 2 is full',
	});
	assert.equal(proposalFromRequest({ op: 'restore_point' }), null);
});

test('sharding is offered to a sharded project, or an account with a spare project slot', () => {
	assert.equal(shardsOffered(null), false);
	assert.equal(shardsOffered({ sharded: false, projectsUsed: 2, maxProjects: 2 }), false);
	assert.equal(shardsOffered({ sharded: false, projectsUsed: null, maxProjects: 2 }), false);
	assert.equal(shardsOffered({ sharded: false, projectsUsed: 1, maxProjects: 2 }), true);
	assert.equal(shardsOffered({ sharded: true, projectsUsed: 2, maxProjects: 2 }), true);
	assert.equal(spareSlots({ projectsUsed: 3, maxProjects: 2 }), 0);
	assert.equal(slotsSentence({ projectsUsed: 2, maxProjects: 5, tier: 'pro' }), '2 of 5 project slots used on the pro plan');
	assert.equal(slotsSentence({ projectsUsed: null, maxProjects: 5, tier: 'pro' }), null);
});

test('the words', () => {
	assert.equal(nodeShade(0), nodeShade(8));
	assert.equal(shortBound(MIN), '-92233…5808');
	assert.match(ranSentence({ job: 4 }), /Job 4/);
	assert.match(ranSentence({ created: ['a'] }), /Attach it/);
	assert.match(ranSentence({ created: ['a'], joining: true }), /joins the cluster and takes its share of the data on its own/);
	assert.doesNotMatch(ranSentence({ created: ['a'], joining: true }), /backup/);
	assert.match(ranSentence({ sharded: false, changed: true }), /not a cluster any more/);
	assert.equal(ranSentence({ queued: ['table.distribute'], next: 'public.orders is being spread.' }), 'public.orders is being spread.');
	assert.equal(proposalFromRequest({ op: 'keyspace.drop', name: 'k' })?.action, 'drop-keyspace');
	const plan = { op: 'range.move', steps: [{ kind: 'transfer', args: {} }], moves: [{ source: 1, targets: [2], tables: ['t'], estimated_rows: 1200, expected_pause_ms: 80 }], cutovers: 1, estimated_rows: 1200, estimated_bytes: 1, estimated_copy_seconds: 0.2, expected_pause_ms: 80, max_write_pause_ms: 2000, warnings: [] };
	assert.match(planSentence(plan), /1 cutover, about 1,200 rows/);
	assert.match(planSentence({ ...plan, moves: [], cutovers: 0 }), /nothing moves/);
});

// Replicas and failover. A node told "protected" that is not, or a
// replica counted as a node, is the owner misreading how safe their data is.

const NODE: ShardPod = { ref: 'qrstvwxyzabcd', ordinal: 2, state: 'ready', desiredState: 'running', node: { id: 2, state: 'active' }, next: null, hasOwnBackup: true, replicaOf: null, replica: null, wantsReplica: false, failover: null, failoverError: null };
const REPLICA: ShardPod = { ...NODE, ref: 'efghjkmnpqrst', node: null, replicaOf: 'qrstvwxyzabcd' };

test('a replica is not a node: it is counted apart, under the node it protects', () => {
	const pods = [NODE, REPLICA, { ...NODE, ref: 'gone', desiredState: 'deleted' }];
	assert.deepEqual(nodePods(pods).map((p) => p.ref), ['qrstvwxyzabcd']);
	assert.deepEqual(replicaPods(pods).map((p) => p.ref), ['efghjkmnpqrst']);
});

test('where a node stands with its replica, and an older control plane says nothing', () => {
	assert.equal(replicaStanding(NODE), 'none');
	assert.equal(replicaStanding({ ...NODE, replica: REPLICA.ref }), 'protected');
	assert.equal(replicaStanding({ ...NODE, wantsReplica: true }), 'making');
	assert.equal(replicaStanding({ ...NODE, replica: REPLICA.ref, failover: 'fence' }), 'failing-over');
	assert.equal(replicaStanding({ ...NODE, failover: 'failed', failoverError: 'x' }), 'failover-failed');
	const { replicaOf: _r, replica: _p, wantsReplica: _w, failover: _f, failoverError: _e, ...older } = NODE;
	assert.equal(replicaStanding(older), 'unknown');
	assert.equal(replicaWords('protected'), 'Protected by a replica');
	assert.equal(replicaWords('none'), 'No replica');
	assert.equal(failoverStep({ ...NODE, failover: 'fence' }), 0);
	assert.equal(failoverStep({ ...NODE, failover: 'promote' }), 1);
});

test('a replica is refused before the review when the node has no backup yet or no slot is spare', () => {
	const slots = { projectsUsed: 2, maxProjects: 5 };
	assert.equal(replicaBlocked(NODE, slots), null);
	assert.match(replicaBlocked({ ...NODE, hasOwnBackup: false }, slots) ?? '', /first backup/);
	assert.match(replicaBlocked(NODE, { projectsUsed: 5, maxProjects: 5 }) ?? '', /project slot/);
	// An unread plan does not block: the control plane decides and says why.
	assert.equal(replicaBlocked(NODE, { projectsUsed: null, maxProjects: null }), null);
});

test('alerts split into open and resolved, and a replica plan is its sentence', () => {
	const alert = { id: 'a', kind: 'node-failing', node: null, severity: 'critical' as const, message: 'm', openedAt: '2026-10-11T10:00:00Z', resolvedAt: null, resolution: null, acknowledged: false };
	const split = splitAlerts([alert, { ...alert, id: 'b', resolvedAt: '2026-10-11T11:00:00Z' }]);
	assert.deepEqual([split.open.map((a) => a.id), split.resolved.map((a) => a.id)], [['a'], ['b']]);
	assert.deepEqual(splitAlerts(undefined), { open: [], resolved: [] });
	const plan = { op: 'replica.add', steps: [], moves: [], cutovers: 0, estimated_rows: 0, estimated_bytes: 0, estimated_copy_seconds: 0, expected_pause_ms: 0, max_write_pause_ms: 0, assumptions: 'A replica of node x.', warnings: [] };
	assert.equal(planIsSentence(plan), true);
	assert.equal(planIsSentence({ ...plan, steps: [{ kind: 'router.start', args: {} }] }), false);
	assert.match(ranSentence({ node: 'x', replica: 'y', note: 'n' }), /replica of cluster node x is being made/);
	assert.match(ranSentence({ node: 'x', changed: true }), /being removed/);
	assert.match(ranSentence({ node: 'x', changed: false }), /has no replica/);
	assert.match(ranSentence({ alert: 'a', acknowledged: true }), /Marked as seen/);
});

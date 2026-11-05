/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clusterMapModel } from './cloudClusterMap';
import type { ShardJob, ShardNode, ShardPod, ShardsStatus } from './cloudShards';

// The Cluster section's map. A node drawn serving while its pod is down, or a ref where a role
// belongs, is the map telling a person something untrue about their database.

function node(id: number, name: string, state = 'active', home = false): ShardNode {
	return { id, name, home, state, ranges: [] };
}

function pod(ref: string, extra: Partial<ShardPod> = {}): ShardPod {
	return { ref, ordinal: 1, state: 'ready', desiredState: 'running', node: null, next: null, ...extra };
}

function status(nodes: ShardNode[], pods: ShardPod[] = [], extra: Partial<ShardsStatus> = {}): ShardsStatus {
	return {
		ref: 'abcdefghijklm', sharded: true, projectsUsed: 3, maxProjects: 5, tier: 'pro', desiredNodes: nodes.length,
		pods, cluster: { catalog: true, nodes }, router: 'ready', routerError: null, ...extra,
	};
}

const word = (model: ReturnType<typeof clusterMapModel>, id: string): string => model.marks.find((m) => m.id === id)?.words ?? '(none)';

test('the router sends queries to the home and every node with data, and marks are named by role', () => {
	const model = clusterMapModel(status([node(3, 'nnnnnnnnnnnn2', 'draining'), node(1, 'abcdefghijklm', 'active', true), node(2, 'nnnnnnnnnnnn1')], [pod('nnnnnnnnnnnn1'), pod('nnnnnnnnnnnn2')]));
	// The home first, then by catalog id, which is also the number: it stays as nodes come and go.
	assert.deepEqual(model.marks.map((m) => m.label), ['Router', 'Home', 'Node 2', 'Node 3']);
	assert.deepEqual(model.lines.filter((l) => l.kind === 'queries').map((l) => l.to), ['home', 'node:2', 'node:3']);
	assert.equal(word(model, 'node:3'), "Moving its data out");
	assert.ok(model.marks.every((m) => !/abcdefghijklm|nnnnnnnnnnnn/.test(`${m.label} ${m.words}`)), 'a ref on the map');
	// The router over the middle of the three.
	assert.equal(model.marks[0].column, 1);
	assert.match(model.sentence, /2 nodes holding its rows/);
});

test("a pod's own state outranks the catalog's, and a node that is not ready gets no queries", () => {
	const model = clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true), node(2, 'nnnnnnnnnnnn1')], [pod('nnnnnnnnnnnn1', { state: 'starting' })]));
	assert.equal(word(model, 'node:2'), "Its server is starting");
	assert.ok(!model.lines.some((l) => l.to === 'node:2'));
});

test('a joining node and a pod not in the catalog yet are dashed, get no queries, and say they are copies', () => {
	const model = clusterMapModel(status(
		[node(1, 'abcdefghijklm', 'active', true), node(2, 'nnnnnnnnnnnn1', 'joining')],
		[pod('nnnnnnnnnnnn1', { joining: 'spreading' }), pod('nnnnnnnnnnnn2', { joining: 'copying', next: 'joining' })]
	));
	assert.equal(word(model, 'node:2'), "Taking its share of the data");
	assert.equal(word(model, 'pod:nnnnnnnnnnnn2'), "Starting as a copy of the home node");
	assert.deepEqual(model.lines.map((l) => [l.from, l.to]), [['router', 'home']]);
	assert.ok(model.marks.filter((m) => m.role === 'node').every((m) => m.pending));
	assert.match(model.sentence, /A node is joining/);
	const stopped = clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true)], [pod('nnnnnnnnnnnn2', { joining: 'failed' })]));
	assert.equal(stopped.marks[2].tone, 'error');
});

test('a replica sits under its node, the home\'s under the home, and a failover is said on the node', () => {
	const model = clusterMapModel(status(
		[node(1, 'abcdefghijklm', 'active', true), node(2, 'nnnnnnnnnnnn1')],
		[pod('nnnnnnnnnnnn1', { replica: 'rrrrrrrrrrrr1', failover: 'promote' }), pod('rrrrrrrrrrrr1', { replicaOf: 'nnnnnnnnnnnn1' })],
		{ home: { ref: 'abcdefghijklm', wantsReplica: true, failover: null, replica: 'rrrrrrrrrrrr0' } }
	));
	const replicas = model.marks.filter((m) => m.role === 'replica');
	assert.deepEqual(replicas.map((m) => [m.column, m.row]).sort(), [[0, 2], [1, 2]]);
	assert.deepEqual(model.lines.filter((l) => l.words === 'replica').map((l) => l.from).sort(), ['home', 'node:2']);
	assert.equal(word(model, 'node:2'), "Its replica is taking its place");
	assert.equal(model.rows, 3);
});

test('sizes scale the marks by the square root of their share, and a running job is the sentence', () => {
	const jobs: ShardJob[] = [{ id: 7, op: 'rebalance', state: 'running', error: null, created_at: '', steps: 5, steps_done: 2 }];
	const model = clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true), node(2, 'nnnnnnnnnnnn1')], [pod('nnnnnnnnnnnn1')]), new Map([[1, 4e9], [2, 1e9]]), jobs);
	assert.equal(model.marks.find((m) => m.id === 'home')?.scale, 1.15);
	assert.ok(Math.abs((model.marks.find((m) => m.id === 'node:2')?.scale ?? 0) - 0.975) < 1e-9);
	assert.equal(model.marks.find((m) => m.id === 'node:2')?.bytes, 1e9);
	assert.match(model.sentence, /^Job 7 \(rebalance\) is running: 2 of 5 steps/);
	assert.equal(clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true)])).marks[1].scale, 1);
});

test('a router that is not answering is said on the map and in the sentence; a lone home has nothing spread', () => {
	const down = clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true)], [], { routerError: 'connection refused' }));
	assert.equal(down.marks[0].tone, 'error');
	assert.match(down.sentence, /not answering/);
	assert.match(clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true)])).sentence, /Every row is on the home node/);
	// A removed node is not drawn.
	assert.equal(clusterMapModel(status([node(1, 'abcdefghijklm', 'active', true), node(2, 'x', 'removed')])).marks.length, 2);
});

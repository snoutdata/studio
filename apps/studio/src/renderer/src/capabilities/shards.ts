/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityResult } from '../../../shared/capabilities';
import {
	SHARDS_RUN_ACTIONS, isShardsRunAction, planSentence, proposalFromRequest, replicaStanding, shardsOffered, spareSlots, splitAlerts,
	type ShardAdvice, type ShardJob, type ShardPlan, type ShardsProposal, type ShardsStatus,
} from '../../../shared/cloudShards';
import { proposeShardsOperation } from '../shardsProposal';
import { find, projectConnections } from './cloud';
import type { CapabilityContext, CapabilityHandler } from './registry';

/**
 * A SnoutData Cloud project's cluster, for the assistant and for a coding agent: READ it, PLAN an
 * operation, and PROPOSE one. There is deliberately no tool that runs an operation. Moving a range
 * pauses writes to it, and adding a node is a pod the plan pays for, so a proposal opens the
 * project's Cluster section with the operation filled in and its plan shown, and a person presses
 * Run there or does not (no surprise cutovers).
 *
 * Built for a small model: the project is taken by name, an operation is an `action` from a fixed
 * list with its fields, and the advisor's recommendations come back with an `operation` that
 * propose takes as it is. Every number and refusal is the router's, in its own words.
 */

const PROJECT_PARAM = { type: 'string', description: 'The project, by name (e.g. "orders") or by ref.' } as const;

const ACTION_PARAM = {
	type: 'string',
	enum: [...SHARDS_RUN_ACTIONS],
	description: 'enable (make the project a cluster), add-node (a new cluster node pod), attach (a ready pod: request.node = its ref), drain, remove (request.node), keyspace (request.name, key_type, ranges), distribute (request.table, column, keyspace), reference/global (request.table), split (request.keyspace, range, at?, to?), merge (request.keyspace, a, b), move (request.keyspace, range, to), pin (request.keyspace, value, node?), rebalance, scale (request.nodes = the count wanted, the home included), verify, cleanup, add-replica / remove-replica (request.node = a data node\'s pod ref: a replica follows the node and takes its place on its own if it is lost or corrupt, and takes one project slot).',
} as const;

const REQUEST_PARAM = {
	type: 'object',
	description: 'The operation\'s fields. Range bounds are 64-bit: pass them as strings, exactly as get_cloud_cluster wrote them (a range is named by keyspace and its lo).',
	additionalProperties: true,
} as const;

const OPERATION_PARAM = {
	type: 'object',
	description: 'Instead of action and request: an advisor recommendation\'s `operation` from get_cloud_cluster, as it is.',
	additionalProperties: true,
} as const;

function refused(message: string, wasRefused = true): CapabilityResult {
	return { ok: false, summary: '', error: message, refused: wasRefused };
}

async function shards<T>(ctx: CapabilityContext, ref: string, body: Record<string, unknown> & { action: string }): Promise<{ ok: true; data: T } | { ok: false; error: CapabilityResult }> {
	const outcome = await ctx.api.cloudProject('shards', { ref, ...body });
	return outcome.ok ? { ok: true, data: outcome.data as unknown as T } : { ok: false, error: refused(outcome.message, outcome.refused) };
}

/** The operation the model named: an advisor's `operation`, or an action and its fields. */
export function proposalArg(args: Record<string, unknown>): ShardsProposal | string {
	const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : undefined;
	if (args.operation && typeof args.operation === 'object' && !Array.isArray(args.operation)) {
		return proposalFromRequest(args.operation as Record<string, unknown>, reason) ?? 'operation.op is not one a Cloud project takes; use action and request instead.';
	}
	if (!isShardsRunAction(args.action)) {
		return `action must be one of ${SHARDS_RUN_ACTIONS.join(', ')}.`;
	}
	const request = args.request && typeof args.request === 'object' && !Array.isArray(args.request) ? args.request as Record<string, unknown> : {};
	for (const key of ['range', 'at', 'a', 'b', 'seed']) {
		const value = request[key];
		if (typeof value === 'number' && !Number.isSafeInteger(value)) {
			return `request.${key} is a 64-bit number and lost its last digits as a JSON number. Pass it as a string, exactly as get_cloud_cluster wrote it.`;
		}
	}
	return { action: args.action, request, ...(reason ? { reason } : {}) };
}

export const shardsCapabilities: CapabilityHandler[] = [
	{
		spec: {
			name: 'get_cloud_cluster',
			description: 'A SnoutData Cloud project\'s cluster (one Postgres database spread over several cluster nodes): whether it is a cluster and how many cluster nodes its plan allows, each cluster node with its size and ranges, each keyspace\'s ranges (keyspace, lo, hi, owner), the tables and how they are spread, cluster node pods and the step each waits for, the latest jobs, and the advisor\'s recommendations, each with its reason, plan and a ready-made `operation`. Runs nothing.',
			parameters: { type: 'object', properties: { project: PROJECT_PARAM }, required: ['project'] },
			domain: 'cloud',
			mutates: false,
			implicitConnection: 'target',
			returnsData: 'schema',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const ref = found.row.ref;
			const status = await shards<ShardsStatus>(ctx, ref, { action: 'status' });
			if (!status.ok) {
				return status.error;
			}
			const s = status.data;
			if (!s.sharded || !s.cluster) {
				return {
					ok: true,
					summary: `${found.row.name} is not a cluster`,
					data: { sharded: false, projectsUsed: s.projectsUsed, maxProjects: s.maxProjects, tier: s.tier, routerError: s.routerError, rule: 'Each cluster node counts as one project against the plan.', next: shardsOffered(s) ? `The account has ${spareSlots(s)} spare project slot(s), one per cluster node: propose action enable.` : 'The account has no spare project slot for a cluster node.' },
				};
			}
			const [jobs, advice] = await Promise.all([
				shards<{ jobs: ShardJob[] }>(ctx, ref, { action: 'jobs' }),
				shards<ShardAdvice>(ctx, ref, { action: 'advice', sampleMs: 0 }),
			]);
			const sizes = advice.ok ? advice.data.facts.nodes : [];
			return {
				ok: true,
				summary: `${found.row.name}: ${(s.cluster.nodes ?? []).length} cluster nodes, ${(s.cluster.keyspaces ?? []).length} keyspaces`,
				data: {
					sharded: true,
					projectsUsed: s.projectsUsed,
					maxProjects: s.maxProjects,
					spareSlots: spareSlots(s),
					nodes: (s.cluster.nodes ?? []).map((n) => {
						const pod = n.home ? undefined : s.pods.find((p) => p.ref === n.name && !p.replicaOf);
						return { id: n.id, name: n.name, home: n.home, state: n.state, ranges: n.ranges.length, sizeBytes: sizes.find((f) => f.id === n.id)?.db_bytes ?? null, ...(pod && pod.replicaOf !== undefined ? { replica: replicaStanding(pod) } : {}) };
					}),
					alerts: splitAlerts(s.alerts).open.map((a) => ({ severity: a.severity, kind: a.kind, node: a.node, message: a.message, seen: a.acknowledged })),
					keyspaces: (s.cluster.keyspaces ?? []).map((k) => ({ name: k.name, keyType: k.key_type, ranges: k.ranges, pins: k.pins })),
					tables: s.cluster.tables ?? [],
					pods: s.pods.filter((p) => p.next !== null).map((p) => ({ ref: p.ref, state: p.state, next: p.next })),
					jobs: jobs.ok ? jobs.data.jobs.slice(0, 10) : { error: jobs.error.error },
					advice: advice.ok
						? advice.data.advice.map((one) => ({ op: one.op, reason: one.reason, operation: one.request, needs: one.needs, plan: one.plan ? planSentence(one.plan) : null }))
						: { error: advice.error.error },
					...(s.routerError ? { routerError: s.routerError } : {}),
				},
			};
		},
	},
	{
		spec: {
			name: 'plan_cloud_cluster_operation',
			description: 'The dry run of one operation on a SnoutData Cloud project\'s cluster: its steps, what moves, rows, copy time and the expected write pause, from the router. Changes nothing. Give action and request, or an advisor operation.',
			parameters: {
				type: 'object',
				properties: { project: PROJECT_PARAM, action: ACTION_PARAM, request: REQUEST_PARAM, operation: OPERATION_PARAM },
				required: ['project'],
			},
			domain: 'cloud',
			mutates: false,
			implicitConnection: 'target',
			returnsData: 'schema',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const proposal = proposalArg(args);
			if (typeof proposal === 'string') {
				return refused(proposal, false);
			}
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			const plan = await shards<ShardPlan>(ctx, found.row.ref, { action: proposal.action, request: proposal.request, plan: true });
			if (!plan.ok) {
				return plan.error;
			}
			return { ok: true, summary: planSentence(plan.data), data: { plan: plan.data, next: 'Nothing has run. To have it run, propose it with propose_cloud_cluster_operation: the user reviews it and presses Run.' } };
		},
	},
	{
		spec: {
			name: 'propose_cloud_cluster_operation',
			description: 'Propose one operation on a SnoutData Cloud project\'s cluster: plans it, then opens the project\'s Cluster section with it filled in and its plan shown, where the USER presses Run or not. Nothing runs from this tool. Give action and request, or an advisor operation from get_cloud_cluster, and a short reason the user will read.',
			parameters: {
				type: 'object',
				properties: {
					project: PROJECT_PARAM,
					action: ACTION_PARAM,
					request: REQUEST_PARAM,
					operation: OPERATION_PARAM,
					reason: { type: 'string', description: 'One sentence the user reads above the plan: why this operation.' },
				},
				required: ['project'],
			},
			domain: 'cloud',
			mutates: false,
			implicitConnection: 'target',
			returnsData: 'schema',
		},
		connections: projectConnections,
		run: async (args, ctx) => {
			const proposal = proposalArg(args);
			if (typeof proposal === 'string') {
				return refused(proposal, false);
			}
			const found = await find(ctx, args.project);
			if ('error' in found) {
				return found.error;
			}
			// Planned first, so a proposal the router refuses comes back to the model in its words
			// rather than landing on the user as a review that cannot run.
			const plan = await shards<ShardPlan>(ctx, found.row.ref, { action: proposal.action, request: proposal.request, plan: true });
			if (!plan.ok) {
				return plan.error;
			}
			proposeShardsOperation(found.row.ref, proposal);
			ctx.app.openCloudProject(found.row.ref, found.row.name, 'shards');
			return {
				ok: true,
				summary: `Proposed ${proposal.action} on ${found.row.name}: ${planSentence(plan.data)} Shown for review; nothing runs until the user presses Run.`,
				data: { plan: plan.data, ran: false },
			};
		},
	},
];

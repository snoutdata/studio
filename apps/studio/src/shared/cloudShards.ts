/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A sharded SnoutData Cloud project, as the project tab's Shards section and the assistant read it.
// The shapes `cloud-project-shards` answers in, and the little arithmetic the section does to draw
// them. Types and pure functions only: main forwards every call to the control plane
// (cloudProjectOps.ts, op `shards`), and the router decides everything.

/** One range of a keyspace: bounds as exact text (they are 64-bit), and the node that owns it. */
export interface ShardRange {
	lo: string;
	hi: string;
	node: number;
}

export interface ShardKeyspace {
	name: string;
	key_type: string;
	seed: string;
	ranges: ShardRange[];
	pins: { value: string; node: number }[];
}

export interface ShardNode {
	id: number;
	name: string;
	home: boolean;
	state: string;
	ranges: { keyspace: string; lo: string; hi: string }[];
}

/** The router's `/v1/status`, as far as Studio reads it. */
export interface ShardCluster {
	catalog: boolean;
	epoch?: number | string;
	nodes?: ShardNode[];
	keyspaces?: ShardKeyspace[];
	tables?: { table: string; kind: string; keyspace: string | null; column: string | null }[];
}

/** A node pod of the project and the one step that follows for it. */
export interface ShardPod {
	ref: string;
	ordinal: number;
	state: string;
	desiredState: string;
	node: { id: number; state: string } | null;
	/** `joining`: the cluster is bringing it in on its own (attach, then its share of the data). */
	next: 'attach' | 'delete-pod' | 'wait' | 'joining' | null;
	/** How far its automatic join is, or failed. Absent from a control plane that does not report joins. */
	joining?: 'copying' | 'joining' | 'spreading' | 'failed' | null;
	joinError?: string | null;
	joinJob?: number | null;
	/** Its first backup is done; a replica is made from it (174). */
	hasOwnBackup?: boolean;
	/** Set on a replica: the node it follows and protects. A replica is never attached. Absent from a control plane without replicas. */
	replicaOf?: string | null;
	/** On a node: its replica's ref, when it has one. */
	replica?: string | null;
	/** The owner asked for a replica; a new one is made after a failover. */
	wantsReplica?: boolean;
	/** Its failover to its replica: stopping the node, promoting the replica, or stopped. */
	failover?: 'fence' | 'promote' | 'failed' | null;
	failoverError?: string | null;
}

/** Something that happened to a cluster its owner must know about. */
export interface ShardAlert {
	id: string;
	/** corruption, node-failing, failover-done, failover-failed, replica-missing or replica-behind. */
	kind: string;
	node: string | null;
	severity: 'info' | 'warning' | 'critical';
	message: string;
	openedAt: string;
	resolvedAt: string | null;
	resolution: string | null;
	acknowledged: boolean;
}

/** What the function answers for `status`. */
export interface ShardsStatus {
	ref: string;
	sharded: boolean;
	/** The account's projects plus node pods: each node of a sharded project counts as one project. */
	projectsUsed: number | null;
	/** The plan's project limit, which nodes share. */
	maxProjects: number | null;
	tier: string | null;
	desiredNodes: number;
	pods: ShardPod[];
	cluster: ShardCluster | null;
	/** ready, starting (the restart after clustering is turned on, or a wake), paused, or unreachable. */
	router?: 'ready' | 'starting' | 'paused' | 'unreachable' | null;
	/** Set only when the router is really not answering, never while it starts. */
	routerError: string | null;
	/** A request the cluster is finishing on its own, such as a table being spread. */
	automation?: { active: boolean; queue: string[]; queueJob: number | null; queueError: string | null } | null;
	/** Open alerts first, then those resolved in the last day. Absent from a control plane without alerts. */
	alerts?: ShardAlert[];
}

/** A plan, from the router or (for a pod) the control plane, in one shape. */
export interface ShardPlan {
	op: string;
	steps: { kind: string; args: Record<string, unknown> }[];
	moves: { source: number; targets: number[]; tables: string[]; estimated_rows: number; expected_pause_ms: number }[];
	cutovers: number;
	estimated_rows: number;
	estimated_bytes: number;
	estimated_copy_seconds: number;
	expected_pause_ms: number;
	max_write_pause_ms: number;
	assumptions?: string;
	warnings: string[];
}

export interface ShardJob {
	id: number;
	op: string;
	state: 'pending' | 'running' | 'done' | 'failed' | 'cancelling' | 'cancelled';
	error: string | null;
	created_at: string;
	steps: number;
	steps_done: number;
}

export interface ShardAdvice {
	summary: string;
	advice: {
		op: string;
		request: Record<string, unknown> & { op: string };
		reason: string;
		metric: string;
		needs: string[];
		plan: ShardPlan | null;
	}[];
	facts: {
		nodes: { id: number; name: string; db_bytes: number; connections: number; max_connections: number }[];
		ranges: { keyspace: string; lo: string; rows: number; bytes: number }[];
	};
	assumptions: string;
}

/**
 * An operation somebody is about to review: the function's action and its fields. What the
 * assistant proposes and what a button in the section opens are the same thing.
 */
export interface ShardsProposal {
	action: ShardsRunAction;
	request: Record<string, unknown>;
	/** Why, in a sentence: the advisor's reason, or what the person asked for. */
	reason?: string;
}

/** The actions that change something, which a person runs from the section after reading the plan. */
export const SHARDS_RUN_ACTIONS = [
	'enable', 'disable', 'add-node', 'attach', 'drain', 'remove', 'keyspace', 'drop-keyspace', 'distribute', 'reference', 'global',
	'split', 'merge', 'move', 'pin', 'rebalance', 'scale', 'verify', 'cleanup', 'spread', 'add-replica', 'remove-replica',
] as const;
export type ShardsRunAction = (typeof SHARDS_RUN_ACTIONS)[number];

export function isShardsRunAction(value: unknown): value is ShardsRunAction {
	return typeof value === 'string' && (SHARDS_RUN_ACTIONS as readonly string[]).includes(value);
}

/** The function's action for an operation name, so an advisor's request runs as it is. */
const ACTION_FOR_OP: Readonly<Record<string, ShardsRunAction>> = {
	'node.add': 'add-node',
	'node.attach': 'attach',
	'node.drain': 'drain',
	'node.remove': 'remove',
	'keyspace.create': 'keyspace',
	'table.distribute': 'distribute',
	'table.reference': 'reference',
	'table.global': 'global',
	'range.split': 'split',
	'range.merge': 'merge',
	'range.move': 'move',
	'tenant.pin': 'pin',
	rebalance: 'rebalance',
	scale: 'scale',
	verify: 'verify',
	cleanup: 'cleanup',
	'keyspace.drop': 'drop-keyspace',
	dissolve: 'disable',
	spread: 'spread',
};

/** An advisor request (`{"op": "range.split", ...}`) as a proposal, or null for an op it has no action for. */
export function proposalFromRequest(request: Record<string, unknown>, reason?: string): ShardsProposal | null {
	const action = typeof request.op === 'string' ? ACTION_FOR_OP[request.op] : undefined;
	if (!action) {
		return null;
	}
	const fields = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'op'));
	return { action, request: fields, ...(reason ? { reason } : {}) };
}

/** Is sharding something this project can use? Sharded already, or a spare project slot for a node. */
export function shardsOffered(status: Pick<ShardsStatus, 'sharded' | 'projectsUsed' | 'maxProjects'> | null): boolean {
	return status !== null && (status.sharded || spareSlots(status) > 0);
}

/** Project slots left on the plan, 0 when unread: each node takes one. */
export function spareSlots(status: Pick<ShardsStatus, 'projectsUsed' | 'maxProjects'>): number {
	if (status.projectsUsed === null || status.maxProjects === null) {
		return 0;
	}
	return Math.max(0, status.maxProjects - status.projectsUsed);
}

/** The plan's slots in a sentence, for beside a node count; null when unread. */
export function slotsSentence(status: Pick<ShardsStatus, 'projectsUsed' | 'maxProjects' | 'tier'>): string | null {
	if (status.projectsUsed === null || status.maxProjects === null) {
		return null;
	}
	return `${status.projectsUsed} of ${status.maxProjects} project slots used on the ${status.tier ?? 'current'} plan`;
}

const SPAN = 2n ** 64n;

/** Each range's share of the hash space as a percentage, exact on the bounds; a thin one keeps a sliver. */
export function rangeShares(ranges: readonly ShardRange[]): { range: ShardRange; percent: number }[] {
	const sorted = [...ranges].sort((a, b) => (BigInt(a.lo) < BigInt(b.lo) ? -1 : 1));
	return sorted.map((range) => {
		const width = BigInt(range.hi) - BigInt(range.lo) + 1n;
		const share = Number((width * 1_000_000n) / SPAN) / 10_000;
		return { range, percent: Math.max(share, 0.4) };
	});
}

/** The range after `range` in its keyspace, which a merge joins it with. */
export function nextRange(keyspace: ShardKeyspace, range: ShardRange): ShardRange | null {
	const sorted = [...keyspace.ranges].sort((a, b) => (BigInt(a.lo) < BigInt(b.lo) ? -1 : 1));
	const at = sorted.findIndex((r) => r.lo === range.lo);
	return at >= 0 && at + 1 < sorted.length ? sorted[at + 1] : null;
}

/** A node's step of the theme's accent on the bar: told apart by weight and the legend, not by hue. */
export function nodeShade(index: number): number {
	const steps = [88, 62, 40, 24, 74, 50, 32, 16];
	return steps[((index % steps.length) + steps.length) % steps.length];
}

export function jobFinished(state: string): boolean {
	return state === 'done' || state === 'failed' || state === 'cancelled';
}

/** A plan in one line a person (or a model) can read. */
export function planSentence(plan: ShardPlan): string {
	if (plan.moves.length === 0 && plan.cutovers === 0) {
		return `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} (${plan.steps.map((s) => s.kind).join(', ') || 'none'}); nothing moves and writes do not pause.`;
	}
	return `${plan.cutovers} cutover${plan.cutovers === 1 ? '' : 's'}, about ${plan.estimated_rows.toLocaleString('en-US')} rows, about ${Math.max(1, Math.round(plan.estimated_copy_seconds))}s to copy, writes pause for about ${plan.expected_pause_ms} ms.`;
}

/** A joining node's phase in the words that follow "Cluster node X is …". */
export function joinWords(phase: ShardPod['joining']): string {
	switch (phase) {
		case 'joining':
			return "joining the cluster";
		case 'spreading':
			return "taking its share of the data";
		case 'failed':
			return "stopped";
		default:
			return "starting as a copy of the home node";
	}
}

/** What a run answered, in a sentence: a job started, a pod made or deleted, clustering on or off. */
export function ranSentence(answer: Record<string, unknown>): string {
	if (answer.sharded === false) {
		return answer.changed === false ? "This project is not a cluster." : "This project is not a cluster any more. The database restarts once while the router leaves.";
	}
	if (typeof answer.joining === 'boolean' && typeof answer.node === 'string') {
		return answer.joining ? `${answer.node} is joining the cluster again.` : `${answer.node} is left as it is.`;
	}
	if (answer.queue === 'retrying' || answer.queue === 'cleared') {
		return answer.queue === 'retrying' ? "The cluster is trying that step again." : "The rest of that request was dropped. Nothing else changed.";
	}
	if (typeof answer.next === 'string' && (typeof answer.job === 'number' || Array.isArray(answer.queued))) {
		return answer.next;
	}
	if (typeof answer.job === 'number') {
		return `Job ${answer.job} started. Its progress is under Jobs.`;
	}
	if (Array.isArray(answer.created)) {
		const one = answer.created.length === 1;
		return answer.joining === true
			? `${one ? 'A cluster node is' : `${answer.created.length} cluster nodes are`} on the way. ${one ? 'It starts' : 'Each starts'} as a copy of the home node, then joins the cluster and takes its share of the data on its own.`
			: `${one ? 'A cluster node is' : `${answer.created.length} cluster nodes are`} starting as a copy of the home node. Attach ${one ? 'it' : 'each'} once it is ready.`;
	}
	if (answer.deleted === true) {
		return `The pod of ${String(answer.pod)} is being deleted.`;
	}
	if (answer.unchanged === true) {
		return `The project already has ${String(answer.nodes)} cluster nodes.`;
	}
	if (answer.sharded === true) {
		return answer.changed === false ? "This project is already a cluster." : "This project is a cluster now. The database restarts once while the router joins it.";
	}
	if (typeof answer.replica === 'string' && typeof answer.node === 'string') {
		return `A replica of cluster node ${answer.node} is being made from its backup. It protects the node once it is following it.`;
	}
	if (typeof answer.changed === 'boolean' && typeof answer.node === 'string') {
		return answer.changed ? `The replica of cluster node ${answer.node} is being removed, and its project slot freed.` : `Cluster node ${answer.node} has no replica. Nothing changed.`;
	}
	if (answer.acknowledged === true) {
		return "Marked as seen. The alert stays open until what it is about is over.";
	}
	return "Done.";
}

/** A plan that is a sentence rather than steps (a replica added or removed): nothing moves, nothing pauses. */
export function planIsSentence(plan: ShardPlan): boolean {
	return plan.steps.length === 0 && plan.moves.length === 0 && plan.cutovers === 0 && Boolean(plan.assumptions);
}

/** The alerts still open, and those resolved in the last day, each newest first as the function sends them. */
export function splitAlerts(alerts: readonly ShardAlert[] | undefined): { open: ShardAlert[]; resolved: ShardAlert[] } {
	const all = alerts ?? [];
	return { open: all.filter((a) => a.resolvedAt === null), resolved: all.filter((a) => a.resolvedAt !== null) };
}

/** The data nodes' pods: everything that is not a replica and is not being deleted. */
export function nodePods(pods: readonly ShardPod[]): ShardPod[] {
	return pods.filter((p) => !p.replicaOf && p.desiredState !== 'deleted');
}

/** The replicas, each beside the node it protects. */
export function replicaPods(pods: readonly ShardPod[]): ShardPod[] {
	return pods.filter((p) => Boolean(p.replicaOf) && p.desiredState !== 'deleted');
}

/**
 * Where a data node stands with its replica, for the nodes table. `unknown` for a control plane
 * that says nothing about replicas.
 */
export type ReplicaStanding = 'protected' | 'making' | 'none' | 'failing-over' | 'failover-failed' | 'unknown';

export function replicaStanding(pod: ShardPod): ReplicaStanding {
	if (pod.failover === 'fence' || pod.failover === 'promote') {
		return 'failing-over';
	}
	if (pod.failover === 'failed') {
		return 'failover-failed';
	}
	if (pod.replicaOf === undefined) {
		return 'unknown';
	}
	if (pod.replica) {
		return 'protected';
	}
	return pod.wantsReplica ? 'making' : 'none';
}

/** The words for a standing, as the nodes table shows them. */
export function replicaWords(standing: ReplicaStanding): string {
	switch (standing) {
		case 'protected':
			return "Protected by a replica";
		case 'making':
			return "A replica is being made";
		case 'none':
			return "No replica";
		case 'failing-over':
			return "Its replica is taking its place";
		case 'failover-failed':
			return "Its replica could not take its place";
		default:
			return '-';
	}
}

/** A failover's steps, and which one it is on: 0 stopping the node, 1 the replica taking its place. */
export const FAILOVER_STEPS = ["The node is stopped", "Its replica takes its place", "A new replica is made"] as const;

export function failoverStep(pod: ShardPod): number {
	return pod.failover === 'fence' ? 0 : 1;
}

/** Why a replica cannot be added to a node just now, or null when it can. */
export function replicaBlocked(pod: ShardPod, status: Pick<ShardsStatus, 'projectsUsed' | 'maxProjects'>): string | null {
	if (pod.hasOwnBackup === false) {
		return "Its first backup is not finished yet, and a replica is made from it.";
	}
	if (status.projectsUsed !== null && status.maxProjects !== null && spareSlots(status) === 0) {
		return "A replica takes one project slot, and all of your plan's are in use.";
	}
	return null;
}

/** A 64-bit bound shortened for a narrow cell; the whole value goes in the title. */
export function shortBound(value: string): string {
	return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

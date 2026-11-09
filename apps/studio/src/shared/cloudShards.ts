/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A sharded SnoutData Cloud project, as the project tab's Shards section and the assistant read it.
// The shapes `cloud-project-shards` answers in, and the little arithmetic the section does to draw
// them. Types and pure functions only: main forwards every call to the control plane
// (cloudProjectOps.ts, op `shards`), and the router decides everything.

/** One range of a keyspace: bounds as exact text (they are 64-bit), and the node that owns it. */
import { t } from './i18n/core';

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
	failover?: 'fence' | 'promote' | 'held' | 'failed' | null;
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
	/**
	 * The home node's replica and failover (migration 222), which no pod row carries: the home is the
	 * project. Absent from a control plane older than 222, whose home could not have a replica.
	 */
	home?: { ref: string; wantsReplica: boolean; failover: 'fence' | 'swap' | 'held' | 'failed' | null; replica: string | null } | null;
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
	/** A table operation's design check of the tables it changes, read before anything moves. */
	check?: DesignCheck;
}

/** One finding of the design check (`GET /v1/check`): what the keys say. */
export interface CheckFinding {
	severity: 'error' | 'warn' | 'info';
	code: string;
	table: string;
	related: string[];
	message: string;
	fix: string;
	/** SQL the owner runs themselves (an index, a column), through the router. */
	sql: string | null;
	/** The request that does the fix (`{"op": "table.distribute", ...}`). */
	operation: Record<string, unknown> | null;
}

/** The design check: every finding, most severe first, and the counts. */
export interface DesignCheck {
	findings: CheckFinding[];
	summary: { errors: number; warnings: number; info: number; tables: number; foreign_keys: number };
	/** A plan's check that could not read the home node says so instead. */
	error?: string;
}

/** The check in a sentence: nothing found, or how much of each. */
export function checkSentence(check: DesignCheck): string {
	const { errors, warnings, info, tables } = check.summary;
	const checked = t('engineCloudShards.check.checked', { count: tables });
	if (errors + warnings + info === 0) {
		return t('engineCloudShards.check.clean', { checked });
	}
	const parts = [
		errors > 0 ? t('engineCloudShards.check.toFix', { n: errors }) : null,
		warnings > 0 ? t('engineCloudShards.check.toLookAt', { n: warnings }) : null,
		info > 0 ? t('engineCloudShards.check.suggestions', { count: info }) : null,
	].filter((p): p is string => p !== null);
	return t('engineCloudShards.check.summary', { checked, parts: parts.join(', ') });
}

/** A finding's severity in the section's words. */
export function severityWord(severity: CheckFinding['severity']): string {
	return severity === 'error' ? t('engineCloudShards.severity.fix') : severity === 'warn' ? t('engineCloudShards.severity.worthAlook') : t('engineCloudShards.severity.suggestion');
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
	return t('engineCloudShards.slots', { used: status.projectsUsed, max: status.maxProjects, tier: status.tier ?? t('engineCloudShards.tierCurrent') });
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

/** The plan as the section shows it, in the app's language. planSentence stays English for the model. */
export function planWords(plan: ShardPlan): string {
	if (plan.moves.length === 0 && plan.cutovers === 0) {
		return t('engineCloudShards.plan.noMove', { count: plan.steps.length, kinds: plan.steps.map((s) => s.kind).join(', ') || t('engineCloudShards.plan.none') });
	}
	return t('engineCloudShards.plan.moves', { count: plan.cutovers, rows: plan.estimated_rows, seconds: Math.max(1, Math.round(plan.estimated_copy_seconds)), ms: plan.expected_pause_ms });
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
			return t('engineCloudShards.join.joining');
		case 'spreading':
			return t('engineCloudShards.join.spreading');
		case 'failed':
			return t('engineCloudShards.join.stopped');
		default:
			return t('engineCloudShards.join.starting');
	}
}

/** What a run answered, in a sentence: a job started, a pod made or deleted, clustering on or off. */
export function ranSentence(answer: Record<string, unknown>): string {
	if (answer.sharded === false) {
		return answer.changed === false ? t('engineCloudShards.ran.notCluster') : t('engineCloudShards.ran.notClusterAnyMore');
	}
	if (typeof answer.joining === 'boolean' && typeof answer.node === 'string') {
		return answer.joining ? t('engineCloudShards.ran.rejoining', { node: answer.node }) : t('engineCloudShards.ran.leftAsIs', { node: answer.node });
	}
	if (answer.queue === 'retrying' || answer.queue === 'cleared') {
		return answer.queue === 'retrying' ? t('engineCloudShards.ran.retrying') : t('engineCloudShards.ran.dropped');
	}
	if (typeof answer.next === 'string' && (typeof answer.job === 'number' || Array.isArray(answer.queued))) {
		return answer.next;
	}
	if (typeof answer.job === 'number') {
		return t('engineCloudShards.ran.jobStarted', { job: String(answer.job) });
	}
	if (Array.isArray(answer.created)) {
		return answer.joining === true
			? t('engineCloudShards.ran.createdJoining', { count: answer.created.length })
			: t('engineCloudShards.ran.createdStarting', { count: answer.created.length });
	}
	if (answer.deleted === true) {
		return t('engineCloudShards.ran.podDeleted', { pod: String(answer.pod) });
	}
	if (answer.unchanged === true) {
		return t('engineCloudShards.ran.alreadyNodes', { nodes: String(answer.nodes) });
	}
	if (answer.sharded === true) {
		return answer.changed === false ? t('engineCloudShards.ran.alreadyCluster') : t('engineCloudShards.ran.nowCluster');
	}
	if (typeof answer.replica === 'string' && typeof answer.node === 'string') {
		return t('engineCloudShards.ran.replicaMaking', { node: answer.node });
	}
	if (typeof answer.changed === 'boolean' && typeof answer.node === 'string') {
		return answer.changed ? t('engineCloudShards.ran.replicaRemoving', { node: answer.node }) : t('engineCloudShards.ran.noReplica', { node: answer.node });
	}
	if (answer.acknowledged === true) {
		return t('engineCloudShards.ran.marked');
	}
	return t('engineCloudShards.ran.done');
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
	if (pod.failover === 'failed' || pod.failover === 'held') {
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

/** The home's standing (222), from the status's `home`; 'unknown' from a control plane older than it. */
export function homeReplicaStanding(home: ShardsStatus['home']): ReplicaStanding {
	if (!home) {
		return 'unknown';
	}
	if (home.failover === 'fence' || home.failover === 'swap') {
		return 'failing-over';
	}
	if (home.failover === 'held' || home.failover === 'failed') {
		return 'failover-failed';
	}
	if (home.replica) {
		return 'protected';
	}
	return home.wantsReplica ? 'making' : 'none';
}

/** The words for a standing, as the nodes table shows them. */
export function replicaWords(standing: ReplicaStanding): string {
	switch (standing) {
		case 'protected':
			return t('engineCloudShards.replica.protected');
		case 'making':
			return t('engineCloudShards.replica.making');
		case 'none':
			return t('engineCloudShards.replica.none');
		case 'failing-over':
			return t('engineCloudShards.replica.failingOver');
		case 'failover-failed':
			return t('engineCloudShards.replica.failoverFailed');
		default:
			return '-';
	}
}

/** A failover's steps, and which one it is on: 0 stopping the node, 1 the replica taking its place. */
export function failoverSteps(): readonly string[] {
	return [t('engineCloudShards.failover.stopped'), t('engineCloudShards.failover.replicaTakes'), t('engineCloudShards.failover.newReplica')];
}

export function failoverStep(pod: ShardPod): number {
	return pod.failover === 'fence' ? 0 : 1;
}

/** Why a replica cannot be added to a node just now, or null when it can. */
export function replicaBlocked(pod: ShardPod, status: Pick<ShardsStatus, 'projectsUsed' | 'maxProjects'>): string | null {
	if (pod.hasOwnBackup === false) {
		return t('engineCloudShards.blocked.firstBackup');
	}
	if (status.projectsUsed !== null && status.maxProjects !== null && spareSlots(status) === 0) {
		return t('engineCloudShards.blocked.noSlot');
	}
	return null;
}

/** A 64-bit bound shortened for a narrow cell; the whole value goes in the title. */
export function shortBound(value: string): string {
	return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Cluster section's map: a sharded cloud project's
// router, home node, cluster nodes and replicas as a small drawn network, each mark with its state
// in words. Pure, from the same status and advice the section already reads; `ClusterMap.tsx`
// draws it. Studio's own, sharing nothing with the dashboard's map.
//
// - Marks are named by role (Router, Home, Node 2, New node, Replica), never by a ref or a host; a
//   node's number is its catalog id, so it stays the same as nodes come and go.
// - The router sends queries to the home and to every node that holds data (`active`, and
//   `draining` while its data moves out): solid lines. A replica follows its node: a dashed line.
//   A node still joining is a dashed mark whose words say it is a copy of the home; a line across
//   the row to the home would cross every mark between them.
// - A pod's own state outranks the catalog's: a node whose pod is not ready says so first.
// - Each node is drawn by its data when the advisor has measured it.

import { joinWords, jobFinished, nodePods, replicaPods, type ShardJob, type ShardsStatus } from './cloudShards';
import { t } from './i18n/core';

export type ClusterMarkTone = 'ok' | 'quiet' | 'warn' | 'error';

export interface ClusterMark {
	id: string;
	role: 'router' | 'home' | 'node' | 'replica';
	label: string;
	words: string;
	tone: ClusterMarkTone;
	/** Drawn dashed: it holds a copy and serves nothing yet. */
	pending: boolean;
	/** The catalog node it is (the home's too), for its colour beside the ranges; null for the rest. */
	catalogId: number | null;
	/** The node's bytes, when the advisor has measured them. */
	bytes: number | null;
	/** 0.8 to 1.15 by the square root of its share of the biggest node; 1 without sizes. */
	scale: number;
	row: number;
	column: number;
}

export interface ClusterLine {
	from: string;
	to: string;
	kind: 'queries' | 'follows';
	words?: string;
}

export interface ClusterMapModel {
	marks: ClusterMark[];
	lines: ClusterLine[];
	columns: number;
	rows: number;
	/** What is happening, in a sentence, over the map. */
	sentence: string;
}

/** The catalog node id's bytes (the advisor's facts), when it has measured them. */
export type NodeSizes = ReadonlyMap<number, number>;

function stopping(failover: string | null | undefined): { words: string; tone: ClusterMarkTone } | null {
	if (failover === 'fence' || failover === 'promote' || failover === 'swap') {
		return { words: t('engineCluster.replicaTaking'), tone: 'warn' };
	}
	if (failover === 'held' || failover === 'failed') {
		return { words: t('engineCluster.replicaFailed'), tone: 'error' };
	}
	return null;
}

function capital(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function clusterMapModel(status: ShardsStatus, sizes?: NodeSizes, jobs?: readonly ShardJob[] | null): ClusterMapModel {
	const catalog = (status.cluster?.nodes ?? []).filter((n) => n.state !== 'removed');
	const pods = nodePods(status.pods);
	const marks: ClusterMark[] = [];
	const lines: ClusterLine[] = [];
	const biggest = Math.max(0, ...catalog.map((n) => sizes?.get(n.id) ?? 0));
	const scaleOf = (id: number): number => {
		const bytes = sizes?.get(id);
		return bytes === undefined || biggest <= 0 ? 1 : 0.8 + 0.35 * Math.sqrt(bytes / biggest);
	};

	const router = status.routerError || status.router === 'unreachable'
		? { words: t('engineCluster.routerDown'), tone: 'error' as const }
		: status.router === 'starting'
			? { words: t('engineCluster.routerStarting'), tone: 'quiet' as const }
			: status.router === 'paused'
				? { words: t('engineCluster.routerPaused'), tone: 'quiet' as const }
				: { words: t('engineCluster.routerOk'), tone: 'ok' as const };
	marks.push({ id: 'router', role: 'router', label: t('engineCluster.router'), ...router, pending: false, catalogId: null, bytes: null, scale: 1, row: 0, column: 0 });

	// The home first, then the nodes in the catalog's order, then pods the catalog has not got yet.
	const ordered = [...catalog.filter((n) => n.home), ...catalog.filter((n) => !n.home).sort((a, b) => a.id - b.id)];
	let column = 0;
	const columnOf = new Map<string, number>();
	for (const node of ordered) {
		const pod = node.home ? undefined : pods.find((p) => p.ref === node.name);
		const id = node.home ? 'home' : `node:${node.id}`;
		let words = t('engineCluster.serves');
		let tone: ClusterMarkTone = 'ok';
		let pending = false;
		const failing = stopping(node.home ? status.home?.failover : pod?.failover);
		if (failing) {
			({ words, tone } = failing);
		} else if (pod && pod.state !== 'ready') {
			words = t('engineCluster.serverStarting');
			tone = 'quiet';
		} else if (node.state === 'joining') {
			words = pod?.joining === 'failed' ? t('engineCluster.joinStopped') : capital(joinWords(pod?.joining ?? 'joining'));
			tone = pod?.joining === 'failed' ? 'error' : 'quiet';
			pending = true;
		} else if (node.state === 'draining') {
			words = t('engineCluster.draining');
			tone = 'quiet';
		} else if (node.state !== 'active') {
			words = capital(node.state);
			tone = 'quiet';
		} else if (node.home) {
			words = t('engineCluster.holdsHome');
		}
		marks.push({
			id,
			role: node.home ? 'home' : 'node',
			label: node.home ? t('engineCluster.home') : t('engineCluster.node', { id: String(node.id) }),
			words,
			tone,
			pending,
			catalogId: node.id,
			bytes: sizes?.get(node.id) ?? null,
			scale: scaleOf(node.id),
			row: 1,
			column
		});
		columnOf.set(node.home ? status.ref : node.name, column);
		columnOf.set(node.name, column);
		if ((node.state === 'active' || node.state === 'draining') && (!pod || pod.state === 'ready')) {
			lines.push({ from: 'router', to: id, kind: 'queries', ...(column === 0 ? { words: t('engineCluster.queries') } : {}) });
		}
		column += 1;
	}
	for (const pod of pods.filter((p) => !p.node && !catalog.some((n) => n.name === p.ref))) {
		const failed = pod.joining === 'failed';
		marks.push({
			id: `pod:${pod.ref}`,
			role: 'node',
			label: t('engineCluster.newNode'),
			words: failed ? t('engineCluster.joinStopped') : capital(joinWords(pod.joining ?? null)),
			tone: failed ? 'error' : 'quiet',
			pending: true,
			catalogId: null,
			bytes: null,
			scale: 1,
			row: 1,
			column
		});
		columnOf.set(pod.ref, column);
		column += 1;
	}

	// Replicas under the node each follows; the home's may be known only from `status.home`.
	const replicas = replicaPods(status.pods);
	const placed = new Set<number>();
	const replicaMark = (key: string, of: number, following: boolean): void => {
		const ofId = marks.find((m) => m.row === 1 && m.column === of)?.id;
		marks.push({
			id: `replica:${key}`,
			role: 'replica',
			label: t('engineCluster.replica'),
			words: following ? t('engineCluster.follows') : t('engineCluster.fromBackup'),
			tone: 'quiet',
			pending: !following,
			catalogId: null,
			bytes: null,
			scale: 0.85,
			row: 2,
			column: of
		});
		placed.add(of);
		if (ofId) {
			lines.push({ from: ofId, to: `replica:${key}`, kind: 'follows', words: t('engineCluster.replicaLine') });
		}
	};
	for (const pod of replicas) {
		const of = columnOf.get(pod.replicaOf ?? '');
		if (of !== undefined && !placed.has(of)) {
			replicaMark(pod.ref, of, pod.state === 'ready');
		}
	}
	if (status.home?.replica && !placed.has(0) && marks.some((m) => m.id === 'home')) {
		replicaMark(status.home.replica, 0, true);
	}

	const columns = Math.max(1, column);
	// The router sits over the middle of the row it sends to.
	marks[0].column = (columns - 1) / 2;
	return { marks, lines, columns, rows: placed.size > 0 ? 3 : 2, sentence: mapSentence(status, marks, lines, jobs ?? null) };
}

function mapSentence(status: ShardsStatus, marks: readonly ClusterMark[], lines: readonly ClusterLine[], jobs: readonly ShardJob[] | null): string {
	const running = (jobs ?? []).find((j) => !jobFinished(j.state));
	if (running) {
		return running.state === 'pending'
			? t('engineCluster.jobWaiting', { id: String(running.id), op: running.op, done: running.steps_done, steps: running.steps })
			: t('engineCluster.jobState', { id: String(running.id), op: running.op, state: running.state, done: running.steps_done, steps: running.steps });
	}
	if (status.routerError || status.router === 'unreachable') {
		return t('engineCluster.sentenceRouterDown');
	}
	if (marks.some((m) => m.pending && m.role === 'node')) {
		return t('engineCluster.sentenceJoining');
	}
	// The nodes the router sends to: a draining node still holds rows until they have moved.
	const serving = lines.filter((l) => l.kind === 'queries' && l.to !== 'home').length;
	return serving === 0
		? t('engineCluster.sentenceHomeOnly')
		: t('engineCluster.sentenceServing', { count: serving });
}

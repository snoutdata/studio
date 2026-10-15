/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snout Orbit's force layout.
 *
 * Takes the `OrbitGraph` a schema implies and gives every node a place in 3D. Pure: no DOM, no
 * three.js, no `node:` anything, so it runs in the normal `npm test` tier and a layout that
 * silently drifts fails a test instead of looking slightly wrong on someone's screen.
 *
 * Three things here are the design and not incidental:
 *
 *  - **It stops.** `alpha` cools geometrically to a hard zero, at which point `home` is
 *    snapshotted and `step()` is a no-op. A database is not a lava lamp; once the shape is found
 *    it holds still, and Pulse's packets are then the only thing that moves (`kick`/`relax`).
 *  - **Repulsion is stochastic and intra-cluster.** Each node pushes off 14 randomly sampled
 *    peers FROM ITS OWN SCHEMA, not all N. That is what makes 10k objects a per-frame cost of
 *    140k pair tests instead of 100M, and keeping it inside the cluster is why the clusters stay
 *    apart rather than blowing each other away.
 *  - **Every random number comes from a seeded PRNG.** Same graph plus same seed is the same
 *    layout, byte for byte, which is the only reason any of this can be asserted.
 */

import type { OrbitGraph, OrbitLink } from './orbit';

export interface LayoutOptions {
	/** Radius of the sphere the schema centroids sit on. */
	spread: number;
	/** Multiplier on the pull toward a node's own schema centroid. */
	gravity: number;
	/** Seed for the internal RNG. Same seed + same graph must give identical positions. */
	seed: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = { spread: 380, gravity: 1.6, seed: 1 };

export interface OrbitLayoutState {
	/** 3 floats per node, indexed by node id. Live — the renderer reads this every frame. */
	readonly positions: Float32Array;
	/** Rest positions, snapshotted the moment the simulation settles. */
	readonly home: Float32Array;
	readonly settled: boolean;
	readonly alpha: number;
	/** One simulation tick. No-op once settled. */
	step(): void;
	/** Run `iterations` ticks now (used to warm the layout before the first frame). */
	settle(iterations: number): void;
	/** Knock one node off its rest position (a query packet landed on it). */
	kick(node: number, strength?: number): void;
	/** Spring the knocked nodes back toward home. Cheap: only excited nodes move. */
	relax(): void;
	excitedCount(): number;
	/** Changing spread or gravity re-wakes the simulation. */
	setOptions(options: Partial<LayoutOptions>): void;
	bounds(): { cx: number; cy: number; cz: number; radius: number };
}

/** A flatter disc reads as a map; a true ball reads as a mess with half of it behind the rest. */
const CENTROID_FLATTEN = 0.62;
/** How many peers a node pushes off per tick. The whole performance story is this number. */
const REPULSION_SAMPLES = 14;
const DAMPING = 0.82;
const COOLING = 0.985;
/** Below this the movement is under a pixel; stopping dead is better than trembling forever. */
const ALPHA_FLOOR = 0.004;
/** Two nodes closer than this have no meaningful direction between them. */
const EPSILON = 1e-6;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function random(): number {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Box-Muller. `1 - random()` keeps the log off zero, which is the only way this returns NaN. */
function gaussian(random: () => number): number {
	const u = 1 - random();
	const v = random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** An index sits ON its table, a dependency near it, a foreign key at arm's length, and a
 *  cross-schema foreign key at the length of the gap between two schemas. */
function restLength(link: OrbitLink): number {
	if (link.kind === 'index') {
		return 11;
	}
	if (link.kind === 'depends') {
		return 18;
	}
	return link.crossSchema ? 150 : 40;
}

/** A cross-schema foreign key is nearly slack on purpose: it should bend the two clusters toward
 *  each other, not drag one into the other and undo the clustering. */
function stiffness(link: OrbitLink): number {
	if (link.kind !== 'fk') {
		return 0.055;
	}
	return link.crossSchema ? 0.0035 : 0.014;
}

export function createOrbitLayout(graph: OrbitGraph, options: Partial<LayoutOptions> = {}): OrbitLayoutState {
	const opts: LayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
	const count = graph.nodes.length;
	const positions = new Float32Array(count * 3);
	const velocities = new Float32Array(count * 3);
	const home = new Float32Array(count * 3);
	const centroids = new Float32Array(Math.max(graph.clusters.length, 1) * 3);
	/** Cluster -> its node ids, so repulsion can sample a peer without scanning the graph. */
	const members: number[][] = graph.clusters.map(() => []);

	let random = mulberry32(opts.seed);
	let alpha = 1;
	let settled = false;
	const excited: number[] = [];
	const isExcited = new Uint8Array(count);

	function placeCentroids(): void {
		const clusters = graph.clusters.length;
		for (let i = 0; i < clusters; i++) {
			// Fibonacci sphere: the cheapest even spread over a sphere that needs no relaxation
			// of its own, and it is stable, so adding a schema does not reshuffle the others.
			const y = clusters === 1 ? 0 : 1 - ((i + 0.5) / clusters) * 2;
			const ring = Math.sqrt(Math.max(0, 1 - y * y));
			const theta = Math.PI * (3 - Math.sqrt(5)) * i;
			centroids[i * 3] = Math.cos(theta) * ring * opts.spread;
			centroids[i * 3 + 1] = y * CENTROID_FLATTEN * opts.spread;
			centroids[i * 3 + 2] = Math.sin(theta) * ring * opts.spread;
		}
	}

	function seed(): void {
		placeCentroids();
		for (let i = 0; i < count; i++) {
			const node = graph.nodes[i];
			members[node.cluster].push(i);
			// A big schema needs a bigger blob or its own repulsion spends the first hundred
			// ticks just getting the nodes off each other.
			const jitter = 11 + Math.sqrt(graph.clusters[node.cluster].size) * 2.4;
			const c = node.cluster * 3;
			positions[i * 3] = centroids[c] + gaussian(random) * jitter;
			positions[i * 3 + 1] = centroids[c + 1] + gaussian(random) * jitter;
			positions[i * 3 + 2] = centroids[c + 2] + gaussian(random) * jitter;
		}
		// Never leave `home` as zeros: a consumer that reads it before the layout settles should
		// get somewhere plausible rather than every node stacked on the origin.
		home.set(positions);
	}

	function springs(): void {
		for (const link of graph.links) {
			const a = link.a * 3;
			const b = link.b * 3;
			const dx = positions[b] - positions[a];
			const dy = positions[b + 1] - positions[a + 1];
			const dz = positions[b + 2] - positions[a + 2];
			const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (distance < EPSILON) {
				// Coincident ends have no direction to pull along; dividing here is the classic
				// way this whole array becomes NaN.
				continue;
			}
			const force = ((distance - restLength(link)) * stiffness(link) * alpha) / distance;
			const fx = dx * force * 0.5;
			const fy = dy * force * 0.5;
			const fz = dz * force * 0.5;
			velocities[a] += fx;
			velocities[a + 1] += fy;
			velocities[a + 2] += fz;
			velocities[b] -= fx;
			velocities[b + 1] -= fy;
			velocities[b + 2] -= fz;
		}
	}

	function gravity(): void {
		const pull = 0.0075 * opts.gravity * alpha;
		for (let i = 0; i < count; i++) {
			const p = i * 3;
			const c = graph.nodes[i].cluster * 3;
			velocities[p] += (centroids[c] - positions[p]) * pull;
			velocities[p + 1] += (centroids[c + 1] - positions[p + 1]) * pull;
			velocities[p + 2] += (centroids[c + 2] - positions[p + 2]) * pull;
		}
	}

	function repulsion(): void {
		for (let i = 0; i < count; i++) {
			const peers = members[graph.nodes[i].cluster];
			if (peers.length < 2) {
				continue;
			}
			const p = i * 3;
			for (let s = 0; s < REPULSION_SAMPLES; s++) {
				const other = peers[Math.floor(random() * peers.length)];
				if (other === i) {
					continue;
				}
				const q = other * 3;
				const dx = positions[p] - positions[q];
				const dy = positions[p + 1] - positions[q + 1];
				const dz = positions[p + 2] - positions[q + 2];
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 < EPSILON) {
					// Stacked exactly: push off in a random direction rather than nowhere.
					velocities[p] += (random() - 0.5) * 0.45;
					velocities[p + 1] += (random() - 0.5) * 0.45;
					velocities[p + 2] += (random() - 0.5) * 0.45;
					continue;
				}
				// The +4 keeps a near-collision from becoming an ejection; the clamp keeps the
				// one that still gets through from leaving the scene.
				const force = Math.min(0.45, (55 * alpha) / (d2 + 4)) / Math.sqrt(d2);
				velocities[p] += dx * force;
				velocities[p + 1] += dy * force;
				velocities[p + 2] += dz * force;
			}
		}
	}

	/**
	 * Per-axis speed limit. Spring force is summed once per link with no normalisation by degree,
	 * so a single node carrying thousands of relations accumulates a force its damping cannot
	 * absorb and the whole world diverges: measured stable at 2,000 relations on one node and at
	 * `radius = 1.9e7` by 3,000, which reaches the renderer as a camera at NaN and a black tab.
	 *
	 * A clamp rather than a per-degree normalisation ON PURPOSE. Normalising would change where
	 * every ordinary graph settles, and every ordinary graph is already tuned and correct; this
	 * only engages in the runaway, where any finite answer beats an infinite one. A hub that hits
	 * the limit simply takes a few more ticks to arrive.
	 */
	const MAX_SPEED = 40;

	function integrate(): void {
		for (let i = 0; i < velocities.length; i++) {
			let velocity = velocities[i] * DAMPING;
			if (!Number.isFinite(velocity)) {
				velocity = 0;
			} else if (velocity > MAX_SPEED) {
				velocity = MAX_SPEED;
			} else if (velocity < -MAX_SPEED) {
				velocity = -MAX_SPEED;
			}
			velocities[i] = velocity;
			positions[i] += velocity;
		}
	}

	function step(): void {
		if (settled) {
			return;
		}
		springs();
		gravity();
		repulsion();
		integrate();
		alpha *= COOLING;
		if (alpha < ALPHA_FLOOR) {
			alpha = 0;
			home.set(positions);
			velocities.fill(0);
			settled = true;
		}
	}

	function settle(iterations: number): void {
		for (let i = 0; i < iterations && !settled; i++) {
			step();
		}
	}

	function kick(node: number, strength = 0.85): void {
		// Before the layout settles there is no rest position to spring back to, so a packet
		// landing on a node that is still moving is simply ignored.
		if (!settled || node < 0 || node >= count) {
			return;
		}
		const p = node * 3;
		velocities[p] += (random() * 2 - 1) * strength;
		velocities[p + 1] += (random() * 2 - 1) * strength;
		velocities[p + 2] += (random() * 2 - 1) * strength;
		if (!isExcited[node]) {
			isExcited[node] = 1;
			excited.push(node);
		}
	}

	function relax(): void {
		for (let i = excited.length - 1; i >= 0; i--) {
			const node = excited[i];
			const p = node * 3;
			let residual = 0;
			for (let axis = 0; axis < 3; axis++) {
				const k = p + axis;
				const v = (velocities[k] + (home[k] - positions[k]) * 0.14) * 0.85;
				velocities[k] = v;
				positions[k] += v;
				residual += Math.abs(v) + Math.abs(home[k] - positions[k]);
			}
			if (residual < 0.03) {
				// Snap exactly, so a node that has been kicked a thousand times has not crept.
				positions[p] = home[p];
				positions[p + 1] = home[p + 1];
				positions[p + 2] = home[p + 2];
				velocities[p] = 0;
				velocities[p + 1] = 0;
				velocities[p + 2] = 0;
				isExcited[node] = 0;
				excited.splice(i, 1);
			}
		}
	}

	function setOptions(next: Partial<LayoutOptions>): void {
		const spreadChanged = next.spread !== undefined && next.spread !== opts.spread;
		const gravityChanged = next.gravity !== undefined && next.gravity !== opts.gravity;
		const seedChanged = next.seed !== undefined && next.seed !== opts.seed;
		Object.assign(opts, next);
		if (seedChanged) {
			random = mulberry32(opts.seed);
		}
		if (spreadChanged) {
			// The centroids ARE the spread; the nodes then follow them under gravity.
			placeCentroids();
		}
		if (spreadChanged || gravityChanged) {
			alpha = 1;
			settled = false;
			for (const node of excited) {
				isExcited[node] = 0;
			}
			excited.length = 0;
		}
	}

	function bounds(): { cx: number; cy: number; cz: number; radius: number } {
		if (count === 0) {
			return { cx: 0, cy: 0, cz: 0, radius: 1 };
		}
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		for (let i = 0; i < count; i++) {
			const p = i * 3;
			minX = Math.min(minX, positions[p]);
			maxX = Math.max(maxX, positions[p]);
			minY = Math.min(minY, positions[p + 1]);
			maxY = Math.max(maxY, positions[p + 1]);
			minZ = Math.min(minZ, positions[p + 2]);
			maxZ = Math.max(maxZ, positions[p + 2]);
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const cz = (minZ + maxZ) / 2;
		let radius = 0;
		for (let i = 0; i < count; i++) {
			const p = i * 3;
			const dx = positions[p] - cx;
			const dy = positions[p + 1] - cy;
			const dz = positions[p + 2] - cz;
			radius = Math.max(radius, dx * dx + dy * dy + dz * dz);
		}
		// A single-node graph has no extent, and a camera framed on a zero radius sees nothing.
		return { cx, cy, cz, radius: Math.max(Math.sqrt(radius), 1) };
	}

	seed();

	return {
		positions,
		home,
		get settled(): boolean {
			return settled;
		},
		get alpha(): number {
			return alpha;
		},
		step,
		settle,
		kick,
		relax,
		excitedCount(): number {
			return excited.length;
		},
		setOptions,
		bounds,
	};
}

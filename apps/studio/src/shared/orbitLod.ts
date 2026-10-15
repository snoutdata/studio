/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snout Orbit's levels of detail and its picking index.
 *
 * Everything that DECIDES what Orbit draws lives here, pure, so the policy is asserted by
 * `orbitLod.test.ts` in the normal unit tier instead of being eyeballed through a GPU. The scene
 * spends this budget; it does not set it.
 *
 * Three rules shape all of it, and the first one is the one that is easy to get wrong:
 *
 *  - **FOLD, DO NOT DROP.** An index that is not drawn as its own star still counts toward its
 *    table's size, so a table with forty indexes still reads as a big object. Culling that made a
 *    hub shrink would be lying about the schema, which is worse than being slow.
 *  - **NEVER AN EMPTY REGION.** A schema whose tables all fell below the cut still gets its most
 *    connected few drawn. A void where a schema is reads as a bug, and the user cannot tell the
 *    difference between "folded" and "missing".
 *  - **NODE PICKING IS NOT A SCAN.** Projected nodes go into a uniform screen-space grid once a
 *    frame, and a pick tests only the cells the cursor's reach overlaps: 2 microseconds at 60,000
 *    objects against 166 for the scan it replaced. Relations deliberately do NOT get the same
 *    treatment, and `PickIndex` records the measurement that says why.
 *
 * The numbers in `lodFor` come from a headless benchmark of the real graph, layout and LOD code,
 * not from taste.
 */

import type { OrbitGraph } from './orbit';

/** What a graph of this size is allowed to draw. */
export interface LodBudget {
	/** Draw index nodes at all? Below this many objects, yes. */
	indexes: boolean;
	/** Draw `index`/`depends` links at all? */
	minorLinks: boolean;
	/** How many nodes may carry a label. */
	labels: number;
	/** Test at most this many nodes per pick; 0 means all of them. */
	pickBudget: number;
	/** Repaint link colours every N frames. */
	repaintEvery: number;
	/** Hard cap on drawn nodes; 0 means no cap. */
	maxNodes: number;
	/** Hard cap on drawn relations; 0 means no cap. */
	maxLinks: number;
	/** Past what this renderer will attempt. The scene draws nothing and says so. */
	ceiling: boolean;
	/** What was folded, in one sentence, for the rail. Null when nothing was. */
	note: string | null;
}

/**
 * The tiers, in objects. Measured on the dev Mac at 1600x900 with the cursor on the biggest hub
 * (a headless benchmark), against a 16.6ms frame that the bloom pass and the draw already own
 * most of, so the budget for everything in this file is about 4ms.
 *
 * FULL: every pass together is well under a millisecond, so nothing is folded and the schema is
 * drawn as it is. INDEXED: still everything, but the link repaint slows down, because it is the
 * single biggest pass and sixteen frames of staleness was already invisible. FOLDED: indexes stop
 * being their own stars (they are the majority of objects in a real schema and the least
 * interesting) and fold into their tables' size instead. CAPPED: the long tail of unconnected
 * objects goes too, ranked out by degree. Past CEILING the honest answer is no.
 */
const FULL_MAX = 4_000;
const INDEXED_MAX = 12_000;
const FOLDED_MAX = 45_000;
const CAPPED_MAX = 150_000;

/** Node kinds ranked by how much a user came here to see one. Lower sorts first. */
function kindRank(kind: string): number {
	if (kind === 'table' || kind === 'collection') {
		return 0;
	}
	if (kind === 'view') {
		return 1;
	}
	if (kind === 'routine') {
		return 2;
	}
	return 3;
}

export function lodFor(nodeCount: number, linkCount: number): LodBudget {
	// Links are counted too because a schema can be small in objects and enormous in relations,
	// and the link passes are the expensive half.
	const weight = nodeCount + linkCount * 0.5;

	if (weight <= FULL_MAX) {
		return { indexes: true, minorLinks: true, labels: 40, pickBudget: 0, repaintEvery: 16, maxNodes: 0, maxLinks: 0, ceiling: false, note: null };
	}
	if (weight <= INDEXED_MAX) {
		return { indexes: true, minorLinks: true, labels: 40, pickBudget: 0, repaintEvery: 24, maxNodes: 0, maxLinks: 0, ceiling: false, note: null };
	}
	if (weight <= FOLDED_MAX) {
		return {
			indexes: false,
			minorLinks: false,
			labels: 32,
			pickBudget: 2_048,
			repaintEvery: 32,
			maxNodes: 0,
			maxLinks: 0,
			ceiling: false,
			note: "Indexes are folded into the tables they belong to, which is why some stars are bigger than their row count.",
		};
	}
	if (weight <= CAPPED_MAX) {
		return {
			indexes: false,
			minorLinks: false,
			labels: 24,
			pickBudget: 2_048,
			repaintEvery: 48,
			maxNodes: 30_000,
			maxLinks: 45_000,
			ceiling: false,
			note: "This schema is past what Orbit draws in full. Indexes are folded into their tables, and the least connected objects are left out. Isolate a table to see its neighbourhood exactly.",
		};
	}
	return {
		indexes: false,
		minorLinks: false,
		labels: 0,
		pickBudget: 512,
		repaintEvery: 64,
		maxNodes: 0,
		maxLinks: 0,
		ceiling: true,
		note: "This schema is too large for Orbit to draw. Connect to a single schema, or turn indexes off when introspecting, and open it again.",
	};
}

/**
 * How many pixels a unit of star size is worth in a world of this radius.
 *
 * Orbit's star sizes (8 to 30, from row count and degree) were chosen against the prototype's
 * galaxy, which was about 800 units across, and the shader turns them into pixels with a fixed
 * perspective divide. A one-schema MySQL database settles into a ball of radius ~36, so those same
 * numbers came out at about a hundred device pixels each: every star overlapped every other,
 * additive blending saturated, and the bloom finished the job. The whole tab was one white sun.
 *
 * Scaling by the world the schema actually produced makes a star's share of the framed galaxy the
 * same at radius 36 and at radius 450. The clamps are the degenerate ends: a single-object
 * database has a radius of 1, and a layout that failed to converge reports 1e10.
 */
export function starScale(radius: number): number {
	if (!Number.isFinite(radius) || radius <= 0) {
		return 1;
	}
	return Math.min(4, Math.max(0.05, radius / 400));
}

/**
 * How many layout ticks to run BEFORE the first frame.
 *
 * A tick costs about 0.12 microseconds per node plus link, measured across five sizes by
 * a headless benchmark and linear across all of them. A flat 320 ticks is therefore 61ms on a
 * small schema and 4.9 SECONDS on 60,000 objects, synchronously, with the window not answering.
 * THAT, not any per-frame pass, is what a warehouse-sized schema actually hits: everything drawn
 * per frame is under a millisecond at that size, and this is five thousand.
 *
 * So the warm-up is budgeted in TIME rather than in ticks, at ~250ms, and never fewer than 40 or
 * more than 320. The floor wins at the top end (40 ticks is still ~600ms at 60,000 objects), and
 * it stays because a layout with fewer than that has not cooled at all and opens as the seeded
 * cloud. Under-settling costs shape, which the frame loop then recovers over the next second
 * because it keeps stepping until the layout settles on its own; a five-second freeze costs the
 * user the belief that the feature works.
 */
export function settleBudget(nodeCount: number, linkCount: number): number {
	const perTickMs = (nodeCount + linkCount) * 115e-6;
	if (perTickMs <= 0) {
		return 320;
	}
	const affordable = Math.floor(250 / perTickMs);
	return Math.max(40, Math.min(320, affordable));
}

/**
 * Which node ids are worth drawing at all at this scale.
 *
 * Selected most connected first, then returned in ASCENDING id order.
 *
 * The ascending order is for the scene's benefit and not the reader's: every buffer is filled in
 * this order, so a gather out of the layout's positions walks that Float32Array forwards. The
 * bench measures both orders and finds them within noise of each other (0.060ms against 0.062ms at
 * 30,000 objects), so this is cheap insurance rather than a win; what it does buy for certain is
 * that slot order and id order agree, which is what makes the identity fast path in the scene
 * possible at all. Ranking for LABELS is a separate question and `hubs()` in `orbit.ts` answers it.
 */
export function visibleNodes(graph: OrbitGraph, budget: LodBudget): Uint32Array {
	const count = graph.nodes.length;
	if (budget.ceiling || count === 0) {
		return new Uint32Array(0);
	}

	// Fast path: nothing is folded and nothing is capped, so every node is drawn and the sort is
	// work for nothing. This is the common case, because most databases are small.
	if (budget.indexes && budget.maxNodes === 0) {
		const all = new Uint32Array(count);
		for (let i = 0; i < count; i++) {
			all[i] = i;
		}
		return all;
	}

	const candidates: number[] = [];
	for (let i = 0; i < count; i++) {
		if (!budget.indexes && graph.nodes[i].kind === 'index') {
			continue;
		}
		candidates.push(i);
	}

	const cap = budget.maxNodes > 0 ? budget.maxNodes : candidates.length;
	const keep = new Uint8Array(count);
	if (candidates.length <= cap) {
		for (const id of candidates) {
			keep[id] = 1;
		}
	} else {
		candidates.sort((a, b) => {
			const nodeA = graph.nodes[a];
			const nodeB = graph.nodes[b];
			return kindRank(nodeA.kind) - kindRank(nodeB.kind)
				|| nodeB.fkDegree - nodeA.fkDegree
				|| nodeB.degree - nodeA.degree
				|| (nodeB.rows ?? 0) - (nodeA.rows ?? 0)
				|| a - b;
		});
		for (let i = 0; i < cap; i++) {
			keep[candidates[i]] = 1;
		}
		topUpClusters(graph, keep, candidates);
	}

	return pack(keep);
}

/**
 * Never an empty region: every cluster that has any candidate at all keeps its most connected few,
 * even when the global cut took all of them. A schema drawn as nothing is indistinguishable from a
 * schema that is not there.
 */
const CLUSTER_FLOOR = 3;

function topUpClusters(graph: OrbitGraph, keep: Uint8Array, ranked: number[]): void {
	const held = new Int32Array(graph.clusters.length);
	for (let i = 0; i < keep.length; i++) {
		if (keep[i]) {
			held[graph.nodes[i].cluster] += 1;
		}
	}
	// `ranked` is already most-connected-first, so the first miss in a starved cluster is the best
	// one it has.
	for (const id of ranked) {
		const cluster = graph.nodes[id].cluster;
		if (keep[id] || held[cluster] >= CLUSTER_FLOOR) {
			continue;
		}
		keep[id] = 1;
		held[cluster] += 1;
	}
}

function pack(keep: Uint8Array): Uint32Array {
	let total = 0;
	for (let i = 0; i < keep.length; i++) {
		total += keep[i];
	}
	const out = new Uint32Array(total);
	let written = 0;
	for (let i = 0; i < keep.length; i++) {
		if (keep[i]) {
			out[written++] = i;
		}
	}
	return out;
}

/**
 * Which relations are drawn: both ends visible, minor kinds dropped when the budget says so, and
 * the cap spent on foreign keys before anything else. Pass the result of `visibleNodes` in; it is
 * recomputed when you do not, which is only convenient in a test.
 */
export function visibleLinks(graph: OrbitGraph, budget: LodBudget, nodes?: Uint32Array): Uint32Array {
	if (budget.ceiling) {
		return new Uint32Array(0);
	}
	const drawn = nodes ?? visibleNodes(graph, budget);
	const isDrawn = new Uint8Array(graph.nodes.length);
	for (let i = 0; i < drawn.length; i++) {
		isDrawn[drawn[i]] = 1;
	}

	const candidates: number[] = [];
	for (let i = 0; i < graph.links.length; i++) {
		const link = graph.links[i];
		if (!budget.minorLinks && link.kind !== 'fk') {
			continue;
		}
		if (!isDrawn[link.a] || !isDrawn[link.b]) {
			continue;
		}
		candidates.push(i);
	}

	if (budget.maxLinks === 0 || candidates.length <= budget.maxLinks) {
		return toUint32(candidates);
	}
	// Over the cap: keep the relations between the objects that matter most. Summed foreign-key
	// degree is the cheapest stand-in for "this edge is part of the shape of the database".
	candidates.sort((a, b) => {
		const linkA = graph.links[a];
		const linkB = graph.links[b];
		const weightA = graph.nodes[linkA.a].fkDegree + graph.nodes[linkA.b].fkDegree;
		const weightB = graph.nodes[linkB.a].fkDegree + graph.nodes[linkB.b].fkDegree;
		return weightB - weightA || a - b;
	});
	const kept = candidates.slice(0, budget.maxLinks);
	kept.sort((a, b) => a - b);
	return toUint32(kept);
}

function toUint32(values: number[]): Uint32Array {
	const out = new Uint32Array(values.length);
	for (let i = 0; i < values.length; i++) {
		out[i] = values[i];
	}
	return out;
}

/**
 * Per drawn slot, how many of that node's children were folded away.
 *
 * This is the whole of "fold, do not drop": a table whose thirty indexes were culled has thirty
 * here, and the scene turns that into size. Without it, turning indexes off would make the biggest
 * tables in a warehouse SHRINK, which is the opposite of what the schema says.
 */
export function foldedChildren(graph: OrbitGraph, nodes: Uint32Array): Uint32Array {
	const slotOf = new Int32Array(graph.nodes.length).fill(-1);
	for (let s = 0; s < nodes.length; s++) {
		slotOf[nodes[s]] = s;
	}
	const folded = new Uint32Array(nodes.length);
	for (let i = 0; i < graph.nodes.length; i++) {
		if (slotOf[i] >= 0) {
			continue;
		}
		const parent = graph.nodes[i].parent;
		if (parent === undefined) {
			continue;
		}
		const slot = slotOf[parent];
		if (slot >= 0) {
			folded[slot] += 1;
		}
	}
	return folded;
}

/**
 * What a folded node's size becomes. Logarithmic, so forty indexes read as bigger than four
 * without a table with four hundred partitions swallowing the screen.
 */
export function foldedSize(base: number, hidden: number): number {
	return hidden <= 0 ? base : base + Math.log1p(hidden) * 1.6;
}
/* ------------------------------------------------------------------- picking */

/**
 * Screen-space cell size in CSS pixels. Nodes are picked at 22px, so a 32px cell means a pick
 * tests a 3x3 block and nothing else.
 */
const NODE_CELL = 32;

/**
 * How far a pick REACHES for each kind, as a multiplier on the squared radius. A table is worth
 * reaching for; an index should not steal the cursor from one.
 *
 * These are load-bearing for the grid and not only for the comparison: a table is pickable out to
 * `radius * sqrt(SLACK_TABLE)`, which is FURTHER than the radius, so the query must widen the cell
 * block by the same factor or it will miss a node the scan it replaced would have found. That was
 * a real bug here, caught by the thousand-cursor agreement test rather than by reading the code.
 */
const SLACK_TABLE = 1.6;
const SLACK_INDEX = 0.5;
const REACH = Math.sqrt(SLACK_TABLE);

/**
 * A uniform screen-space grid over the projected nodes.
 *
 * The projected points are counting-sorted into CSR arrays once a frame; a pick tests the cells
 * the cursor's radius overlaps. That is what takes node picking off the schema's size: the query
 * is ~2 microseconds at 60,000 objects against 166 for the scan it replaces, and it stays there
 * however big the database gets.
 *
 * There is deliberately NO link grid, and that is a measurement rather than an omission. One was
 * built: segments rasterised into a coarse grid by Amanatides & Woo, so a cursor in the middle of
 * a long filament finds it. It works, and it is slower. Rebuilding it cost 2.44ms a frame at
 * 60,000 objects against the 0.63ms full scan it was replacing, because a segment lands in five
 * cells and a node lands in one. Link picking therefore stays a scan (`nearestLinkIn` below),
 * bounded by the LOD's link cap rather than by a spatial index.
 *
 * Everything here speaks BUFFER SLOTS, not node ids: after LOD the two are different, and the
 * scene owns the mapping.
 */
export interface PickIndex {
	/** Bucket the projected nodes. Call once a frame, after projecting. */
	rebuild(x: Float32Array, y: Float32Array, onScreen: Uint8Array, count: number, width: number, height: number): void;
	/** Nearest node slot within `radius` px, or -1. `kinds[slot]` is 1 for an index. */
	nearestNode(px: number, py: number, radius: number, kinds: Uint8Array, x: Float32Array, y: Float32Array, budget?: number): number;
	/** For the bench and the test: how the grid is currently shaped. */
	shape(): { cols: number; rows: number; bucketed: number };
}

export function createPickIndex(): PickIndex {
	let cols = 0;
	let rows = 0;
	let start = new Int32Array(0);
	let items = new Int32Array(0);
	let cursor = new Int32Array(0);
	/** Per slot, the cell it landed in, so the placement pass does not redo the division. */
	let cellOfSlot = new Int32Array(0);
	let bucketed = 0;

	function rebuild(x: Float32Array, y: Float32Array, onScreen: Uint8Array, count: number, width: number, height: number): void {
		cols = Math.max(1, Math.ceil(width / NODE_CELL));
		rows = Math.max(1, Math.ceil(height / NODE_CELL));
		const cells = cols * rows;
		if (start.length !== cells + 1) {
			start = new Int32Array(cells + 1);
			cursor = new Int32Array(cells);
		} else {
			start.fill(0);
			cursor.fill(0);
		}
		if (items.length < count) {
			items = new Int32Array(count);
			cellOfSlot = new Int32Array(count);
		}

		// Counting sort: count, prefix sum, place. Anything off screen is never counted, which is
		// also the frustum cull for picking, and -1 marks it so the placement pass can skip it
		// without recomputing anything.
		bucketed = 0;
		for (let i = 0; i < count; i++) {
			if (!onScreen[i]) {
				cellOfSlot[i] = -1;
				continue;
			}
			const col = Math.floor(x[i] / NODE_CELL);
			const row = Math.floor(y[i] / NODE_CELL);
			// The bounds test is written as a positive so a NaN coordinate falls out here rather
			// than indexing the grid with one.
			if (!(col >= 0 && col < cols && row >= 0 && row < rows)) {
				cellOfSlot[i] = -1;
				continue;
			}
			const cell = row * cols + col;
			cellOfSlot[i] = cell;
			start[cell + 1] += 1;
			bucketed += 1;
		}
		for (let c = 0; c < cells; c++) {
			start[c + 1] += start[c];
		}
		for (let i = 0; i < count; i++) {
			const cell = cellOfSlot[i];
			if (cell < 0) {
				continue;
			}
			items[start[cell] + cursor[cell]] = i;
			cursor[cell] += 1;
		}
	}

	function nearestNode(px: number, py: number, radius: number, kinds: Uint8Array, x: Float32Array, y: Float32Array, budget = 0): number {
		let best = -1;
		let bestDistance = radius * radius;
		let tested = 0;
		if (cols === 0 || rows === 0) {
			return -1;
		}
		const reach = radius * REACH;
		const minCol = clamp(Math.floor((px - reach) / NODE_CELL), 0, cols - 1);
		const maxCol = clamp(Math.floor((px + reach) / NODE_CELL), 0, cols - 1);
		const minRow = clamp(Math.floor((py - reach) / NODE_CELL), 0, rows - 1);
		const maxRow = clamp(Math.floor((py + reach) / NODE_CELL), 0, rows - 1);
		for (let row = minRow; row <= maxRow; row++) {
			for (let col = minCol; col <= maxCol; col++) {
				const cell = row * cols + col;
				const end = start[cell + 1];
				for (let k = start[cell]; k < end; k++) {
					const slot = items[k];
					const dx = x[slot] - px;
					const dy = y[slot] - py;
					const distance = dx * dx + dy * dy;
					const slack = kinds[slot] === 1 ? SLACK_INDEX : SLACK_TABLE;
					if (distance < bestDistance * slack) {
						bestDistance = distance / slack;
						best = slot;
					}
					tested += 1;
					if (budget > 0 && tested >= budget) {
						return best;
					}
				}
			}
		}
		return best;
	}

	return {
		rebuild,
		nearestNode,
		shape(): { cols: number; rows: number; bucketed: number } {
			return { cols, rows, bucketed };
		},
	};
}

/**
 * Nearest relation slot within `radius` px, or -1.
 *
 * A scan, on purpose (see `PickIndex`), but a scan that rejects on four comparisons before it
 * reaches a square root: a filament is only pickable if the cursor's box overlaps the segment's
 * box, and almost none of them do. `ends` is two node SLOTS per link, in buffer order.
 *
 * `eligible`, when given, is 1 for the relations that may be picked at all. It has to be applied
 * INSIDE the loop rather than to the answer: rejecting afterwards would let a dimmed filament that
 * happens to be nearer hide the lit one behind it, and an isolated neighbourhood would stop
 * answering the cursor in exactly the places it overlaps the rest of the database.
 */
export function nearestLinkIn(
	px: number,
	py: number,
	radius: number,
	ends: Int32Array,
	x: Float32Array,
	y: Float32Array,
	onScreen: Uint8Array,
	eligible?: Uint8Array,
	budget = 0,
): number {
	let best = -1;
	let bestDistance = radius;
	let tested = 0;
	const count = ends.length / 2;
	for (let i = 0; i < count; i++) {
		if (eligible && eligible[i] === 0) {
			continue;
		}
		const a = ends[i * 2];
		const b = ends[i * 2 + 1];
		if (a < 0 || b < 0 || !onScreen[a] || !onScreen[b]) {
			continue;
		}
		const ax = x[a];
		const bx = x[b];
		if ((ax < px - radius && bx < px - radius) || (ax > px + radius && bx > px + radius)) {
			continue;
		}
		const ay = y[a];
		const by = y[b];
		if ((ay < py - radius && by < py - radius) || (ay > py + radius && by > py + radius)) {
			continue;
		}
		const distance = segmentDistance(px, py, ax, ay, bx, by);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i;
		}
		tested += 1;
		if (budget > 0 && tested >= budget) {
			return best;
		}
	}
	return best;
}

function clamp(value: number, low: number, high: number): number {
	if (high < low) {
		return low;
	}
	return value < low ? low : value > high ? high : value;
}

/** Distance from the cursor to a relation, in screen pixels. */
export function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const vx = x2 - x1;
	const vy = y2 - y1;
	const lengthSquared = vx * vx + vy * vy;
	let t = lengthSquared ? ((px - x1) * vx + (py - y1) * vy) / lengthSquared : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const dx = px - (x1 + vx * t);
	const dy = py - (y1 + vy * t);
	return Math.sqrt(dx * dx + dy * dy);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildOrbitGraph, type OrbitGraph } from './orbit';
import type { DatabaseSchema, TableInfo } from './schema';
import {
	createPickIndex,
	foldedChildren,
	foldedSize,
	lodFor,
	nearestLinkIn,
	segmentDistance,
	settleBudget,
	starScale,
	visibleLinks,
	visibleNodes,
	type LodBudget,
} from './orbitLod';

/* ------------------------------------------------------------------ fixtures */

interface FixtureOptions {
	tables: number;
	schemas?: number;
	indexesPerTable?: number;
	/** Every nth table is a hub the ones after it reference, which is what makes degree uneven. */
	hubEvery?: number;
}

function schemaFixture(options: FixtureOptions): DatabaseSchema {
	const schemas = options.schemas ?? 3;
	const indexes = options.indexesPerTable ?? 2;
	const hubEvery = options.hubEvery ?? 10;
	const tables: TableInfo[] = [];
	for (let i = 0; i < options.tables; i++) {
		const schema = `s${i % schemas}`;
		const hub = i % hubEvery === 0;
		const target = Math.floor(i / hubEvery) * hubEvery;
		tables.push({
			name: `t${i}`,
			schema,
			kind: 'table',
			columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
			primaryKey: ['id'],
			foreignKeys: hub ? [] : [{
				constraintName: `fk_${i}`,
				columns: ['parent_id'],
				referencedTable: `s${target % schemas}.t${target}`,
				referencedColumns: ['id'],
			}],
			indexes: Array.from({ length: indexes }, (_unused, x) => ({ name: `ix_${i}_${x}`, columns: ['id'], unique: false })),
			stats: { rowCount: i * 100 },
		});
	}
	return { database: 'fixture', tables, fetchedAt: 0 };
}

function graphFixture(options: FixtureOptions): OrbitGraph {
	return buildOrbitGraph(schemaFixture(options));
}

/** A budget with everything at its most permissive, then whatever the test wants changed. */
function budgetWith(overrides: Partial<LodBudget>): LodBudget {
	return {
		indexes: true,
		minorLinks: true,
		labels: 40,
		pickBudget: 0,
		repaintEvery: 16,
		maxNodes: 0,
		maxLinks: 0,
		ceiling: false,
		note: null,
		...overrides,
	};
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function random(): number {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* ---------------------------------------------------------------- the budget */

describe('lodFor', () => {
	it('draws a small database exactly as it is', () => {
		const budget = lodFor(400, 500);
		assert.equal(budget.indexes, true);
		assert.equal(budget.minorLinks, true);
		assert.equal(budget.maxNodes, 0);
		assert.equal(budget.ceiling, false);
		// Nothing was folded, so there is nothing to tell the user about.
		assert.equal(budget.note, null);
	});

	it('folds indexes before it caps anything, and says so', () => {
		const budget = lodFor(20_000, 22_000);
		assert.equal(budget.indexes, false);
		assert.equal(budget.minorLinks, false);
		assert.equal(budget.maxNodes, 0, 'folding comes before capping');
		assert.equal(budget.ceiling, false);
		assert.ok(budget.note && budget.note.length > 0);
	});

	it('caps the long tail past the folded tier', () => {
		const budget = lodFor(80_000, 90_000);
		assert.ok(budget.maxNodes > 0);
		assert.ok(budget.maxLinks > 0);
		assert.equal(budget.ceiling, false);
	});

	it('refuses, in a sentence, rather than hanging', () => {
		const budget = lodFor(400_000, 500_000);
		assert.equal(budget.ceiling, true);
		assert.ok(budget.note && budget.note.length > 0);
		// Nothing is drawn past the ceiling, so nothing may be selected either.
		assert.equal(visibleNodes(graphFixture({ tables: 20 }), budget).length, 0);
		assert.equal(visibleLinks(graphFixture({ tables: 20 }), budget).length, 0);
	});

	it('never relaxes as the graph grows', () => {
		let previous = lodFor(1, 1);
		for (const size of [1_000, 5_000, 12_000, 30_000, 60_000, 120_000, 400_000]) {
			const budget = lodFor(size, size);
			assert.ok(budget.labels <= previous.labels, `labels grew at ${size}`);
			assert.ok(budget.repaintEvery >= previous.repaintEvery, `repaint sped up at ${size}`);
			assert.ok(!previous.ceiling || budget.ceiling, 'a ceiling is never un-hit');
			assert.ok(previous.indexes || !budget.indexes, 'indexes never come back');
			previous = budget;
		}
	});

	it('counts relations as well as objects, because the link passes are the expensive half', () => {
		// Same object count, ten times the relations: the second one must be cheaper to draw.
		const sparse = lodFor(6_000, 1_000);
		const dense = lodFor(6_000, 60_000);
		assert.equal(sparse.indexes, true);
		assert.equal(dense.indexes, false);
	});
});

describe('starScale', () => {
	it('makes a star the same share of the galaxy whatever size the world came out', () => {
		// The number that matters is not the scale, it is the pixels a size-13 table ends up as
		// once the camera has framed the world it is in. That must not depend on the world.
		const share = (radius: number): number => {
			const distance = Math.max(40, radius * 2.6);
			return (13 * starScale(radius) * 900) / distance;
		};
		const small = share(36);
		const large = share(450);
		assert.ok(Math.abs(small - large) / large < 0.05, `${small.toFixed(1)}px against ${large.toFixed(1)}px`);
		// And it is a readable size, not a hundred-pixel blob and not a speck.
		assert.ok(small > 4 && small < 24, `${small.toFixed(1)}px`);
	});

	it('holds the degenerate ends to something drawable', () => {
		assert.equal(starScale(Number.NaN), 1);
		assert.equal(starScale(0), 1);
		assert.equal(starScale(-5), 1);
		assert.ok(starScale(1) >= 0.05);
		assert.ok(starScale(1e10) <= 4);
	});
});

describe('settleBudget', () => {
	it('warms a small schema fully', () => {
		assert.equal(settleBudget(500, 600), 320);
	});

	it('turns a five-second freeze into a fraction of a second at warehouse size', () => {
		const iterations = settleBudget(60_000, 66_000);
		const perTickMs = 126_000 * 115e-6;
		assert.ok(iterations <= 40, `still ${iterations} ticks`);
		// The 40-tick floor exceeds the time budget on its own at this size, and deliberately does:
		// a layout with fewer ticks than that has not cooled and opens as the seeded cloud. What
		// must not survive is the five seconds a flat 320 costs here.
		assert.ok(iterations * perTickMs < 700, 'the warm-up is still a freeze');
		assert.ok(320 * perTickMs > 2_000, 'the fixture would be a real freeze unbudgeted');
	});

	it('never returns something a caller cannot use', () => {
		for (const size of [0, 1, 1_000, 1_000_000]) {
			const iterations = settleBudget(size, size);
			assert.ok(Number.isInteger(iterations) && iterations >= 40 && iterations <= 320);
		}
	});
});

/* --------------------------------------------------------------- what is drawn */

describe('visibleNodes', () => {
	it('draws everything when nothing is folded', () => {
		const graph = graphFixture({ tables: 40 });
		const nodes = visibleNodes(graph, budgetWith({}));
		assert.equal(nodes.length, graph.nodes.length);
	});

	it('returns ids in ascending order, which is what the buffers are indexed by', () => {
		const graph = graphFixture({ tables: 200 });
		const nodes = visibleNodes(graph, budgetWith({ indexes: false, maxNodes: 60 }));
		for (let i = 1; i < nodes.length; i++) {
			assert.ok(nodes[i] > nodes[i - 1], 'ids must be ascending and unique');
		}
	});

	it('drops index nodes but keeps every table when indexes are folded', () => {
		const graph = graphFixture({ tables: 50, indexesPerTable: 3 });
		const nodes = visibleNodes(graph, budgetWith({ indexes: false }));
		const drawn = new Set([...nodes]);
		for (const node of graph.nodes) {
			assert.equal(drawn.has(node.id), node.kind !== 'index', `${node.kind} ${node.name}`);
		}
	});

	it('spends a cap on the most connected objects', () => {
		const graph = graphFixture({ tables: 300, hubEvery: 30 });
		const nodes = visibleNodes(graph, budgetWith({ indexes: false, maxNodes: 20 }));
		const drawn = new Set([...nodes]);
		// The single most connected table cannot be the one that got cut.
		const best = [...graph.nodes].sort((a, b) => b.fkDegree - a.fkDegree)[0];
		assert.ok(drawn.has(best.id), 'the biggest hub must survive any cut');
	});

	it('never leaves a schema as empty void', () => {
		// Ten schemas and a cap far below their number: a naive rank would put every survivor in
		// whichever schema happened to hold the hubs, and nine regions would be nothing at all.
		const graph = graphFixture({ tables: 400, schemas: 10, hubEvery: 40 });
		const nodes = visibleNodes(graph, budgetWith({ indexes: false, maxNodes: 12 }));
		const perCluster = new Map<number, number>();
		for (const id of nodes) {
			const cluster = graph.nodes[id].cluster;
			perCluster.set(cluster, (perCluster.get(cluster) ?? 0) + 1);
		}
		for (let cluster = 0; cluster < graph.clusters.length; cluster++) {
			assert.ok((perCluster.get(cluster) ?? 0) > 0, `schema ${graph.clusters[cluster].name} drew nothing`);
		}
	});

	it('is deterministic', () => {
		const graph = graphFixture({ tables: 120 });
		const budget = budgetWith({ indexes: false, maxNodes: 30 });
		assert.deepEqual([...visibleNodes(graph, budget)], [...visibleNodes(graph, budget)]);
	});
});

describe('visibleLinks', () => {
	it('keeps only relations whose ends are both drawn', () => {
		const graph = graphFixture({ tables: 60, indexesPerTable: 2 });
		const budget = budgetWith({ indexes: false });
		const nodes = visibleNodes(graph, budget);
		const drawn = new Set([...nodes]);
		for (const id of visibleLinks(graph, budget, nodes)) {
			const link = graph.links[id];
			assert.ok(drawn.has(link.a) && drawn.has(link.b), `link ${link.name} points at a folded node`);
		}
	});

	it('drops the minor kinds when the budget says so', () => {
		const graph = graphFixture({ tables: 60 });
		const budget = budgetWith({ indexes: false, minorLinks: false });
		for (const id of visibleLinks(graph, budget)) {
			assert.equal(graph.links[id].kind, 'fk');
		}
	});

	it('keeps every relation when nothing is folded', () => {
		const graph = graphFixture({ tables: 30 });
		assert.equal(visibleLinks(graph, budgetWith({})).length, graph.links.length);
	});

	it('respects a cap and stays in ascending order', () => {
		const graph = graphFixture({ tables: 300, hubEvery: 30 });
		const ids = visibleLinks(graph, budgetWith({ indexes: false, minorLinks: false, maxLinks: 25 }));
		assert.equal(ids.length, 25);
		for (let i = 1; i < ids.length; i++) {
			assert.ok(ids[i] > ids[i - 1]);
		}
	});
});

/* ------------------------------------------------------------- fold, not drop */

describe('folding', () => {
	it('counts a table\'s culled indexes against the table itself', () => {
		const graph = graphFixture({ tables: 12, indexesPerTable: 4 });
		const budget = budgetWith({ indexes: false });
		const nodes = visibleNodes(graph, budget);
		const folded = foldedChildren(graph, nodes);
		let total = 0;
		for (let slot = 0; slot < nodes.length; slot++) {
			assert.equal(folded[slot], graph.nodes[nodes[slot]].kind === 'table' ? 4 : 0);
			total += folded[slot];
		}
		// Nothing is simply gone: every culled node is accounted for somewhere.
		assert.equal(total, graph.nodes.length - nodes.length);
	});

	it('makes a heavily indexed table bigger, not smaller', () => {
		const plain = foldedSize(10, 0);
		const four = foldedSize(10, 4);
		const forty = foldedSize(10, 40);
		assert.equal(plain, 10);
		assert.ok(four > plain);
		assert.ok(forty > four);
		// Logarithmic: ten times the indexes must not be ten times the star.
		assert.ok(forty < four * 2);
	});

	it('folds nothing when nothing was culled', () => {
		const graph = graphFixture({ tables: 10 });
		const folded = foldedChildren(graph, visibleNodes(graph, budgetWith({})));
		assert.ok([...folded].every((count) => count === 0));
	});
});

/* -------------------------------------------------------------------- picking */

/** A tiny projected scene: `count` points on a grid, all on screen. */
function projected(count: number, seed = 7): { x: Float32Array; y: Float32Array; on: Uint8Array; kinds: Uint8Array } {
	const random = mulberry32(seed);
	const x = new Float32Array(count);
	const y = new Float32Array(count);
	const on = new Uint8Array(count).fill(1);
	const kinds = new Uint8Array(count);
	for (let i = 0; i < count; i++) {
		x[i] = random() * 1600;
		y[i] = random() * 900;
		kinds[i] = random() < 0.5 ? 1 : 0;
	}
	return { x, y, on, kinds };
}

/** The scan the grid replaced, kept here as the thing the grid has to agree with. */
function scanNearest(px: number, py: number, radius: number, scene: ReturnType<typeof projected>): number {
	let best = -1;
	let bestDistance = radius * radius;
	for (let i = 0; i < scene.x.length; i++) {
		if (!scene.on[i]) {
			continue;
		}
		const dx = scene.x[i] - px;
		const dy = scene.y[i] - py;
		const distance = dx * dx + dy * dy;
		// Mirrors the slack the index applies, so a disagreement is a bug and not two policies.
		const slack = scene.kinds[i] === 1 ? 0.5 : 1.6;
		if (distance < bestDistance * slack) {
			bestDistance = distance / slack;
			best = i;
		}
	}
	return best;
}

describe('PickIndex', () => {
	it('finds the node under the cursor', () => {
		const scene = projected(1);
		scene.x[0] = 400;
		scene.y[0] = 300;
		scene.kinds[0] = 0;
		const index = createPickIndex();
		index.rebuild(scene.x, scene.y, scene.on, 1, 1600, 900);
		assert.equal(index.nearestNode(402, 301, 22, scene.kinds, scene.x, scene.y), 0);
		assert.equal(index.nearestNode(900, 700, 22, scene.kinds, scene.x, scene.y), -1);
	});

	it('agrees with a full scan over a thousand random cursors', () => {
		// This is the assertion that matters: a spatial index is only worth having if it is not a
		// different answer, and "close enough" in a hover is a bug the user reads as flakiness.
		const scene = projected(2_000, 11);
		const index = createPickIndex();
		index.rebuild(scene.x, scene.y, scene.on, scene.x.length, 1600, 900);
		const random = mulberry32(99);
		for (let trial = 0; trial < 1_000; trial++) {
			const px = random() * 1600;
			const py = random() * 900;
			assert.equal(
				index.nearestNode(px, py, 22, scene.kinds, scene.x, scene.y),
				scanNearest(px, py, 22, scene),
				`disagreed at ${px.toFixed(1)},${py.toFixed(1)}`,
			);
		}
	});

	it('never picks something the projection culled', () => {
		const scene = projected(40, 3);
		scene.on.fill(0);
		const index = createPickIndex();
		index.rebuild(scene.x, scene.y, scene.on, scene.x.length, 1600, 900);
		assert.equal(index.shape().bucketed, 0);
		for (let i = 0; i < scene.x.length; i++) {
			assert.equal(index.nearestNode(scene.x[i], scene.y[i], 22, scene.kinds, scene.x, scene.y), -1);
		}
	});

	it('lets a table beat an index that is just as close', () => {
		const x = new Float32Array([400, 410]);
		const y = new Float32Array([300, 300]);
		const on = new Uint8Array([1, 1]);
		const kinds = new Uint8Array([1, 0]);
		const index = createPickIndex();
		index.rebuild(x, y, on, 2, 1600, 900);
		// The cursor sits between them; the table is the one worth reaching for.
		assert.equal(index.nearestNode(405, 300, 22, kinds, x, y), 1);
	});

	it('survives a coordinate that is not a number', () => {
		const x = new Float32Array([Number.NaN, 400]);
		const y = new Float32Array([Number.NaN, 300]);
		const on = new Uint8Array([1, 1]);
		const kinds = new Uint8Array([0, 0]);
		const index = createPickIndex();
		index.rebuild(x, y, on, 2, 1600, 900);
		assert.equal(index.shape().bucketed, 1);
		assert.equal(index.nearestNode(400, 300, 22, kinds, x, y), 1);
	});

	it('stops at the pick budget', () => {
		// Everything piled into one cell, so the budget is the only thing that can stop the walk.
		const count = 500;
		const x = new Float32Array(count).fill(400);
		const y = new Float32Array(count).fill(300);
		const on = new Uint8Array(count).fill(1);
		const kinds = new Uint8Array(count);
		const index = createPickIndex();
		index.rebuild(x, y, on, count, 1600, 900);
		assert.equal(index.nearestNode(400, 300, 22, kinds, x, y, 1), 0, 'a budget of one tests the first only');
		assert.ok(index.nearestNode(400, 300, 22, kinds, x, y, 0) >= 0);
	});

	it('is reusable across frames without leaking the previous one', () => {
		const scene = projected(300, 5);
		const index = createPickIndex();
		index.rebuild(scene.x, scene.y, scene.on, scene.x.length, 1600, 900);
		const first = index.shape().bucketed;
		index.rebuild(scene.x, scene.y, scene.on, scene.x.length, 1600, 900);
		assert.equal(index.shape().bucketed, first);
		scene.on.fill(0);
		index.rebuild(scene.x, scene.y, scene.on, scene.x.length, 1600, 900);
		assert.equal(index.shape().bucketed, 0);
	});
});

describe('nearestLinkIn', () => {
	const x = new Float32Array([100, 900, 200]);
	const y = new Float32Array([100, 100, 800]);
	const on = new Uint8Array([1, 1, 1]);
	const ends = new Int32Array([0, 1, 0, 2]);

	it('finds a filament the cursor is in the MIDDLE of, not just near an end', () => {
		assert.equal(nearestLinkIn(500, 103, 7, ends, x, y, on), 0);
	});

	it('returns -1 when the cursor is off every filament', () => {
		assert.equal(nearestLinkIn(500, 400, 7, ends, x, y, on), -1);
	});

	it('ignores a relation whose end the projection culled', () => {
		const culled = new Uint8Array([1, 0, 1]);
		assert.equal(nearestLinkIn(500, 103, 7, ends, x, y, culled), -1);
	});

	it('ignores a relation whose end was folded away', () => {
		const folded = new Int32Array([0, -1]);
		assert.equal(nearestLinkIn(500, 103, 7, folded, x, y, on), -1);
	});

	it('skips an ineligible relation instead of losing to it', () => {
		// The isolate case: the nearest filament is dimmed, and the lit one just behind it must
		// still be found rather than the pick coming back empty.
		const cx = new Float32Array([0, 1000, 0, 1000]);
		const cy = new Float32Array([300, 300, 304, 304]);
		const cOn = new Uint8Array([1, 1, 1, 1]);
		const crossing = new Int32Array([0, 1, 2, 3]);
		const lit = new Uint8Array([0, 1]);
		assert.equal(nearestLinkIn(500, 301, 7, crossing, cx, cy, cOn), 0, 'without a mask the nearer one wins');
		assert.equal(nearestLinkIn(500, 301, 7, crossing, cx, cy, cOn, lit), 1, 'with one, the lit one is found');
	});

	it('picks the nearer of two crossing filaments', () => {
		const cx = new Float32Array([0, 1000, 0, 1000]);
		const cy = new Float32Array([300, 300, 320, 320]);
		const cOn = new Uint8Array([1, 1, 1, 1]);
		const crossing = new Int32Array([0, 1, 2, 3]);
		assert.equal(nearestLinkIn(500, 318, 7, crossing, cx, cy, cOn), 1);
		assert.equal(nearestLinkIn(500, 302, 7, crossing, cx, cy, cOn), 0);
	});
});

describe('segmentDistance', () => {
	it('measures to the segment, not to the infinite line', () => {
		assert.equal(segmentDistance(0, 0, 10, 0, 20, 0), 10);
		assert.equal(segmentDistance(15, 3, 10, 0, 20, 0), 3);
	});

	it('handles a segment of zero length', () => {
		assert.equal(segmentDistance(3, 4, 0, 0, 0, 0), 5);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { buildOrbitGraph } from './orbit';
import type { OrbitGraph } from './orbit';
import { createOrbitLayout, DEFAULT_LAYOUT_OPTIONS } from './orbitLayout';
import type { DatabaseSchema, TableInfo } from './schema';

function table(schema: string, name: string, extra: Partial<TableInfo> = {}): TableInfo {
	return {
		name,
		schema,
		kind: 'table',
		columns: [
			{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
			{ name: 'label', dataType: 'text', nullable: true, isPrimaryKey: false },
		],
		primaryKey: ['id'],
		foreignKeys: [],
		...extra,
	};
}

/** Three schemas of ten tables, each schema a chain of foreign keys and nothing crossing. */
function threeClusters(): OrbitGraph {
	const tables: TableInfo[] = [];
	for (const schema of ['sales', 'stock', 'audit']) {
		for (let i = 0; i < 10; i++) {
			tables.push(
				table(schema, `t${i}`, {
					foreignKeys:
						i === 0
							? []
							: [
									{
										constraintName: `${schema}_t${i}_fk`,
										columns: ['id'],
										referencedTable: `t${i - 1}`,
										referencedColumns: ['id'],
									},
								],
				}),
			);
		}
	}
	return buildOrbitGraph({ database: 'shop', tables, fetchedAt: 0 });
}

function graphWithIndexes(): OrbitGraph {
	const schema: DatabaseSchema = {
		database: 'shop',
		tables: [
			table('app', 'users', { indexes: [{ name: 'ix_users_email', columns: ['email'], unique: true }] }),
			table('app', 'orders', {
				foreignKeys: [
					{ constraintName: 'orders_user_fk', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] },
					{ constraintName: 'orders_audit_fk', columns: ['id'], referencedTable: 'core.audit', referencedColumns: ['id'] },
				],
				indexes: [{ name: 'ix_orders_user', columns: ['user_id'], unique: false }],
			}),
			table('core', 'audit'),
			table('core', 'audit_line', {
				foreignKeys: [
					{ constraintName: 'line_audit_fk', columns: ['audit_id'], referencedTable: 'audit', referencedColumns: ['id'] },
				],
			}),
		],
		fetchedAt: 0,
	};
	return buildOrbitGraph(schema);
}

function distance(positions: Float32Array, a: number, b: number): number {
	const dx = positions[a * 3] - positions[b * 3];
	const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
	const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

test('default options are the tuned ones', () => {
	assert.deepStrictEqual(DEFAULT_LAYOUT_OPTIONS, { spread: 380, gravity: 1.6, seed: 1 });
});

test('same graph + same seed settles to byte-identical positions', () => {
	const a = createOrbitLayout(threeClusters(), { seed: 7 });
	const b = createOrbitLayout(threeClusters(), { seed: 7 });
	a.settle(300);
	b.settle(300);
	assert.deepStrictEqual(a.positions, b.positions);
});

test('a different seed lays the same graph out differently', () => {
	const a = createOrbitLayout(threeClusters(), { seed: 7 });
	const b = createOrbitLayout(threeClusters(), { seed: 8 });
	a.settle(300);
	b.settle(300);
	assert.notDeepStrictEqual(a.positions, b.positions);
});

test('the simulation terminates: alpha hits zero and home is snapshotted', () => {
	const layout = createOrbitLayout(threeClusters());
	assert.strictEqual(layout.settled, false);
	layout.settle(800);
	assert.strictEqual(layout.settled, true);
	assert.strictEqual(layout.alpha, 0);
	assert.deepStrictEqual(layout.home, layout.positions);
	// A settled layout does not move again.
	const before = Float32Array.from(layout.positions);
	layout.settle(100);
	assert.deepStrictEqual(layout.positions, before);
});

test('clusters separate: cross-schema pairs sit far outside their own schema', () => {
	const graph = threeClusters();
	const layout = createOrbitLayout(graph);
	layout.settle(800);

	let within = 0;
	let withinCount = 0;
	let across = 0;
	let acrossCount = 0;
	for (let i = 0; i < graph.nodes.length; i++) {
		for (let j = i + 1; j < graph.nodes.length; j++) {
			const d = distance(layout.positions, i, j);
			if (graph.nodes[i].cluster === graph.nodes[j].cluster) {
				within += d;
				withinCount++;
			} else {
				across += d;
				acrossCount++;
			}
		}
	}
	const meanWithin = within / withinCount;
	const meanAcross = across / acrossCount;
	assert.ok(meanAcross > meanWithin * 4, `expected clusters to separate, within=${meanWithin} across=${meanAcross}`);
});

test('no NaN anywhere after settling, indexes and cross-schema keys included', () => {
	const layout = createOrbitLayout(graphWithIndexes());
	layout.settle(800);
	for (let i = 0; i < layout.positions.length; i++) {
		assert.ok(Number.isFinite(layout.positions[i]), `position ${i} is ${layout.positions[i]}`);
		assert.ok(Number.isFinite(layout.home[i]), `home ${i} is ${layout.home[i]}`);
	}
	const box = layout.bounds();
	assert.ok(Number.isFinite(box.cx) && Number.isFinite(box.cy) && Number.isFinite(box.cz));
	assert.ok(box.radius > 0);
});

test('coincident nodes do not produce NaN (the spring divide-by-zero)', () => {
	const graph = graphWithIndexes();
	const layout = createOrbitLayout(graph);
	// Stack every node on the origin, which is the state a naive spring divides by.
	layout.positions.fill(0);
	layout.settle(800);
	for (let i = 0; i < layout.positions.length; i++) {
		assert.ok(Number.isFinite(layout.positions[i]), `position ${i} is ${layout.positions[i]}`);
	}
});

test('a kick moves a node and relax returns it exactly home', () => {
	const graph = threeClusters();
	const layout = createOrbitLayout(graph);
	layout.settle(800);
	const node = 4;
	const homeX = layout.home[node * 3];
	const homeY = layout.home[node * 3 + 1];
	const homeZ = layout.home[node * 3 + 2];

	layout.kick(node);
	assert.strictEqual(layout.excitedCount(), 1);
	layout.relax();
	assert.notStrictEqual(layout.positions[node * 3], homeX);

	let ticks = 0;
	while (layout.excitedCount() > 0 && ticks < 2000) {
		layout.relax();
		ticks++;
	}
	assert.strictEqual(layout.excitedCount(), 0);
	assert.ok(ticks < 2000, 'relax should converge well inside the bound');
	assert.strictEqual(layout.positions[node * 3], homeX);
	assert.strictEqual(layout.positions[node * 3 + 1], homeY);
	assert.strictEqual(layout.positions[node * 3 + 2], homeZ);
});

test('kicking the same node twice excites it once; nothing else moves', () => {
	const layout = createOrbitLayout(threeClusters());
	layout.settle(800);
	const others = Float32Array.from(layout.positions);
	layout.kick(2);
	layout.kick(2);
	assert.strictEqual(layout.excitedCount(), 1);
	layout.relax();
	for (let i = 0; i < layout.positions.length; i++) {
		if (i < 6 || i > 8) {
			assert.strictEqual(layout.positions[i], others[i]);
		}
	}
});

test('a kick before the layout settles is ignored', () => {
	const layout = createOrbitLayout(threeClusters());
	layout.kick(1);
	assert.strictEqual(layout.excitedCount(), 0);
});

test('changing spread or gravity re-wakes the simulation', () => {
	const layout = createOrbitLayout(threeClusters());
	layout.settle(800);
	assert.strictEqual(layout.settled, true);

	layout.setOptions({ spread: 520 });
	assert.strictEqual(layout.settled, false);
	assert.ok(layout.alpha > 0);

	layout.settle(800);
	assert.strictEqual(layout.settled, true);
	layout.setOptions({ gravity: 3 });
	assert.strictEqual(layout.settled, false);

	layout.settle(800);
	// Setting the same values back changes nothing, so a rail slider that lands where it started
	// does not restart the world.
	layout.setOptions({ gravity: 3, spread: 520 });
	assert.strictEqual(layout.settled, true);
});

test('a wider spread pushes the clusters further apart', () => {
	const graph = threeClusters();
	const tight = createOrbitLayout(graph, { spread: 200 });
	const wide = createOrbitLayout(graph, { spread: 900 });
	tight.settle(800);
	wide.settle(800);
	assert.ok(wide.bounds().radius > tight.bounds().radius * 1.5);
});

test('an empty graph is a layout that settles and has sane bounds', () => {
	const layout = createOrbitLayout(buildOrbitGraph({ database: 'empty', tables: [], fetchedAt: 0 }));
	layout.settle(800);
	assert.strictEqual(layout.settled, true);
	assert.deepStrictEqual(layout.bounds(), { cx: 0, cy: 0, cz: 0, radius: 1 });
});

test('a hub with thousands of relations does not blow the world up', () => {
	// Spring force is summed per link with no degree normalisation, so before the speed limit a
	// single node wired to everything drove the layout to a non-finite radius, which reached the
	// renderer as a camera at NaN and a black tab. Measured stable at 2,000 relations and diverging
	// by 3,000, so this sits well past both.
	const tables: TableInfo[] = [{
		name: 'hub', schema: 'public', kind: 'table',
		columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
		primaryKey: ['id'], foreignKeys: [],
	}];
	for (let i = 0; i < 4000; i++) {
		tables.push({
			name: `spoke_${i}`, schema: 'public', kind: 'table',
			columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
			primaryKey: ['id'],
			foreignKeys: [{ constraintName: `spoke_${i}_hub_fkey`, columns: ['hub_id'], referencedTable: 'hub', referencedColumns: ['id'] }],
		});
	}
	const graph = buildOrbitGraph({ database: 'wide', tables, fetchedAt: 0 }, { includeIndexes: false });
	const layout = createOrbitLayout(graph, { seed: 7 });
	layout.settle(200);
	const bounds = layout.bounds();
	assert.ok(Number.isFinite(bounds.radius), 'the world stayed finite');
	assert.ok(bounds.radius < 1e5, `the world stayed a world, not ${bounds.radius}`);
	for (let i = 0; i < layout.positions.length; i++) {
		assert.ok(Number.isFinite(layout.positions[i]), `position ${i} is finite`);
	}
});

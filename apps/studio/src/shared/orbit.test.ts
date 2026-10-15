/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { buildOrbitGraph, condenseStatement, findNode, hubs, neighbourhood, searchNodes } from './orbit';
import type { OrbitGraph } from './orbit';
import type { DatabaseSchema, IndexInfo, TableInfo } from './schema';

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

function index(name: string, column: string): IndexInfo {
	return { name, columns: [column], unique: false };
}

/**
 * Two schemas: `app` (users, orders, order_items) and `core` (audit). Carries one bare foreign
 * key, one schema-qualified one, one that points at nothing, a log group that must not be drawn,
 * and a routine.
 */
function schema(): DatabaseSchema {
	return {
		database: 'shop',
		tables: [
			table('app', 'users', {
				foreignKeys: [
					{ constraintName: 'users_ghost_fk', columns: ['ghost_id'], referencedTable: 'ghost', referencedColumns: ['id'] },
				],
				indexes: [
					index('ix_users_email', 'email'),
					index('ix_users_name', 'name'),
					index('ix_users_city', 'city'),
					index('ix_users_created', 'created_at'),
				],
				stats: { rowCount: 4210 },
			}),
			table('app', 'orders', {
				foreignKeys: [
					{ constraintName: 'orders_user_fk', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] },
					{
						constraintName: 'orders_audit_fk',
						columns: ['audit_id'],
						referencedTable: 'core.audit',
						referencedColumns: ['id'],
					},
				],
				indexes: [index('ix_orders_user', 'user_id')],
			}),
			table('app', 'order_items', {
				foreignKeys: [
					{ constraintName: 'items_order_fk', columns: ['order_id'], referencedTable: 'orders', referencedColumns: ['id'] },
				],
				indexes: [index('ix_items_order', 'order_id')],
			}),
			table('core', 'audit'),
			{
				name: '/aws/lambda/checkout',
				schema: 'core',
				kind: 'logGroup',
				columns: [{ name: 'ts', dataType: 'timestamp', nullable: false, isPrimaryKey: false }],
				primaryKey: [],
				foreignKeys: [],
			},
		],
		routines: [{ name: 'recalc_totals', schema: 'app', kind: 'procedure', parameters: [] }],
		fetchedAt: 0,
	};
}

function named(graph: OrbitGraph, reference: string): number {
	const id = findNode(graph, reference);
	assert.notStrictEqual(id, -1, `expected a node for ${reference}`);
	return id;
}

test('every id is its own index, for both nodes and links', () => {
	const graph = buildOrbitGraph(schema());
	graph.nodes.forEach((node, i) => assert.strictEqual(node.id, i));
	graph.links.forEach((link, i) => assert.strictEqual(link.id, i));
	assert.ok(graph.nodes.length > 0 && graph.links.length > 0);
});

test('a bare referencedTable resolves inside the referencing schema', () => {
	const graph = buildOrbitGraph(schema());
	const orders = named(graph, 'app.orders');
	const users = named(graph, 'app.users');
	const link = graph.links.find((l) => l.name === 'orders_user_fk');
	assert.ok(link, 'orders_user_fk should exist');
	assert.strictEqual(link.a, orders);
	assert.strictEqual(link.b, users);
	assert.strictEqual(link.crossSchema, false);
	assert.deepStrictEqual(link.columns, ['user_id']);
	assert.deepStrictEqual(link.referencedColumns, ['id']);
});

test('a schema-qualified referencedTable resolves across schemas and is marked crossSchema', () => {
	const graph = buildOrbitGraph(schema());
	const link = graph.links.find((l) => l.name === 'orders_audit_fk');
	assert.ok(link, 'orders_audit_fk should exist');
	assert.strictEqual(link.a, named(graph, 'app.orders'));
	assert.strictEqual(link.b, named(graph, 'core.audit'));
	assert.strictEqual(link.crossSchema, true);
});

test('a foreign key that points at nothing is skipped, not thrown', () => {
	const graph = buildOrbitGraph(schema());
	assert.strictEqual(
		graph.links.find((l) => l.name === 'users_ghost_fk'),
		undefined,
	);
	assert.strictEqual(findNode(graph, 'ghost'), -1);
});

test('a logGroup pseudo-table is not drawn', () => {
	const graph = buildOrbitGraph(schema());
	assert.strictEqual(
		graph.nodes.find((n) => n.name === '/aws/lambda/checkout'),
		undefined,
	);
});

test('indexes become nodes with a parent and an index link', () => {
	const graph = buildOrbitGraph(schema());
	const users = named(graph, 'app.users');
	const ix = graph.nodes.find((n) => n.name === 'ix_users_email');
	assert.ok(ix, 'the index should be a node');
	assert.strictEqual(ix.kind, 'index');
	assert.strictEqual(ix.parent, users);
	assert.strictEqual(ix.schema, 'app');
	assert.strictEqual(ix.cluster, graph.nodes[users].cluster);
	// It inherits the table's row estimate, so it can be sized against it.
	assert.strictEqual(ix.rows, 4210);
	const link = graph.links.find((l) => l.kind === 'index' && l.b === ix.id);
	assert.ok(link, 'the index should be wired to its table');
	assert.strictEqual(link.a, users);
});

test('includeIndexes: false omits index nodes and their links', () => {
	const graph = buildOrbitGraph(schema(), { includeIndexes: false });
	assert.strictEqual(
		graph.nodes.find((n) => n.kind === 'index'),
		undefined,
	);
	assert.strictEqual(
		graph.links.find((l) => l.kind === 'index'),
		undefined,
	);
	// The tables and their foreign keys are untouched.
	assert.ok(graph.links.every((l) => l.kind === 'fk'));
	assert.notStrictEqual(findNode(graph, 'app.users'), -1);
});

test('routines are drawn in their schema, unwired', () => {
	const graph = buildOrbitGraph(schema());
	const routine = graph.nodes.find((n) => n.kind === 'routine');
	assert.ok(routine, 'the routine should be a node');
	assert.strictEqual(routine.schema, 'app');
	assert.strictEqual(routine.degree, 0);

	assert.strictEqual(
		buildOrbitGraph(schema(), { includeRoutines: false }).nodes.find((n) => n.kind === 'routine'),
		undefined,
	);
});

test('clusters are the schemas, sized by membership', () => {
	const graph = buildOrbitGraph(schema());
	assert.deepStrictEqual(
		graph.clusters.map((c) => c.name),
		['app', 'core'],
	);
	const total = graph.clusters.reduce((sum, c) => sum + c.size, 0);
	assert.strictEqual(total, graph.nodes.length);
});

test('a driver that reports no schema clusters under the database name', () => {
	const graph = buildOrbitGraph({
		database: 'local.db',
		tables: [{ ...table('', 'notes'), schema: undefined }],
		fetchedAt: 0,
	});
	assert.deepStrictEqual(
		graph.clusters.map((c) => c.name),
		['local.db'],
	);
	assert.strictEqual(graph.nodes[0].schema, 'local.db');
	assert.notStrictEqual(findNode(graph, 'notes'), -1);
});

test('hubs rank by fkDegree before raw degree', () => {
	const graph = buildOrbitGraph(schema());
	const orders = named(graph, 'app.orders');
	const users = named(graph, 'app.users');
	// users has more links (four indexes) but orders has more foreign keys, and it is the
	// foreign keys that mean "connected".
	assert.ok(graph.nodes[users].degree > graph.nodes[orders].degree);
	assert.ok(graph.nodes[orders].fkDegree > graph.nodes[users].fkDegree);
	assert.strictEqual(hubs(graph, 3)[0], orders);
	// Only real objects get a label; an index is never a hub.
	assert.ok(hubs(graph, 20).every((id) => graph.nodes[id].kind !== 'index'));
	assert.strictEqual(hubs(graph, 2).length, 2);
});

test('neighbourhood includes a table own indexes, and its neighbours indexes, at one hop', () => {
	const graph = buildOrbitGraph(schema());
	const items = named(graph, 'app.order_items');
	const orders = named(graph, 'app.orders');
	const own = graph.nodes.findIndex((n) => n.name === 'ix_items_order');
	const neighbours = graph.nodes.findIndex((n) => n.name === 'ix_orders_user');

	const set = neighbourhood(graph, items, 1);
	assert.ok(set.has(items));
	assert.ok(set.has(orders));
	assert.ok(set.has(own), 'the table own index');
	assert.ok(set.has(neighbours), 'the neighbour own index, added by the small-object pass');
	// One hop of foreign keys, so users (two hops away) stays out.
	assert.ok(!set.has(named(graph, 'app.users')));
});

test('findNode takes schema.table, a bare name, and refuses nonsense', () => {
	const graph = buildOrbitGraph(schema());
	assert.strictEqual(findNode(graph, 'app.users'), findNode(graph, 'users'));
	assert.strictEqual(findNode(graph, '  APP.Users  '), findNode(graph, 'app.users'));
	assert.strictEqual(findNode(graph, 'nope.at.all'), -1);
	assert.strictEqual(findNode(graph, ''), -1);
});

test('condenseStatement keeps the part that names the objects', () => {
	// The select list goes: it is long, it says nothing about which tables were read, and it pushes
	// the names that DO off the end of the panel.
	assert.equal(
		condenseStatement('SELECT a.id, a.name, a.created_at, b.total FROM orders.baskets a JOIN orders.lines b ON b.id = a.id'),
		'SELECT ... FROM orders.baskets a JOIN orders.lines b ON b.id = a.id',
	);
	// Newlines and runs of spaces are one space, because the feed is one line per statement.
	assert.equal(condenseStatement('SELECT\n  x\nFROM   t'), 'SELECT ... FROM t');
	// A statement with no select list is already the shape we want.
	assert.equal(condenseStatement('DELETE FROM auth.role_grants WHERE id = 4'), 'DELETE FROM auth.role_grants WHERE id = 4');
	assert.equal(condenseStatement('  INSERT INTO billing.customers (id) VALUES (1) '), 'INSERT INTO billing.customers (id) VALUES (1)');
	// A SELECT with no FROM has nothing to condense and must not be mangled into one.
	assert.equal(condenseStatement('SELECT 1'), 'SELECT 1');
	assert.equal(condenseStatement(''), '');
	// The first FROM wins, so a subquery in the select list cannot swallow the real target.
	assert.equal(condenseStatement('SELECT (SELECT 1) FROM t'), 'SELECT ... FROM t');
});

test('searchNodes matches a substring anywhere in the name', () => {
	const graph = buildOrbitGraph(schema());
	const names = (query: string): string[] => searchNodes(graph, query).map((id) => graph.nodes[id].name);
	// The point of the feature: `er` is in the MIDDLE of every one of these, and a prefix match
	// would find none of them.
	assert.deepStrictEqual(names('er').sort(), ['order_items', 'orders', 'users']);
	// Case does not matter, and neither does surrounding whitespace.
	assert.deepStrictEqual(names('  USERS  '), ['users']);
	// A schema-qualified query narrows to that schema.
	assert.deepStrictEqual(names('core.aud'), ['audit']);
	assert.deepStrictEqual(names('app.aud'), []);
	assert.deepStrictEqual(names('nothing_like_this'), []);
	assert.deepStrictEqual(names(''), []);
	assert.deepStrictEqual(names('   '), []);
});

test('searchNodes leaves out indexes and routines, and honours the limit', () => {
	const graph = buildOrbitGraph(schema());
	// `ix_users_email` and friends contain "us", and `recalc_totals` contains "al". Neither is
	// what "find a table" means, and there are more of them than there are tables.
	for (const id of searchNodes(graph, 'us')) {
		assert.notStrictEqual(graph.nodes[id].kind, 'index');
		assert.notStrictEqual(graph.nodes[id].kind, 'routine');
	}
	assert.strictEqual(searchNodes(graph, 'recalc').length, 0);
	assert.strictEqual(searchNodes(graph, 'er', 2).length, 2);
});

test('searchNodes ranks a leading match, then a word start, then the middle', () => {
	const graph = buildOrbitGraph(schema());
	const ranked = searchNodes(graph, 'order').map((id) => graph.nodes[id].name);
	// `orders` starts with it; `order_items` also starts with it but is less connected; nothing
	// else matches. The tie is broken by how connected the object is, not alphabetically, so the
	// table the query is about does not sit under its own child.
	assert.deepStrictEqual(ranked, ['orders', 'order_items']);
});

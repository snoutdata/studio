/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { DatabaseSchema, TableInfo } from '../../../shared/schema';
import type { CapabilityContext } from './registry';
import { orbitCapabilities, setOrbitBridge, type OrbitBridge } from './orbit';

/*
 * Orbit's agent half.
 *
 * Two things here are worth more than the coverage. One, the specs are asserted to be LITERAL:
 * the MCP tool list is frozen at connect, so a description that read app state
 * at declaration time would ship one window's schema to every agent that ever connected. Two,
 * `orbit_neighbourhood` is checked on a two-schema fixture built from the real DatabaseSchema
 * types, because the thing it exists to get right is telling a model that a relation leaves the
 * schema it started in.
 */

const openOrbit = orbitCapabilities.find((h) => h.spec.name === 'open_orbit')!;
const orbitFocus = orbitCapabilities.find((h) => h.spec.name === 'orbit_focus')!;
const orbitNeighbourhood = orbitCapabilities.find((h) => h.spec.name === 'orbit_neighbourhood')!;

function column(name: string, dataType = 'int', isPrimaryKey = false): TableInfo['columns'][number] {
	return { name, dataType, nullable: !isPrimaryKey, isPrimaryKey };
}

/**
 * Two schemas on purpose: `sales.orders` reaches `sales.customers` inside its own schema and
 * `ops.warehouses` outside it, and `sales.order_lines` reaches back into `orders`. That is the
 * smallest shape that can tell a cross-schema relation from an in-schema one.
 */
function fixture(): DatabaseSchema {
	const orders: TableInfo = {
		name: 'orders',
		schema: 'sales',
		kind: 'table',
		columns: [column('id', 'int', true), column('customer_id'), column('warehouse_id'), column('placed_at', 'timestamp')],
		primaryKey: ['id'],
		foreignKeys: [
			{ constraintName: 'orders_customer_id_fkey', columns: ['customer_id'], referencedTable: 'sales.customers', referencedColumns: ['id'] },
			{ constraintName: 'orders_warehouse_id_fkey', columns: ['warehouse_id'], referencedTable: 'ops.warehouses', referencedColumns: ['id'] },
		],
		indexes: [{ name: 'idx_orders_placed_at', columns: ['placed_at'], unique: false }],
		stats: { rowCount: 120000 },
	};
	const customers: TableInfo = {
		name: 'customers',
		schema: 'sales',
		kind: 'table',
		columns: [column('id', 'int', true), column('name', 'varchar(120)')],
		primaryKey: ['id'],
		foreignKeys: [],
	};
	const orderLines: TableInfo = {
		name: 'order_lines',
		schema: 'sales',
		kind: 'table',
		columns: [column('id', 'int', true), column('order_id'), column('sku', 'varchar(40)')],
		primaryKey: ['id'],
		foreignKeys: [{ constraintName: 'order_lines_order_id_fkey', columns: ['order_id'], referencedTable: 'sales.orders', referencedColumns: ['id'] }],
	};
	const warehouses: TableInfo = {
		name: 'warehouses',
		schema: 'ops',
		kind: 'table',
		columns: [column('id', 'int', true), column('code', 'varchar(8)')],
		primaryKey: ['id'],
		foreignKeys: [],
	};
	return { database: 'shop', tables: [orders, customers, orderLines, warehouses], fetchedAt: 1 };
}

interface Harness {
	ctx: CapabilityContext;
	opened: (string | undefined)[];
	focused: string[];
}

/** A fake context: these capabilities reach the app only through ctx.snapshot() (which connection,
 *  which tabs) and ctx.api.getSchema. The view is reached through the module-level bridge, so the
 *  harness sets it and records what it was asked to do. */
function harness(options: { connected?: boolean; orbitOpen?: boolean; schema?: DatabaseSchema | null; canFocus?: boolean; noBridge?: boolean; active?: string } = {}): Harness {
	const opened: (string | undefined)[] = [];
	const focused: string[] = [];
	const bridge: OrbitBridge = {
		openOrbit: (table) => { opened.push(table); },
		focusOrbit: (table) => { focused.push(table); return options.canFocus !== false; },
	};
	setOrbitBridge(options.noBridge === true ? undefined : bridge);
	const schema = options.schema === undefined ? fixture() : options.schema;
	const ctx = {
		api: { getSchema: async () => schema },
		app: {},
		snapshot: () => ({
			connections: [{ id: 'c1', label: 'Shop', driver: 'postgres', connected: options.connected !== false }],
			activeConnectionId: options.active === undefined ? 'c1' : options.active || undefined,
			tabs: options.orbitOpen ? [{ id: 't1', title: 'Orbit', kind: 'orbit', active: true }] : [{ id: 't1', title: 'Query 1', kind: 'sql', active: true }],
			appSettings: {},
		}),
	} as unknown as CapabilityContext;
	return { ctx, opened, focused };
}

function report(data: unknown): string {
	assert.ok(Array.isArray(data), 'the neighbourhood comes back as lines, not a JSON blob');
	return (data as string[]).join('\n');
}

describe('orbit capability specs', () => {
	test('every tool is read-only, so none of them asks for consent', () => {
		// Orbit draws a schema the app already has. Nothing here writes, queries or needs undoing.
		for (const handler of orbitCapabilities) {
			assert.equal(handler.spec.mutates, false, handler.spec.name);
			assert.equal(handler.spec.consentLabel, undefined, handler.spec.name);
			assert.equal(handler.spec.domain, 'orbit');
		}
	});

	test('the specs are literal, because the MCP tool list is frozen at connect', () => {
		// Snapshot the manifest, then change everything a spec could have peeked at. If a
		// description or a parameter schema were built from app state, this would move.
		const before = JSON.stringify(orbitCapabilities.map((h) => h.spec));
		harness({ orbitOpen: true, connected: true });
		setOrbitBridge(undefined);
		assert.equal(JSON.stringify(orbitCapabilities.map((h) => h.spec)), before);
		for (const handler of orbitCapabilities) {
			assert.doesNotMatch(handler.spec.description, /orders|customers|Shop/);
		}
	});

	test('orbit_neighbourhood exists without the view, so an agent that connected first still sees it', () => {
		// The constraint that shaped this file: "open the view" can gate what a tool DOES, never
		// whether the tool is there. All three are in the static list.
		assert.deepEqual(orbitCapabilities.map((h) => h.spec.name), ['open_orbit', 'orbit_focus', 'orbit_neighbourhood']);
	});
});

describe('open_orbit', () => {
	test('opens the tab with no arguments and reads no schema', async () => {
		const { ctx, opened } = harness();
		const result = await openOrbit.run({}, ctx);
		assert.equal(result.ok, true);
		assert.deepEqual(opened, [undefined]);
	});

	test('a named table is resolved to schema.table before the tab opens', async () => {
		const { ctx, opened } = harness();
		const result = await openOrbit.run({ table: 'orders' }, ctx);
		assert.equal(result.ok, true);
		assert.deepEqual(opened, ['sales.orders']);
		assert.match(result.summary, /sales\.orders/);
	});

	test('a table nobody has is refused with the near matches, not an empty view', async () => {
		const { ctx, opened } = harness();
		const result = await openOrbit.run({ table: 'order' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /Did you mean/);
		assert.match(result.error ?? '', /sales\.orders/);
		assert.equal(opened.length, 0);
	});

	test('a name with nothing like it says where to look instead', async () => {
		const { ctx } = harness();
		const result = await openOrbit.run({ table: 'zzz' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /list_tables/);
	});

	test('refuses a disconnected connection, and an unknown one, with the fix', async () => {
		const disconnected = harness({ connected: false });
		const off = await openOrbit.run({ table: 'orders' }, disconnected.ctx);
		assert.equal(off.ok, false);
		assert.match(off.error ?? '', /Connect it first/);

		const { ctx } = harness();
		const unknown = await openOrbit.run({ table: 'orders', connectionId: 'nope' }, ctx);
		assert.equal(unknown.ok, false);
		assert.match(unknown.error ?? '', /list_connections/);
	});

	test('refuses when nothing is selected and nothing was named', async () => {
		const { ctx } = harness({ active: '' });
		const result = await openOrbit.run({ table: 'orders' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /connectionId/);
	});

	test('refuses a connection that has never been introspected', async () => {
		const { ctx } = harness({ schema: null });
		const result = await openOrbit.run({ table: 'orders' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /list_tables/);
	});

	test('says so when the window has not wired Orbit up yet', async () => {
		const { ctx } = harness({ noBridge: true });
		const result = await openOrbit.run({}, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /not wired up/);
	});
});

describe('orbit_focus', () => {
	test('focuses the resolved object when Orbit is open', async () => {
		const { ctx, focused } = harness({ orbitOpen: true });
		const result = await orbitFocus.run({ table: 'ORDERS' }, ctx);
		assert.equal(result.ok, true);
		assert.deepEqual(focused, ['sales.orders']);
		assert.deepEqual(result.data, { focused: 'sales.orders', kind: 'table', degree: 4 });
	});

	test('tells the caller to open Orbit first rather than failing quietly', async () => {
		const { ctx, focused } = harness({ orbitOpen: false });
		const result = await orbitFocus.run({ table: 'orders' }, ctx);
		assert.equal(result.ok, false);
		assert.equal(result.error, 'Orbit is not open. Call open_orbit first.');
		assert.equal(focused.length, 0);
	});

	test('an unknown object names the near matches', async () => {
		const { ctx, focused } = harness({ orbitOpen: true });
		const result = await orbitFocus.run({ table: 'customer' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /Did you mean .*sales\.customers/);
		assert.equal(focused.length, 0);
	});

	test('requires a table, and says what a table looks like', async () => {
		const { ctx } = harness({ orbitOpen: true });
		const blank = await orbitFocus.run({ table: '   ' }, ctx);
		assert.equal(blank.ok, false);
		assert.match(blank.error ?? '', /schema\.table/);
		assert.equal((await orbitFocus.run({}, ctx)).ok, false);
	});

	test('an Orbit that cannot act yet says why and offers open_orbit', async () => {
		const { ctx } = harness({ orbitOpen: true, canFocus: false });
		const result = await orbitFocus.run({ table: 'orders' }, ctx);
		assert.equal(result.ok, false);
		assert.match(result.error ?? '', /open_orbit/);
	});
});

describe('orbit_neighbourhood', () => {
	test('works with the Orbit tab closed: it reads the schema, not the view', async () => {
		const { ctx } = harness({ orbitOpen: false });
		const result = await orbitNeighbourhood.run({ table: 'sales.orders' }, ctx);
		assert.equal(result.ok, true);
	});

	test('reads as sentences a model can say out loud', async () => {
		const { ctx } = harness();
		const result = await orbitNeighbourhood.run({ table: 'orders' }, ctx);
		assert.equal(result.ok, true);
		const text = report(result.data);
		assert.match(text, /sales\.orders is a table in schema "sales", 4 columns, about 120,000 rows\./);
		assert.match(text, /Primary key: id\./);
		// The constraint name is the real one off ForeignKeyInfo, not a guessed <table>_fkey.
		assert.match(text, /orders_customer_id_fkey: \(customer_id\) references sales\.customers \(id\)/);
		assert.match(text, /order_lines_order_id_fkey: sales\.order_lines \(order_id\) references \(id\)/);
		assert.match(text, /idx_orders_placed_at \(placed_at\)/);
		assert.match(text, /One hop away \(3\): /);
		assert.equal(result.summary, 'sales.orders: 3 foreign keys');
	});

	test('says which relations leave the schema, and how many', async () => {
		const { ctx } = harness();
		const text = report((await orbitNeighbourhood.run({ table: 'orders' }, ctx)).data);
		assert.match(text, /orders_warehouse_id_fkey: \(warehouse_id\) references ops\.warehouses \(id\) \[crosses schemas\]/);
		// The in-schema one must NOT be marked, or the marker means nothing.
		assert.doesNotMatch(text, /sales\.customers \(id\) \[crosses schemas\]/);
		assert.match(text, /1 of its 3 foreign keys cross a schema boundary\./);
	});

	test('absence is stated, not left as a missing section', async () => {
		// A section that silently disappears reads as one the tool forgot to fill in, and a model
		// cannot tell "no foreign keys" from "not looked at".
		const { ctx } = harness();
		const text = report((await orbitNeighbourhood.run({ table: 'ops.warehouses' }, ctx)).data);
		assert.match(text, /Foreign keys out: none\./);
		assert.match(text, /Foreign keys in \(1\)/);
		assert.match(text, /Indexes: none besides the primary key\./);
	});

	test('a table nothing touches says so rather than printing an empty list', async () => {
		const lonely = fixture();
		lonely.tables = [{ name: 'audit_log', schema: 'ops', kind: 'table', columns: [column('id', 'int', true)], primaryKey: ['id'], foreignKeys: [] }];
		const { ctx } = harness({ schema: lonely });
		const text = report((await orbitNeighbourhood.run({ table: 'audit_log' }, ctx)).data);
		assert.match(text, /One hop away: nothing\./);
	});

	test('requires a table and refuses an unknown one with the near matches', async () => {
		const { ctx } = harness();
		assert.equal((await orbitNeighbourhood.run({ table: '' }, ctx)).ok, false);
		assert.equal((await orbitNeighbourhood.run({ table: 42 }, ctx)).ok, false);
		const unknown = await orbitNeighbourhood.run({ table: 'warehouse' }, ctx);
		assert.equal(unknown.ok, false);
		assert.match(unknown.error ?? '', /Did you mean .*ops\.warehouses/);
	});
});

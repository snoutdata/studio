/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { AiToolSettings, ToolCall } from '../../ai';
import type { DatabaseSchema } from '../../schema';
import type { ExecuteQueryResult } from '../../protocol';
import { buildToolSpecs, parseMongoRunQuery, runTool, type ConnectionHandle, type ToolContext } from './tools';
import type { ToolAuditRecord } from '../audit';
import type { NativeQuery } from '../compile/native';

const SCHEMA: DatabaseSchema = {
	database: 'shop',
	fetchedAt: 0,
	tables: [
		{
			name: 'orders',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'customer_id', dataType: 'int', nullable: false, isPrimaryKey: false },
				{ name: 'total', dataType: 'decimal', nullable: true, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [{ constraintName: 'fk_cust', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'] }],
			indexes: [{ name: 'idx_cust', columns: ['customer_id'], unique: false }],
		},
		{
			name: 'customers',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'email', dataType: 'varchar', nullable: true, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [],
		},
	],
};

const ALL_ON: AiToolSettings = { enabled: true, listTables: true, describeTable: true, searchColumns: true, runQuery: true, autoApproveConnections: [], maxSteps: 8, maxRows: 200 };

interface CtxOptions {
	approve?: boolean;
	rows?: unknown[][];
	executeOk?: boolean;
	maxRows?: number;
}

/** A test ToolContext; records the SQL passed to execute and whether approval was asked. */
function makeCtx(opts: CtxOptions = {}): { ctx: ToolContext; sawSql(): string | undefined; approvalAsked(): boolean } {
	let lastSql: string | undefined;
	let asked = false;
	const ctx: ToolContext = {
		schema: SCHEMA,
		dialect: 'MySQL',
		settings: { ...ALL_ON, maxRows: opts.maxRows ?? 200 },
		execute: async (sql: string): Promise<ExecuteQueryResult> => {
			lastSql = sql;
			if (opts.executeOk === false) {
				return { ok: false, error: 'Table not found' };
			}
			return { ok: true, result: { fields: [{ name: 'id' }, { name: 'email' }], rows: opts.rows ?? [[1, 'a@x.com'], [2, 'b@x.com']], rowCount: (opts.rows ?? [[1], [2]]).length, durationMs: 4 } };
		},
		approve: async (): Promise<boolean> => {
			asked = true;
			return opts.approve ?? true;
		},
		emit: () => undefined,
	};
	return { ctx, sawSql: () => lastSql, approvalAsked: () => asked };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
	return { id: 'c1', name, arguments: args };
}

describe('buildToolSpecs', () => {
	test('only includes enabled tools and needs a connection available', () => {
		assert.deepEqual(buildToolSpecs(ALL_ON, true).map((t) => t.name).sort(), ['describe_table', 'list_tables', 'run_query', 'search_columns']);
		assert.deepEqual(buildToolSpecs({ ...ALL_ON, runQuery: false, searchColumns: false }, true).map((t) => t.name).sort(), ['describe_table', 'list_tables']);
		assert.deepEqual(buildToolSpecs(ALL_ON, false), []);
	});
});

describe('connect-on-demand', () => {
	test('a DB tool against an offline connection asks to connect, then runs', async () => {
		let connectAsked = false;
		const { ctx } = makeCtx();
		ctx.schema = null; // not connected yet
		ctx.ensureConnected = async () => {
			connectAsked = true;
			ctx.schema = SCHEMA; // connecting introspects the schema
			return { ok: true };
		};
		const result = await runTool(call('run_query', { sql: 'SELECT id FROM customers' }), ctx);
		assert.equal(connectAsked, true);
		assert.equal(result.isError, undefined);
	});

	test('a declined connect returns a soft note and never executes', async () => {
		const { ctx, sawSql } = makeCtx();
		ctx.schema = null;
		ctx.ensureConnected = async () => ({ ok: false, declined: true });
		const result = await runTool(call('run_query', { sql: 'SELECT 1' }), ctx);
		assert.equal(result.isError, undefined); // a soft stop, not an error
		assert.match(result.content, /declined to connect/i);
		assert.equal(sawSql(), undefined); // the query never ran
	});

	test('a failed connect surfaces as a tool error', async () => {
		const { ctx } = makeCtx();
		ctx.schema = null;
		ctx.ensureConnected = async () => ({ ok: false, error: 'Access denied' });
		const result = await runTool(call('list_tables', {}), ctx);
		assert.equal(result.isError, true);
		assert.match(result.content, /Access denied/);
	});
});

describe('run_query read-only enforcement', () => {
	test('refuses a DELETE without asking for approval or executing', async () => {
		const { ctx, sawSql, approvalAsked } = makeCtx();
		const result = await runTool(call('run_query', { sql: 'DELETE FROM orders' }), ctx);
		assert.equal(result.isError, true);
		assert.match(result.content, /read-only/i);
		assert.equal(approvalAsked(), false);
		assert.equal(sawSql(), undefined);
	});

	test('refuses a non-read leading verb (USE/SET)', async () => {
		const { ctx } = makeCtx();
		assert.equal((await runTool(call('run_query', { sql: 'USE other_db' }), ctx)).isError, true);
		assert.equal((await runTool(call('run_query', { sql: 'SET autocommit = 0' }), ctx)).isError, true);
	});

	test('refuses a destructive second statement', async () => {
		const { ctx, approvalAsked } = makeCtx();
		const result = await runTool(call('run_query', { sql: 'SELECT 1; DROP TABLE orders' }), ctx);
		assert.equal(result.isError, true);
		assert.equal(approvalAsked(), false);
	});

	test('allows a SELECT after approval and formats rows', async () => {
		const { ctx, approvalAsked } = makeCtx();
		const result = await runTool(call('run_query', { sql: 'SELECT id, email FROM customers' }), ctx);
		assert.equal(approvalAsked(), true);
		assert.notEqual(result.isError, true);
		assert.match(result.content, /id \| email/);
		assert.match(result.content, /a@x\.com/);
		assert.match(result.content, /2 rows/);
	});

	test('declined approval returns a non-error note and does not execute', async () => {
		const { ctx, sawSql } = makeCtx({ approve: false });
		const result = await runTool(call('run_query', { sql: 'SELECT * FROM orders' }), ctx);
		assert.notEqual(result.isError, true);
		assert.match(result.content, /declined/i);
		assert.equal(sawSql(), undefined);
	});

	test('surfaces a driver error as a tool error', async () => {
		const { ctx } = makeCtx({ executeOk: false });
		const result = await runTool(call('run_query', { sql: 'SELECT 1' }), ctx);
		assert.equal(result.isError, true);
		assert.match(result.content, /Table not found/);
	});
});

describe('parseMongoRunQuery (document run_query)', () => {
	test('accepts {collection, pipeline} and row-caps an unbounded pipeline', () => {
		const r = parseMongoRunQuery('{"collection":"orders","pipeline":[{"$match":{"total":{"$gt":10}}}]}', undefined, 50);
		assert.deepEqual(r, { native: { lang: 'mongo', collection: 'orders', pipeline: [{ $match: { total: { $gt: 10 } } }, { $limit: 50 }] } });
	});

	test('accepts a bare array + the collection argument; keeps an existing $limit', () => {
		const r = parseMongoRunQuery('[{"$sort":{"createdAt":-1}},{"$limit":5}]', 'orders', 50);
		assert.deepEqual(r, { native: { lang: 'mongo', collection: 'orders', pipeline: [{ $sort: { createdAt: -1 } }, { $limit: 5 }] } });
	});

	test('refuses a $out/$merge write', () => {
		const r = parseMongoRunQuery('{"collection":"orders","pipeline":[{"$out":"dump"}]}', undefined, 50);
		assert.ok('error' in r && /read-only|\$out/i.test(r.error));
	});

	test('errors when no collection can be determined', () => {
		const r = parseMongoRunQuery('[{"$match":{}}]', undefined, 50);
		assert.ok('error' in r && /collection/i.test(r.error));
	});

	test('non-JSON falls through to the SQL path', () => {
		assert.deepEqual(parseMongoRunQuery('SELECT * FROM orders', undefined, 50), { sql: true });
	});
});

describe('run_query document mode (native pipeline)', () => {
	function makeDocCtx(): { ctx: ToolContext; sawNative(): NativeQuery | undefined } {
		let native: NativeQuery | undefined;
		const ctx: ToolContext = {
			schema: SCHEMA,
			dialect: 'MongoDB',
			settings: { ...ALL_ON, maxRows: 200 },
			documentMode: true,
			execute: async () => ({ ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } }),
			executeNative: async (q: NativeQuery): Promise<ExecuteQueryResult> => {
				native = q;
				return { ok: true, result: { fields: [{ name: '_id' }, { name: 'total' }], rows: [['a', 12]], rowCount: 1, durationMs: 3 } };
			},
			approve: async () => true,
			emit: () => undefined,
		};
		return { ctx, sawNative: () => native };
	}

	test('runs a proposed pipeline natively and formats the documents', async () => {
		const { ctx, sawNative } = makeDocCtx();
		const result = await runTool(call('run_query', { sql: '{"collection":"orders","pipeline":[{"$match":{"total":{"$gt":10}}}]}' }), ctx);
		assert.notEqual(result.isError, true);
		assert.match(result.content, /_id \| total/);
		assert.equal(sawNative()?.lang, 'mongo');
	});

	test('refuses a write pipeline before executing', async () => {
		const { ctx, sawNative } = makeDocCtx();
		const result = await runTool(call('run_query', { sql: '{"collection":"orders","pipeline":[{"$merge":{"into":"x"}}]}' }), ctx);
		assert.equal(result.isError, true);
		assert.equal(sawNative(), undefined);
	});
});

describe('run_query auto-LIMIT', () => {
	test('appends LIMIT to an unbounded SELECT', async () => {
		const { ctx, sawSql } = makeCtx({ maxRows: 50 });
		await runTool(call('run_query', { sql: 'SELECT * FROM orders' }), ctx);
		assert.match(sawSql() ?? '', /LIMIT 50/);
	});

	test('leaves an existing LIMIT untouched', async () => {
		const { ctx, sawSql } = makeCtx({ maxRows: 50 });
		await runTool(call('run_query', { sql: 'SELECT * FROM orders LIMIT 5' }), ctx);
		assert.doesNotMatch(sawSql() ?? '', /LIMIT 50/);
		assert.match(sawSql() ?? '', /LIMIT 5/);
	});

	test('does not add LIMIT to SHOW/DESCRIBE', async () => {
		const { ctx, sawSql } = makeCtx();
		await runTool(call('run_query', { sql: 'SHOW TABLES' }), ctx);
		assert.doesNotMatch(sawSql() ?? '', /LIMIT/);
	});
});

describe('schema tools', () => {
	test('list_tables filters by name', async () => {
		const { ctx } = makeCtx();
		const all = await runTool(call('list_tables', {}), ctx);
		assert.match(all.content, /orders/);
		assert.match(all.content, /customers/);
		const filtered = await runTool(call('list_tables', { filter: 'cust' }), ctx);
		assert.match(filtered.content, /customers/);
		assert.doesNotMatch(filtered.content, /orders \(/);
	});

	test('describe_table returns columns, PK, FK and indexes', async () => {
		const { ctx } = makeCtx();
		const result = await runTool(call('describe_table', { name: 'orders' }), ctx);
		assert.match(result.content, /customer_id int/);
		assert.match(result.content, /Primary key: id/);
		assert.match(result.content, /customer_id → customers\(id\)/);
		assert.match(result.content, /idx_cust/);
	});

	test('describe_table on an unknown table errors with a hint', async () => {
		const { ctx } = makeCtx();
		const result = await runTool(call('describe_table', { name: 'nope' }), ctx);
		assert.equal(result.isError, true);
	});

	test('describe_table surfaces stored functions callable from the table\'s columns', async () => {
		const { ctx } = makeCtx();
		// A function whose params are all columns of `orders` is related; an unrelated one isn't.
		ctx.schema!.routines = [
			{ name: 'orderTotal', schema: 'shop', kind: 'function', returnType: 'decimal', parameters: [{ name: 'id', dataType: 'int' }, { name: 'customer_id', dataType: 'int' }] },
			{ name: 'getDaysOutOfCredit', schema: 'shop', kind: 'function', returnType: 'int', parameters: [{ name: 'cp_id', dataType: 'int' }] },
		];
		const result = await runTool(call('describe_table', { name: 'orders' }), ctx);
		assert.match(result.content, /Related stored functions/);
		assert.match(result.content, /orderTotal\(id int, customer_id int\) → decimal/);
		assert.doesNotMatch(result.content, /getDaysOutOfCredit/);
	});

	test('search_columns finds matching columns', async () => {
		const { ctx } = makeCtx();
		const result = await runTool(call('search_columns', { term: 'email' }), ctx);
		assert.match(result.content, /customers\.email/);
	});
});

describe('authoritative schema tools force a live re-introspect', () => {
	// A schema that gains a column only after refreshSchema runs — mimics a column added to the DB
	// after the last introspect, which a cache-only lookup would wrongly report as missing.
	function makeRefreshingCtx(): { ctx: ToolContext; refreshes(): number } {
		let refreshed = 0;
		const stale: DatabaseSchema = { database: 'shop', fetchedAt: 0, tables: [{ name: 'customer_order', kind: 'table', columns: [{ name: 'close_date', dataType: 'timestamp', nullable: true, isPrimaryKey: false }], primaryKey: [], foreignKeys: [], indexes: [] }] };
		const ctx: ToolContext = {
			schema: stale,
			dialect: 'MySQL',
			settings: ALL_ON,
			execute: async () => ({ ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } }),
			approve: async () => true,
			emit: () => undefined,
			refreshSchema: async () => {
				refreshed++;
				ctx.schema = { database: 'shop', fetchedAt: 0, tables: [{ ...stale.tables[0], columns: [...stale.tables[0].columns, { name: 'shipped_at', dataType: 'timestamp', nullable: true, isPrimaryKey: false }] }] };
			},
		};
		return { ctx, refreshes: () => refreshed };
	}

	test('describe_table refreshes and sees a newly-added column', async () => {
		const { ctx, refreshes } = makeRefreshingCtx();
		const result = await runTool(call('describe_table', { name: 'customer_order' }), ctx);
		assert.equal(refreshes(), 1);
		assert.match(result.content, /shipped_at/);
	});

	test('search_columns refreshes before searching', async () => {
		const { ctx, refreshes } = makeRefreshingCtx();
		const result = await runTool(call('search_columns', { term: 'shipped' }), ctx);
		assert.equal(refreshes(), 1);
		assert.match(result.content, /shipped_at/);
	});

	test('list_tables does not force a refresh (cache is fine there)', async () => {
		const { ctx, refreshes } = makeRefreshingCtx();
		await runTool(call('list_tables', {}), ctx);
		assert.equal(refreshes(), 0);
	});
});

describe('cross-connection targeting (the connection argument)', () => {
	// A second connection ("dev") whose customer_order LACKS shipped_at, resolved by label. The
	// active connection (SCHEMA/makeCtx) is a different DB — so a tool with connection:"dev" must read
	// dev's schema, not the active one.
	const DEV_SCHEMA: DatabaseSchema = { database: 'dev', fetchedAt: 0, tables: [{ name: 'customer_order', kind: 'table', columns: [{ name: 'close_date', dataType: 'timestamp', nullable: true, isPrimaryKey: false }], primaryKey: [], foreignKeys: [], indexes: [] }] };
	function withDev(): { ctx: ToolContext; devExecuted(): string | undefined } {
		let devSql: string | undefined;
		const { ctx } = makeCtx();
		ctx.resolveConnection = async (ref: string): Promise<ConnectionHandle | null> => {
			if (ref.toLowerCase() !== 'dev') {
				return null;
			}
			return {
				label: 'dev',
				schema: DEV_SCHEMA,
				execute: async (sql: string): Promise<ExecuteQueryResult> => { devSql = sql; return { ok: true, result: { fields: [{ name: 'n' }], rows: [[0]], rowCount: 1, durationMs: 1 } }; },
				approve: async () => true,
			};
		};
		return { ctx, devExecuted: () => devSql };
	}

	test('describe_table with connection targets that DB\'s schema, not the active one', async () => {
		const { ctx } = withDev();
		// Active connection HAS an "email" column on customers; dev's customer_order does not have shipped_at.
		const result = await runTool(call('describe_table', { name: 'customer_order', connection: 'dev' }), ctx);
		assert.doesNotMatch(result.content, /shipped_at/);
		assert.match(result.content, /close_date/);
	});

	test('run_query with connection runs against the named connection', async () => {
		const { ctx, devExecuted } = withDev();
		const result = await runTool(call('run_query', { sql: 'SELECT COUNT(*) FROM customer_order', connection: 'dev' }), ctx);
		assert.equal(result.isError, undefined);
		assert.match(devExecuted() ?? '', /customer_order/);
	});

	test('an unknown connection ref is a soft error the model can recover from', async () => {
		const { ctx } = withDev();
		const result = await runTool(call('describe_table', { name: 'customer_order', connection: 'staging' }), ctx);
		assert.equal(result.isError, true);
		assert.match(result.content, /No saved connection matches "staging"/);
	});

	test('no connection argument uses the active connection (unchanged path)', async () => {
		const { ctx } = withDev();
		const result = await runTool(call('describe_table', { name: 'orders' }), ctx);
		assert.match(result.content, /orders/);
	});
});

describe('client capabilities (renderer-side tools)', () => {
	interface ClientCtxOptions {
		approveAction?: boolean;
		result?: { ok: boolean; summary: string; data?: unknown; error?: string };
		mutates?: boolean;
		names?: string[];
	}
	function makeClientCtx(opts: ClientCtxOptions = {}): { ctx: ToolContext; invoked(): boolean; approvalAsked(): boolean; approvalSummary(): string } {
		let invoked = false;
		let asked = false;
		let summary = '';
		const names = opts.names ?? ['open_connection_form', 'get_app_state'];
		const ctx: ToolContext = {
			schema: SCHEMA,
			dialect: 'MySQL',
			settings: ALL_ON,
			execute: async () => ({ ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } }),
			approve: async () => true,
			emit: () => undefined,
			invokeClient: async () => { invoked = true; return opts.result ?? { ok: true, summary: 'Opened the connection form' }; },
			approveAction: async (text) => { asked = true; summary = text; return opts.approveAction ?? true; },
			clientCapabilities: new Set(names),
			clientMutates: new Set(opts.mutates === false ? [] : ['open_connection_form']),
		};
		return { ctx, invoked: () => invoked, approvalAsked: () => asked, approvalSummary: () => summary };
	}

	test('routes a read-only capability to invokeClient with no approval', async () => {
		const { ctx, invoked, approvalAsked } = makeClientCtx({ result: { ok: true, summary: '2 connections', data: { connections: [] } } });
		const result = await runTool(call('get_app_state', {}), ctx);
		assert.equal(invoked(), true);
		assert.equal(approvalAsked(), false);
		assert.notEqual(result.isError, true);
		assert.match(result.content, /2 connections/);
	});

	test('a mutating capability asks for approval before invoking', async () => {
		const { ctx, invoked, approvalAsked } = makeClientCtx();
		const result = await runTool(call('open_connection_form', { label: 'Local' }), ctx);
		assert.equal(approvalAsked(), true);
		assert.equal(invoked(), true);
		assert.match(result.content, /Opened the connection form/);
	});

	test('the approval card names the target even when the capability does not call it label/name/id', async () => {
		// The card is the only thing between the model and an unattended write, so "run data flow"
		// with no flow named is not enough to approve: `run_data_flow` calls its argument `flow`,
		// which none of the preferred keys match. Found in a hand test.
		const { ctx, approvalSummary } = makeClientCtx({ names: ['run_data_flow'], mutates: true });
		ctx.clientMutates = new Set(['run_data_flow']);
		await runTool(call('run_data_flow', { flow: 'customers' }), ctx);
		assert.equal(approvalSummary(), 'run data flow (customers)');
	});

	test('the host may refuse a call before anyone is asked, or pin its arguments for the card and the run', async () => {
		const { ctx, invoked, approvalAsked } = makeClientCtx();
		ctx.prepareAction = () => ({ ok: false, error: 'Refused: not a read.' });
		const refused = await runTool(call('open_connection_form', { label: 'Local' }), ctx);
		assert.equal(refused.isError, true);
		assert.match(refused.content, /not a read/);
		assert.equal(approvalAsked(), false);
		assert.equal(invoked(), false);

		let ran: Record<string, unknown> = {};
		const pinned = makeClientCtx();
		pinned.ctx.prepareAction = (c) => ({ ok: true, arguments: { ...c.arguments, label: 'Pinned' } });
		pinned.ctx.invokeClient = async (inv) => { ran = inv.arguments; return { ok: true, summary: 'done' }; };
		await runTool(call('open_connection_form', { label: 'Local' }), pinned.ctx);
		assert.equal(pinned.approvalSummary(), 'open connection form (Pinned)');
		assert.equal(ran.label, 'Pinned');
	});

	test('a declined mutating capability is not invoked and returns a non-error note', async () => {
		const { ctx, invoked } = makeClientCtx({ approveAction: false });
		const result = await runTool(call('open_connection_form', { label: 'Local' }), ctx);
		assert.equal(invoked(), false);
		assert.notEqual(result.isError, true);
		assert.match(result.content, /declined/i);
	});

	test('an unsuccessful capability result becomes a tool error', async () => {
		const { ctx } = makeClientCtx({ result: { ok: false, summary: '', error: 'No such connection.' } });
		const result = await runTool(call('open_connection_form', {}), ctx);
		assert.equal(result.isError, true);
		assert.match(result.content, /No such connection/);
	});

	test('a built-in tool name beats a colliding client capability', async () => {
		// Even if the manifest advertises list_tables, the built-in switch handles it first.
		const { ctx, invoked } = makeClientCtx({ names: ['list_tables'] });
		const result = await runTool(call('list_tables', {}), ctx);
		assert.equal(invoked(), false);
		assert.match(result.content, /orders/);
	});

	test('an unknown tool lists client capabilities in its hint', async () => {
		const { ctx } = makeClientCtx({ names: ['get_app_state'] });
		const result = await runTool(call('frobnicate', {}), ctx);
		assert.equal(result.isError, true);
		assert.match(result.content, /get_app_state/);
	});

	test('a read-only workspace capability (list_workspace_files) runs with no approval', async () => {
		let invoked = false;
		let asked = false;
		const ctx: ToolContext = {
			schema: SCHEMA,
			dialect: 'MySQL',
			settings: ALL_ON,
			execute: async () => ({ ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } }),
			approve: async () => true,
			emit: () => undefined,
			invokeClient: async () => { invoked = true; return { ok: true, summary: '2 workspace files', data: [] }; },
			approveAction: async () => { asked = true; return true; },
			clientCapabilities: new Set(['list_workspace_files', 'save_workspace_file']),
			clientMutates: new Set(['save_workspace_file']),
		};
		const result = await runTool(call('list_workspace_files', {}), ctx);
		assert.equal(invoked, true);
		assert.equal(asked, false);
		assert.match(result.content, /2 workspace files/);
	});

	test('a mutating workspace capability (save_workspace_file) asks for approval first', async () => {
		let invoked = false;
		let asked = false;
		const ctx: ToolContext = {
			schema: SCHEMA,
			dialect: 'MySQL',
			settings: ALL_ON,
			execute: async () => ({ ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } }),
			approve: async () => true,
			emit: () => undefined,
			invokeClient: async () => { invoked = true; return { ok: true, summary: 'Saved report.sql' }; },
			approveAction: async () => { asked = true; return true; },
			clientCapabilities: new Set(['list_workspace_files', 'save_workspace_file']),
			clientMutates: new Set(['save_workspace_file']),
		};
		const result = await runTool(call('save_workspace_file', { name: 'report', content: 'SELECT 1' }), ctx);
		assert.equal(asked, true);
		assert.equal(invoked, true);
		assert.match(result.content, /Saved report\.sql/);
	});
});

describe('audit trail', () => {
	// The point of auditing at runTool rather than per-capability: a capability added later is
	// recorded without anyone remembering to record it. These lock that in.
	function auditingCtx(opts: { fail?: boolean; throws?: boolean } = {}): { ctx: ToolContext; records(): ToolAuditRecord[] } {
		const records: ToolAuditRecord[] = [];
		let tick = 100;
		const ctx: ToolContext = {
			schema: SCHEMA,
			dialect: 'MySQL',
			settings: ALL_ON,
			connectionId: 'conn-1',
			clock: () => (tick += 5),
			execute: async () => ({ ok: true, result: { fields: [], rows: [], rowCount: 0, durationMs: 0 } }),
			approve: async () => true,
			emit: () => undefined,
			audit: (record) => {
				if (opts.throws) {
					throw new Error('disk full');
				}
				records.push(record);
			},
			invokeClient: async () => (opts.fail
				? { ok: false, summary: '', error: 'the form was already open' }
				: { ok: true, summary: 'Opened the connection form' }),
			approveAction: async () => true,
			clientCapabilities: new Set(['open_connection_form', 'get_app_state']),
			clientMutates: new Set(['open_connection_form']),
		};
		return { ctx, records: () => records };
	}

	test('a capability invocation is recorded', async () => {
		const { ctx, records } = auditingCtx();
		await runTool(call('open_connection_form', { driver: 'postgres' }), ctx);
		assert.equal(records().length, 1);
		const record = records()[0];
		assert.equal(record.tool, 'open_connection_form');
		assert.equal(record.ok, true);
		assert.equal(record.mutates, true, 'a mutating capability is flagged as such');
		assert.equal(record.origin, 'chat', 'origin defaults to chat');
		assert.equal(record.connectionId, 'conn-1');
		assert.deepEqual(record.arguments, { driver: 'postgres' });
		assert.equal(record.durationMs, 5, 'duration comes from the injected clock');
	});

	test('a read-only DB tool is recorded too, and not flagged as mutating', async () => {
		const { ctx, records } = auditingCtx();
		await runTool(call('list_tables', {}), ctx);
		assert.equal(records().length, 1);
		assert.equal(records()[0].tool, 'list_tables');
		assert.equal(records()[0].mutates, false);
	});

	test('a failed invocation is recorded with its error', async () => {
		const { ctx, records } = auditingCtx({ fail: true });
		await runTool(call('open_connection_form', {}), ctx);
		assert.equal(records()[0].ok, false);
		assert.match(records()[0].error ?? '', /already open/);
	});

	test('the recorded name is the normalised one, so aliases do not fragment the log', async () => {
		const { ctx, records } = auditingCtx();
		await runTool(call('execute_query', { sql: 'SELECT 1' }), ctx);
		assert.equal(records()[0].tool, 'run_query', 'the alias resolved before recording');
	});

	test('a destructive run_query is recorded as mutating, a SELECT is not', async () => {
		// run_query is the one tool whose mutating-ness is only knowable from its argument, so
		// the audit has to look at the SQL rather than trust a declared flag.
		const { ctx, records } = auditingCtx();
		await runTool(call('run_query', { sql: 'SELECT * FROM users' }), ctx);
		assert.equal(records()[0].mutates, false);
		await runTool(call('run_query', { sql: 'DROP TABLE users' }), ctx);
		assert.equal(records()[1].mutates, true, 'a DROP must not be logged as a read');
	});

	test('an unwritable audit log never fails the action the user is waiting on', async () => {
		const { ctx } = auditingCtx({ throws: true });
		const result = await runTool(call('get_app_state', {}), ctx);
		assert.notEqual(result.isError, true, 'the tool still succeeded despite the audit throwing');
	});
});

describe('series tables in the agent tools (SnoutTime)', () => {
	const cols = [{ name: 'ts', dataType: 'timestamptz', nullable: false, isPrimaryKey: false }];
	const SERIES: DatabaseSchema = {
		database: 'iot',
		fetchedAt: 0,
		tables: [
			{
				name: 'metrics', schema: 'public', kind: 'table', columns: cols, primaryKey: [], foreignKeys: [],
				series: { timeColumn: 'ts', timeType: 'timestamptz', partitionSize: '1 day', partitions: [{ name: 'metrics_p20260921', state: 'sealed' }], rollups: [] },
			},
			{ name: 'metrics_p20260921', schema: 'public', kind: 'table', columns: cols, primaryKey: [], foreignKeys: [], partitionOf: { schema: 'public', name: 'metrics' } },
		],
	};

	test('list_tables shows the series once, as a series, and not its partitions', async () => {
		const { ctx } = makeCtx();
		ctx.schema = SERIES;
		const result = await runTool(call('list_tables', {}), ctx);
		assert.match(result.content, /^1 tables:/);
		assert.match(result.content, /metrics \(series table partitioned by ts, 1 partitions, 1 cols\)/);
		assert.doesNotMatch(result.content, /metrics_p20260921/);
	});

	test('describe_table says what a series is, and sends a partition back to its parent', async () => {
		const { ctx } = makeCtx();
		ctx.schema = SERIES;
		assert.match((await runTool(call('describe_table', { name: 'metrics' }), ctx)).content, /SERIES: time column ts/);
		assert.match((await runTool(call('describe_table', { name: 'metrics_p20260921' }), ctx)).content, /A partition of public\.metrics: query that table/);
	});
});

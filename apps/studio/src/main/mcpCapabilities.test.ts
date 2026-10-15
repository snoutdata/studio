/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';

import { LocalMcpServer, type McpConnectionRef, type McpServerDeps } from './mcpServer';
import type { CapabilityResult, CapabilitySpec } from '../shared/capabilities';
import type { ToolAuditRecord } from '../shared/engine';

/*
 * App capabilities as MCP tools: the part that lets an external agent act on the app's SCREEN, not
 * just read a database.
 *
 * Kept beside mcpServer.test.ts rather than inside it because every case here needs its own server
 * with its own published capabilities and its own answer to "may an agent change the app".
 */

const TOKEN = 'capability-test-token';

const READ_SPEC: CapabilitySpec = {
	name: 'get_app_state',
	description: 'What is open in the app.',
	parameters: { type: 'object', properties: {} },
	domain: 'app',
	mutates: false,
	implicitConnection: 'none',
	returnsData: 'none',
};

const WRITE_SPEC: CapabilitySpec = {
	name: 'open_query_tab',
	description: 'Open a new editor tab with SQL in it.',
	parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
	domain: 'editor',
	mutates: true,
	implicitConnection: 'none',
	returnsData: 'none',
};

/** A second mutating capability, so a test can tell "allowed for good" from "will ask". */
const OTHER_WRITE_SPEC: CapabilitySpec = {
	name: 'set_setting',
	description: 'Change one app preference.',
	parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
	domain: 'settings',
	mutates: true,
	implicitConnection: 'none',
	returnsData: 'none',
};

/** The render surface's tool, so a test can tell a build that can DRAW from one that cannot. */
const DRAW_SPEC: CapabilitySpec = {
	name: 'show_in_app',
	description: 'Show the user something in the app.',
	parameters: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] },
	domain: 'canvas',
	mutates: false,
	implicitConnection: 'none',
	returnsData: 'none',
};

interface Harness {
	port: number;
	invoked: { name: string; args: Record<string, unknown>; client: string; expect?: string[] }[];
	/** The capabilities main asked the app to resolve a connection for, before running. */
	resolved: string[];
	audited: { record: ToolAuditRecord; client: string }[];
}

/** The database half of the deps, which these tests never exercise but the server requires. */
function baseDeps(audited: Harness['audited']): McpServerDeps {
	return {
		serverInfo: { name: 'snoutdata', version: '9.9.9' },
		token: () => TOKEN,
		connections: () => [],
		resolveSchema: async () => null,
		execute: async () => ({ ok: false, error: 'not used' }),
		log: () => undefined,
		audit: (record, client) => { audited.push({ record, client }); },
		clock: (() => { let t = 0; return () => ++t; })(),
	};
}

interface Options {
	specs: CapabilitySpec[];
	allowMutating?: boolean;
	autoApproved?: string[];
	result?: CapabilityResult;
	/** Omit the bridge entirely, to prove a build without one still serves database tools. */
	noBridge?: boolean;
	/** The saved connections, and which are exposed to agents. */
	connections?: McpConnectionRef[];
	/** What the app answers when main asks which connections a call acts on. */
	acting?: string[];
}

async function withServer(options: Options, fn: (h: Harness) => Promise<void>): Promise<void> {
	const invoked: Harness['invoked'] = [];
	const audited: Harness['audited'] = [];
	const resolved: string[] = [];
	const server = new LocalMcpServer({
		...baseDeps(audited),
		...(options.connections ? { connections: () => options.connections ?? [] } : {}),
		...(options.noBridge ? {} : {
			capabilities: () => options.specs,
			allowMutatingCapabilities: () => options.allowMutating === true,
			autoApprovedCapabilities: () => options.autoApproved ?? [],
			invokeCapability: async (name, args, client, expect) => {
				invoked.push({ name, args, client, ...(expect ? { expect } : {}) });
				return options.result ?? { ok: true, summary: 'Opened a tab.', data: { tabId: 't1' } };
			},
			resolveCapabilityConnections: async (name) => {
				resolved.push(name);
				return { ok: true, summary: '', connectionIds: options.acting ?? [] };
			},
		}),
	});
	const port = await server.start(0); // 0 ⇒ the OS picks a free port
	try {
		await fn({ port, invoked, audited, resolved });
	} finally {
		await server.stop();
	}
}

async function rpc(port: number, body: unknown): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
	const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return text ? JSON.parse(text) : {};
}

interface ToolListed { name: string; description: string }

async function toolNames(port: number): Promise<string[]> {
	const res = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	return ((res.result?.tools ?? []) as ToolListed[]).map((t) => t.name);
}

async function toolDescription(port: number, name: string): Promise<string> {
	const res = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	return ((res.result?.tools ?? []) as ToolListed[]).find((t) => t.name === name)?.description ?? '';
}

interface CallOutcome { text: string; isError: boolean }

async function callTool(port: number, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
	const res = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
	const result = res.result as { content: { text: string }[]; isError: boolean };
	return { text: result.content[0].text, isError: result.isError };
}

test('tools/list carries the app capabilities alongside the database tools', async () => {
	await withServer({ specs: [READ_SPEC, WRITE_SPEC], allowMutating: true }, async (h) => {
		const names = await toolNames(h.port);
		assert.ok(names.includes('run_query'), 'the database tools are still there');
		assert.ok(names.includes('get_app_state'));
		assert.ok(names.includes('open_query_tab'));
	});
});

test('a capability that changes the app says so in its description', async () => {
	await withServer({ specs: [WRITE_SPEC], allowMutating: true }, async (h) => {
		assert.match(await toolDescription(h.port, 'open_query_tab'), /Changes the app/);
	});
});

test('the description does NOT carry the current permission, in either direction', async () => {
	// It used to say "currently refused" when the switch was off. The tool list is frozen at
	// connect and clients read it once, so that sentence outlives the fact: the user turns app
	// changes on in Settings and the agent goes on believing it is refused, which is exactly the
	// wrong idea to leave it with. The live answer is list_app_actions.
	for (const allowMutating of [false, true]) {
		await withServer({ specs: [WRITE_SPEC], allowMutating }, async (h) => {
			const description = await toolDescription(h.port, 'open_query_tab');
			assert.match(description, /needs the user's permission/);
			assert.doesNotMatch(description, /currently refused/);
			assert.match(description, /list_app_actions/, 'it points at the tool that does know');
		});
	}
});

test('list_app_actions lists every action, allowed or not, and says which is which', async () => {
	await withServer({ specs: [READ_SPEC, WRITE_SPEC], allowMutating: false }, async (h) => {
		const out = await callTool(h.port, 'list_app_actions');
		assert.equal(out.isError, false);
		// The refused one is LISTED. An agent shown only what it may do reports that the app cannot
		// do the rest, and the user never finds out the feature is there.
		assert.match(out.text, /open_query_tab/);
		assert.match(out.text, /get_app_state/);
		assert.match(out.text, /OFF/);
		assert.match(out.text, /asks the user/);
	});
});

test('list_app_actions distinguishes a standing yes from one that will ask', async () => {
	await withServer({ specs: [WRITE_SPEC, OTHER_WRITE_SPEC], allowMutating: true, autoApproved: ['open_query_tab'] }, async (h) => {
		const out = await callTool(h.port, 'list_app_actions');
		assert.match(out.text, /open_query_tab: allowed/);
		assert.match(out.text, /set_setting: needs permission/);
		assert.match(out.text, /ON/);
	});
});

test('a read capability is never listed as needing permission', async () => {
	await withServer({ specs: [READ_SPEC], allowMutating: false }, async (h) => {
		const out = await callTool(h.port, 'list_app_actions');
		assert.match(out.text, /get_app_state: allowed \(reads only/);
	});
});

test('a read capability runs with no permission and returns its summary and data', async () => {
	await withServer({ specs: [READ_SPEC], result: { ok: true, summary: '2 tabs open', data: { tabs: 2 } } }, async (h) => {
		const out = await callTool(h.port, 'get_app_state');
		assert.equal(out.isError, false);
		assert.match(out.text, /2 tabs open/);
		assert.match(out.text, /"tabs": 2/);
		assert.equal(h.invoked.length, 1);
	});
});

test('with the switch off a mutating call is HANDED ON, because that is where the user is asked', async () => {
	// It used to be refused right here, and the agent was told to send the user to Settings. Nobody
	// opens Settings to browse a list of things they have not heard of, so the feature was
	// discoverable only to whoever already knew about it. The gate now lives in one place, the
	// invoker, which raises the prompt (see invokeAgentCapability); this layer only reports the
	// state. A refusal still comes back as a refusal, from there.
	await withServer({ specs: [WRITE_SPEC], allowMutating: false, result: { ok: false, summary: '', error: 'Refused: app changes are switched off, and the user declined to turn them on.', refused: true } }, async (h) => {
		const out = await callTool(h.port, 'open_query_tab', { sql: 'select 1' });
		assert.equal(h.invoked.length, 1, 'the call reaches the invoker, which is what asks the user');
		assert.equal(out.isError, true);
		assert.match(out.text, /Refused/);
	});
});

test('a mutating capability runs, with its arguments, once app changes are allowed', async () => {
	await withServer({ specs: [WRITE_SPEC], allowMutating: true }, async (h) => {
		const out = await callTool(h.port, 'open_query_tab', { sql: 'select 1' });
		assert.equal(out.isError, false);
		assert.equal(h.invoked[0].name, 'open_query_tab');
		assert.deepEqual(h.invoked[0].args, { sql: 'select 1' });
	});
});

test('a capability call lands on the audit trail, tagged mutating, with the client name', async () => {
	await withServer({ specs: [WRITE_SPEC], allowMutating: true }, async (h) => {
		await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } });
		await callTool(h.port, 'open_query_tab', { sql: 'select 1' });
		const entry = h.audited.find((a) => a.record.tool === 'open_query_tab');
		assert.ok(entry, 'the call was audited');
		assert.equal(entry!.record.mutates, true);
		assert.equal(entry!.record.origin, 'mcp');
		assert.equal(entry!.client, 'claude-code');
	});
});

test('a failed capability comes back as a readable tool error, not a protocol error', async () => {
	await withServer({ specs: [READ_SPEC], result: { ok: false, summary: '', error: 'The app window is not open, so there is nothing to act on.' } }, async (h) => {
		const res = await rpc(h.port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_app_state', arguments: {} } });
		assert.equal(res.error, undefined);
		const result = res.result as { content: { text: string }[]; isError: boolean };
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /window is not open/);
	});
});

test('the tool list a client was given stays put for its session', async () => {
	// This transport has no SSE stream, so there is no notifications/tools/list_changed to send.
	// A list that shifted under a client would be one it could never learn about.
	let specs: CapabilitySpec[] = [READ_SPEC];
	const server = new LocalMcpServer({
		...baseDeps([]),
		capabilities: () => specs,
		invokeCapability: async () => ({ ok: true, summary: 'ok' }),
	});
	const port = await server.start(0);
	try {
		await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		specs = [READ_SPEC, WRITE_SPEC];
		const names = await toolNames(port);
		assert.ok(!names.includes('open_query_tab'), 'a capability registered later waits for the next connect');
	} finally {
		await server.stop();
	}
});

test('a build with no capability bridge serves the database tools and nothing else', async () => {
	await withServer({ specs: [READ_SPEC], noBridge: true }, async (h) => {
		const names = await toolNames(h.port);
		assert.deepEqual(names.sort(), ['describe_table', 'explain', 'list_connections', 'list_tables', 'run_query', 'search_columns']);
	});
});

/*
 * The house rules travel on the wire. `instructions` is where MCP puts "how to work with this
 * server", so every client gets them, including Codex and opencode, which never see a launch flag
 * of ours.
 */

async function instructions(port: number, params: Record<string, unknown> = {}): Promise<string> {
	const res = await rpc(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params });
	return String((res.result as { instructions?: unknown } | undefined)?.instructions ?? '');
}

test('initialize hands the client the house rules', async () => {
	await withServer({ specs: [READ_SPEC, DRAW_SPEC] }, async (h) => {
		const text = await instructions(h.port, { clientInfo: { name: 'claude-code' } });
		// Our server is the route to a database, and it says so with the tools by name.
		assert.match(text, /run_query/);
		// The habits it has to outrank, named: a local CLI, a local skill, another MCP server.
		assert.match(text, /psql/);
		assert.match(text, /skill/);
		// And where results go, since this build published the draw tool.
		assert.match(text, /show_in_app/);
	});
});

test('the rules never promise a render surface this build does not have', async () => {
	await withServer({ specs: [READ_SPEC] }, async (h) => {
		const text = await instructions(h.port);
		assert.equal(text.includes('show_in_app'), false);
		// The database half does not depend on a window, so it still stands.
		assert.match(text, /run_query/);
	});
});

test('a build with no capability bridge still tells the agent how to reach a database', async () => {
	await withServer({ specs: [], noBridge: true }, async (h) => {
		const text = await instructions(h.port);
		assert.match(text, /run_query/);
		assert.equal(text.includes('show_in_app'), false);
	});
});

// A capability that names a connection, or hands back rows from one, is held to the same
// per-connection allowlist as run_query: before, any token holder could read the users and grants
// of a production database the user never exposed, with no card.

function ref(id: string, label: string, allowed: boolean): McpConnectionRef {
	return { id, label, driver: 'postgres', allowed, writes: false, readOnlyBy: 'the statement check' };
}

const CONNECTIONS = [ref('prod-1', 'Billing prod', false), ref('dev-1', 'Local dev', true)];

const USERS_SPEC: CapabilitySpec = {
	name: 'list_db_users',
	description: 'List the users on a connection.',
	parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] },
	domain: 'security',
	mutates: false,
	implicitConnection: 'none',
	returnsData: 'schema',
};

const NEIGHBOURS_SPEC: CapabilitySpec = {
	name: 'orbit_neighbourhood',
	description: 'What a table is joined to.',
	parameters: { type: 'object', properties: { table: { type: 'string' }, connectionId: { type: 'string' } }, required: ['table'] },
	domain: 'orbit',
	mutates: false,
	implicitConnection: 'none',
	returnsData: 'schema',
};

const TEST_SPEC: CapabilitySpec = {
	name: 'test_connection',
	description: 'Test a saved connection.',
	parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	domain: 'connections',
	mutates: false,
	implicitConnection: 'none',
	returnsData: 'none',
	connectionArg: 'id',
};

const RESULT_SPEC: CapabilitySpec = {
	name: 'get_query_result',
	description: 'The rows in the result grid.',
	parameters: { type: 'object', properties: { limit: { type: 'number' } } },
	domain: 'results',
	mutates: false,
	implicitConnection: 'result',
	returnsData: 'values',
};

test('a capability naming a connection that is not exposed is refused, and the app never runs it', async () => {
	await withServer({ specs: [USERS_SPEC, TEST_SPEC], connections: CONNECTIONS }, async (h) => {
		for (const [name, args] of [['list_db_users', { connectionId: 'Billing prod' }], ['list_db_users', { connectionId: 'prod-1' }], ['test_connection', { id: 'billing PROD' }]] as const) {
			const out = await callTool(h.port, name, args);
			assert.equal(out.isError, true, name);
			assert.match(out.text, /"Billing prod" is not exposed to agents/);
		}
		assert.deepEqual(h.invoked, []);
	});
});

test('an exposed connection goes through, handed on by its id', async () => {
	await withServer({ specs: [USERS_SPEC], connections: CONNECTIONS }, async (h) => {
		const out = await callTool(h.port, 'list_db_users', { connectionId: 'Local dev' });
		assert.equal(out.isError, false);
		assert.deepEqual(h.invoked.map((call) => call.args), [{ connectionId: 'dev-1' }]);
	});
});

test('an optional connection left out is refused, since the app would use the selected one', async () => {
	await withServer({ specs: [NEIGHBOURS_SPEC], connections: CONNECTIONS }, async (h) => {
		const out = await callTool(h.port, 'orbit_neighbourhood', { table: 'invoices' });
		assert.equal(out.isError, true);
		assert.match(out.text, /Name the connection with "connectionId"/);
		assert.deepEqual(h.invoked, []);
	});
});

test('a required connection left out is the capability\'s own error to give', async () => {
	await withServer({ specs: [TEST_SPEC], connections: CONNECTIONS, result: { ok: false, summary: '', error: 'test_connection only tests a saved connection by its id.' } }, async (h) => {
		const out = await callTool(h.port, 'test_connection', { host: 'elsewhere.example' });
		assert.equal(out.isError, true);
		assert.match(out.text, /only tests a saved connection/);
		assert.equal(h.invoked.length, 1);
	});
});

test('rows from the result grid go out only when they came from an exposed connection', async () => {
	const rows = { ok: true, summary: '1 row', data: { rows: [['ada@example.com']] } };
	for (const [dataConnectionId, handedOn] of [['prod-1', false], [undefined, false], ['dev-1', true]] as const) {
		await withServer({ specs: [RESULT_SPEC], connections: CONNECTIONS, result: { ...rows, dataConnectionId } }, async (h) => {
			const out = await callTool(h.port, 'get_query_result');
			assert.equal(out.isError, !handedOn, String(dataConnectionId));
			assert.equal(out.text.includes('ada@example.com'), handedOn, String(dataConnectionId));
		});
	}
});

test('a capability that touches no connection when none is named goes on without one', async () => {
	const createMonitor: CapabilitySpec = {
		name: 'create_monitor',
		description: 'Create a monitor.',
		parameters: { type: 'object', properties: { name: { type: 'string' }, connectionId: { type: 'string' } }, required: ['name'] },
		domain: 'monitors',
		mutates: true,
		implicitConnection: 'none',
		returnsData: 'none',
		connectionWhenAbsent: 'none',
	};
	await withServer({ specs: [createMonitor], connections: CONNECTIONS, allowMutating: true, autoApproved: ['create_monitor'] }, async (h) => {
		assert.equal((await callTool(h.port, 'create_monitor', { name: 'Slow queries' })).isError, false);
		assert.equal((await callTool(h.port, 'create_monitor', { name: 'Billing', connectionId: 'Billing prod' })).isError, true);
		assert.deepEqual(h.invoked.map((call) => call.args), [{ name: 'Slow queries' }]);
	});
});

/*
 * A capability that acts on a connection WITHOUT naming one: the active tab's (run_current), the
 * result grid's (get_query_result, sort_results), the last error's (get_last_error). Before, these
 * never met the allowlist at all, so insert_sql + run_current ran anything on whatever tab was
 * active, and get_last_error read the rows back out of the driver's error.
 */

function spec(name: string, implicitConnection: CapabilitySpec['implicitConnection'], returnsData: CapabilitySpec['returnsData'], mutates = false): CapabilitySpec {
	return { name, description: name, parameters: { type: 'object', properties: {} }, domain: 'test', mutates, implicitConnection, returnsData };
}

const RUN_CURRENT = spec('run_current', 'activeTab', 'none', true);
const LAST_ERROR = spec('get_last_error', 'lastError', 'values');
const LOGS = spec('get_recent_logs', 'perItem', 'values');
const SORT = spec('sort_results', 'result', 'schema');
const ROWS = spec('get_query_result', 'result', 'values');
const LEAK = "Duplicate entry 'ada@example.com,bob@example.com' for key 'users.email' (ER_DUP_ENTRY)";

test('run_current on a tab whose connection is not exposed is refused before anyone is asked', async () => {
	await withServer({ specs: [RUN_CURRENT], connections: CONNECTIONS, allowMutating: true, autoApproved: ['run_current'], acting: ['prod-1'] }, async (h) => {
		const out = await callTool(h.port, 'run_current');
		assert.equal(out.isError, true);
		assert.match(out.text, /"Billing prod" \(the active editor tab's connection\), which is not exposed to agents/);
		assert.deepEqual(h.resolved, ['run_current']);
		assert.deepEqual(h.invoked, []);
	});
});

test('run_current on an exposed connection runs, pinned to the connection that was checked', async () => {
	await withServer({ specs: [RUN_CURRENT], connections: CONNECTIONS, allowMutating: true, acting: ['dev-1'] }, async (h) => {
		const out = await callTool(h.port, 'run_current');
		assert.equal(out.isError, false);
		assert.deepEqual(h.invoked.map((call) => call.expect), [['dev-1']]);
	});
});

test('an implicit connection the app cannot answer for is refused', async () => {
	const server = new LocalMcpServer({
		...baseDeps([]),
		connections: () => CONNECTIONS,
		capabilities: () => [RUN_CURRENT],
		invokeCapability: async () => ({ ok: true, summary: 'ran' }),
	});
	const port = await server.start(0);
	try {
		const out = await callTool(port, 'run_current');
		assert.equal(out.isError, true);
		assert.match(out.text, /cannot say which connection/);
	} finally {
		await server.stop();
	}
});

test('the last error from a connection that is not exposed is withheld, in a fixed sentence', async () => {
	const result: CapabilityResult = { ok: true, summary: `Last error: ${LEAK}`, data: { detail: LEAK, connectionId: 'prod-1' }, dataConnectionId: 'prod-1' };
	await withServer({ specs: [LAST_ERROR], connections: CONNECTIONS, acting: ['prod-1'], result }, async (h) => {
		const out = await callTool(h.port, 'get_last_error');
		assert.equal(out.isError, true);
		assert.equal(out.text.includes('ada@example.com'), false);
		assert.deepEqual(h.invoked, []);
	});
});

test('a last error tied to no connection goes out as its class and code only', async () => {
	const result: CapabilityResult = { ok: true, summary: `Last error: ${LEAK}`, data: { title: LEAK, detail: LEAK } };
	await withServer({ specs: [LAST_ERROR], connections: CONNECTIONS, acting: [], result }, async (h) => {
		const out = await callTool(h.port, 'get_last_error');
		assert.equal(out.isError, false);
		assert.equal(out.text.includes('ada@example.com'), false);
		assert.match(out.text, /constraint-violation/);
		assert.match(out.text, /ER_DUP_ENTRY/);
	});
});

test('a last error from an exposed connection is handed on as it is', async () => {
	const result: CapabilityResult = { ok: true, summary: 'Last error: duplicate', data: { detail: LEAK, connectionId: 'dev-1' }, dataConnectionId: 'dev-1' };
	await withServer({ specs: [LAST_ERROR], connections: CONNECTIONS, acting: ['dev-1'], result }, async (h) => {
		const out = await callTool(h.port, 'get_last_error');
		assert.equal(out.isError, false);
		assert.match(out.text, /ada@example\.com/);
	});
});

test('log lines from a connection that is not exposed, or from none, are reduced line by line', async () => {
	const lines = [
		{ ts: 1, level: 'error', message: `Query failed: ${LEAK}`, connectionId: 'prod-1' },
		{ ts: 2, level: 'error', message: `Unhandled: ${LEAK}` },
		{ ts: 3, level: 'info', message: 'Exported 12 rows from dev', connectionId: 'dev-1' },
	];
	await withServer({ specs: [LOGS], connections: CONNECTIONS, result: { ok: true, summary: '3 lines', data: lines } }, async (h) => {
		const out = await callTool(h.port, 'get_recent_logs');
		assert.equal(out.isError, false);
		assert.equal(out.text.includes('ada@example.com'), false);
		assert.match(out.text, /Exported 12 rows from dev/);
		assert.deepEqual(h.resolved, [], 'nothing to resolve before: each line carries its own');
	});
});

test('the grid of a connection that is not exposed cannot be sorted, nor its columns listed', async () => {
	await withServer({ specs: [SORT], connections: CONNECTIONS, acting: ['prod-1'], result: { ok: false, summary: '', error: 'No column "x" in the result. Columns: email, ssn.' } }, async (h) => {
		const out = await callTool(h.port, 'sort_results', { column: 'x' });
		assert.equal(out.isError, true);
		assert.equal(out.text.includes('ssn'), false);
		assert.deepEqual(h.invoked, []);
	});
});

test('database content whose connection changed under the call is withheld on the way out', async () => {
	// Checked exposed before, but the rows came back tagged with a different, unexposed connection.
	await withServer({ specs: [ROWS], connections: CONNECTIONS, acting: ['dev-1'], result: { ok: true, summary: '1 row', data: { rows: [['ada@example.com']] }, dataConnectionId: 'prod-1' } }, async (h) => {
		const out = await callTool(h.port, 'get_query_result');
		assert.equal(out.isError, true);
		assert.equal(out.text.includes('ada@example.com'), false);
	});
});

test('a failed read of an exposed result keeps its error, reduced only by the data-access level', async () => {
	const failed: CapabilityResult = { ok: false, summary: '', error: `The last query failed: ${LEAK}`, errorFromDatabase: true, dataConnectionId: 'dev-1' };
	await withServer({ specs: [ROWS], connections: CONNECTIONS, acting: ['dev-1'], result: failed }, async (h) => {
		const out = await callTool(h.port, 'get_query_result');
		assert.equal(out.isError, true);
		assert.match(out.text, /ada@example\.com/);
	});
});


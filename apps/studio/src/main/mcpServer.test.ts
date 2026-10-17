/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { request } from 'node:http';

import { BAD_BEARER_LIMIT, LOCKOUT_MS, LocalMcpServer, loopbackPortFree, McpPortInUseError, mcpHostAllowed, nextFreeLoopbackPort, studioProof, toConnectionRefs, type McpServerDeps } from './mcpServer';
import type { ConnectionConfig } from '../shared/connection';
import type { DatabaseSchema } from '../shared/schema';
import { mcpProblemNotice, type McpLockout, type McpLogInput } from '../shared/mcp';
import type { ExecuteQueryResult } from '../shared/protocol';
import type { ToolAuditRecord } from '../shared/engine';
import type { CapabilityResult, CapabilitySpec } from '../shared/capabilities';

const TOKEN = 'test-secret-token';

function schema(): DatabaseSchema {
	return {
		database: 'shop',
		fetchedAt: 0,
		tables: [
			{
				name: 'orders',
				kind: 'table',
				columns: [
					{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
					{ name: 'total', dataType: 'decimal', nullable: true, isPrimaryKey: false },
				],
				primaryKey: ['id'],
				foreignKeys: [],
			},
		],
	};
}

interface Harness {
	server: LocalMcpServer;
	port: number;
	executed: string[];
	/** The `readOnly` option each executed statement was sent with, in the same order. */
	readOnlyRuns: boolean[];
	logged: McpLogInput[];
	audited: { record: ToolAuditRecord; client: string }[];
}

let harness: Harness;

function makeDeps(executed: string[], logged: McpLogInput[], audited: Harness['audited'], readOnlyRuns: boolean[] = []): McpServerDeps {
	return {
		serverInfo: { name: 'snoutdata', version: '9.9.9' },
		token: () => TOKEN,
		connections: () => [
			{ id: 'c1', label: 'prod', driver: 'mysql', environment: 'prod', readOnly: true, allowed: true, writes: false, readOnlyBy: 'The database refuses writes to tables.' },
			{ id: 'c2', label: 'stage', driver: 'postgres', allowed: false, writes: false, readOnlyBy: 'The database refuses any write.' },
			{ id: 'c3', label: 'writable', driver: 'mysql', allowed: true, writes: true, readOnlyBy: 'The database refuses writes to tables.' },
		],
		resolveSchema: async (id) => (id === 'c1' || id === 'c3' ? schema() : null),
		execute: async (_id, sql, options): Promise<ExecuteQueryResult> => {
			executed.push(sql);
			readOnlyRuns.push(options?.readOnly === true);
			return { ok: true, result: { fields: [{ name: 'id' }, { name: 'total' }], rows: [[1, '9.99']], rowCount: 1, durationMs: 3 } };
		},
		log: (entry) => { logged.push(entry); },
		audit: (record, client) => { audited.push({ record, client }); },
		// Deterministic durations: two ticks per call (start, end) ⇒ every record is 1ms.
		clock: (() => { let t = 0; return () => ++t; })(),
	};
}

test('every connection is listed the same way, whatever it is and wherever it came from', () => {
	// A database imported from SnoutData Cloud reaches an agent exactly as a hand-made one
	// does. McpConnectionRef carries no field that could say otherwise, so there is no
	// branch anywhere to get wrong — this asserts the two are indistinguishable rather
	// than that some flag is handled correctly.
	const local: ConnectionConfig = { id: 'c1', label: 'orders', driver: 'postgres', host: 'h', port: 5432, username: 'u' };
	const imported: ConnectionConfig = { ...local, id: 'c2', cloudProjectRef: 'exampleref001' };

	const [a, b] = toConnectionRefs([local, imported], () => true, () => false);
	assert.deepEqual({ ...a, id: '' }, { ...b, id: '' });
	assert.equal('cloudProjectRef' in b, false, 'the broker must not be able to tell an agent where a connection came from');
});

test('a cloud-imported connection is NOT exposed to agents by default', () => {
	// The line to hold. The broker is opt-in per connection and off by default, and it is
	// tempting to exempt a hosted database on the grounds that the user's own cloud
	// account is not really a third party. It is exactly as much a third party: an agent
	// reading it reads the customer's data. "Zero setup" means no credential to plumb,
	// never no permission to ask.
	const imported: ConnectionConfig = {
		id: 'c9', label: 'first light', driver: 'postgres', host: 'h', port: 5432, username: 'u',
		cloudProjectRef: 'exampleref001',
	};
	const allowlist = new Set<string>();
	const [ref] = toConnectionRefs([imported], (id) => allowlist.has(id), () => false);
	assert.equal(ref.allowed, false);
	assert.equal(ref.writes, false);

	// And it becomes visible the ordinary way, by the user allowing it.
	allowlist.add('c9');
	assert.equal(toConnectionRefs([imported], (id) => allowlist.has(id), () => false)[0].allowed, true);
});

test('no credential can reach an agent through the connection list', () => {
	// Not that the password is stripped — that it was never in this shape. It lives in the
	// keychain and is resolved in main at connect time, so the broker runs the query and
	// the agent receives rows.
	const withSecret = {
		id: 'c1', label: 'orders', driver: 'postgres', host: 'h', port: 5432, username: 'u',
		password: 'hunter2',
	} as ConnectionConfig;
	const [ref] = toConnectionRefs([withSecret], () => true, () => true);
	assert.equal(JSON.stringify(ref).includes('hunter2'), false);
	assert.deepEqual(Object.keys(ref).sort(), ['allowed', 'driver', 'engine', 'environment', 'flavor', 'id', 'label', 'readOnly', 'readOnlyBy', 'writes']);
});

beforeEach(async () => {
	const executed: string[] = [];
	const logged: McpLogInput[] = [];
	const audited: Harness['audited'] = [];
	const readOnlyRuns: boolean[] = [];
	const server = new LocalMcpServer(makeDeps(executed, logged, audited, readOnlyRuns));
	const port = await server.start(0); // 0 ⇒ OS picks a free port
	harness = { server, port, executed, readOnlyRuns, logged, audited };
});

afterEach(async () => {
	await harness.server.stop();
});

/** POST a JSON-RPC message and return { status, body }. */
async function rpc(body: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token !== null) {
		headers.authorization = `Bearer ${token}`;
	}
	const res = await fetch(`http://127.0.0.1:${harness.port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : null };
}

function call(name: string, args: Record<string, unknown>): Promise<{ status: number; json: any }> {
	return rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

test('rejects a request with no/wrong bearer token', async () => {
	const missing = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null);
	assert.equal(missing.status, 401);
	const wrong = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope');
	assert.equal(wrong.status, 401);
});

test('initialize returns our server info', async () => {
	const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
	assert.equal(res.status, 200);
	assert.equal(res.json.result.serverInfo.name, 'snoutdata');
	assert.ok(res.json.result.capabilities.tools);
});

test('a notification (no id) yields 202 and no body', async () => {
	const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
	assert.equal(res.status, 202);
	assert.equal(res.json, null);
});

test('tools/list advertises the read-only tool surface', async () => {
	const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
	const names = res.json.result.tools.map((t: { name: string }) => t.name);
	assert.deepEqual(names.sort(), ['describe_table', 'explain', 'list_connections', 'list_tables', 'run_query', 'search_columns']);
});

test('the read tools say they are read-only, so a client need not ask its user to approve them', async () => {
	// Codex refuses an unannotated tool outright under `codex exec`; readOnlyHint is what it reads.
	const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
	const byName = new Map<string, { annotations?: { readOnlyHint?: boolean } }>(res.json.result.tools.map((t: { name: string }) => [t.name, t]));
	for (const name of ['list_connections', 'list_tables', 'describe_table', 'search_columns', 'explain']) {
		assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
	}
	// run_query can write when the user has enabled writes, so it does not claim to be read-only.
	assert.notEqual(byName.get('run_query')?.annotations?.readOnlyHint, true);
});

test('list_connections shows only exposed connections', async () => {
	const res = await call('list_connections', {});
	const text = res.json.result.content[0].text;
	assert.match(text, /prod/);
	assert.doesNotMatch(text, /stage/);
});

test('run_query runs a read-only query and auto-limits it', async () => {
	const res = await call('run_query', { connection: 'prod', sql: 'SELECT id, total FROM orders' });
	assert.equal(res.json.result.isError, false);
	assert.match(res.json.result.content[0].text, /1 rows/);
	assert.equal(harness.executed.length, 1);
	assert.match(harness.executed[0], /LIMIT 200/);
});

test('run_query refuses a write, without touching the database', async () => {
	const res = await call('run_query', { connection: 'prod', sql: 'DELETE FROM orders' });
	assert.equal(res.json.result.isError, true);
	assert.match(res.json.result.content[0].text, /not read-only/i);
	assert.equal(harness.executed.length, 0);
});

test('run_query logs the executed query to the agent log', async () => {
	await call('run_query', { connection: 'prod', sql: 'SELECT id FROM orders' });
	assert.equal(harness.logged.length, 1);
	assert.equal(harness.logged[0].tool, 'run_query');
	assert.equal(harness.logged[0].connectionLabel, 'prod');
	assert.match(harness.logged[0].sql ?? '', /SELECT id FROM orders/);
	assert.equal(harness.logged[0].outcome.ok, true);
	assert.equal(harness.logged[0].kind, 'query');
});

test('a REFUSED write is logged, and marked refused', async () => {
	// It never ran, and it used to be left out for that reason. But "the agent tried to delete
	// from prod and was refused" is one of the more interesting lines the log can carry, and a
	// timeline with the refusals missing is the least honest version of it.
	await call('run_query', { connection: 'prod', sql: 'DELETE FROM orders' });
	assert.equal(harness.logged.length, 1);
	assert.equal(harness.logged[0].outcome.ok, false);
	assert.equal(harness.logged[0].outcome.ok === false && harness.logged[0].outcome.refused, true);
	assert.equal(harness.executed.length, 0, 'nothing reached the database');
});

test('every tool call lands in the log, not only the ones that touch a database', async () => {
	await call('list_connections', {});
	assert.equal(harness.logged.length, 1);
	assert.equal(harness.logged[0].tool, 'list_connections');
	assert.equal(harness.logged[0].sql, undefined);
	assert.ok(harness.logged[0].summary && harness.logged[0].summary.length > 0);
});

test('a write is allowed when the connection has writes enabled', async () => {
	const res = await call('run_query', { connection: 'writable', sql: 'DELETE FROM orders WHERE id = 1' });
	assert.equal(res.json.result.isError, false);
	assert.equal(harness.executed.length, 1);
	assert.match(harness.executed[0], /DELETE FROM orders/);
	assert.deepEqual(harness.readOnlyRuns, [false], 'a granted write is not sent read-only');
});

test('a read with no write grant asks the DATABASE to refuse writes too, and so does explain', async () => {
	// The lexical check cannot see that `SELECT cleanup()` calls a function that writes; the
	// readOnly option is what makes the database refuse it.
	await call('run_query', { connection: 'prod', sql: 'SELECT id FROM orders' });
	await call('explain', { connection: 'prod', sql: 'SELECT id FROM orders' });
	await call('explain', { connection: 'writable', sql: 'SELECT id FROM orders' });
	assert.deepEqual(harness.readOnlyRuns, [true, true, true]);
});

test('list_connections tells the agent what the database enforces for a read', async () => {
	const res = await call('list_connections', {});
	const text = res.json.result.content[0].text;
	assert.match(text, /prod[^\n]*\n\s+Reads: The database refuses writes to tables\./);
	assert.doesNotMatch(text, /writable[^\n]*\n\s+Reads:/, 'a connection with writes allowed makes no read-only claim');
});

test('a non-exposed connection is refused', async () => {
	const res = await call('run_query', { connection: 'stage', sql: 'SELECT 1' });
	assert.equal(res.json.result.isError, true);
	assert.match(res.json.result.content[0].text, /not exposed/i);
	assert.equal(harness.executed.length, 0);
});

test('describe_table returns the table structure', async () => {
	const res = await call('describe_table', { connection: 'prod', table: 'orders' });
	assert.equal(res.json.result.isError, false);
	assert.match(res.json.result.content[0].text, /orders/);
	assert.match(res.json.result.content[0].text, /id int/);
});

test('an unknown method is a JSON-RPC method-not-found error', async () => {
	const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'bogus/thing' });
	assert.equal(res.json.error.code, -32601);
});

// The audit trail: one trail across chat AND the agent path.

test('every agent tool call lands on the audit trail, tagged mcp', async () => {
	await call('list_connections', {});
	await call('list_tables', { connection: 'prod' });
	assert.equal(harness.audited.length, 2);
	assert.deepEqual(harness.audited.map((a) => a.record.tool), ['list_connections', 'list_tables']);
	assert.ok(harness.audited.every((a) => a.record.origin === 'mcp' && a.record.ok && !a.record.mutates));
	// The connection the agent touched is on the record; list_connections touches none.
	assert.equal(harness.audited[0].record.connectionId, undefined);
	assert.equal(harness.audited[1].record.connectionId, 'c1');
	assert.equal(harness.audited[1].record.durationMs, 1);
});

test('the audit record names the agent from initialize', async () => {
	await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code', version: '1' } } });
	await call('list_connections', {});
	assert.equal(harness.audited[0].client, 'claude-code');
});

test('an agent that does not identify itself is still recorded', async () => {
	await call('list_connections', {});
	assert.equal(harness.audited[0].client, 'unknown agent');
});

test('a write over MCP is audited as mutating; a refused one is audited as failed', async () => {
	await call('run_query', { connection: 'writable', sql: 'DELETE FROM orders' });
	assert.equal(harness.audited[0].record.mutates, true);
	assert.equal(harness.audited[0].record.ok, true);
	// Refused on a read-only connection: it never ran, but the ATTEMPT is what the log is for.
	await call('run_query', { connection: 'prod', sql: 'DELETE FROM orders' });
	assert.equal(harness.audited[1].record.mutates, true);
	assert.equal(harness.audited[1].record.ok, false);
	assert.match(harness.audited[1].record.error ?? '', /not read-only/i);
});

test('a failing audit sink cannot fail the agent call', async () => {
	const server = new LocalMcpServer({
		...makeDeps([], [], []),
		audit: () => { throw new Error('disk full'); },
	});
	const port = await server.start(0);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_connections', arguments: {} } }),
		});
		const json = await res.json() as { result: { isError: boolean } };
		assert.equal(json.result.isError, false);
	} finally {
		await server.stop();
	}
});

/* ------------------------------------------------------------------------------------------------
 * The sign-in handoff: who is signed in, and a token of your own.
 * ---------------------------------------------------------------------------------------------- */

/** Run one server with these deps and tear it down afterwards. */
async function withServer(over: Partial<McpServerDeps>, fn: (port: number) => Promise<void>): Promise<void> {
	const server = new LocalMcpServer({ ...makeDeps([], [], []), ...over });
	const port = await server.start(0);
	try {
		await fn(port);
	} finally {
		await server.stop();
	}
}

async function whoami(port: number, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
	const headers: Record<string, string> = {};
	if (token !== null) {
		headers.authorization = `Bearer ${token}`;
	}
	const res = await fetch(`http://127.0.0.1:${port}/cli/whoami`, { headers });
	return { status: res.status, json: await res.json() };
}

async function mint(port: number, body: unknown = {}): Promise<{ status: number; json: any }> {
	const res = await fetch(`http://127.0.0.1:${port}/cli/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

const SIGNED_IN: Partial<McpServerDeps> = {
	machine: () => 'alexs-laptop',
	account: () => 'alex@example.com',
	signInHandoff: () => true,
	mintCliToken: async () => ({ ok: true, token: 'sdt_secret', name: 'SnoutData CLI on alexs-laptop', prefix: 'sdt_abc', expiresAt: null }),
};

test('whoami says who is signed in, and never hands over anything that could stand in for a session', async () => {
	await withServer(SIGNED_IN, async (port) => {
		const res = await whoami(port);
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, {
			ok: true,
			app: { name: 'snoutdata', version: '9.9.9' },
			machine: 'alexs-laptop',
			signedIn: true,
			email: 'alex@example.com',
			signInHandoff: true,
			canMintToken: true,
		});
		// Mint, never lend, as a shape rather than a promise: there is no field here a session could hide in.
		assert.deepEqual(Object.keys(res.json).sort(), ['app', 'canMintToken', 'email', 'machine', 'ok', 'signInHandoff', 'signedIn']);
	});
});

test('whoami answers with no connection on the allowlist at all', async () => {
	// The point of the endpoint: this is about the ACCOUNT, not about a database, so an install
	// that has exposed nothing to agents must still be able to say who is signed in.
	await withServer({ ...SIGNED_IN, connections: () => [] }, async (port) => {
		const res = await whoami(port);
		assert.equal(res.status, 200);
		assert.equal(res.json.signedIn, true);
		assert.equal(res.json.canMintToken, true);
	});
});

test('signed out is an ANSWER, not a failure', async () => {
	await withServer({ ...SIGNED_IN, account: () => null }, async (port) => {
		const res = await whoami(port);
		assert.equal(res.status, 200);
		assert.equal(res.json.ok, true);
		assert.equal(res.json.signedIn, false);
		assert.equal(res.json.email, null);
		assert.equal(res.json.canMintToken, false, 'nothing to offer, so do not make the caller work it out');
	});
});

test('whoami still needs the bearer token', async () => {
	await withServer(SIGNED_IN, async (port) => {
		assert.equal((await whoami(port, null)).status, 401);
		assert.equal((await whoami(port, 'nope')).status, 401);
	});
});

/* ------------------------------------------------------------------------------------------------
 * Proving this is the app before a client sends the token, and locking out a sender of wrong ones.
 * ---------------------------------------------------------------------------------------------- */

test('the proof is an HMAC of the nonce and the port, the same one the CLI computes', () => {
	// The snoutdata CLI asserts this same vector in its own tests: the two must never drift apart.
	assert.equal(studioProof('test-secret-token', 7311, 'AAAAAAAAAAAAAAAAAAAAAA'), 'GhKfaBXRUv0iN811Y6NjA9tGjTZCFWneI9qZAam1-s4');
	assert.notEqual(studioProof(TOKEN, 7311, 'AAAAAAAAAAAAAAAAAAAAAA'), studioProof(TOKEN, 7312, 'AAAAAAAAAAAAAAAAAAAAAA'), 'bound to the port');
});

test('the app proves it holds the token without a bearer, and without revealing it', async () => {
	await withServer({}, async (port) => {
		const nonce = 'n0nce-n0nce-n0nce-n0nce';
		const res = await fetch(`http://127.0.0.1:${port}/cli/prove?nonce=${nonce}`);
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.deepEqual(JSON.parse(body), { ok: true, proof: studioProof(TOKEN, port, nonce) });
		assert.equal(body.includes(TOKEN), false);
		assert.equal((await fetch(`http://127.0.0.1:${port}/cli/prove?nonce=short`)).status, 400);
		assert.equal((await fetch(`http://127.0.0.1:${port}/cli/prove`)).status, 400);
		assert.equal((await fetch(`http://127.0.0.1:${port}/cli/prove?nonce=${nonce}`, { method: 'POST' })).status, 405);
		// Nothing else is reachable without the bearer.
		assert.equal((await whoami(port, null)).status, 401);
	});
});

test('repeated wrong bearers throttle the wrong ones, never the right token, and never rotate it', async () => {
	let now = 1_000_000;
	const lockouts: McpLockout[] = [];
	let token = TOKEN;
	const over: Partial<McpServerDeps> = {
		clock: () => now,
		token: () => token,
		isRetiredToken: (bearer) => bearer === 'the-old-token',
		onLockout: (lockout) => { lockouts.push(lockout); },
	};
	await withServer(over, async (port) => {
		for (let i = 0; i < 8; i++) {
			assert.equal((await whoami(port, null)).status, 401);
			assert.equal((await whoami(port, 'the-old-token')).status, 401);
		}
		assert.equal(lockouts.length, 0, 'an unconfigured client and a stale config are not a guess');
		for (let i = 1; i < BAD_BEARER_LIMIT; i++) {
			assert.equal((await whoami(port, `guess-${i}`)).status, 401);
		}
		assert.equal(lockouts.length, 0);
		assert.equal((await whoami(port, 'guess-last')).status, 401);
		assert.equal(lockouts.length, 1, 'the last wrong bearer in the window starts the throttle');
		assert.equal(lockouts[0].attempts, BAD_BEARER_LIMIT);
		assert.equal(lockouts[0].until, now + LOCKOUT_MS);
		assert.equal(token, TOKEN, 'the token is never replaced by the server');
		// A wrong token is refused outright now, with a time to come back.
		const throttled = await fetch(`http://127.0.0.1:${port}/cli/whoami`, { headers: { authorization: 'Bearer guess-more' } });
		assert.equal(throttled.status, 429);
		assert.ok(Number(throttled.headers.get('retry-after')) > 0);
		// The right token and the proof are never refused: every local client shares 127.0.0.1, so a
		// throttle on the address would let any program keep the person's own agents out.
		assert.equal((await whoami(port)).status, 200);
		assert.equal((await fetch(`http://127.0.0.1:${port}/cli/prove?nonce=n0nce-n0nce-n0nce-n0nce`)).status, 200);
		now += LOCKOUT_MS + 1;
		assert.equal((await whoami(port, 'guess-after')).status, 401, 'after the cool-down a wrong token is a plain 401 again');
	});
});

test('a flood of wrong bearers cannot keep a client with the right token out', async () => {
	let now = 2_000_000;
	await withServer({ clock: () => now }, async (port) => {
		for (let round = 0; round < 4; round++) {
			for (let i = 0; i < BAD_BEARER_LIMIT * 3; i++) {
				assert.notEqual((await whoami(port, `flood-${round}-${i}`)).status, 200);
			}
			assert.equal((await whoami(port)).status, 200, 'the right token always gets in');
			now += 60_000;
		}
		// A bearer that shares the token's prefix, or is longer, is still wrong.
		assert.notEqual((await whoami(port, TOKEN.slice(0, -1))).status, 200);
		assert.notEqual((await whoami(port, `${TOKEN}x`)).status, 200);
	});
});

test('a lockout is per remote address, and lifted when the person replaces the token', async () => {
	let now = 5_000;
	const server = new LocalMcpServer({ ...makeDeps([], [], []), clock: () => now });
	const port = await server.start(0);
	try {
		for (let i = 0; i < BAD_BEARER_LIMIT; i++) {
			await whoami(port, `guess-${i}`);
		}
		assert.equal(server.lockouts().length, 1);
		assert.equal(server.lockouts()[0].remote, '127.0.0.1');
		server.clearLockouts();
		assert.equal(server.lockouts().length, 0);
		assert.equal((await whoami(port)).status, 200);
		now += 1;
	} finally {
		await server.stop();
	}
});

test('a taken port is reported, never walked past', async () => {
	const holder = new LocalMcpServer(makeDeps([], [], []));
	const taken = await holder.start(0);
	const server = new LocalMcpServer(makeDeps([], [], []));
	try {
		await assert.rejects(() => server.start(taken), (err: unknown) => err instanceof McpPortInUseError && err.port === taken);
		assert.equal(server.running(), false, 'the broker did not start anywhere else');
		assert.equal(await loopbackPortFree(taken), false);
		// A suggestion is offered for the person to choose, above the taken port.
		const next = await nextFreeLoopbackPort(taken, async (p) => p === taken + 3);
		assert.equal(next, taken + 3);
		assert.equal(await nextFreeLoopbackPort(taken, async () => false), null);
	} finally {
		await server.stop();
		await holder.stop();
	}
});

test('the handoff mints a token and returns it, never the session', async () => {
	await withServer(SIGNED_IN, async (port) => {
		const res = await mint(port, { client: 'snoutdata-cli', command: 'init' });
		assert.equal(res.status, 200);
		assert.equal(res.json.ok, true);
		assert.equal(res.json.token, 'sdt_secret');
		assert.equal(res.json.name, 'SnoutData CLI on alexs-laptop');
		assert.deepEqual(Object.keys(res.json).sort(), ['expiresAt', 'name', 'ok', 'prefix', 'token']);
	});
});

test('a mint the user approved lands on the agent log', async () => {
	const logged: McpLogInput[] = [];
	await withServer({ ...SIGNED_IN, log: (entry) => { logged.push(entry); } }, async (port) => {
		await mint(port, { client: 'snoutdata-cli' });
		assert.equal(logged.length, 1);
		assert.equal(logged[0].tool, 'sign_in_handoff');
		assert.equal(logged[0].mutates, true);
		assert.match(logged[0].summary ?? '', /SnoutData CLI on alexs-laptop/);
		// The token itself is never written anywhere but the reply.
		assert.equal(JSON.stringify(logged[0]).includes('sdt_secret'), false);
	});
});

test('with the handoff switched off the mint is refused outright, and nobody is asked', async () => {
	let asked = false;
	await withServer({
		...SIGNED_IN,
		signInHandoff: () => false,
		mintCliToken: async () => { asked = true; return { ok: true, token: 't', name: 'n', prefix: 'p', expiresAt: null }; },
	}, async (port) => {
		const res = await mint(port, { client: 'snoutdata-cli' });
		assert.equal(res.status, 403);
		assert.equal(res.json.code, 'disabled');
		assert.equal(asked, false, 'switched off means the user is not interrupted at all');
		// And whoami says so up front, so a caller need not ask to find out.
		assert.equal((await whoami(port)).json.canMintToken, false);
	});
});

test('a signed-out app refuses the mint without interrupting anyone', async () => {
	let asked = false;
	await withServer({
		...SIGNED_IN,
		account: () => null,
		mintCliToken: async () => { asked = true; return { ok: true, token: 't', name: 'n', prefix: 'p', expiresAt: null }; },
	}, async (port) => {
		const res = await mint(port, { client: 'snoutdata-cli' });
		assert.equal(res.status, 401);
		assert.equal(res.json.code, 'not-signed-in');
		assert.equal(asked, false);
	});
});

test('a refusal is a result with a code worth branching on, not a protocol error', async () => {
	const cases: Array<[string, number]> = [['declined', 403], ['timeout', 408], ['not-ready', 503], ['forbidden', 403], ['server', 502], ['network', 504]];
	for (const [code, status] of cases) {
		await withServer({
			...SIGNED_IN,
			mintCliToken: async () => ({ ok: false, code: code as never, error: 'nope' }),
		}, async (port) => {
			const res = await mint(port, {});
			assert.equal(res.status, status, code);
			assert.deepEqual(res.json, { ok: false, code, error: 'nope' });
		});
	}
});

test("a caller's claims about itself are clipped, not trusted", async () => {
	let seen: { client: string; command?: string } | null = null;
	await withServer({
		...SIGNED_IN,
		mintCliToken: async (request) => { seen = request; return { ok: true, token: 't', name: 'n', prefix: 'p', expiresAt: null }; },
	}, async (port) => {
		await mint(port, { client: 'x'.repeat(500), command: '  push\n\nmigrations  ' });
		assert.equal(seen!.client.length, 60);
		assert.equal(seen!.command, 'push migrations');
		// An anonymous caller is still asked about; it is just described less well on the card.
		await mint(port, {});
		assert.equal(seen!.client, 'A program on this computer');
		assert.equal(seen!.command, undefined);
	});
});

test('the endpoints refuse the wrong method rather than falling through to /mcp', async () => {
	await withServer(SIGNED_IN, async (port) => {
		const post = await fetch(`http://127.0.0.1:${port}/cli/whoami`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(post.status, 405);
		const get = await fetch(`http://127.0.0.1:${port}/cli/token`, { headers: { authorization: `Bearer ${TOKEN}` } });
		assert.equal(get.status, 405);
	});
});

test('a build with no control plane says not-ready rather than pretending', async () => {
	await withServer({ ...SIGNED_IN, mintCliToken: undefined }, async (port) => {
		const res = await mint(port, {});
		assert.equal(res.status, 503);
		assert.equal(res.json.code, 'not-ready');
		assert.equal((await whoami(port)).json.canMintToken, false);
	});
});

describe('the data-access level (Settings → AI, shared with the assistant)', () => {
	async function withLevel(level: 'schema' | 'screen' | 'queries' | undefined, run: (port: number, executed: string[]) => Promise<void>): Promise<void> {
		const executed: string[] = [];
		const server = new LocalMcpServer({ ...makeDeps(executed, [], []), dataAccess: () => level });
		const port = await server.start(0);
		try {
			await run(port, executed);
		} finally {
			await server.stop();
		}
	}

	async function callOn(port: number, name: string, args: Record<string, unknown>): Promise<any> {
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
		});
		return ((await res.json()) as { result: any }).result;
	}

	test('below "read-only queries", run_query and explain are refused and nothing reaches the database', async () => {
		for (const level of ['schema', 'screen'] as const) {
			await withLevel(level, async (port, executed) => {
				for (const tool of ['run_query', 'explain']) {
					const result = await callOn(port, tool, { connection: 'prod', sql: 'SELECT 1' });
					assert.equal(result.isError, true, `${tool} at ${level}`);
					assert.match(result.content[0].text, /Settings → AI/);
				}
				assert.deepEqual(executed, []);
			});
		}
	});

	test('the schema tools still answer at "schema only"', async () => {
		await withLevel('schema', async (port) => {
			const result = await callOn(port, 'describe_table', { connection: 'prod', table: 'orders' });
			assert.notEqual(result.isError, true);
		});
	});

	test('a connection\'s own level decides for that connection only', async () => {
		const executed: string[] = [];
		// The default allows queries; "prod" (c1) is set to schema only, "writable" (c3) is not set.
		const server = new LocalMcpServer({ ...makeDeps(executed, [], []), dataAccess: (id) => (id === 'c1' ? 'schema' : 'queries') });
		const port = await server.start(0);
		try {
			const prod = await callOn(port, 'run_query', { connection: 'prod', sql: 'SELECT 1' });
			assert.equal(prod.isError, true);
			const other = await callOn(port, 'run_query', { connection: 'writable', sql: 'SELECT 1' });
			assert.notEqual(other.isError, true);
			assert.equal(executed.length, 1);
		} finally {
			await server.stop();
		}
	});

	test('never chosen behaves as before the setting existed: queries run', async () => {
		await withLevel(undefined, async (port, executed) => {
			const result = await callOn(port, 'run_query', { connection: 'prod', sql: 'SELECT 1' });
			assert.notEqual(result.isError, true);
			assert.equal(executed.length, 1);
		});
	});
});

/* ------------------------------------------------------------------------------------------------
 * DNS rebinding: the Host header must name this listener.
 * ---------------------------------------------------------------------------------------------- */

test('only 127.0.0.1:<port> and localhost:<port> are this listener', () => {
	assert.equal(mcpHostAllowed('127.0.0.1:4321', 4321), true);
	assert.equal(mcpHostAllowed('LOCALHOST:4321', 4321), true);
	assert.equal(mcpHostAllowed('127.0.0.1:4322', 4321), false);
	assert.equal(mcpHostAllowed('127.0.0.1', 4321), false);
	assert.equal(mcpHostAllowed('evil.example:4321', 4321), false);
	assert.equal(mcpHostAllowed(undefined, 4321), false);
	assert.equal(mcpHostAllowed('127.0.0.1:0', 0), false, 'a server that is not listening has no host');
});

/** One request with a Host header of our choosing (fetch will not let a caller set it). */
function withHost(port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path: '/cli/whoami', method: 'GET', headers: { host, authorization: `Bearer ${TOKEN}` } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on('error', reject);
		req.end();
	});
}

test('a rebound page, valid token and all, is refused by its Host header', async () => {
	await withServer({}, async (port) => {
		assert.equal(await withHost(port, `evil.example:${port}`), 403);
		assert.equal(await withHost(port, `127.0.0.1:${port}`), 200);
		assert.equal(await withHost(port, `localhost:${port}`), 200);
	});
});

test('the notice names the taken port and says nothing moved by itself', () => {
	const port = mcpProblemNotice({ kind: 'port-in-use', port: 7311, suggestedPort: 7312 });
	assert.match(port.title, /7311/);
	assert.match(port.detail, /127\.0\.0\.1:7311/);
	assert.match(port.detail, /did not move to another port by itself/);
	assert.match(port.detail, /port 7312/);
	const locked = mcpProblemNotice({ kind: 'locked-out', remote: '127.0.0.1', until: Date.now() + LOCKOUT_MS, attempts: 5 });
	assert.match(locked.detail, /The token was not changed/);
	assert.match(locked.detail, /right token still get in/);
	assert.doesNotMatch(locked.detail, /includes your own agents/);
});

test('a capability named like a built-in tool is not listed twice', async () => {
	const spec = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} }, mutates: false }) as unknown as CapabilitySpec;
	await withServer({ capabilities: () => [spec('list_connections'), spec('open_query_tab')], invokeCapability: async () => ({ ok: true, summary: '' }) as unknown as CapabilityResult }, async (port) => {
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
		const names: string[] = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool: { name: string }) => tool.name);
		assert.equal(names.filter((name) => name === 'list_connections').length, 1);
		assert.ok(names.includes('open_query_tab'));
	});
});

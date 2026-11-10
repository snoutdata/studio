/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentAiRelay } from './agentAiRelay';

function setup(statuses: number[] = [200]): { relay: AgentAiRelay; seen: { url: string; auth: string | null; body: string }[]; fresh: boolean[] } {
	const seen: { url: string; auth: string | null; body: string }[] = [];
	const fresh: boolean[] = [];
	const queue = [...statuses];
	const relay = new AgentAiRelay({
		upstream: (kind) => (kind === 'opencode' ? null : { base: 'https://project.example/ai', key: async (isFresh) => { fresh.push(isFresh); return isFresh ? 'psy_new' : 'psy_old'; } }),
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: init?.body ? Buffer.from(init.body as Uint8Array).toString() : '' });
			return new Response(JSON.stringify({ ok: true }), { status: queue.shift() ?? 200, headers: { 'Content-Type': 'application/json' } });
		}) as typeof fetch,
	});
	return { relay, seen, fresh };
}

test('a call with the token reaches the project with the project\'s key, not the agent\'s token', async () => {
	const { relay, seen } = setup();
	const { root, token } = await relay.endpoint();
	const res = await fetch(`${root}/agent/claude/v1/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"a":1}' });
	assert.equal(res.status, 200);
	assert.deepEqual(seen, [{ url: 'https://project.example/ai/v1/messages', auth: 'Bearer psy_old', body: '{"a":1}' }]);
	relay.stop();
});

test('no token, the wrong token, an unknown call and an agent with no project are refused', async () => {
	const { relay, seen } = setup();
	const { root, token } = await relay.endpoint();
	assert.equal((await fetch(`${root}/agent/claude/v1/messages`, { method: 'POST' })).status, 401);
	assert.equal((await fetch(`${root}/agent/claude/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'nope' } })).status, 401);
	assert.equal((await fetch(`${root}/agent/claude/v1/admin/keys`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
	assert.equal((await fetch(`${root}/agent/opencode/v1/models`, { headers: { Authorization: `Bearer ${token}` } })).status, 409);
	assert.equal(seen.length, 0);
	relay.stop();
});

test('a refused key is replaced once', async () => {
	const { relay, seen, fresh } = setup([401, 200]);
	const { root, token } = await relay.endpoint();
	const res = await fetch(`${root}/agent/claude/v1/messages`, { method: 'POST', headers: { 'x-api-key': token }, body: '{}' });
	assert.equal(res.status, 200);
	assert.deepEqual(fresh, [false, true]);
	assert.equal(seen[1].auth, 'Bearer psy_new');
	relay.stop();
});

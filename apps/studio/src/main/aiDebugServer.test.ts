/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';

import { createAiDebugServer, newDebugToken, refuseDebugRequest } from './aiDebugServer';
import type { AiService } from './aiService';
import type { ConnectionManager } from './connectionManager';

const GATE = { port: 8317, token: 'run-token-abc' };

describe('refuseDebugRequest', () => {
	test('serves a local client that carries the token, on either loopback name', () => {
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317', authorization: 'Bearer run-token-abc' }, GATE), null);
		assert.equal(refuseDebugRequest({ host: 'localhost:8317', 'x-ai-debug-token': 'run-token-abc' }, GATE), null);
	});

	test('refuses anything a browser sent, whatever else it carries', () => {
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317', authorization: 'Bearer run-token-abc', origin: 'http://127.0.0.1:8317' }, GATE)?.status, 403);
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317', authorization: 'Bearer run-token-abc', origin: 'null' }, GATE)?.status, 403);
	});

	test('refuses a Host that is not this loopback port (a rebound name)', () => {
		assert.equal(refuseDebugRequest({ host: 'attacker.example:8317', authorization: 'Bearer run-token-abc' }, GATE)?.status, 403);
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:9999', authorization: 'Bearer run-token-abc' }, GATE)?.status, 403);
		assert.equal(refuseDebugRequest({ authorization: 'Bearer run-token-abc' }, GATE)?.status, 403);
	});

	test('refuses a missing or wrong token', () => {
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317' }, GATE)?.status, 401);
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317', authorization: 'Bearer run-token-abd' }, GATE)?.status, 401);
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317', authorization: 'Bearer ' }, GATE)?.status, 401);
		assert.equal(refuseDebugRequest({ host: '127.0.0.1:8317', authorization: 'Bearer x' }, { port: 8317, token: '' })?.status, 401);
	});

	test('a token is new on every run', () => {
		assert.notEqual(newDebugToken(), newDebugToken());
		assert.ok(newDebugToken().length >= 32);
	});
});

describe('the endpoint', () => {
	const connections = { state: () => ({ connections: [{ id: 'c1', label: 'shop', driver: 'postgres' }], connectedIds: ['c1'] }) } as unknown as ConnectionManager;
	const aiService = { auditState: () => ({}), benchmarkModels: () => [] } as unknown as AiService;

	function freePort(): Promise<number> {
		return new Promise((resolve) => {
			const probe = createServer();
			probe.listen(0, '127.0.0.1', () => {
				const { port } = probe.address() as AddressInfo;
				probe.close(() => resolve(port));
			});
		});
	}

	function get(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
		return new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, path: '/ai/info', method: 'GET', headers }, (res) => {
				let body = '';
				res.on('data', (chunk: Buffer) => { body += chunk; });
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
			});
			req.on('error', reject);
			req.end();
		});
	}

	test('answers /ai/info only with the token, the right Host and no Origin', async () => {
		const token = newDebugToken();
		const port = await freePort();
		const server = createAiDebugServer(aiService, connections, { port, token });
		await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
		try {
			const host = `127.0.0.1:${port}`;
			assert.equal((await get(port, { host })).status, 401);
			assert.equal((await get(port, { host, authorization: `Bearer ${token}`, origin: 'http://evil.example' })).status, 403);
			assert.equal((await get(port, { host: `evil.example:${port}`, authorization: `Bearer ${token}` })).status, 403);
			const ok = await get(port, { host, authorization: `Bearer ${token}` });
			assert.equal(ok.status, 200);
			assert.equal((JSON.parse(ok.body) as { connectedIds: string[] }).connectedIds[0], 'c1');
			assert.equal(ok.body.includes(token), false, 'the token is never echoed');
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

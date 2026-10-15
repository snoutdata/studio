/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { OllamaProvider } from './ollamaProvider';

// A mock Ollama server: streams NDJSON chat chunks, serves /api/tags, and returns a
// 500 when the requested model is "boom" (to exercise the failure path).
let server: Server;
let port = 0;

before(async () => {
	server = createServer((req, res) => {
		if (req.url === '/api/chat') {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				const model = (JSON.parse(body || '{}') as { model?: string }).model;
				if (model === 'boom') {
					res.writeHead(500);
					res.end('kaboom');
					return;
				}
				res.writeHead(200, { 'content-type': 'application/x-ndjson' });
				for (const part of ['Hello ', 'world', '!']) {
					res.write(JSON.stringify({ message: { role: 'assistant', content: part }, done: false }) + '\n');
				}
				res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
				res.end();
			});
			return;
		}
		if (req.url === '/api/generate') {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => {
				const parsed = JSON.parse(body || '{}') as { model?: string; prompt?: string; suffix?: string };
				if (parsed.model === 'boom') {
					res.writeHead(500);
					res.end('kaboom');
					return;
				}
				// Echo back what arrived so the test can assert prefix→prompt, suffix→suffix.
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ response: `[mid:${parsed.prompt}|${parsed.suffix}]`, done: true }));
			});
			return;
		}
		if (req.url === '/api/tags') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.1' }] }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
});

after(() => server.close());

describe('OllamaProvider', () => {
	test('streams chat deltas and assembles the reply', async () => {
		const provider = new OllamaProvider(`http://127.0.0.1:${port}`, 'm');
		const deltas: string[] = [];
		await provider.chat([{ role: 'user', content: 'hi' }], { onDelta: (t) => deltas.push(t) });
		assert.equal(deltas.join(''), 'Hello world!');
		assert.ok(deltas.length >= 3);
	});

	test('lists models', async () => {
		const provider = new OllamaProvider(`http://127.0.0.1:${port}`, 'm');
		assert.deepEqual(await provider.listModels(), ['qwen2.5-coder:7b', 'llama3.1']);
	});

	test('trailing slash in endpoint is tolerated', async () => {
		const provider = new OllamaProvider(`http://127.0.0.1:${port}/`, 'm');
		const deltas: string[] = [];
		await provider.chat([{ role: 'user', content: 'hi' }], { onDelta: (t) => deltas.push(t) });
		assert.equal(deltas.join(''), 'Hello world!');
	});

	test('throws on a non-OK response', async () => {
		const provider = new OllamaProvider(`http://127.0.0.1:${port}`, 'boom');
		await assert.rejects(() => provider.chat([{ role: 'user', content: 'hi' }], { onDelta: () => undefined }));
	});

	test('fim sends prefix as prompt and suffix as suffix, returns the middle', async () => {
		const provider = new OllamaProvider(`http://127.0.0.1:${port}`, 'm');
		const middle = await provider.fim({ prefix: 'SELECT ', suffix: ' FROM t' });
		assert.equal(middle, '[mid:SELECT | FROM t]');
	});

	test('fim throws on a non-OK response', async () => {
		const provider = new OllamaProvider(`http://127.0.0.1:${port}`, 'boom');
		await assert.rejects(() => provider.fim({ prefix: 'a', suffix: 'b' }));
	});
});

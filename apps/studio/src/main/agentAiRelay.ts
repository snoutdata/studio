/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { agentAiCall } from '../shared/agentAiRoute';
import type { AgentKind } from '../shared/agentConsole';
import { t } from '../shared/i18n/core';

// The door between a coding agent and a project's AI gateway. The console's rule is that an agent
// gets capabilities and never credentials, and a project's key is a credential: so the agent is
// handed this relay's address and a token good only here (shared/agentAiRoute.ts), and the key is
// added on the way through. Started the first time an agent is pointed at a project, on an address
// nothing else can reach, and it forwards model calls and nothing else.

/** Where one agent's calls go. `key(true)` is asked after the gateway refused the last one. */
export interface AgentAiUpstream {
	/** Up to and including `/ai`: the path the agent asked for follows it. */
	base: string;
	key(fresh: boolean): Promise<string>;
}

export interface AgentAiRelayDeps {
	/** Null when this agent was not pointed at a project. */
	upstream(kind: AgentKind): AgentAiUpstream | null;
	fetch: typeof fetch;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const FORWARDED_REQUEST = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'];
const FORWARDED_RESPONSE = ['content-type', 'cache-control', 'retry-after', 'request-id', 'x-request-id'];

function refuse(res: ServerResponse, status: number, message: string): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ type: 'error', error: { type: 'relay_error', message } }));
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

export class AgentAiRelay {
	private server: Server | null = null;
	private starting: Promise<string> | null = null;
	private readonly token = randomBytes(32);

	constructor(private readonly deps: AgentAiRelayDeps) {}

	/** Where an agent is sent, and the token it presents. Starts the relay on first use. */
	async endpoint(): Promise<{ root: string; token: string }> {
		this.starting ??= this.listen();
		return { root: await this.starting, token: this.token.toString('hex') };
	}

	stop(): void {
		this.server?.close();
		this.server = null;
		this.starting = null;
	}

	private listen(): Promise<string> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				void this.handle(req, res).catch(() => {
					if (!res.headersSent) {
						refuse(res, 502, t('mainProjects.agentRelayFailed'));
					} else {
						res.destroy();
					}
				});
			});
			server.once('error', (error) => {
				this.starting = null;
				reject(error);
			});
			server.listen(0, '127.0.0.1', () => {
				this.server = server;
				resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
			});
		});
	}

	private authorized(req: IncomingMessage): boolean {
		const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
		const presented = bearer ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '');
		const expected = this.token.toString('hex');
		const given = Buffer.from(presented);
		const wanted = Buffer.from(expected);
		return given.length === wanted.length && timingSafeEqual(given, wanted);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.authorized(req)) {
			refuse(res, 401, t('mainProjects.agentRelayToken'));
			return;
		}
		const call = agentAiCall(req.url ?? '');
		if (!call) {
			refuse(res, 404, t('mainProjects.agentRelayNoCall'));
			return;
		}
		const upstream = this.deps.upstream(call.kind);
		if (!upstream) {
			refuse(res, 409, t('mainProjects.agentRelayNoProject'));
			return;
		}
		const method = req.method === 'GET' ? 'GET' : 'POST';
		const body = method === 'POST' ? await readBody(req) : undefined;
		if (body === null) {
			refuse(res, 413, t('mainProjects.agentRelayTooLarge'));
			return;
		}
		const headers: Record<string, string> = {};
		for (const name of FORWARDED_REQUEST) {
			const value = req.headers[name];
			if (typeof value === 'string') {
				headers[name] = value;
			}
		}
		const abort = new AbortController();
		res.on('close', () => {
			if (!res.writableEnded) {
				abort.abort();
			}
		});
		let answer: Response | null = null;
		// A key revoked since it was made: make another, once.
		for (let attempt = 0; attempt < 2; attempt++) {
			const key = await upstream.key(attempt > 0);
			answer = await this.deps.fetch(`${upstream.base}/${call.path}`, {
				method,
				headers: { ...headers, Authorization: `Bearer ${key}` },
				body: method === 'POST' ? new Uint8Array(body as Buffer) : undefined,
				signal: abort.signal,
			});
			if (answer.status !== 401) {
				break;
			}
		}
		if (!answer) {
			refuse(res, 502, t('mainProjects.agentRelayFailed'));
			return;
		}
		const out: Record<string, string> = {};
		for (const name of FORWARDED_RESPONSE) {
			const value = answer.headers.get(name);
			if (value) {
				out[name] = value;
			}
		}
		res.writeHead(answer.status, out);
		if (!answer.body) {
			res.end();
			return;
		}
		Readable.fromWeb(answer.body as unknown as WebReadableStream).pipe(res);
	}
}

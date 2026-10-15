/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AiProviderId } from '../shared/ai';
import type { AiService, AiDebugChatRequest, AiDebugEditRequest } from './aiService';
import type { ConnectionManager } from './connectionManager';

/** Localhost only — never bind a public interface; this drives the real model with real
 *  (decrypted) credentials. */
const HOST = '127.0.0.1';
/** Default port for the dev endpoint (overridable via SNOUTDATA_AI_DEBUG_PORT). */
const DEFAULT_PORT = 8317;
/** Cap on request bodies so a stray client can't exhaust memory. */
const MAX_BODY = 1_000_000;

/** What a request must carry to be served: this run's token, for this port. */
export interface DebugGate {
	port: number;
	token: string;
}

/** A fresh token for one run of the endpoint. */
export function newDebugToken(): string {
	return randomBytes(24).toString('base64url');
}

/**
 * Why a request is refused, or null when it may be served. The endpoint answers only a local
 * program that read this run's token from the dev log:
 *  - any `Origin` header is refused, because a browser sends one on every cross-origin request and
 *    a command-line client never does, so no web page can drive it;
 *  - `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, so a page that rebinds its own name
 *    to the loopback address is refused even if it never sends an Origin;
 *  - the token must arrive as `Authorization: Bearer <token>` (or `x-ai-debug-token`), compared in
 *    constant time.
 */
export function refuseDebugRequest(headers: IncomingHttpHeaders, gate: DebugGate): { status: number; error: string } | null {
	if (headers.origin !== undefined) {
		return { status: 403, error: 'Requests from a web page are refused.' };
	}
	const host = (headers.host ?? '').toLowerCase();
	if (host !== `127.0.0.1:${gate.port}` && host !== `localhost:${gate.port}`) {
		return { status: 403, error: `Host must be 127.0.0.1:${gate.port} or localhost:${gate.port}.` };
	}
	const auth = headers.authorization ?? '';
	const header = headers['x-ai-debug-token'];
	const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (Array.isArray(header) ? header[0] : header) ?? '';
	const expected = Buffer.from(gate.token);
	const given = Buffer.from(presented);
	if (gate.token === '' || given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return { status: 401, error: 'Missing or wrong token: send "Authorization: Bearer <token>" with the token printed in the dev log.' };
	}
	return null;
}

/** The connection-selector fields shared by every POST body (resolved by {@link resolveConnection}). */
interface ConnBody {
	/** Friendly selector: a connection's label OR id (case-insensitive). Must be connected. */
	connection?: string | null;
	/** Explicit id (skips the label lookup). `null` ⇒ send with no schema. */
	connectionId?: string | null;
}

interface ChatBody extends ConnBody {
	question?: string;
	provider?: AiProviderId;
	model?: string;
	agent?: boolean;
}

interface EditBody extends ConnBody {
	instruction?: string;
	selection?: string;
	document?: string;
	provider?: AiProviderId;
	model?: string;
	/** Run the edit across every benchmark model instead of one. */
	benchmark?: boolean;
}

/** Resolve which connection to ground the prompt in from the request body. Precedence:
 *  `connection` (label/id, must be live) → `connectionId` (`null` = no schema) → the first
 *  connected connection. Returns an `error` string when a named connection is unknown or
 *  not currently connected (so the prompt wouldn't actually be schema-grounded). */
function resolveConnection(connections: ConnectionManager, body: ConnBody): { connectionId?: string; error?: string } {
	const state = connections.state();
	const connected = new Set(state.connectedIds);
	if (body.connection !== undefined && body.connection !== null) {
		const needle = String(body.connection).toLowerCase();
		const match = state.connections.find((c) => c.id.toLowerCase() === needle || c.label.toLowerCase() === needle);
		if (!match) {
			const known = state.connections.map((c) => c.label).join(', ') || '(none configured)';
			return { error: `No connection matching "${body.connection}". Known connections: ${known}.` };
		}
		if (!connected.has(match.id)) {
			return { error: `Connection "${match.label}" is not connected — connect it in the app first so its schema is available (or omit it / pass "connectionId": null for a schemaless prompt).` };
		}
		return { connectionId: match.id };
	}
	if (body.connectionId === null) {
		return { connectionId: undefined };
	}
	if (body.connectionId !== undefined) {
		return { connectionId: body.connectionId };
	}
	return { connectionId: state.connectedIds[0] };
}

/**
 * A tiny dev-only HTTP control surface for AI prompt tuning, never started in a packaged build.
 * Every request must pass {@link refuseDebugRequest}. It calls the *real*
 * {@link AiService} — live settings, the active connection's schema, decrypted API keys —
 * so what comes back is exactly what the app would produce, and the blackbox logger
 * records every round-trip to aiDebug.jsonl along the way. Started only in dev (see main).
 *
 * Routes:
 *   GET  /ai/info        → saved provider/model, connected ids, the benchmark model list
 *   POST /ai/chat        → { question, provider?, model?, connectionId?, agent? } → one result
 *   POST /ai/benchmark   → { question, connectionId?, agent? } → one result per benchmark model
 *   POST /ai/edit        → { instruction, selection?, document?, provider?, model?, benchmark? }
 *                          → the real Ctrl+K edit path; `benchmark:true` ⇒ one per benchmark model
 *
 * `connectionId` defaults to the first connected connection (so the prompt is schema-grounded
 * without having to look the id up); pass it explicitly, or `null`, to override.
 */
export function startAiDebugServer(aiService: AiService, connections: ConnectionManager): void {
	const port = Number(process.env.SNOUTDATA_AI_DEBUG_PORT) || DEFAULT_PORT;
	const gate: DebugGate = { port, token: newDebugToken() };
	const server = createAiDebugServer(aiService, connections, gate);
	server.on('error', (err) => {
		console.error(`[ai-debug] endpoint failed to start: ${err.message}`);
	});
	server.listen(port, HOST, () => {
		console.log(`[ai-debug] dev endpoint on http://${HOST}:${port}  token ${gate.token}  (Authorization: Bearer <token>; GET /ai/info, POST /ai/chat, POST /ai/benchmark)`);
	});
}

/** The endpoint's HTTP server, every request checked against `gate` before it is routed. */
export function createAiDebugServer(aiService: AiService, connections: ConnectionManager, gate: DebugGate): Server {
	return createServer((req, res) => {
		const refused = refuseDebugRequest(req.headers, gate);
		if (refused) {
			sendJson(res, refused.status, { error: refused.error });
			return;
		}
		void handle(req, res, aiService, connections).catch((err) => {
			sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
		});
	});
}

async function handle(req: IncomingMessage, res: ServerResponse, aiService: AiService, connections: ConnectionManager): Promise<void> {
	const url = req.url ?? '';
	if (req.method === 'GET' && url === '/ai/info') {
		const state = connections.state();
		const connected = new Set(state.connectedIds);
		sendJson(res, 200, {
			connectedIds: state.connectedIds,
			connections: state.connections.map((c) => ({ id: c.id, label: c.label, driver: c.driver, connected: connected.has(c.id) })),
			benchmarkModels: aiService.benchmarkModels(),
			// Why a chat/action isn't landing in the audit log: recording needs BOTH the tier
			// entitlement (auditAllowed) and the kind being enabled in Settings (auditKinds).
			audit: aiService.auditState(),
		});
		return;
	}

	if (req.method === 'POST' && (url === '/ai/chat' || url === '/ai/benchmark')) {
		const body = await readJson<ChatBody>(req);
		if (!body.question || typeof body.question !== 'string') {
			sendJson(res, 400, { error: 'Body must be JSON with a "question" string.' });
			return;
		}
		const resolved = resolveConnection(connections, body);
		if (resolved.error) {
			sendJson(res, 400, { error: resolved.error });
			return;
		}
		const base: Omit<AiDebugChatRequest, 'provider' | 'model'> = { question: body.question, connectionId: resolved.connectionId, agent: body.agent };
		if (url === '/ai/benchmark') {
			sendJson(res, 200, { results: await aiService.benchmark(base) });
		} else {
			sendJson(res, 200, await aiService.debugChat({ ...base, provider: body.provider, model: body.model }));
		}
		return;
	}

	if (req.method === 'POST' && url === '/ai/edit') {
		const body = await readJson<EditBody>(req);
		if (!body.instruction || typeof body.instruction !== 'string') {
			sendJson(res, 400, { error: 'Body must be JSON with an "instruction" string (and usually a "selection").' });
			return;
		}
		const resolved = resolveConnection(connections, body);
		if (resolved.error) {
			sendJson(res, 400, { error: resolved.error });
			return;
		}
		const base: Omit<AiDebugEditRequest, 'provider' | 'model'> = { instruction: body.instruction, selection: body.selection, document: body.document, connectionId: resolved.connectionId };
		if (body.benchmark) {
			sendJson(res, 200, { results: await aiService.benchmarkEdit(base) });
		} else {
			sendJson(res, 200, await aiService.debugEdit({ ...base, provider: body.provider, model: body.model }));
		}
		return;
	}

	sendJson(res, 404, { error: `No route ${req.method} ${url}` });
}

function readJson<T>(req: IncomingMessage): Promise<T> {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => {
			raw += chunk;
			if (raw.length > MAX_BODY) {
				reject(new Error('Request body too large.'));
				req.destroy();
			}
		});
		req.on('end', () => {
			try {
				resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
			} catch {
				reject(new Error('Invalid JSON body.'));
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body, null, 2);
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(payload);
}

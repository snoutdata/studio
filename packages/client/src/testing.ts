/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Test doubles: a fetch that records what was sent and answers from a script, and a
 * WebSocket that plays a Phoenix server. Not exported from the package.
 */

export interface Sent {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | undefined;
}

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

export function fakeFetch(answer: (request: Sent) => Answer = () => ({ body: [] })): { fetch: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const request: Sent = {
			url: String(input),
			method: init.method ?? 'GET',
			headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
			body: typeof init.body === 'string' ? init.body : undefined
		};
		sent.push(request);
		const { status = 200, body = null, headers = {} } = answer(request);
		const text = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
		return new Response(status === 204 || request.method === 'HEAD' ? null : text, {
			status,
			headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers }
		});
	};
	return { fetch: impl as typeof fetch, sent };
}

export interface Frame {
	topic: string;
	event: string;
	payload: Record<string, unknown>;
	ref: string | null;
	join_ref?: string | null;
}

/**
 * A socket whose server side is `onFrame`. `sockets` records every one opened, so a test
 * can drop a connection and watch the client open another.
 */
export function fakeSocket(onFrame: (frame: Frame, socket: FakeSocket) => void): { transport: typeof WebSocket; sockets: FakeSocket[] } {
	const sockets: FakeSocket[] = [];
	class Socket implements FakeSocket {
		readyState = 0;
		onopen: (() => void) | null = null;
		onmessage: ((event: { data: string }) => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		readonly frames: Frame[] = [];

		constructor(readonly url: string) {
			sockets.push(this);
			queueMicrotask(() => {
				this.readyState = 1;
				this.onopen?.();
			});
		}

		send(text: string): void {
			const frame = JSON.parse(text) as Frame;
			this.frames.push(frame);
			queueMicrotask(() => onFrame(frame, this));
		}

		close(): void {
			if (this.readyState === 3) {
				return;
			}
			this.readyState = 3;
			queueMicrotask(() => this.onclose?.());
		}

		serve(frame: Frame): void {
			this.onmessage?.({ data: JSON.stringify(frame) });
		}

		serveRaw(data: string): void {
			this.onmessage?.({ data });
		}

		reply(to: Frame, response: Record<string, unknown> = {}, status = 'ok'): void {
			this.serve({ topic: to.topic, event: 'phx_reply', payload: { status, response }, ref: to.ref, join_ref: to.join_ref });
		}
	}
	return { transport: Socket as unknown as typeof WebSocket, sockets };
}

export interface FakeSocket {
	readyState: number;
	readonly url: string;
	readonly frames: Frame[];
	close(): void;
	serve(frame: Frame): void;
	/** Any text at all, as a hostile or broken server could send it. */
	serveRaw(data: string): void;
	reply(to: Frame, response?: Record<string, unknown>, status?: string): void;
}

export function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A JWT-shaped token; nothing here checks the signature. */
export function jwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What every product shares: one fetch, and the headers each request carries.
 *
 * The headers are asked for per request rather than fixed at construction, because the
 * `Authorization` a request carries is whoever is signed in at the moment it is sent, and
 * that changes under the client's feet (sign-in, refresh, sign-out).
 */

export type Fetch = typeof fetch;

/**
 * Which names the client speaks on the wire.
 *
 * `new` (the default) is our own layout: `/v1/data`, `/v1/identity`, `/v1/files`, `/v1/live`,
 * `/v1/fn`, the key in a `Snout-Key` header, the auth server's new routes and fields, and the
 * `live:` realtime wire. `old` is the layout 0.3.x spoke (`/rest/v1`, `apikey`, ...), for a server
 * that has not been updated to accept the new names yet. Only the names differ: every request
 * means the same thing and every answer has the same shape either way.
 */
export type Vocabulary = 'new' | 'old';

/** The header a request carries the project key in. */
export function keyHeader(vocabulary: Vocabulary): string {
	return vocabulary === 'old' ? 'apikey' : 'Snout-Key';
}

/** Resolves the headers one request carries: the key, and the bearer of the moment. */
export type HeaderSource = () => Promise<Record<string, string>>;

export interface Transport {
	fetch: Fetch;
	headers: HeaderSource;
}

/** Reads a body as JSON when it says it is JSON, as text otherwise, and never throws. */
export async function readBody(response: Response): Promise<unknown> {
	const text = await response.text().catch(() => '');
	if (text === '') {
		return null;
	}
	const type = response.headers.get('content-type') ?? '';
	if (type.includes('json')) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

/** The first human sentence in an error body, whichever server and whichever shape wrote it. */
export function messageOf(body: unknown, fallback: string): string {
	if (typeof body === 'string' && body.trim() !== '') {
		return body.trim();
	}
	if (body !== null && typeof body === 'object') {
		const record = body as Record<string, unknown>;
		for (const field of ['message', 'msg', 'error_description', 'error']) {
			const value = record[field];
			if (typeof value === 'string' && value !== '') {
				return value;
			}
		}
	}
	return fallback;
}

/** `https://x` + `/a/b` with no doubled or missing slash. */
export function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * An object path with each segment encoded and the slashes kept.
 *
 * A `.` or `..` segment is refused: the URL parser resolves it (encoded as `%2e` too) before
 * the request leaves, so a path another user chose could walk out of its product prefix and
 * send this user's token and body to another endpoint of the project.
 */
export function encodePath(path: string): string {
	return path
		.replace(/^\/+|\/+$/g, '')
		.split('/')
		.map((segment) => encodeURIComponent(checkSegment(segment, path)))
		.join('/');
}

/** One path segment that cannot be `.` or `..`, however it is spelled. */
export function checkSegment(segment: string, whole: string = segment): string {
	let decoded = segment;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		// Not percent-encoding at all; encodeURIComponent will escape it as it stands.
	}
	if (decoded === '.' || decoded === '..') {
		throw new TypeError(`A path may not contain a "${decoded}" segment: ${whole}`);
	}
	return segment;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const KEY_HEADERS = new Set(['snout-key', 'apikey', 'authorization']);

/**
 * A fetch that never carries the key or the bearer to another origin on a redirect.
 *
 * Fetch drops `Authorization` on a cross-origin hop but keeps a custom key header (`Snout-Key`,
 * or `apikey` in the old vocabulary), so a function (or anything else on the project) answering
 * `307 Location: https://elsewhere` would hand over the key, which on a server is the server key.
 * Here a redirect is followed by hand: within the request's own origin as fetch would, and to
 * another origin without those headers (a storage download redirected to a presigned URL needs
 * none of them).
 *
 * In a browser the key is the public app key and a manual redirect cannot be read, so the
 * platform's own following is kept. A caller that set `redirect` itself is left alone.
 */
export function guardRedirects(inner: Fetch): Fetch {
	if (isBrowser()) {
		return inner;
	}
	const guarded = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		if (init.redirect !== undefined || (typeof input !== 'string' && !(input instanceof URL))) {
			return inner(input, init);
		}
		let url = new URL(String(input));
		const origin = url.origin;
		let current: RequestInit = { ...init, redirect: 'manual' };
		for (let hop = 0; ; hop++) {
			const response = await inner(url.toString(), current);
			const location = response.headers.get('location');
			if (!REDIRECTS.has(response.status) || !location) {
				return response;
			}
			if (hop >= 20) {
				throw new TypeError('Too many redirects');
			}
			const method = (current.method ?? 'GET').toUpperCase();
			const toGet = (response.status === 303 && method !== 'HEAD') || ((response.status === 301 || response.status === 302) && method === 'POST');
			const stream = typeof ReadableStream !== 'undefined' && current.body instanceof ReadableStream;
			if (!toGet && stream) {
				// A stream cannot be sent twice; the caller sees the redirect, as fetch would refuse it.
				return response;
			}
			await response.body?.cancel().catch(() => undefined);
			const next = new URL(location, url);
			const headers: Record<string, string> = {};
			new Headers(current.headers).forEach((value, name) => {
				if (next.origin !== origin && KEY_HEADERS.has(name)) {
					return;
				}
				if (toGet && (name === 'content-type' || name === 'content-length')) {
					return;
				}
				headers[name] = value;
			});
			const { duplex: _duplex, ...rest } = current as RequestInit & { duplex?: string };
			current = toGet ? { ...rest, method: 'GET', body: undefined, headers } : { ...current, headers };
			url = next;
		}
	};
	return guarded as Fetch;
}

export function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined';
}

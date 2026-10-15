/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Snout Functions: your own TypeScript, at `/v1/fn/<name>` (`/functions/v1/<name>` in the old
 * vocabulary).
 *
 * `call` sends the signed-in person's token, so a function can act as them, and decodes the
 * answer by its content type. A function that answers with a status of 400 or above is an
 * `error` whose `context` is the Response, so its own body can still be read.
 */

import { checkSegment, joinUrl, type Transport } from './http.js';

export class FunctionsError extends Error {
	/** The function's own response, when it answered at all. */
	readonly context: Response | undefined;

	constructor(message: string, name: 'FunctionsHttpError' | 'FunctionsFetchError' | 'FunctionsRelayError', context?: Response) {
		super(message);
		this.name = name;
		this.context = context;
	}
}

export type FunctionsResult<T> = { data: T; error: null } | { data: null; error: FunctionsError };

export interface CallOptions {
	body?: unknown;
	headers?: Record<string, string>;
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	signal?: AbortSignal;
}

/** @deprecated Since 0.4.0: `CallOptions`. */
export type InvokeOptions = CallOptions;

/**
 * A function's name, by the rule the control plane applies when one is deployed: letters,
 * digits, hyphens and underscores, up to 48 characters, starting with a letter or a digit.
 */
const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/** A backslash (the URL parser reads it as a slash) or a control character (it drops tabs and newlines). */
const RESOLVED_AWAY = /[\\\u0000-\u001f\u007f]/;

/**
 * Refuses a target that would not stay under the functions prefix. The name must be one a function can
 * have; after it, a subpath is the function's own, but a `.` or `..` segment, a backslash or a
 * control character would be resolved by the URL parser before the request leaves.
 */
function assertInFunctions(target: string): void {
	const path = target.split(/[?#]/)[0].replace(/^\/+/, '');
	const [name, ...subpath] = path.split('/');
	if (!FUNCTION_NAME.test(name)) {
		throw new TypeError(
			`Not a function name: ${JSON.stringify(name)}. Letters, digits, hyphens and underscores, up to 48 characters, starting with a letter or a digit.`
		);
	}
	if (RESOLVED_AWAY.test(path)) {
		throw new TypeError(`A function path may not contain a backslash or a control character: ${JSON.stringify(target)}`);
	}
	for (const segment of subpath) {
		checkSegment(segment, target);
	}
}

export class FunctionsClient {
	constructor(
		/** @internal */ readonly url: string,
		private readonly transport: Transport
	) {}

	/** @deprecated Since 0.4.0: use `call()`, the same function. Removed in 0.5.0. */
	declare invoke: FunctionsClient['call'];

	/** Calls the function `name` (a subpath or a query string after it is the function's own). */
	async call<T = unknown>(name: string, options: CallOptions = {}): Promise<FunctionsResult<T>> {
		// The name is sent as written (a subpath or a query string is the function's own), once it
		// is known to stay under the functions prefix.
		try {
			assertInFunctions(name);
		} catch (cause) {
			return { data: null, error: new FunctionsError((cause as Error).message, 'FunctionsFetchError') };
		}
		const headers: Record<string, string> = { ...(await this.transport.headers()) };
		const given = options.body;
		let body: BodyInit | undefined;
		if (given !== undefined) {
			if (typeof given === 'string') {
				headers['Content-Type'] = 'text/plain';
				body = given;
			} else if (
				(typeof Blob !== 'undefined' && given instanceof Blob) ||
				given instanceof ArrayBuffer ||
				ArrayBuffer.isView(given)
			) {
				headers['Content-Type'] = 'application/octet-stream';
				body = given as BodyInit;
			} else if (given instanceof FormData || given instanceof URLSearchParams) {
				body = given;
			} else {
				headers['Content-Type'] = 'application/json';
				body = JSON.stringify(given);
			}
		}
		Object.assign(headers, options.headers);

		let response: Response;
		try {
			response = await this.transport.fetch(joinUrl(this.url, name), {
				method: options.method ?? 'POST',
				headers,
				body,
				signal: options.signal
			});
		} catch (cause) {
			return { data: null, error: new FunctionsError(cause instanceof Error ? cause.message : String(cause), 'FunctionsFetchError') };
		}
		if (response.headers.get('x-relay-error') === 'true') {
			return { data: null, error: new FunctionsError('The function could not be reached', 'FunctionsRelayError', response) };
		}
		if (!response.ok) {
			return { data: null, error: new FunctionsError(`The function answered ${response.status}`, 'FunctionsHttpError', response) };
		}

		const type = (response.headers.get('content-type') ?? 'text/plain').split(';')[0].trim();
		let data: unknown;
		if (type === 'application/json') {
			data = await response.json();
		} else if (type === 'application/octet-stream' || type.startsWith('image/') || type === 'application/pdf') {
			data = await response.blob();
		} else if (type === 'text/event-stream') {
			// A stream is handed over unread, so the caller reads it as it arrives.
			data = response;
		} else if (type === 'multipart/form-data') {
			data = await response.formData();
		} else {
			data = await response.text();
		}
		return { data: data as T, error: null };
	}
}

FunctionsClient.prototype.invoke = FunctionsClient.prototype.call;

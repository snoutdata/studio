/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The project's AI gateway at `/ai/v1`: the models the project serves, a chat reply whole or as
 * it is written, and embeddings. The wire is OpenAI's, so a request is what an OpenAI client
 * would send, with the project's own model names.
 *
 * Every call sends the signed-in person's token, which is how a browser app calls a model: the
 * gateway takes it only once the project has a hard budget for itself and one for every user, and
 * it never takes the app key alone. A server sends the server key, or a gateway key (`psy_…`) set
 * as `Authorization` in `global.headers`.
 *
 * A refusal comes back as `error`, with the gateway's own sentence, its `code`
 * (`budget_exceeded`, `model_not_found`, ...) and the HTTP status.
 */

import { joinUrl, readBody, type Transport } from './http.js';

export class AiError extends Error {
	/** The HTTP status, or 0 when nothing answered (or the stream broke after it began). */
	readonly status: number;
	/** The gateway's code: `budget_exceeded`, `model_not_found`, `rate_limit_exceeded`, ... */
	readonly code: string | undefined;
	/** The error's kind on the OpenAI wire: `insufficient_quota`, `permission_error`, ... */
	readonly type: string | undefined;

	constructor(message: string, status: number, code?: string, type?: string) {
		super(message);
		this.name = 'AiError';
		this.status = status;
		this.code = code;
		this.type = type;
	}
}

export type AiResult<T> = { data: T; error: null } | { data: null; error: AiError };

/** One part of a message's content: text, or an image by URL (a `data:` URL included). */
export type AiContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface AiMessage {
	role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
	content: string | AiContentPart[] | null;
	name?: string;
	tool_calls?: AiToolCall[];
	tool_call_id?: string;
}

export interface AiToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface AiChatRequest {
	model: string;
	messages: AiMessage[];
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	tools?: unknown[];
	tool_choice?: unknown;
	response_format?: unknown;
	user?: string;
	/** Anything else the OpenAI wire takes, passed through as written. */
	[field: string]: unknown;
}

export interface AiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	[field: string]: unknown;
}

export interface AiChatCompletion {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: { index: number; message: AiMessage; finish_reason: string | null }[];
	usage?: AiUsage;
}

export interface AiChatChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: { index: number; delta: Partial<AiMessage>; finish_reason: string | null }[];
	/** On the last chunk, when the gateway reports it. */
	usage?: AiUsage | null;
}

export interface AiModel {
	id: string;
	object: 'model';
	created?: number;
	owned_by?: string;
	[field: string]: unknown;
}

export interface AiEmbedRequest {
	model: string;
	input: string | string[];
	dimensions?: number;
	encoding_format?: 'float' | 'base64';
	[field: string]: unknown;
}

export interface AiEmbeddings {
	object: 'list';
	data: { object: 'embedding'; index: number; embedding: number[] | string }[];
	model: string;
	usage?: { prompt_tokens: number; total_tokens: number };
}

export interface AiCallOptions {
	signal?: AbortSignal;
}

/** The gateway's refusal, from its body when it has one. */
async function refusal(response: Response): Promise<AiError> {
	const body = await readBody(response);
	const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
	if (error !== null && typeof error === 'object') {
		const { message, code, type } = error as Record<string, unknown>;
		return new AiError(
			typeof message === 'string' && message !== '' ? message : `The AI gateway answered ${response.status}`,
			response.status,
			typeof code === 'string' ? code : undefined,
			typeof type === 'string' ? type : undefined
		);
	}
	if (typeof body === 'string' && body.trim() !== '') {
		return new AiError(body.trim(), response.status);
	}
	return new AiError(`The AI gateway answered ${response.status}`, response.status);
}

/**
 * The `data:` events of a server-sent stream, decoded, up to `[DONE]`. An event that carries an
 * `error` (the provider failed after the reply began) is thrown as an `AiError`.
 */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<AiChatChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// An event ends at a blank line; the last, unfinished one waits for more bytes.
			const blocks = buffered.split(/\r?\n\r?\n/);
			buffered = done ? '' : (blocks.pop() ?? '');
			for (const block of blocks) {
				const data = block
					.split(/\r?\n/)
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).replace(/^ /, ''))
					.join('\n');
				if (data === '') {
					continue;
				}
				if (data === '[DONE]') {
					return;
				}
				const parsed = JSON.parse(data) as AiChatChunk & { error?: { message?: string; code?: string; type?: string } };
				if (parsed.error) {
					throw new AiError(parsed.error.message ?? 'The reply stopped with an error', 0, parsed.error.code, parsed.error.type);
				}
				yield parsed;
			}
			if (done) {
				return;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

export class AiClient {
	constructor(
		/** @internal */ readonly url: string,
		private readonly transport: Transport
	) {}

	private async send(method: 'GET' | 'POST', path: string, body: unknown, options: AiCallOptions): Promise<Response | AiError> {
		const headers: Record<string, string> = { ...(await this.transport.headers()) };
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		try {
			return await this.transport.fetch(joinUrl(this.url, path), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: options.signal
			});
		} catch (cause) {
			return new AiError(cause instanceof Error ? cause.message : String(cause), 0);
		}
	}

	private async json<T>(method: 'GET' | 'POST', path: string, body: unknown, options: AiCallOptions): Promise<AiResult<T>> {
		const response = await this.send(method, path, body, options);
		if (response instanceof AiError) {
			return { data: null, error: response };
		}
		if (!response.ok) {
			return { data: null, error: await refusal(response) };
		}
		return { data: (await response.json()) as T, error: null };
	}

	/** The models this project serves, by the names it serves them under. */
	async models(options: AiCallOptions = {}): Promise<AiResult<AiModel[]>> {
		const answer = await this.json<{ data: AiModel[] }>('GET', 'models', undefined, options);
		return answer.error ? answer : { data: answer.data.data, error: null };
	}

	/** One reply, whole. */
	chat(request: AiChatRequest, options: AiCallOptions = {}): Promise<AiResult<AiChatCompletion>> {
		return this.json<AiChatCompletion>('POST', 'chat/completions', { ...request, stream: false }, options);
	}

	/**
	 * One reply as it is written: `data` is read with `for await`, a chunk at a time, and the
	 * last chunk carries the usage. A refusal before the reply begins (a budget, a model the
	 * project does not serve) is `error`; a failure after it began is thrown by the loop.
	 */
	async stream(request: AiChatRequest, options: AiCallOptions = {}): Promise<AiResult<AsyncIterable<AiChatChunk>>> {
		const streamOptions = { include_usage: true, ...(request.stream_options as object | undefined) };
		const response = await this.send('POST', 'chat/completions', { ...request, stream: true, stream_options: streamOptions }, options);
		if (response instanceof AiError) {
			return { data: null, error: response };
		}
		if (!response.ok) {
			return { data: null, error: await refusal(response) };
		}
		if (!response.body) {
			return { data: null, error: new AiError('The AI gateway answered with no body', response.status) };
		}
		return { data: events(response.body), error: null };
	}

	/** Vectors for one input or several, in the order given. */
	embed(request: AiEmbedRequest, options: AiCallOptions = {}): Promise<AiResult<AiEmbeddings>> {
		return this.json<AiEmbeddings>('POST', 'embeddings', request, options);
	}
}

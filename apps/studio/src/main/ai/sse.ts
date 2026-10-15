/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Yield the JSON payload of each `data:` line from a streaming SSE response body,
 *  skipping `event:`/blank lines and the OpenAI `[DONE]` sentinel. Shared by the
 *  OpenAI-compatible and Anthropic providers, which both stream server-sent events. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) {
				continue;
			}
			const payload = line.slice(5).trim();
			if (payload === '[DONE]') {
				continue;
			}
			yield payload;
		}
	}
}

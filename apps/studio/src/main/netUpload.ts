/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { createReadStream } from 'node:fs';

// A file PUT to a URL, streamed from disk and never held in memory, through Chromium's network
// stack for the reason `netFetch.ts` gives: it trusts the OS certificate store and honours the
// system proxy, so an upload works wherever the rest of the app does. Used by "Deploy from a
// folder" to send a built image to the project's own upload link.

/** How long the answer may take once the file is sent: the far end stores the image first. */
const ANSWER_TIMEOUT_MS = 15 * 60_000;

export function uploadFile(url: string, file: string, sent?: (bytes: number) => void): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = net.request({ method: 'PUT', url, redirect: 'error' });
		request.chunkedEncoding = true;
		request.setHeader('Content-Type', 'application/octet-stream');
		const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
		let timer: NodeJS.Timeout | null = null;
		const fail = (error: Error): void => {
			if (timer) {
				clearTimeout(timer);
			}
			reject(error);
		};
		request.on('response', (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => {
				if (timer) {
					clearTimeout(timer);
				}
				// Answered before the file was all sent (a link refused up front): stop reading it.
				if (!stream.readableEnded) {
					stream.unpipe();
					stream.destroy();
				}
				resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
			});
			response.on('error', fail);
		});
		request.on('error', fail);
		let total = 0;
		stream.on('data', (chunk) => {
			total += chunk.length;
			sent?.(total);
		});
		stream.on('error', (error) => {
			request.abort();
			fail(error);
		});
		stream.on('end', () => {
			timer = setTimeout(() => {
				request.abort();
				fail(new Error('The upload finished but no answer came back in 15 minutes.'));
			}, ANSWER_TIMEOUT_MS);
		});
		stream.pipe(request as unknown as NodeJS.WritableStream);
	});
}

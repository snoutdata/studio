/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { createReadStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';

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

/** A bodiless request to the project's door (CT30's begin, done and status steps), through `net`. */
export function callDoor(method: 'POST' | 'GET', url: string, headers: Readonly<Record<string, string>>): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = net.request({ method, url, redirect: 'error' });
		for (const [name, value] of Object.entries(headers)) {
			request.setHeader(name, value);
		}
		request.on('response', (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		request.on('error', reject);
		request.end();
	});
}

/**
 * The archive PUT to the presigned place in storage (CT30), with exactly the headers it was signed
 * for. Node's `https` rather than `net`, and on purpose: the place is signed for an exact
 * `content-length`, S3 refuses a chunked body on a presigned PUT, and `net` holds a body that is not
 * chunked in memory until it ends, which for a 2 GB archive is not an option. So this one request
 * does not take the system proxy; the steps through the door still do.
 */
export function putToStorage(
	url: string,
	file: string,
	headers: Readonly<Record<string, string>>,
	sent?: (bytes: number) => void,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest(new URL(url), { method: 'PUT', headers });
		request.on('response', (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		request.on('error', reject);
		const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
		let total = 0;
		stream.on('data', (chunk) => {
			total += chunk.length;
			sent?.(total);
		});
		stream.on('error', (error) => request.destroy(error));
		stream.pipe(request);
	});
}

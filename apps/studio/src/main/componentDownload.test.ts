/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { allowTestHooks } from './testHooks';
import { checksumComparable, downloadFailureMessage, downloadFile, humanBytes, isFetchable, isPlaceholder, resolveFeedUrl, sha256File } from './componentDownload';

// The overrides below are test hooks, which a packaged build closes (testHooks.ts); open them here.
allowTestHooks(true);

/*  The download path for on-demand components, tested against a REAL http server on loopback.
 *
 *  It is worth the server: the interesting behaviour here is what happens when a transfer is cut in
 *  half, and a mocked stream would be asserting my own idea of how one breaks. The resume path in
 *  particular can only be wrong in ways that produce a plausible file (a doubled prefix, a truncated
 *  tail), so every test that resumes checks the CONTENT, not the length.  */

const BODY = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

let server: Server;
let port = 0;
let dir = '';
/** Set to cut the connection after N bytes, simulating a dropped transfer. */
let cutAfter: number | null = null;
/** Set false to answer 200 with the whole body even when a Range was asked for. */
let honourRange = true;
/** Send one chunk then go quiet forever, holding the socket open: a stall, not an error. */
let stallForever = false;
/** Send the body in slow pieces: progressing, not stalled. */
let dribble = false;
let lastRange: string | undefined;
let requests = 0;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), 'snout-dl-'));
	server = createServer((req, res) => {
		requests++;
		lastRange = req.headers.range;
		if (req.url === '/gone') {
			res.writeHead(404).end('nope');
			return;
		}
		if (req.url === '/redirect') {
			res.writeHead(302, { location: `http://127.0.0.1:${port}/file` }).end();
			return;
		}
		const range = honourRange ? req.headers.range : undefined;
		let body = BODY;
		if (range) {
			const start = Number(/bytes=(\d+)-/.exec(String(range))?.[1] ?? 0);
			if (start >= BODY.length) {
				res.writeHead(416).end();
				return;
			}
			body = BODY.subarray(start);
			res.writeHead(206, { 'content-length': String(body.length), 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
		} else {
			res.writeHead(200, { 'content-length': String(body.length) });
		}
		if (stallForever) {
			res.write(body.subarray(0, 500));
			return; // never end, never error: the socket just goes quiet
		}
		if (dribble) {
			let sent = 0;
			const step = (): void => {
				if (sent >= body.length) {
					res.end();
					return;
				}
				const next = Math.min(sent + 1000, body.length);
				res.write(body.subarray(sent, next));
				sent = next;
				setTimeout(step, 100); // slower than nothing, faster than the stall window
			};
			step();
			return;
		}
		if (cutAfter !== null) {
			// Flush the first chunk and only THEN drop the socket. Destroying immediately after write()
			// discards the buffered bytes, so the client receives nothing and there is no partial to
			// resume from, which tests a different (and less interesting) failure than the one meant.
			res.write(body.subarray(0, cutAfter), () => {
				setTimeout(() => res.destroy(), 20);
			});
			return;
		}
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as { port: number }).port;
});

after(() => {
	server?.close();
	rmSync(dir, { recursive: true, force: true });
});

function url(path = '/file'): string {
	return `http://127.0.0.1:${port}${path}`;
}

describe('downloadFile', () => {
	it('downloads a file and reports progress against the real total', async () => {
		cutAfter = null;
		const dest = join(dir, 'plain.bin');
		const seen: number[] = [];
		let total = 0;
		await downloadFile(url(), dest, (received, t) => {
			seen.push(received);
			total = t;
		});
		assert.deepEqual(readFileSync(dest), BODY);
		assert.equal(total, BODY.length);
		assert.ok(seen.length > 0);
		assert.equal(seen[seen.length - 1], BODY.length);
	});

	it('leaves no .part behind on success', async () => {
		cutAfter = null;
		const dest = join(dir, 'clean.bin');
		await downloadFile(url(), dest, () => {});
		assert.ok(existsSync(dest));
		assert.equal(existsSync(`${dest}.part`), false, 'the partial should be renamed, not copied');
	});

	it('follows redirects', async () => {
		cutAfter = null;
		const dest = join(dir, 'redirected.bin');
		await downloadFile(url('/redirect'), dest, () => {});
		assert.deepEqual(readFileSync(dest), BODY);
	});

	it('keeps the partial file when a transfer is cut, and does NOT write the destination', async () => {
		cutAfter = 2000;
		const dest = join(dir, 'cut.bin');
		await assert.rejects(downloadFile(dest === '' ? '' : url(), dest, () => {}));
		assert.equal(existsSync(dest), false, 'a broken download must never look like a finished one');
		assert.ok(existsSync(`${dest}.part`));
		assert.equal(statSync(`${dest}.part`).size, 2000);
	});

	it('resumes from the partial, asking only for the rest, and the result is byte-correct', async () => {
		// Half a file is on disk from the test above's shape; write it explicitly so this test stands
		// on its own rather than on execution order.
		const dest = join(dir, 'resume.bin');
		writeFileSync(`${dest}.part`, BODY.subarray(0, 2000));
		cutAfter = null;
		honourRange = true;
		await downloadFile(url(), dest, () => {});
		assert.equal(lastRange, 'bytes=2000-', 'it should ask for only the missing bytes');
		assert.deepEqual(readFileSync(dest), BODY, 'a resumed file must equal a whole one');
		assert.equal(await sha256File(dest), BODY_SHA);
	});

	it('starts over when the server ignores the Range header', async () => {
		// The failure this prevents: appending a whole second copy onto the partial, which produces a
		// file that is the right shape, the wrong length, and passes no hash check anybody reads.
		const dest = join(dir, 'norange.bin');
		writeFileSync(`${dest}.part`, BODY.subarray(0, 2000));
		cutAfter = null;
		honourRange = false;
		await downloadFile(url(), dest, () => {});
		honourRange = true;
		assert.deepEqual(readFileSync(dest), BODY, 'must not be the partial plus a full copy');
	});

	it('starts over when the partial is already past the end (416)', async () => {
		const dest = join(dir, 'stale.bin');
		writeFileSync(`${dest}.part`, Buffer.alloc(BODY.length + 10, 7));
		cutAfter = null;
		honourRange = true;
		await downloadFile(url(), dest, () => {});
		assert.deepEqual(readFileSync(dest), BODY);
	});

	it('ignores the partial when resume is off', async () => {
		const dest = join(dir, 'noresume.bin');
		writeFileSync(`${dest}.part`, BODY.subarray(0, 2000));
		cutAfter = null;
		await downloadFile(url(), dest, () => {}, { resume: false });
		assert.equal(lastRange, undefined, 'no Range header when resume is off');
		assert.deepEqual(readFileSync(dest), BODY);
	});

	it('rejects a non-200 with the status in the message', async () => {
		cutAfter = null;
		await assert.rejects(
			downloadFile(url('/gone'), join(dir, 'gone.bin'), () => {}),
			/HTTP 404/,
		);
	});

	it('cancels on an abort signal and keeps what it had', async () => {
		cutAfter = null;
		const dest = join(dir, 'cancelled.bin');
		const controller = new AbortController();
		const promise = downloadFile(url(), dest, (received) => {
			if (received > 0) {
				controller.abort();
			}
		}, { signal: controller.signal, resume: false });
		await assert.rejects(promise, /cancelled/);
		assert.equal(existsSync(dest), false);
	});

	it('gives up when the transfer stalls, and keeps what arrived', async () => {
		// The case an inversion exposed: with the socket-error handlers removed, a dead transfer did
		// not fail, it HUNG. A connection that goes quiet without erroring is the one failure no socket
		// event reports, so it needs its own clock. Here the server sends a chunk and then simply
		// stops, holding the socket open.
		stallForever = true;
		const dest = join(dir, 'stalled.bin');
		await assert.rejects(
			downloadFile(url(), dest, () => {}, { stallMs: 300, resume: false }),
			/stopped responding/,
		);
		stallForever = false;
		assert.equal(existsSync(dest), false, 'a stalled download must not become the destination');
		assert.ok(existsSync(`${dest}.part`), 'and what did arrive must survive for the resume');
	});

	it('does not treat a slow but progressing download as stalled', async () => {
		// The counterpart, and the reason the timer measures silence rather than elapsed time: a big
		// file on a slow line must not be killed for being big.
		dribble = true;
		const dest = join(dir, 'slow.bin');
		await downloadFile(url(), dest, () => {}, { stallMs: 400, resume: false });
		dribble = false;
		assert.deepEqual(readFileSync(dest), BODY);
	});

	it('refuses plain http off loopback, so the registry cannot be downgraded', async () => {
		await assert.rejects(
			downloadFile('http://example.com/x.zip', join(dir, 'insecure.bin'), () => {}),
			/refusing to download over http/,
		);
	});
});

describe('sha256File', () => {
	it('hashes a file as a stream', async () => {
		const path = join(dir, 'hash.bin');
		writeFileSync(path, BODY);
		assert.equal(await sha256File(path), BODY_SHA);
	});

	it('hashes a file larger than one read buffer', async () => {
		// The reason this function changed at all: it must not depend on the file fitting in memory.
		const path = join(dir, 'big.bin');
		const big = Buffer.alloc(3 * 1024 * 1024, 9);
		writeFileSync(path, big);
		assert.equal(await sha256File(path), createHash('sha256').update(big).digest('hex'));
	});

	/*
	 * The regression this function's SECOND change exists for: the hash must not run on the thread
	 * that called it, because in Electron that thread owns the window.
	 *
	 * IT DOES NOT MEASURE STALLS, and the first version of this test did. That version could not
	 * fail: hashing 1.1 GB in plain Node never stalls a timer (worst gap 22 ms of a 20 ms interval),
	 * while the SAME code in Electron's main process stalls for 224 ms at a time and drops half its
	 * ticks. The behaviour being guarded only exists under Chromium's message pump, and `node --test`
	 * has no such thing - so a stall assertion here is green whatever this function does, which is
	 * worse than no test.
	 *
	 * What IS observable from any thread: whether the work made progress while this thread was
	 * BUSY. So it hashes once to learn what the file costs, then hashes again while blocking the
	 * caller synchronously. Off-thread, the block overlaps the hash and the total is the baseline.
	 * On-thread, nothing can happen until the block ends and the total is the baseline PLUS it.
	 *
	 * Opt-in (`SNOUTDATA_TEST_TIMING=1`) because it reads a quarter of a gigabyte twice. Run it when
	 * touching this function.
	 */
	it('makes progress while the calling thread is blocked', { skip: process.env.SNOUTDATA_TEST_TIMING ? false : 'set SNOUTDATA_TEST_TIMING=1' }, async () => {
		const path = join(dir, 'huge.bin');
		const block = Buffer.alloc(8 * 1024 * 1024, 3);
		const handle = openSync(path, 'w');
		for (let i = 0; i < 32; i += 1) {
			writeSync(handle, block);
		}
		closeSync(handle);

		// What the file costs with nothing in the way. Also warms the OS cache, so the second read
		// is not being timed against a cold disk.
		const warm = Date.now();
		await sha256File(path);
		const baseline = Date.now() - warm;

		const BLOCK_MS = 400;
		const started = Date.now();
		const hashing = sha256File(path);
		// Synchronous on purpose. Nothing on this thread can run until this returns, which is the
		// whole question being asked.
		const until = Date.now() + BLOCK_MS;
		while (Date.now() < until) {
			// spin
		}
		await hashing;
		const total = Date.now() - started;

		assert.ok(
			total < baseline + BLOCK_MS / 2,
			`hashing took ${total}ms against a ${baseline}ms baseline while this thread was blocked for ${BLOCK_MS}ms, so it waited for the thread rather than running beside it`,
		);
	});
});

describe('helpers', () => {
	it('treats a __placeholder__ hash as not-yet-published', () => {
		assert.equal(isPlaceholder('__llamacpp_cpu_win__'), true);
		assert.equal(isPlaceholder(BODY_SHA), false);
	});

	it('labels sizes the way the prompt reads them', () => {
		assert.equal(humanBytes(0), 'unknown size');
		assert.equal(humanBytes(42 * 1024 * 1024), '42 MB');
		assert.equal(humanBytes(1_200_000_000), '1.1 GB');
	});
});

describe('resolveFeedUrl', () => {
	const REAL = 'https://github.com/snoutdata/studio/releases/download/components-v1/llamacpp-cpu-b10435-win32-x64.zip';

	it('ignores the override where test hooks are closed, as in every packaged build', () => {
		allowTestHooks(false);
		process.env.SNOUTDATA_TEST_FEED = 'http://127.0.0.1:9331';
		try {
			assert.equal(resolveFeedUrl(REAL), REAL);
			assert.equal(isFetchable('__llamacpp_cpu_win32_x64__'), false);
			assert.equal(checksumComparable('b0fd698e46ddb13dbda42699df4c88cfc023c84dafd6efa6d17eda8d9e1b609b'), true);
		} finally {
			delete process.env.SNOUTDATA_TEST_FEED;
			allowTestHooks(true);
		}
	});

	it('leaves the real URL alone when nothing is set', () => {
		delete process.env.SNOUTDATA_TEST_FEED;
		assert.equal(resolveFeedUrl(REAL), REAL);
	});

	it('swaps the origin for a server on this machine, keeping the path', () => {
		process.env.SNOUTDATA_TEST_FEED = 'http://127.0.0.1:9331';
		assert.equal(
			resolveFeedUrl(REAL),
			'http://127.0.0.1:9331/snoutdata/studio/releases/download/components-v1/llamacpp-cpu-b10435-win32-x64.zip',
		);
		delete process.env.SNOUTDATA_TEST_FEED;
	});

	it('REFUSES to redirect a download anywhere but loopback', () => {
		// The whole safety argument for the override. An origin that could name any host would be a
		// waiting redirect to somebody else's mirror; this one can only name this machine.
		process.env.SNOUTDATA_TEST_FEED = 'https://example.com';
		assert.equal(resolveFeedUrl(REAL), REAL);
		process.env.SNOUTDATA_TEST_FEED = 'not a url';
		assert.equal(resolveFeedUrl(REAL), REAL);
		delete process.env.SNOUTDATA_TEST_FEED;
	});
});

describe('isFetchable', () => {
	it('says a placeholder checksum cannot be fetched, because nothing was ever uploaded for it', () => {
		delete process.env.SNOUTDATA_TEST_FEED;
		// The whole point: the app knows this statically. It used to offer the download anyway and
		// find out at the end of a progress bar, which is a dead end a user cannot act on.
		assert.equal(isFetchable('__llamacpp_cpu_win32_x64__'), false);
		assert.equal(isFetchable('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), true);
	});

	it('is fetchable again under the test feed, which is what that override stands in for', () => {
		// Without this the setup assistant's download half could only be exercised by publishing
		// first, which is the wrong order (the e2e suite serves the real bundles over loopback).
		process.env.SNOUTDATA_TEST_FEED = 'http://127.0.0.1:1234';
		assert.equal(isFetchable('__llamacpp_cpu_win32_x64__'), true);
		delete process.env.SNOUTDATA_TEST_FEED;
	});
});

describe('checksumComparable', () => {
	const REAL = 'b0fd698e46ddb13dbda42699df4c88cfc023c84dafd6efa6d17eda8d9e1b609b';

	it('compares a real hash from the real feed, which is every shipped download', () => {
		delete process.env.SNOUTDATA_TEST_FEED;
		assert.equal(checksumComparable(REAL), true);
	});

	it('has nothing to compare a placeholder against, because nothing was uploaded for it', () => {
		delete process.env.SNOUTDATA_TEST_FEED;
		assert.equal(checksumComparable('__llamacpp_cpu_darwin_arm64__'), false);
	});

	it('does not compare under the test feed, because what that serves is not the published file', () => {
		// A real hash in the registry must not fail a spec that serves its own fixture over loopback:
		// that fixture is not pretending to be the published artifact, so there is nothing to compare.
		process.env.SNOUTDATA_TEST_FEED = 'http://127.0.0.1:1234';
		assert.equal(checksumComparable(REAL), false);
		delete process.env.SNOUTDATA_TEST_FEED;
	});

	it('is not the same question as isFetchable, and they answer oppositely under the override', () => {
		// Worth pinning because the two read the same field: "can this be downloaded at all" and "can
		// what came back be compared to what we published" are different, and the override flips one
		// on and the other off.
		process.env.SNOUTDATA_TEST_FEED = 'http://127.0.0.1:1234';
		assert.equal(isFetchable('__llamacpp_cpu_darwin_arm64__'), true);
		assert.equal(checksumComparable('__llamacpp_cpu_darwin_arm64__'), false);
		delete process.env.SNOUTDATA_TEST_FEED;
	});
});

describe('downloadFailureMessage', () => {
	it('says what a 404 means, because it is not about this machine', () => {
		// The one case worth translating: "download failed (HTTP 404)" reads like a broken connection,
		// so somebody will retry it, check their network, and get the same thing every time. What it
		// actually means is that the file is not on our feed.
		const said = downloadFailureMessage(new Error('download failed (HTTP 404)'));
		assert.match(said, /not on our feed/);
		assert.match(said, /Nothing is wrong with this computer/);
	});

	it('leaves every other failure exactly as it was written', () => {
		// Those sentences are already addressed to the person reading them, and rewording a cancel or
		// a stall would lose the one thing each of them says.
		for (const message of ['download cancelled', 'the connection dropped before the download finished', 'download failed (HTTP 500)', 'no bytes for 60s']) {
			assert.equal(downloadFailureMessage(new Error(message)), message);
		}
		assert.equal(downloadFailureMessage('a plain string'), 'a plain string');
	});
});

// Keep the linter honest about the unused counter, which exists for debugging a failing run.
void requests;

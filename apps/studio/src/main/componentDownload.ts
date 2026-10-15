/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Fetching and verifying a downloaded component.
 *
 *  Lifted out of `componentStore.ts` unchanged in behaviour and then extended, for one reason worth
 *  stating: `componentStore.ts` imports `electron`, so nothing in it can be tested under plain Node,
 *  and these two functions are the ones that will be handed a GIGABYTE. Untestable code that reads
 *  a whole file into memory is not a combination to leave alone.
 *
 *  Two properties, both needed for a download the size of a model and both an improvement for the
 *  driver bundles that use this today:
 *
 *    1. **Hashing streams.** Reading the whole file would be fine for a 42 MB driver bundle and a
 *       gigabyte-plus memory spike for a model.
 *    2. **Downloads resume.** A failed 42 MB download is an annoyance; a failed 1.1 GB download on a
 *       hotel connection is a user who gives up. The partial file is kept as `<dest>.part` and the
 *       next attempt asks for the rest with a Range header.
 *
 *  The download target is written to `<dest>.part` and renamed only on success, so a half-finished
 *  file is never mistaken for a complete one. That was already the store's shape (it writes the
 *  manifest last); this puts the same idea one level down.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { Worker } from 'node:worker_threads';
import { testEnv } from './testHooks';

/** A sha256 left as a `__…__` placeholder has not been filled from a real upload yet; skip the
 *  check rather than reject every download during bring-up. */
export function isPlaceholder(hash: string): boolean {
	return hash.startsWith('__');
}

/**
 * Whether a registry entry can actually be FETCHED today.
 *
 * A `__…__` checksum is not decoration: it is the record that **nothing has been uploaded for this
 * entry yet**, so its URL is a 404 for everybody. The app knows that statically, and until this was
 * read it went on offering the download anyway and found out at the end of a progress bar.
 *
 * The test-feed override makes one fetchable again, which is exactly what that override stands in
 * for: the e2e suite serves the real bundles over loopback with placeholder hashes, and a rule that
 * called those unavailable would turn the setup assistant's whole download half back into something
 * that can only be exercised by publishing first.
 *
 * When the maintainer publishes and pastes the real hashes in, this flips on its own. That is the point of
 * hanging it on the checksum rather than on a second flag somebody has to remember.
 */
export function isFetchable(sha256: string): boolean {
	return !isPlaceholder(sha256) || Boolean(testEnv('SNOUTDATA_TEST_FEED'));
}

/**
 * Whether a downloaded file's checksum can be COMPARED to the registry's.
 *
 * Two cases where it cannot, and they are different facts that can look the same:
 *
 * - **The registry entry is a placeholder.** Nothing has been uploaded for it, so there is no hash
 *   to compare against. `isFetchable` is what reads that and refuses the download in the first
 *   place; this is the same fact seen from the other end.
 * - **`SNOUTDATA_TEST_FEED` is set.** That override swaps the ORIGIN of every bundle URL for a
 *   server on this machine, so what comes back is by construction NOT the published artifact — it
 *   is a fixture the test built, a bundle with a library deliberately removed, a truncated body. Its
 *   hash cannot equal the published one, and comparing them checks the wrong file.
 *
 * **This became load-bearing the day the real hashes were pasted in.** Until then every entry was a
 * placeholder, so the first case silently covered the second, and the e2e suite's stand-in bundles
 * sailed past a check that was never actually running. The moment the registry named real files,
 * every test that serves its own bundle started failing an integrity check against an artifact it
 * was never pretending to be — which is a true statement about the fixture and tells you nothing
 * about the app.
 *
 * It cannot weaken a real download: a packaged build never reads the override (testHooks.ts), and
 * `resolveFeedUrl` accepts it only for a LOOPBACK origin, so the file whose check is skipped is one this machine served to itself. A fetch from the
 * real feed is verified, always.
 */
export function checksumComparable(sha256: string): boolean {
	return !isPlaceholder(sha256) && !testEnv('SNOUTDATA_TEST_FEED');
}

/**
 * Where a bundle is actually fetched from.
 *
 * The registry's URLs name our public feed and are what ships. `SNOUTDATA_TEST_FEED` swaps the ORIGIN
 * for a server on this machine, which is what lets the setup assistant's download half be DRIVEN by a
 * test rather than described: a real socket, real bytes, a cancel, a failure and a resume. Without it
 * the only way to exercise that path is to publish first, which is the wrong order.
 *
 * **Loopback only, and that is the whole safety argument.** An override that could name any host
 * would be a redirect to somebody else's mirror waiting to be found; one that can only name this
 * machine cannot move a download anywhere it was not already going to run code from.
 */
export function resolveFeedUrl(url: string): string {
	const origin = testEnv('SNOUTDATA_TEST_FEED');
	if (!origin) {
		return url;
	}
	try {
		const base = new URL(origin);
		if (!isLoopback(base.hostname)) {
			return url;
		}
		const target = new URL(url);
		return new URL(`${target.pathname}${target.search}`, base).toString();
	} catch {
		// A malformed override is ignored rather than fatal: it is a test convenience, and the real
		// URL is always the right answer when it makes no sense.
		return url;
	}
}

function isLoopback(hostname: string): boolean {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

export function humanBytes(bytes: number): string {
	if (!bytes) {
		return 'unknown size';
	}
	const mb = bytes / (1024 * 1024);
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * The hash, computed on a WORKER THREAD.
 *
 * Inline source rather than a file, so there is nothing extra for esbuild to emit and nothing to
 * resolve inside an asar: it requires node builtins only, and the path it is handed is a real file
 * on disk (userData), never a packaged one.
 */
const HASH_WORKER = `
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { workerData, parentPort } = require('node:worker_threads');
const hash = createHash(workerData.algorithm);
const stream = createReadStream(workerData.path);
stream.on('data', (chunk) => hash.update(chunk));
stream.on('error', (err) => parentPort.postMessage({ error: String((err && err.message) || err) }));
stream.on('end', () => parentPort.postMessage({ digest: hash.digest(workerData.encoding) }));
`;

/**
 * sha256 of a file, streamed, and NOT on the thread that owns the window.
 *
 * The streaming was always the point (a component can be over a gigabyte, and the `readFileSync`
 * this replaced held all of it in memory). What streaming did NOT fix is that hashing is CPU work on
 * the main process, and main is where Electron pumps the window's messages: hashing a gigabyte there
 * stalls the window for seconds, long enough for Windows to call it "not responding". In a worker it
 * is slightly slower in wall clock, by the cost of one thread, and the UI keeps working.
 *
 * The trade is deliberate. A verify that takes two seconds longer and leaves the app usable beats a
 * faster one that makes it look crashed - and the checksum itself is not up for discussion, since
 * dropping it is how a damaged gigabyte becomes "the runtime will not start" a day later.
 *
 * Falls back to hashing in-process if a worker cannot be created at all, because a wrong answer is
 * worse than a slow one and no answer is worse than both.
 */
export function sha256File(path: string): Promise<string> {
	return hashFile(path, 'sha256', 'hex');
}

/** A file's digest, streamed on a worker thread (see `sha256File` for why). */
export function hashFile(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
	try {
		return new Promise<string>((resolve, reject) => {
			const worker = new Worker(HASH_WORKER, { eval: true, workerData: { path, algorithm, encoding } });
			worker.once('message', (message: { digest?: string; error?: string }) => {
				void worker.terminate();
				if (message.error !== undefined) {
					reject(new Error(message.error));
					return;
				}
				resolve(message.digest ?? '');
			});
			worker.once('error', reject);
		});
	} catch {
		return hashFileHere(path, algorithm, encoding);
	}
}

/** The same hash, in this thread. Only reached when a worker could not be started. */
function hashFileHere(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const hash = createHash(algorithm);
		const stream = createReadStream(path);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest(encoding)));
	});
}

/**
 * Whether a file is the one a pin names.
 *
 * Two pin shapes are accepted, because two kinds of publisher are trusted: a bare 64-character hex
 * string is a SHA-256 (what our own feed and IBM's driver are pinned by), and `sha512-<base64>` is a
 * Subresource Integrity string, which is exactly what the npm registry publishes as a version's
 * `dist.integrity`. Pinning npm's own string means the value in the code can be checked against the
 * registry by anyone, with no conversion in between.
 *
 * Anything else is refused rather than treated as "no pin": an integrity check that cannot be
 * performed must not pass.
 */
export async function integrityMatches(path: string, expected: string): Promise<boolean> {
	const pin = expected.trim();
	if (/^[0-9a-f]{64}$/i.test(pin)) {
		return (await hashFile(path, 'sha256', 'hex')).toLowerCase() === pin.toLowerCase();
	}
	const sri = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(pin);
	if (sri) {
		return (await hashFile(path, 'sha512', 'base64')) === sri[1];
	}
	throw new Error(`not a usable integrity pin: ${pin.slice(0, 16)}`);
}

export interface DownloadOptions {
	/** Abort an in-flight download. The partial file is KEPT, so a cancel is resumable too. */
	signal?: AbortSignal;
	/** Set false to ignore any existing partial and start over. */
	resume?: boolean;
	/**
	 * Give up after this long with NO bytes arriving. Not a total deadline: a 1.1 GB model on a slow
	 * connection is legitimately a long download, and a deadline would punish it for being big.
	 *
	 * It exists because of what an inversion found. Removing the two socket-error handlers did not
	 * turn a test red, it made the suite HANG: with nothing listening for the connection dying, a cut
	 * transfer never settles at all. Those handlers cover every way a socket has been observed to
	 * fail here, but "the promise never settles" is a bad worst case for something a user is watching
	 * a progress bar for, and a stall is the one failure a socket error does not report.
	 */
	stallMs?: number;
}

/** CHOSEN. Long enough that a slow first byte from a CDN is not a failure, short enough that a
 *  wedged download does not sit there looking busy forever. */
export const DEFAULT_STALL_MS = 60_000;

/**
 * Download a URL to a file, following redirects, reporting progress, resuming where it can.
 *
 * **https only, except on loopback.** The registry's URLs are https; the exception exists so this is
 * testable against a local server without standing up a self-signed certificate, and it is narrow
 * enough that it cannot become a downgrade path for a real download.
 */
export function downloadFile(
	url: string,
	dest: string,
	onProgress: (received: number, total: number) => void,
	options: DownloadOptions = {},
): Promise<void> {
	const part = `${dest}.part`;
	return new Promise<void>((resolve, reject) => {
		// Bytes already on disk from an interrupted attempt. `total` below is always the size of the
		// WHOLE file, so progress means the same thing whether or not this is a resume.
		let already = 0;
		if (options.resume !== false && existsSync(part)) {
			try {
				already = statSync(part).size;
			} catch {
				already = 0;
			}
		}

		const request = (target: string, redirects: number, offset: number): void => {
			if (redirects > 6) {
				reject(new Error('too many redirects'));
				return;
			}
			let parsed: URL;
			try {
				parsed = new URL(target);
			} catch {
				reject(new Error(`not a valid download URL: ${target}`));
				return;
			}
			const loopback = isLoopback(parsed.hostname);
			if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
				reject(new Error(`refusing to download over ${parsed.protocol.replace(':', '')} from ${parsed.hostname}`));
				return;
			}

			const headers: Record<string, string> = { 'User-Agent': 'snoutdata', Accept: 'application/octet-stream' };
			if (offset > 0) {
				headers.Range = `bytes=${offset}-`;
			}
			const getter = parsed.protocol === 'http:' ? httpGet : httpsGet;
			const req = getter(target, { headers }, (res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400 && res.headers.location) {
					res.resume();
					request(new URL(res.headers.location, target).toString(), redirects + 1, offset);
					return;
				}
				// A server that ignores Range answers 200 with the whole file. Honour that rather than
				// appending a second copy onto the first, which is how a resume corrupts a download.
				const resumed = status === 206 && offset > 0;
				if (status !== 200 && status !== 206) {
					res.resume();
					// 416 means the partial is at or past the end: the file on disk is stale or complete,
					// and either way starting over is the only thing that can be right.
					if (status === 416 && offset > 0) {
						rmSync(part, { force: true });
						request(target, redirects + 1, 0);
						return;
					}
					reject(new Error(`download failed (HTTP ${status})`));
					return;
				}
				const startAt = resumed ? offset : 0;
				if (!resumed && offset > 0) {
					rmSync(part, { force: true });
				}
				const total = Number(res.headers['content-length'] ?? 0) + startAt;
				let received = startAt;
				const out = createWriteStream(part, resumed ? { flags: 'a' } : { flags: 'w' });

				// A transfer that dies has to leave its bytes ON DISK, closed, before anyone is told it
				// failed: the whole point of keeping the partial is that the next attempt resumes from
				// it, and a write stream that is still buffering when the rejection lands may never have
				// opened the file at all. So every failure from here on goes through `fail`, which closes
				// the file first and settles once.
				let settled = false;
				let stall: NodeJS.Timeout | undefined;
				const fail = (err: Error): void => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(stall);
					out.end(() => reject(err));
				};
				const done = (): void => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(stall);
					resolve();
				};
				// Restarted on every chunk, so this measures SILENCE rather than duration: a big model on a
				// slow line is a long download, not a stalled one, and a total deadline would punish it for
				// being big.
				const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
				const beat = (): void => {
					clearTimeout(stall);
					stall = setTimeout(() => {
						// Claim the reason BEFORE destroying, for the same reason the cancel path does:
						// destroying fires 'aborted', and a user told "the connection dropped" when the
						// truth is "it went silent for a minute" is being handed the wrong thing to fix.
						fail(new Error(`the download stopped responding after ${received} bytes`));
						res.destroy();
					}, stallMs);
					stall.unref?.();
				};
				beat();
				res.on('data', (chunk: Buffer) => {
					received += chunk.length;
					beat();
					onProgress(received, total);
				});
				res.pipe(out);
				out.on('finish', () => out.close(() => {
					if (settled) {
						return;
					}
					// A dropped connection ends the response WITHOUT an error, so `pipe` closes the file
					// and this fires exactly as it does on success. Without the short-read check, a
					// transfer cut in half is renamed to the destination and reported as a finished
					// download — the corruption this whole module exists to make impossible. Found by the
					// test that cuts the connection mid-body, which is why that test cuts it.
					if (total > 0 && received < total) {
						settled = true;
						reject(new Error(`download ended early (${received} of ${total} bytes)`));
						return;
					}
					try {
						rmSync(dest, { force: true });
						renameSync(part, dest);
					} catch (err) {
						settled = true;
						reject(err instanceof Error ? err : new Error(String(err)));
						return;
					}
					done();
				}));
				out.on('error', fail);
				res.on('error', fail);
				// The response ending early without an error at all. `pipe` will close the file and the
				// finish handler above catches it, but saying so here names the cause instead of leaving
				// a byte count to be interpreted.
				res.on('aborted', () => fail(new Error('the connection dropped before the download finished')));

				options.signal?.addEventListener('abort', () => {
					// Settle FIRST, then destroy. Destroying the response fires 'aborted', and if that got
					// there first the user would be told the connection dropped when in fact they pressed
					// Cancel. `fail` settles once, so claiming the reason before causing it is what makes
					// the message honest.
					fail(new Error('download cancelled'));
					// LEAVE the partial: a cancelled download that threw away its bytes would make
					// "cancel" and "start over" the same button.
					res.destroy();
				}, { once: true });
			});
			req.on('error', reject);
			options.signal?.addEventListener('abort', () => req.destroy(), { once: true });
		};

		if (options.signal?.aborted) {
			reject(new Error('download cancelled'));
			return;
		}
		request(url, 0, already);
	});
}
/**
 * What a failed download should SAY, as opposed to what it threw.
 *
 * One case is worth translating and it is the one a user cannot act on: a **404 means the file this
 * app asked for is not on the feed**, which is a fact about our publishing rather than about their
 * machine. "download failed (HTTP 404)" reads like a broken connection, and somebody who takes it
 * that way will retry, check their network, and get the same thing every time.
 *
 * Everything else passes through unchanged: those messages are already written for the person
 * reading them (a cancelled transfer, a stall, a dropped connection, a refused protocol).
 */
export function downloadFailureMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/\(HTTP 404\)/.test(message)) {
		return 'That download is not on our feed yet, so there is nothing here to fetch. Nothing is wrong with this computer or your connection.';
	}
	return message;
}

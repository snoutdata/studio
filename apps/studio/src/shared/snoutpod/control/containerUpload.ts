// GENERATED: a copy of SnoutData's control-plane code (containerUpload.ts).
// Do not edit here: edits are overwritten by the build.
/**
 * An image built from a Dockerfile, uploaded (CT28 and CT30): the client's
 * half, decided once for the CLI and Studio.
 *
 * ## Why the bytes no longer go through the door (CT30, 2026-10-20)
 *
 * A project's API address is served through Cloudflare, which refuses a request
 * body over 100 MB below Enterprise, while an archive may be 2 GB. So the archive goes to the
 * project's own prefix in its cohort bucket, on a URL the project's host signs, and only three
 * small requests go through the door:
 *
 *   1. `POST <ticket url>` with the archive's size and SHA-256: the agent consumes the ticket and
 *      answers where to put the archive (`UploadPlace`), a presigned PUT signed for exactly that
 *      size and checksum, so S3 itself refuses anything else and the 2 GB cap still holds;
 *   2. the client PUTs the archive there, straight to S3;
 *   3. `POST <ticket url>/done`: the agent fetches it, stores it as before (load, check, push to
 *      the project's own repository) and records it. That takes minutes, longer than Cloudflare
 *      holds a request open (100 s), so it answers at once and the client polls
 *      `GET <ticket url>` for the digest (`UploadStatus`).
 *
 * The ticket stays the whole credential: no key, no registry login, and the client learns a URL
 * that works for one object for 15 minutes and names nothing else of ours.
 *
 * A door or agent from before this answers the first POST with 405. The client then PUTs the
 * archive to the ticket URL as it always did (`legacy`), so a client released first works against
 * the fleet as it is, and the fleet can be updated first too.
 *
 * Pure: the network, the file and the clock are an `UploadTransport`.
 */

/** The archive's size, declared by the client when it asks where to put it. */
export const UPLOAD_BYTES_HEADER = 'x-snoutdata-upload-bytes';
/** The archive's SHA-256, hex, declared with its size; S3 checks the bytes against it. */
export const UPLOAD_SHA256_HEADER = 'x-snoutdata-upload-sha256';
/** Appended to the ticket URL: the archive is in the bucket, store it. */
export const UPLOAD_DONE_SUFFIX = '/done';

/** Where the client puts the archive: a presigned PUT, to be sent with exactly these headers. */
export interface UploadPlace {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly expiresAt: string;
}

/** `waiting` for the archive, `storing` it, `stored` at `digest`, or `failed` with a sentence. */
export type UploadState = 'waiting' | 'storing' | 'stored' | 'failed';

export interface UploadStatus {
	readonly state: UploadState;
	readonly name?: string;
	readonly digest?: string;
	/** The sentence, when it failed. */
	readonly error?: string;
	/** The status the failure would have been answered with, for the client's own sentence. */
	readonly status?: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
	return SHA256_HEX.test(value);
}

export interface UploadAnswer {
	readonly status: number;
	readonly body: string;
}

export interface UploadTransport {
	/** A bodiless request to the project's door. */
	call(method: 'POST' | 'GET', url: string, headers: Readonly<Record<string, string>>): Promise<UploadAnswer>;
	/** PUT the file to `url`, streamed, with exactly `headers` (none for the legacy PUT). */
	put(url: string, file: string, headers: Readonly<Record<string, string>>): Promise<UploadAnswer>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/**
 * The upload did not end in a digest. `status` and `body` are the answer that said so, in the
 * shape the door and the agent answer with, so each client keeps its own sentence for them.
 */
export class UploadFailed extends Error {
	constructor(
		readonly status: number,
		readonly body: string
	) {
		super(`the upload failed (${status})`);
	}
}

function parsed<T>(body: string): Partial<T> {
	try {
		const value = JSON.parse(body) as unknown;
		return value && typeof value === 'object' ? (value as Partial<T>) : {};
	} catch {
		return {};
	}
}

function digestOf(body: string): string {
	const digest = String(parsed<{ digest: unknown }>(body).digest ?? '');
	if (!DIGEST.test(digest)) {
		throw new UploadFailed(502, JSON.stringify({ error: 'The upload finished without saying what it stored, so there is nothing to deploy. Build again.' }));
	}
	return digest;
}

/** How long the client waits for the host to store the archive, after it is in the bucket. */
export const STORE_WAIT_MS = 15 * 60_000;
const POLL_MS = 2_000;

/**
 * Upload the archive at `file` (`bytes` long, `sha256` hex) to the ticket URL the control plane
 * handed out, and return the digest it was stored at.
 */
export async function uploadArchive(options: {
	readonly ticketUrl: string;
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly transport: UploadTransport;
	/** Called as each step starts, for a line of progress. */
	readonly step?: (step: 'uploading' | 'storing') => void;
	readonly waitMs?: number;
	readonly pollMs?: number;
}): Promise<string> {
	const { ticketUrl, file, transport } = options;
	if (!isSha256Hex(options.sha256)) {
		throw new Error('an upload is declared with its SHA-256, in hex');
	}
	const begin = await transport.call('POST', ticketUrl, {
		[UPLOAD_BYTES_HEADER]: String(options.bytes),
		[UPLOAD_SHA256_HEADER]: options.sha256
	});
	if (begin.status === 405) {
		// A door or agent from before CT30: the bytes go through the door, as they always did.
		options.step?.('uploading');
		const legacy = await transport.put(ticketUrl, file, {});
		if (legacy.status !== 200) {
			throw new UploadFailed(legacy.status, legacy.body);
		}
		return digestOf(legacy.body);
	}
	if (begin.status !== 200) {
		throw new UploadFailed(begin.status, begin.body);
	}
	const place = parsed<UploadPlace>(begin.body);
	if (typeof place.url !== 'string' || !place.url.startsWith('https://') || !place.headers || typeof place.headers !== 'object') {
		throw new UploadFailed(502, JSON.stringify({ error: "The project's host did not say where to put the image. Build again in a moment." }));
	}

	options.step?.('uploading');
	const put = await transport.put(place.url, file, place.headers);
	if (put.status !== 200) {
		// S3's own answer is XML naming its own internals; the client is told what it can act on.
		const code = /<Code>([^<]+)<\/Code>/.exec(put.body)?.[1];
		const error =
			code === 'BadDigest' || code === 'XAmzContentSHA256Mismatch'
				? 'The image changed or was damaged while it was uploading. Build again.'
				: code === 'AccessDenied' || code === 'SignatureDoesNotMatch' || code === 'RequestTimeTooSkewed'
					? "The upload link was refused (it lasts 15 minutes, and this computer's clock must be right). Build again."
					: `The upload to storage failed (${put.status}). Build again in a moment.`;
		throw new UploadFailed(put.status === 403 ? 401 : 502, JSON.stringify({ error }));
	}

	options.step?.('storing');
	const deadline = transport.now() + (options.waitMs ?? STORE_WAIT_MS);
	const pollMs = options.pollMs ?? POLL_MS;
	let told = false;
	while (!told) {
		const done = await transport.call('POST', `${ticketUrl}${UPLOAD_DONE_SUFFIX}`, {});
		if (done.status === 200 || done.status === 202) {
			told = true;
		} else if (done.status === 429 && transport.now() < deadline) {
			// The host is storing other images; it takes this one when it can.
			await transport.sleep(pollMs * 5);
		} else {
			throw new UploadFailed(done.status, done.body);
		}
	}
	for (;;) {
		const answer = await transport.call('GET', ticketUrl, {});
		if (answer.status !== 200) {
			throw new UploadFailed(answer.status, answer.body);
		}
		const status = parsed<UploadStatus>(answer.body);
		if (status.state === 'stored') {
			return digestOf(answer.body);
		}
		if (status.state === 'failed') {
			throw new UploadFailed(typeof status.status === 'number' ? status.status : 502, JSON.stringify({ error: status.error ?? 'The image could not be stored. Build again in a moment.' }));
		}
		if (transport.now() >= deadline) {
			throw new UploadFailed(504, JSON.stringify({ error: "The project's host took too long to store the image. Build again in a moment." }));
		}
		await transport.sleep(pollMs);
	}
}

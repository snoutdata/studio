/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Files: files in spaces (buckets), at `/v1/files` (`/storage/v1` in the old vocabulary).
 *
 * Who may read or write a file is row-level security on the project's files table, exactly as
 * for a table, so the same signed-in session that reads rows reads files. A public space's
 * files are also served without a key, at the URL `publicLink` builds.
 */

import { encodePath, joinUrl, messageOf, readBody, type Transport, type Vocabulary } from './http.js';

/** Each route of the files server, in the old vocabulary and the new. */
const ROUTES = {
	bucket: ['bucket', 'space'],
	object: ['object', 'file'],
	info: ['object/info', 'file/info'],
	list: ['object/list', 'file/list'],
	move: ['object/move', 'file/move'],
	copy: ['object/copy', 'file/copy'],
	sign: ['object/sign', 'file/signed'],
	uploadSign: ['object/upload/sign', 'file/upload/signed'],
	public: ['object/public', 'file/public'],
	imageMember: ['render/image/authenticated', 'image/member'],
	imagePublic: ['render/image/public', 'image/public']
} as const;

function route(vocabulary: Vocabulary, name: keyof typeof ROUTES): string {
	return ROUTES[name][vocabulary === 'old' ? 0 : 1];
}

export class StorageError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'StorageError';
		this.status = status;
	}
}

export type StorageResult<T> = { data: T; error: null } | { data: null; error: StorageError };

export interface Space {
	id: string;
	name: string;
	owner: string;
	public: boolean;
	file_size_limit: number | null;
	allowed_mime_types: string[] | null;
	created_at: string;
	updated_at: string;
}

/** @deprecated Since 0.4.0: `Space`. */
export type Bucket = Space;

export interface FileObject {
	name: string;
	id: string | null;
	bucket_id?: string;
	owner?: string;
	updated_at: string | null;
	created_at: string | null;
	last_accessed_at: string | null;
	metadata: Record<string, unknown> | null;
}

/** Image transformation, applied on the way out. */
export interface Transform {
	width?: number;
	height?: number;
	resize?: 'cover' | 'contain' | 'fill';
	quality?: number;
	format?: 'origin';
}

export type Body = Blob | ArrayBuffer | ArrayBufferView | ReadableStream | string | FormData;

export interface UploadOptions {
	/** Seconds a CDN or browser may cache it. Default 3600. */
	cacheControl?: string;
	contentType?: string;
	/** Replace an object already at that path instead of refusing. */
	upsert?: boolean;
	metadata?: Record<string, unknown>;
}

export interface SpaceOptions {
	public?: boolean;
	fileSizeLimit?: number | string | null;
	allowedMimeTypes?: string[] | null;
}

async function send<T>(
	transport: Transport,
	url: string,
	init: { method: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; as?: 'json' | 'blob' }
): Promise<StorageResult<T>> {
	const headers: Record<string, string> = { ...(await transport.headers()), ...init.headers };
	let body: BodyInit | undefined = init.raw;
	if (init.body !== undefined) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(init.body);
	}
	let response: Response;
	try {
		// A stream body has to say it is half-duplex, and only a stream body may.
		const stream = typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
		response = await transport.fetch(url, { method: init.method, headers, body, ...(stream ? { duplex: 'half' } : {}) } as RequestInit);
	} catch (cause) {
		return { data: null, error: new StorageError(cause instanceof Error ? cause.message : String(cause), 0) };
	}
	if (!response.ok) {
		const payload = await readBody(response);
		const status = Number((payload as { statusCode?: string } | null)?.statusCode ?? response.status);
		return { data: null, error: new StorageError(messageOf(payload, `${response.status} ${response.statusText}`), status) };
	}
	if (init.as === 'blob') {
		return { data: (await response.blob()) as T, error: null };
	}
	return { data: (await readBody(response)) as T, error: null };
}

function transformQuery(transform: Transform | undefined): string {
	if (!transform) {
		return '';
	}
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(transform)) {
		if (value !== undefined) {
			params.set(name, String(value));
		}
	}
	return params.toString();
}

function bucketBody(id: string, options: SpaceOptions): Record<string, unknown> {
	return {
		id,
		name: id,
		public: options.public ?? false,
		file_size_limit: options.fileSizeLimit,
		allowed_mime_types: options.allowedMimeTypes
	};
}

export class StorageClient {
	constructor(
		/** @internal */ readonly url: string,
		private readonly transport: Transport,
		private readonly vocabulary: Vocabulary = 'new'
	) {}

	/** @deprecated Since 0.4.0: use `space()`, the same function. Removed in 0.5.0. */
	declare from: StorageClient['space'];
	/** @deprecated Since 0.4.0: use `listSpaces()`, the same function. Removed in 0.5.0. */
	declare listBuckets: StorageClient['listSpaces'];
	/** @deprecated Since 0.4.0: use `getSpace()`, the same function. Removed in 0.5.0. */
	declare getBucket: StorageClient['getSpace'];
	/** @deprecated Since 0.4.0: use `createSpace()`, the same function. Removed in 0.5.0. */
	declare createBucket: StorageClient['createSpace'];
	/** @deprecated Since 0.4.0: use `updateSpace()`, the same function. Removed in 0.5.0. */
	declare updateBucket: StorageClient['updateSpace'];
	/** @deprecated Since 0.4.0: use `emptySpace()`, the same function. Removed in 0.5.0. */
	declare emptyBucket: StorageClient['emptySpace'];
	/** @deprecated Since 0.4.0: use `deleteSpace()`, the same function. Removed in 0.5.0. */
	declare deleteBucket: StorageClient['deleteSpace'];

	private spaceUrl(id?: string, then = ''): string {
		const base = route(this.vocabulary, 'bucket');
		return joinUrl(this.url, id === undefined ? base : `${base}/${encodePath(id)}${then}`);
	}

	/** The files of one space. */
	space(space: string): SpaceClient {
		return new SpaceClient(this.url, space, this.transport, this.vocabulary);
	}

	listSpaces(): Promise<StorageResult<Space[]>> {
		return send(this.transport, this.spaceUrl(), { method: 'GET' });
	}

	getSpace(id: string): Promise<StorageResult<Space>> {
		return send(this.transport, this.spaceUrl(id), { method: 'GET' });
	}

	createSpace(id: string, options: SpaceOptions = {}): Promise<StorageResult<{ name: string }>> {
		return send(this.transport, this.spaceUrl(), { method: 'POST', body: bucketBody(id, options) });
	}

	updateSpace(id: string, options: SpaceOptions): Promise<StorageResult<{ message: string }>> {
		return send(this.transport, this.spaceUrl(id), { method: 'PUT', body: bucketBody(id, options) });
	}

	/** Removes every file in it. The space stays. */
	emptySpace(id: string): Promise<StorageResult<{ message: string }>> {
		return send(this.transport, this.spaceUrl(id, '/empty'), { method: 'POST', body: {} });
	}

	/** A space must be empty to be deleted. */
	deleteSpace(id: string): Promise<StorageResult<{ message: string }>> {
		return send(this.transport, this.spaceUrl(id), { method: 'DELETE', body: {} });
	}
}

/** The files of one space: what `files.space(name)` returns. */
export class SpaceClient {
	constructor(
		private readonly url: string,
		private readonly bucket: string,
		private readonly transport: Transport,
		private readonly vocabulary: Vocabulary = 'new'
	) {}

	/** @deprecated Since 0.4.0: use `put()`, the same function. Removed in 0.5.0. */
	declare upload: SpaceClient['put'];
	/** @deprecated Since 0.4.0: use `get()`, the same function. Removed in 0.5.0. */
	declare download: SpaceClient['get'];
	/** @deprecated Since 0.4.0: use `signedLink()`, the same function. Removed in 0.5.0. */
	declare createSignedUrl: SpaceClient['signedLink'];
	/** @deprecated Since 0.4.0: use `publicLink()`, the same function. Removed in 0.5.0. */
	declare getPublicUrl: SpaceClient['publicLink'];

	private at(name: keyof typeof ROUTES, rest: string): string {
		return joinUrl(this.url, `${route(this.vocabulary, name)}/${rest}`);
	}

	private objectPath(path: string): string {
		return `${encodePath(this.bucket)}/${encodePath(path)}`;
	}

	private write(method: 'POST' | 'PUT', path: string, body: Body, options: UploadOptions): Promise<StorageResult<{ id: string; path: string; fullPath: string }>> {
		const headers: Record<string, string> = {
			'cache-control': `max-age=${options.cacheControl ?? '3600'}`,
			'x-upsert': String(options.upsert ?? false)
		};
		if (!(body instanceof FormData)) {
			headers['content-type'] =
				options.contentType ?? (typeof Blob !== 'undefined' && body instanceof Blob && body.type ? body.type : 'text/plain;charset=UTF-8');
		}
		if (options.metadata) {
			headers['x-metadata'] = btoa(JSON.stringify(options.metadata));
		}
		return send<{ Id: string; Key: string }>(this.transport, this.at('object', this.objectPath(path)), {
			method,
			raw: body as BodyInit,
			headers
		}).then((result) =>
			result.error
				? result
				: { data: { id: result.data.Id, path: path.replace(/^\/+/, ''), fullPath: result.data.Key }, error: null }
		);
	}

	/** Puts a file at `path`. Refuses if something is already there, unless `upsert`. */
	put(path: string, body: Body, options: UploadOptions = {}): Promise<StorageResult<{ id: string; path: string; fullPath: string }>> {
		return this.write('POST', path, body, options);
	}

	/** Replaces the file at `path`. */
	update(path: string, body: Body, options: UploadOptions = {}): Promise<StorageResult<{ id: string; path: string; fullPath: string }>> {
		return this.write('PUT', path, body, options);
	}

	/** The file at `path`, transformed on the way out when `transform` says so. */
	get(path: string, options: { transform?: Transform } = {}): Promise<StorageResult<Blob>> {
		const query = transformQuery(options.transform);
		const url = query ? `${this.at('imageMember', this.objectPath(path))}?${query}` : this.at('object', this.objectPath(path));
		return send(this.transport, url, { method: 'GET', as: 'blob' });
	}

	/** An object's size, type and metadata. */
	info(path: string): Promise<StorageResult<Record<string, unknown>>> {
		return send(this.transport, this.at('info', this.objectPath(path)), { method: 'GET' });
	}

	async exists(path: string): Promise<StorageResult<boolean>> {
		const result = await send(this.transport, this.at('object', this.objectPath(path)), { method: 'HEAD' });
		if (result.error) {
			return result.error.status === 400 || result.error.status === 404 ? { data: false, error: null } : result;
		}
		return { data: true, error: null };
	}

	/** The files directly under `prefix`; folders appear as entries with a null `id`. */
	list(
		prefix = '',
		options: { limit?: number; offset?: number; sortBy?: { column: string; order: 'asc' | 'desc' }; search?: string } = {}
	): Promise<StorageResult<FileObject[]>> {
		return send(this.transport, this.at('list', encodePath(this.bucket)), {
			method: 'POST',
			body: {
				prefix,
				limit: options.limit ?? 100,
				offset: options.offset ?? 0,
				sortBy: options.sortBy ?? { column: 'name', order: 'asc' },
				search: options.search
			}
		});
	}

	remove(paths: string[]): Promise<StorageResult<FileObject[]>> {
		return send(this.transport, this.at('object', encodePath(this.bucket)), { method: 'DELETE', body: { prefixes: paths } });
	}

	move(from: string, to: string, options: { destinationBucket?: string } = {}): Promise<StorageResult<{ message: string }>> {
		return send(this.transport, joinUrl(this.url, route(this.vocabulary, 'move')), {
			method: 'POST',
			body: { bucketId: this.bucket, sourceKey: from, destinationKey: to, destinationBucket: options.destinationBucket }
		});
	}

	copy(from: string, to: string, options: { destinationBucket?: string } = {}): Promise<StorageResult<{ path: string }>> {
		return send<{ Key: string }>(this.transport, joinUrl(this.url, route(this.vocabulary, 'copy')), {
			method: 'POST',
			body: { bucketId: this.bucket, sourceKey: from, destinationKey: to, destinationBucket: options.destinationBucket }
		}).then((result) => (result.error ? result : { data: { path: result.data.Key }, error: null }));
	}

	/**
	 * A URL anyone holding it can read for `expiresIn` seconds. `download` makes the browser
	 * save it (under that name when a string) instead of showing it.
	 */
	async signedLink(
		path: string,
		expiresIn: number,
		options: { download?: string | boolean; transform?: Transform } = {}
	): Promise<StorageResult<{ signedUrl: string }>> {
		const result = await send<{ signedURL: string }>(this.transport, this.at('sign', this.objectPath(path)), {
			method: 'POST',
			body: { expiresIn, transform: options.transform }
		});
		if (result.error) {
			return result;
		}
		return { data: { signedUrl: this.absolute(result.data.signedURL, options.download) }, error: null };
	}

	async createSignedUrls(
		paths: string[],
		expiresIn: number,
		options: { download?: string | boolean } = {}
	): Promise<StorageResult<{ path: string | null; signedUrl: string; error: string | null }[]>> {
		const result = await send<{ path: string | null; signedURL: string | null; error: string | null }[]>(
			this.transport,
			this.at('sign', encodePath(this.bucket)),
			{ method: 'POST', body: { expiresIn, paths } }
		);
		if (result.error) {
			return result;
		}
		return {
			data: result.data.map((entry) => ({
				path: entry.path,
				error: entry.error,
				signedUrl: entry.signedURL ? this.absolute(entry.signedURL, options.download) : ''
			})),
			error: null
		};
	}

	/** A URL a browser can upload to without a session, for two hours. Pair with `uploadToSignedUrl`. */
	async createSignedUploadUrl(path: string, options: { upsert?: boolean } = {}): Promise<StorageResult<{ signedUrl: string; token: string; path: string }>> {
		const result = await send<{ url: string }>(this.transport, this.at('uploadSign', this.objectPath(path)), {
			method: 'POST',
			body: {},
			headers: options.upsert ? { 'x-upsert': 'true' } : {}
		});
		if (result.error) {
			return result;
		}
		const signedUrl = joinUrl(this.url, result.data.url);
		const token = new URL(signedUrl).searchParams.get('token') ?? '';
		return { data: { signedUrl, token, path }, error: null };
	}

	async uploadToSignedUrl(path: string, token: string, body: Body, options: UploadOptions = {}): Promise<StorageResult<{ path: string; fullPath: string }>> {
		const url = new URL(this.at('uploadSign', this.objectPath(path)));
		url.searchParams.set('token', token);
		const headers: Record<string, string> = {
			'cache-control': `max-age=${options.cacheControl ?? '3600'}`,
			'x-upsert': String(options.upsert ?? false)
		};
		if (!(body instanceof FormData)) {
			headers['content-type'] = options.contentType ?? 'text/plain;charset=UTF-8';
		}
		const result = await send<{ Key: string }>(this.transport, url.toString(), { method: 'PUT', raw: body as BodyInit, headers });
		return result.error ? result : { data: { path, fullPath: result.data.Key }, error: null };
	}

	/** The URL of a file in a PUBLIC space. Builds a string; checks nothing. */
	publicLink(path: string, options: { download?: string | boolean; transform?: Transform } = {}): { data: { publicUrl: string } } {
		const query = new URLSearchParams(transformQuery(options.transform));
		if (options.download !== undefined && options.download !== false) {
			query.set('download', options.download === true ? '' : options.download);
		}
		const search = query.toString();
		return { data: { publicUrl: `${this.at(options.transform ? 'imagePublic' : 'public', this.objectPath(path))}${search ? `?${search}` : ''}` } };
	}

	private absolute(signed: string, download: string | boolean | undefined): string {
		const url = new URL(joinUrl(this.url, signed));
		if (download !== undefined && download !== false) {
			url.searchParams.set('download', download === true ? '' : download);
		}
		return url.toString();
	}
}

// The 0.3.x names, each the same function as its new one, kept for 0.4.x.

StorageClient.prototype.from = StorageClient.prototype.space;
StorageClient.prototype.listBuckets = StorageClient.prototype.listSpaces;
StorageClient.prototype.getBucket = StorageClient.prototype.getSpace;
StorageClient.prototype.createBucket = StorageClient.prototype.createSpace;
StorageClient.prototype.updateBucket = StorageClient.prototype.updateSpace;
StorageClient.prototype.emptyBucket = StorageClient.prototype.emptySpace;
StorageClient.prototype.deleteBucket = StorageClient.prototype.deleteSpace;

SpaceClient.prototype.upload = SpaceClient.prototype.put;
SpaceClient.prototype.download = SpaceClient.prototype.get;
SpaceClient.prototype.createSignedUrl = SpaceClient.prototype.signedLink;
SpaceClient.prototype.getPublicUrl = SpaceClient.prototype.publicLink;

/** @deprecated Since 0.4.0: `SpaceClient`, the same class. */
export const BucketClient = SpaceClient;
/** @deprecated Since 0.4.0: `SpaceClient`. */
export type BucketClient = SpaceClient;

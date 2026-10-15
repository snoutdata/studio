/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `@snoutdata/client`: one project's data, identity, files, live topics and functions, from its
 * URL and a key.
 *
 *     import { snout } from '@snoutdata/client'
 *     const db = snout('https://<ref>.api.snoutdata.com', '<app key>')
 *
 * Every product lives under that one URL at a fixed prefix (`/v1/data`, `/v1/identity`,
 * `/v1/files`, `/v1/live`, `/v1/fn`, `/push/v1`). Every request carries the key as `Snout-Key`,
 * and as `Authorization` the signed-in person's access token, or the key itself when nobody is
 * signed in. Row-level security reads that token, which is why the app key is safe in a browser:
 * it grants what your policies grant the app role, and nothing else.
 *
 * A server not yet updated to the new names takes `{ vocabulary: 'old' }`, which speaks the
 * layout 0.3.x spoke (`/rest/v1`, `apikey`, ...) with the same calls.
 */

import { AuthClient, type AuthOptions } from './auth.js';
import { FunctionsClient } from './functions.js';
import { checkSegment, guardRedirects, joinUrl, keyHeader, type Fetch, type Transport, type Vocabulary } from './http.js';
import { RealtimeClient, type ChannelOptions, type RealtimeChannel, type RealtimeOptions, type SendStatus } from './realtime.js';
import { PushClient } from './push.js';
import { procedure, TableBuilder, type CountMethod, type QueryBuilder, type Row } from './rest.js';
import { StorageClient } from './storage.js';
import { VERSION } from './version.js';

export { keyHeader, type Vocabulary } from './http.js';

export * from './auth.js';
export * from './cookies.js';
export * from './functions.js';
export * from './push.js';
export * from './realtime.js';
export * from './rest.js';
export * from './storage.js';

/**
 * The shape `snoutdata gen types typescript` writes. With it, `table('todos')` knows the
 * table's columns; without it, rows are plain records.
 */
export interface Database {
	[schema: string]: {
		Tables: Record<string, { Row: Row; Insert?: Row; Update?: Row }>;
		Views?: Record<string, { Row: Row }>;
		Functions?: Record<string, { Args: Row; Returns: unknown }>;
	};
}

type Schema<DB, S extends string> = DB extends Database ? DB[S] : never;
type Relations<DB, S extends string> = Schema<DB, S> extends never
	? Record<string, { Row: Row }>
	: Schema<DB, S>['Tables'] & NonNullable<Schema<DB, S>['Views']>;
type RelationName<DB, S extends string> = Extract<keyof Relations<DB, S>, string>;
type RowOf<DB, S extends string, N extends string> = N extends keyof Relations<DB, S>
	? Relations<DB, S>[N] extends { Row: infer R }
		? R
		: Row
	: Row;

export interface ClientOptions<S extends string> {
	db?: { schema?: S };
	/** Options for `identity`. */
	auth?: AuthOptions;
	/** Options for `live`. */
	realtime?: RealtimeOptions;
	global?: {
		headers?: Record<string, string>;
		fetch?: Fetch;
	};
	/**
	 * `new` (the default) speaks our own layout: `/v1/data` and its neighbours, the `Snout-Key`
	 * header, the identity server's new routes and fields, and the `live:` wire. `old` speaks
	 * the layout 0.3.x spoke, for a server that has not been updated to the new names yet. The
	 * calls, their options and their results are the same either way.
	 */
	vocabulary?: Vocabulary;
}

/** Each product's prefix, old then new. */
const PREFIXES = {
	data: ['rest/v1', 'v1/data'],
	identity: ['auth/v1', 'v1/identity'],
	files: ['storage/v1', 'v1/files'],
	fn: ['functions/v1', 'v1/fn'],
	live: ['realtime/v1', 'v1/live']
} as const;

export class SnoutClient<DB = Database, S extends string = 'public'> {
	readonly url: string;
	/** Which names this client speaks on the wire. */
	readonly vocabulary: Vocabulary;
	readonly dataUrl: string;
	readonly identityUrl: string;
	readonly filesUrl: string;
	readonly fnUrl: string;
	/** The `wss://` base of `live`. */
	readonly liveUrl: string;
	readonly pushUrl: string;
	/** People, sessions and the token every other product sends. */
	readonly identity: AuthClient;
	/** Files in spaces. */
	readonly files: StorageClient;
	/** Snout Functions. */
	readonly fn: FunctionsClient;
	/** Live topics: signals, the roster and table changes. */
	readonly live: RealtimeClient;
	/** Snout Push: devices, topics, sends and receipts. */
	readonly push: PushClient;
	/** The data API's base, for code that checks where it points. */
	readonly rest: { url: string };
	/** @deprecated Since 0.4.0: `dataUrl`. Removed in 0.5.0. */
	readonly restUrl: string;
	/** @deprecated Since 0.4.0: `identityUrl`. Removed in 0.5.0. */
	readonly authUrl: string;
	/** @deprecated Since 0.4.0: `filesUrl`. Removed in 0.5.0. */
	readonly storageUrl: string;
	/** @deprecated Since 0.4.0: `fnUrl`. Removed in 0.5.0. */
	readonly functionsUrl: string;
	/** @deprecated Since 0.4.0: `liveUrl`. Removed in 0.5.0. */
	readonly realtimeUrl: string;
	/** @deprecated Since 0.4.0: `identity`, the same object. Removed in 0.5.0. */
	readonly auth: AuthClient;
	/** @deprecated Since 0.4.0: `files`, the same object. Removed in 0.5.0. */
	readonly storage: StorageClient;
	/** @deprecated Since 0.4.0: `fn`, the same object. Removed in 0.5.0. */
	readonly functions: FunctionsClient;
	/** @deprecated Since 0.4.0: `live`, the same object. Removed in 0.5.0. */
	readonly realtime: RealtimeClient;
	private readonly transport: Transport;
	private readonly schemaName: string | undefined;

	/** @deprecated Since 0.4.0: use `table()`, the same function. Removed in 0.5.0. */
	declare from: SnoutClient<DB, S>['table'];
	/** @deprecated Since 0.4.0: use `procedure()`, the same function. Removed in 0.5.0. */
	declare rpc: SnoutClient<DB, S>['procedure'];
	/** @deprecated Since 0.4.0: use `live.topic()`, the same function. Removed in 0.5.0. */
	declare channel: (name: string, options?: ChannelOptions) => RealtimeChannel;

	constructor(url: string, appKey: string, options: ClientOptions<S> = {}) {
		if (!url) {
			throw new Error('snout() needs the project URL, https://<ref>.api.snoutdata.com');
		}
		if (!appKey) {
			throw new Error('snout() needs a key: the app key in a browser, the server key on a server');
		}
		const key = appKey;
		const vocabulary: Vocabulary = options.vocabulary === 'old' ? 'old' : 'new';
		const at = (product: keyof typeof PREFIXES): string => PREFIXES[product][vocabulary === 'old' ? 0 : 1];
		const base = new URL(url).toString().replace(/\/+$/, '');
		this.url = base;
		this.vocabulary = vocabulary;
		this.dataUrl = joinUrl(base, at('data'));
		this.identityUrl = joinUrl(base, at('identity'));
		this.filesUrl = joinUrl(base, at('files'));
		this.fnUrl = joinUrl(base, at('fn'));
		this.liveUrl = joinUrl(base.replace(/^http/, 'ws'), at('live'));
		this.pushUrl = joinUrl(base, 'push/v1');
		this.restUrl = this.dataUrl;
		this.authUrl = this.identityUrl;
		this.storageUrl = this.filesUrl;
		this.functionsUrl = this.fnUrl;
		this.realtimeUrl = this.liveUrl;
		this.rest = { url: this.dataUrl };
		this.schemaName = options.db?.schema;

		const fetchImpl: Fetch = guardRedirects(options.global?.fetch ?? ((...args) => fetch(...args)));
		const globalHeaders = { 'X-Client-Info': `snoutdata-js/${VERSION}`, ...options.global?.headers };
		const ref = new URL(base).hostname.split('.')[0];
		this.identity = new AuthClient(this.identityUrl, key, fetchImpl, globalHeaders, ref, options.auth, vocabulary);

		// A caller who set Authorization themselves (a server acting as a known person) keeps it.
		const fixedBearer = Object.keys(globalHeaders).some((name) => name.toLowerCase() === 'authorization');
		this.transport = {
			fetch: fetchImpl,
			headers: async () => ({
				...globalHeaders,
				[keyHeader(vocabulary)]: key,
				...(fixedBearer ? {} : { Authorization: `Bearer ${await this.identity.getAccessToken()}` })
			})
		};

		this.files = new StorageClient(this.filesUrl, this.transport, vocabulary);
		this.fn = new FunctionsClient(this.fnUrl, this.transport);
		this.push = new PushClient(this.pushUrl, this.transport);
		this.live = new RealtimeClient(this.liveUrl, key, this.transport, () => this.identity.getAccessToken(), options.realtime, vocabulary);
		this.auth = this.identity;
		this.storage = this.files;
		this.functions = this.fn;
		this.realtime = this.live;

		this.identity.onSessionChange((event, session) => {
			if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
				this.live.setAuth(session?.access_token ?? null);
			}
		});
	}

	/** A table or view. Awaiting the builder it returns sends the request. */
	table<N extends RelationName<DB, S>>(relation: N): TableBuilder<RowOf<DB, S, N>> {
		return new TableBuilder(this.transport, joinUrl(this.dataUrl, encodeURIComponent(checkSegment(relation))), this.schemaName);
	}

	/** The same client, pointed at another schema (which must be exposed to the data API). */
	schema<T extends string>(name: T): SnoutClient<DB, T> {
		const view = Object.create(this) as SnoutClient<DB, T>;
		Object.defineProperty(view, 'schemaName', { value: name });
		return view;
	}

	/** Calls a Postgres function. Filters and modifiers apply to what it returns: `any` unless typed. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	procedure<T = any>(fn: string, args: Record<string, unknown> = {}, options: { head?: boolean; get?: boolean; count?: CountMethod } = {}): QueryBuilder<T> {
		return procedure<T>(this.transport, this.dataUrl, this.schemaName, fn, args, options);
	}

	getChannels(): RealtimeChannel[] {
		return this.live.getChannels();
	}

	removeChannel(channel: RealtimeChannel): Promise<SendStatus> {
		return this.live.removeChannel(channel);
	}

	removeAllChannels(): Promise<SendStatus[]> {
		return this.live.removeAllChannels();
	}
}

/**
 * A client for one project: its URL, and a key (the app key in a browser, the server key on a
 * server, which must never reach a browser).
 */
export function snout<DB = Database, S extends string = 'public'>(url: string, appKey: string, options: ClientOptions<S> = {}): SnoutClient<DB, S> {
	return new SnoutClient<DB, S>(url, appKey, options);
}

/** @deprecated Since 0.4.0: `snout()`, the same function. Removed in 0.5.0. */
export const createClient = snout;

// The 0.3.x names, each the same function as its new one, kept for 0.4.x.

SnoutClient.prototype.from = SnoutClient.prototype.table;
SnoutClient.prototype.rpc = SnoutClient.prototype.procedure;
SnoutClient.prototype.channel = function channel(this: SnoutClient, name: string, options: ChannelOptions = {}): RealtimeChannel {
	return this.live.topic(name, options);
};

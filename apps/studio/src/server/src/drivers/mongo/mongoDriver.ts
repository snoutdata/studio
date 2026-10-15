/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  MongoDB driver. A document backend: `execute` receives a `mongo`
 *  NativeQuery (an aggregation pipeline) rather than SQL, and introspection is schema-*inferred*
 *  by sampling documents (Mongo is schema-less) rather than read from a catalog. Backed by the
 *  pure-JS `mongodb` client (kept external in esbuild). Writes and structure edits run through
 *  the batch methods below.
 *--------------------------------------------------------------------------------------------*/

import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

import { MongoClient, ObjectId, UUID, type Db, type MongoClientOptions } from 'mongodb';

import type { ConnectionConfig } from '../../../../shared/connection';
import type { ColumnInfo, DatabaseSchema, IndexInfo, TableInfo } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { QueryCancelledError } from '../databaseDriver';
import { inferColumns, type MongoDdl, type MongoWrite, type NativeQuery } from '../../../../shared/engine';
import { openSshTunnel, type SshTunnel } from '../sshTunnel';
import { injectUriPassword, isMongoUri, uriHasUserinfo } from '../../../../shared/connectionUri';

/** How many documents to sample per collection when inferring its field columns. */
const SAMPLE_SIZE = 50;

/** How many collections to introspect / index-list at once. Introspection does a sample read AND an
 *  `.indexes()` per collection; running them serially is slow on a many-collection DB (each pays a
 *  round-trip), so bound-concurrency the work. Bounded, not unbounded, so a
 *  1000-collection database doesn't open 1000 simultaneous cursors. */
const INTROSPECT_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` in flight at once, preserving input order in the
 *  result. A pool of `limit` workers pull from a shared cursor until the list is drained. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = cursor++;
			if (i >= items.length) {
				return;
			}
			results[i] = await fn(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
	return results;
}

/** Build the connection URI + options from a generic ConnectionConfig. If `host` already looks
 *  like a connection string (mongodb:// or mongodb+srv://) it is used as the URI, with the saved
 *  password put back after its user name (main keeps a URI's password in the keychain, not in the
 *  saved URI: shared/connectionUri.ts); otherwise a plain `mongodb://host:port` URI is built and
 *  auth/TLS supplied as options. */
export function buildConnection(config: ConnectionConfig): { uri: string; options: MongoClientOptions; dbName: string } {
	const dbName = config.database || 'test';
	const looksLikeUri = isMongoUri(config.host);
	// A URI that carries a user name owns its credentials; attaching form credentials on top of
	// that makes MongoClient throw on the conflict, so its password goes INTO the URI instead.
	const uriHasCredentials = looksLikeUri && uriHasUserinfo(config.host);
	const options: MongoClientOptions = {};
	if (config.username && !uriHasCredentials) {
		options.auth = { username: config.username, password: config.password ?? '' };
		// Credentials are verified against the working database unless it's a URI carrying its own.
		options.authSource = config.database || 'admin';
	}
	if (config.ssl) {
		options.tls = true;
	}
	if (looksLikeUri) {
		return { uri: uriHasCredentials ? injectUriPassword(config.host, config.password) : config.host, options, dbName };
	}
	const port = config.port || 27017;
	return { uri: `mongodb://${config.host}:${port}`, options, dbName };
}

/** The parsed pieces of a `mongodb://` connection string we need to retarget it at a tunnel. */
interface ParsedMongoUri {
	/** `user:pass` (no trailing `@`), or `''` when the URI carries no credentials. */
	userinfo: string;
	/** The raw host list (`host1:port1,host2:port2,…`) between the authority `@` and the path. */
	hosts: string;
	/** The `/database` path segment (may be empty). */
	pathPart: string;
	/** The `?option=…` query segment including the leading `?` (may be empty). */
	queryPart: string;
}

/** Split a `mongodb://` URI into the parts needed to point it at a loopback tunnel endpoint.
 *  `mongodb+srv://` is rejected: an SRV seedlist resolves its member hosts via DNS that a single
 *  forwarded socket can't reach, so it can't be tunnelled. */
function parseMongoUri(uri: string): ParsedMongoUri {
	if (/^mongodb\+srv:/i.test(uri)) {
		throw new Error('mongodb: a "mongodb+srv://" connection string cannot be used with an SSH tunnel. Use a "mongodb://" URI with an explicit host:port.');
	}
	const match = /^mongodb:\/\/(?:([^@/]*)@)?([^/?]+)(\/[^?]*)?(\?.*)?$/i.exec(uri);
	if (!match) {
		throw new Error('mongodb: could not parse the connection string for tunnelling.');
	}
	return { userinfo: match[1] ?? '', hosts: match[2], pathPart: match[3] ?? '', queryPart: match[4] ?? '' };
}

/** The first host:port of a Mongo seedlist — the endpoint the tunnel forwards to. */
function firstHost(hosts: string): { host: string; port: number } {
	const first = hosts.split(',')[0].trim();
	// IPv6 literals are bracketed (`[::1]:27017`); a port colon only follows the closing `]`.
	const colon = first.lastIndexOf(':');
	if (colon > first.lastIndexOf(']')) {
		return { host: first.slice(0, colon), port: Number(first.slice(colon + 1)) || 27017 };
	}
	return { host: first, port: 27017 };
}

/** Rewrite a `mongodb://` URI to point at the tunnel's loopback endpoint. Collapses the seedlist to
 *  the single tunnelled host and forces `directConnection=true` (dropping any `replicaSet`), so the
 *  driver talks only to the forwarded socket instead of discovering replica-set members by their
 *  private hostnames and dialling those directly (which bypasses the tunnel — the DocumentDB
 *  failure mode). Credentials, database, and other options are preserved. */
function rewriteUriForTunnel(parsed: ParsedMongoUri, localHost: string, localPort: number): string {
	const params = new URLSearchParams(parsed.queryPart.replace(/^\?/, ''));
	// directConnection and replicaSet are mutually exclusive; the driver throws if both are set.
	params.delete('replicaSet');
	params.set('directConnection', 'true');
	const query = params.toString();
	const auth = parsed.userinfo ? `${parsed.userinfo}@` : '';
	return `mongodb://${auth}${localHost}:${localPort}${parsed.pathPart}${query ? `?${query}` : ''}`;
}

/**
 * TLS options for a connection that reaches its server through an SSH tunnel.
 *
 * The driver dials 127.0.0.1, so its own hostname check would compare the certificate against
 * the loopback address and fail. Rather than switch the check off, the certificate is checked
 * against the host the person actually configured (and that name is sent as SNI), so a bastion or
 * anything on the path still cannot present some other valid certificate. Only a connection string
 * that itself says `tlsAllowInvalidHostnames=true` or `tlsInsecure=true` skips it: that is the
 * person's own opt-in, and the driver reads it from the URI.
 */
export function tunnelTlsOptions(uri: string, tlsRequested: boolean, targetHost: string): Pick<MongoClientOptions, 'servername' | 'checkServerIdentity'> {
	const usesTls = tlsRequested || /[?&](tls|ssl)=true/i.test(uri);
	if (!usesTls || /[?&](tlsAllowInvalidHostnames|tlsInsecure)=true/i.test(uri)) {
		return {};
	}
	const host = targetHost.replace(/^\[(.*)\]$/, '$1');
	return {
		...(isIP(host) ? {} : { servername: host }),
		checkServerIdentity: (_dialled, cert) => checkServerIdentity(host, cert),
	};
}

/** A canonical 24-hex-character ObjectId string. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** A canonical hyphenated UUID string (any RFC-4122 variant), e.g. `2b1c3d4e-5f60-4718-9a2b-…`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string that looks like an ObjectId → an ObjectId, a UUID string → a BSON UUID (subtype 4);
 *  anything else unchanged. The heuristic the READ path uses inside operators (`$in`, `$ne`, …):
 *  SQL `WHERE _id = '…'` carries no schema type, and a read whose filter matches nothing is
 *  harmless (an empty grid, never a wrong write). */
function maybeId(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	if (OBJECT_ID_RE.test(value)) {
		return new ObjectId(value);
	}
	if (UUID_RE.test(value)) {
		return new UUID(value);
	}
	return value;
}

/** An explicit `{ $oid: "<hex>" }` Extended-JSON wrapper → an ObjectId, else `undefined`. The
 *  editable grid emits this for true ObjectId `_id` columns (it knows the type from introspection),
 *  so a genuine 24-hex STRING `_id` is never silently coerced to an ObjectId on the write path
 *  (which would match no document and make the edit a silent no-op). */
function unwrapOid(value: unknown): ObjectId | undefined {
	if (value && typeof value === 'object') {
		const entries = Object.entries(value);
		if (entries.length === 1 && entries[0][0] === '$oid' && typeof entries[0][1] === 'string' && OBJECT_ID_RE.test(entries[0][1])) {
			return new ObjectId(entries[0][1]);
		}
	}
	return undefined;
}

/** Revive one scalar `_id` operand value. An explicit `{$oid}` wrapper always wins; otherwise the
 *  bare 24-hex heuristic applies ONLY on the read path (`heuristic` true). Write filters pass
 *  `heuristic` false, so a genuine string `_id` stays a string. */
function reviveIdValue(value: unknown, heuristic: boolean): unknown {
	const oid = unwrapOid(value);
	if (oid) {
		return oid;
	}
	return heuristic ? maybeId(value) : value;
}

/** Revive an `_id` filter operand. The SQL→pipeline compiler emits plain strings (NativeQuery is
 *  JSON), but `_id` keys are ObjectIds in Mongo, so `_id = '6303…'` would match nothing. Convert
 *  the direct form (`'6303…'` / `{$oid}`), list form (`$in: [...]`) and comparison forms (`$ne`,
 *  `$gt`, …). `heuristic` gates the bare-24-hex coercion (on for reads, off for writes). */
function reviveIdOperand(operand: unknown, heuristic: boolean): unknown {
	const direct = unwrapOid(operand);
	if (direct) {
		return direct;
	}
	if (typeof operand === 'string') {
		if (!heuristic) {
			return operand;
		}
		// A UUID `_id`'s storage form is unknowable from SQL (a plain string, or a BSON UUID binary
		// written by another driver), so match EITHER — `_id = '…'` becomes `_id ∈ {string, UUID}`.
		if (UUID_RE.test(operand)) {
			return { $in: [operand, new UUID(operand)] };
		}
		return maybeId(operand);
	}
	if (Array.isArray(operand)) {
		return operand.map((v) => reviveIdValue(v, heuristic));
	}
	if (operand && typeof operand === 'object') {
		const out: Record<string, unknown> = {};
		for (const [op, val] of Object.entries(operand)) {
			out[op] = Array.isArray(val) ? val.map((v) => reviveIdValue(v, heuristic)) : reviveIdValue(val, heuristic);
		}
		return out;
	}
	return operand;
}

/** Walk a pipeline (or any nested value) reviving ObjectId strings bound to an `_id` field. Leaves
 *  every other value untouched, so collections that genuinely use string `_id`s are only affected
 *  when their ids happen to be 24 hex chars (the standard ObjectId heuristic). */
export function reviveObjectIds(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(reviveObjectIds);
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			out[key] = key === '_id' || key.endsWith('._id') ? reviveIdOperand(val, true) : reviveObjectIds(val);
		}
		return out;
	}
	return value;
}

/** Like {@link reviveObjectIds}, but also unwraps the explicit Extended-JSON wrappers the write
 *  builder and the SQL compiler emit — `{ $date }` → Date, `{ $oid }` → ObjectId, `{ $uuid }` → BSON
 *  UUID — for ANY field, not just `_id`. These wrappers are unambiguous: they
 *  are emitted only when introspection says the field IS that type, so they always revive precisely,
 *  with no bare-string guessing. `idHeuristic` gates the SEPARATE bare-24-hex `_id` coercion: on for
 *  reads (SQL text carries no type), off for writes (a wrong guess is a silent no-op edit). */
function reviveTagged(value: unknown, idHeuristic: boolean): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => reviveTagged(item, idHeuristic));
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value);
		if (entries.length === 1 && typeof entries[0][1] === 'string') {
			const [tag, inner] = entries[0] as [string, string];
			if (tag === '$date') {
				return new Date(inner);
			}
			if (tag === '$oid' && OBJECT_ID_RE.test(inner)) {
				return new ObjectId(inner);
			}
			if (tag === '$uuid' && UUID_RE.test(inner)) {
				return new UUID(inner);
			}
		}
		const out: Record<string, unknown> = {};
		for (const [key, val] of entries) {
			out[key] = key === '_id' || key.endsWith('._id') ? reviveIdOperand(val, idHeuristic) : reviveTagged(val, idHeuristic);
		}
		return out;
	}
	return value;
}

/** Revive a write filter / document (NativeQuery can only carry JSON). */
export function reviveWriteValue(value: unknown): unknown {
	return reviveTagged(value, false);
}

/** Revive a read pipeline: the same explicit wrappers (the SQL compiler emits `{$date}`/`{$oid}` for
 *  typed fields, so `created_at > '2024-01-01'` compares against a real Date) PLUS the bare-24-hex
 *  `_id` heuristic, which still covers hand-written pipelines and schema-blind SQL. */
export function reviveReadValue(value: unknown): unknown {
	return reviveTagged(value, true);
}

/** Convert a BSON/JS value into something the JSON-RPC wire can carry and the grid can render.
 *  Leaf BSON types fold to strings/numbers; nested documents/arrays recurse so the grid's cellText can
 *  JSON-stringify them. */
function toWire(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === 'bigint') {
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
	}
	if (typeof value !== 'object') {
		return value;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Buffer.isBuffer(value)) {
		return value;
	}
	const tagged = value as { _bsontype?: string; toString(): string; toJSON?: () => unknown };
	switch (tagged._bsontype) {
		case 'ObjectId':
		case 'Decimal128':
		case 'Long':
		case 'Double':
		case 'Int32':
			return tagged.toString();
		case 'Binary': {
			// A grid cell / tree leaf can't render raw bytes, but the bare `[Binary]` lost the two
			// facts a user actually wants (how big, what kind) — surface subtype + length instead.
			// Subtype 4 is a UUID: show its canonical string.
			const bin = value as { sub_type?: number; length?: () => number; buffer?: { length?: number }; toUUID?: () => { toString(): string } };
			if (bin.sub_type === 4 && typeof bin.toUUID === 'function') {
				try {
					return bin.toUUID().toString();
				} catch {
					// fall through to the size/subtype summary
				}
			}
			const len = typeof bin.length === 'function' ? bin.length() : (bin.buffer?.length ?? 0);
			return `Binary(subtype=${bin.sub_type ?? 0}, ${len} bytes)`;
		}
		default:
			break;
	}
	if (Array.isArray(value)) {
		return value.map(toWire);
	}
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		out[key] = toWire(v);
	}
	return out;
}

/**
 * Every collection an aggregation pipeline reads from: the root plus any secondary collections joined
 * in via `$lookup` / `$graphLookup` (`from`) or appended via `$unionWith` (a bare string or `{ coll }`).
 * These stages carry their own sub-pipelines, which can reference yet more collections, so we recurse.
 * Used to validate a multi-collection query before EXPLAIN, since Mongo silently plans a missing join
 * target as empty rather than erroring. Names are collected in encounter order, de-duplicated.
 */
export function referencedCollections(root: string, pipeline: unknown[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	function add(name: unknown): void {
		if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
	function walk(stages: unknown[]): void {
		for (const stage of stages) {
			if (!stage || typeof stage !== 'object') {
				continue;
			}
			const s = stage as Record<string, unknown>;
			const lookup = (s.$lookup ?? s.$graphLookup) as Record<string, unknown> | undefined;
			if (lookup && typeof lookup === 'object') {
				add(lookup.from);
				if (Array.isArray(lookup.pipeline)) {
					walk(lookup.pipeline);
				}
			}
			const union = s.$unionWith;
			if (typeof union === 'string') {
				add(union);
			} else if (union && typeof union === 'object') {
				const u = union as Record<string, unknown>;
				add(u.coll);
				if (Array.isArray(u.pipeline)) {
					walk(u.pipeline);
				}
			}
			const facet = s.$facet;
			if (facet && typeof facet === 'object') {
				for (const branch of Object.values(facet as Record<string, unknown>)) {
					if (Array.isArray(branch)) {
						walk(branch);
					}
				}
			}
		}
	}
	add(root);
	walk(pipeline);
	return names;
}

class MongoDriver implements DatabaseDriver {
	readonly id = 'mongodb';
	readonly displayName = 'MongoDB';
	readonly kind = 'document' as const;

	private client?: MongoClient;
	private db?: Db;
	private tunnel?: SshTunnel;
	// The aggregate currently running (one at a time per connection), so cancel() can abort it.
	// The mongodb driver honours an AbortSignal on the operation (the document-DB analog of
	// pg_cancel_backend / KILL QUERY), rejecting the in-flight toArray() when we abort.
	private activeQuery?: { abort: AbortController; cancelled: boolean };

	async connect(config: ConnectionConfig): Promise<void> {
		const { uri, options, dbName } = buildConnection(config);
		let finalUri = uri;
		if (config.sshTunnel) {
			// Forward a loopback socket to the URI's real host:port through the bastion, then retarget
			// the URI at that endpoint. TLS certs (DocumentDB's `*.docdb.amazonaws.com`) won't match
			// 127.0.0.1, so the certificate is checked against the configured host instead.
			const parsed = parseMongoUri(uri);
			const target = firstHost(parsed.hosts);
			this.tunnel = await openSshTunnel(config.sshTunnel, target.host, target.port);
			finalUri = rewriteUriForTunnel(parsed, this.tunnel.host, this.tunnel.port);
			Object.assign(options, tunnelTlsOptions(uri, options.tls === true, target.host));
		}
		const client = new MongoClient(finalUri, options);
		// Same reason as the SQL pools: a topology error emitted with no listener is an
		// uncaughtException, and that kills the whole server child rather than this one
		// connection. The driver reconnects on its own; a failed command surfaces per query.
		client.on('error', () => undefined);
		try {
			await client.connect();
			this.client = client;
			this.db = client.db(dbName);
			await this.ping();
		} catch (err) {
			await this.tunnel?.close().catch(() => undefined);
			this.tunnel = undefined;
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		await this.client?.close().catch(() => undefined);
		this.client = undefined;
		this.db = undefined;
		await this.tunnel?.close().catch(() => undefined);
		this.tunnel = undefined;
	}

	isConnected(): boolean {
		return this.db !== undefined;
	}

	async ping(): Promise<void> {
		if (!this.db) {
			throw new Error('mongodb: not connected');
		}
		await this.db.command({ ping: 1 });
	}

	private database(): Db {
		if (!this.db) {
			throw new Error('mongodb: not connected');
		}
		return this.db;
	}

	async introspectSchema(_options?: IntrospectOptions): Promise<DatabaseSchema> {
		const db = this.database();
		const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
			.filter((info) => !info.type || info.type === 'collection' || info.type === 'view');
		// Introspect collections with bounded concurrency — each does a sample
		// read + an index list, so serial is a round-trip per collection.
		const tables = await mapWithConcurrency(collections, INTROSPECT_CONCURRENCY, (info) => {
			// A `$jsonSchema` validator, if any, is the authoritative field schema — prefer it over
			// inference and merge sampled fields on top.
			const jsonSchema = (info.options as { validator?: { $jsonSchema?: Record<string, unknown> } } | undefined)?.validator?.$jsonSchema;
			return this.introspectCollection(info.name, info.type === 'view', jsonSchema);
		});
		tables.sort((a, b) => a.name.localeCompare(b.name));
		return { database: db.databaseName, tables, fetchedAt: Date.now() };
	}

	private async introspectCollection(name: string, isView: boolean, jsonSchema?: Record<string, unknown>): Promise<TableInfo> {
		const db = this.database();
		const coll = db.collection(name);
		// `$sample` draws a random spread instead of the first N docs, so the inferred schema isn't
		// biased to the oldest documents (fields added later only appear in newer ones). Views (and
		// any collection $sample rejects) fall back to the first-N read.
		let sample: Record<string, unknown>[];
		try {
			sample = (await coll.aggregate([{ $sample: { size: SAMPLE_SIZE } }]).toArray()) as Record<string, unknown>[];
		} catch {
			sample = (await coll.find({}, { limit: SAMPLE_SIZE }).toArray()) as Record<string, unknown>[];
		}
		const columns = inferColumns(sample, { jsonSchema });
		let indexes: IndexInfo[] = [];
		try {
			const raw = await coll.indexes();
			indexes = raw
				.filter((ix) => ix.name !== '_id_')
				.map((ix) => ({ name: ix.name ?? '', columns: Object.keys(ix.key ?? {}), unique: ix.unique === true }));
		} catch {
			// A view (or a permissions gap) has no listable indexes; leave it empty.
		}
		return {
			name,
			kind: isView ? 'view' : 'collection',
			columns,
			// Every Mongo document has a unique `_id`; it is the de-facto primary key.
			primaryKey: columns.some((c) => c.name === '_id') ? ['_id'] : [],
			foreignKeys: [],
			indexes,
		};
	}

	/** Cheap fingerprint: collection names + their index signatures. Deliberately excludes the
	 *  sampled fields — Mongo documents vary doc-to-doc, so field drift must NOT trigger a
	 *  re-introspection every poll; only added/dropped collections or indexes count as structure. */
	async structuralDigest(): Promise<string> {
		const db = this.database();
		const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
			.sort((a, b) => a.name.localeCompare(b.name));
		// This runs every 15s poll, so on a many-collection DB the per-collection index list must not
		// be serial — bound-concurrency it like introspection.
		const parts = await mapWithConcurrency(collections, INTROSPECT_CONCURRENCY, async (info) => {
			let idx = '';
			try {
				idx = (await db.collection(info.name).indexes())
					.map((ix) => `${ix.name}:${Object.keys(ix.key ?? {}).join(',')}`)
					.sort()
					.join('|');
			} catch {
				// ignore (view / permissions)
			}
			return `${info.name}#${idx}`;
		});
		return parts.join(';');
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		if (query.lang === 'mongo-write') {
			return this.writeBatch(query.writes);
		}
		if (query.lang === 'mongo-ddl') {
			return this.ddlBatch(query.ops);
		}
		if (query.lang !== 'mongo') {
			throw new Error(`mongodb: cannot execute a '${query.lang}' query.`);
		}
		const db = this.database();
		const start = Date.now();
		// Revive the typed operands the compiler could only send as JSON: explicit `{$date}`/`{$oid}`/
		// `{$uuid}` wrappers anywhere, plus bare ObjectId strings in `_id` filters.
		const pipeline = reviveReadValue(query.pipeline) as object[];
		if (query.explain) {
			// Explain the pipeline: the plan is a nested document the grid shows
			// as one cell and the tree viewer expands. `queryPlanner` verbosity is enough to see which
			// index (if any) the pipeline uses without executing it. Errors surface as-is.
			// Mongo happily explains a non-existent namespace (it plans an EOF/collection-scan rather than
			// erroring), which reads as a meaningless plan in the grid; check first and say so plainly. A
			// multi-collection pipeline ($lookup/$unionWith/etc.) is checked in full, since a missing join
			// target is planned as empty rather than erroring too.
			const referenced = referencedCollections(query.collection, pipeline);
			const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
			const missing = referenced.filter((name) => !present.has(name));
			if (missing.length > 0) {
				const label = missing.length === 1 ? `Collection "${missing[0]}" does not` : `Collections ${missing.map((n) => `"${n}"`).join(', ')} do not`;
				throw new Error(`${label} exist in database "${db.databaseName}".`);
			}
			const plan = await db.collection(query.collection).aggregate(pipeline).explain('queryPlanner');
			return { fields: [{ name: 'explain' }], rows: [[toWire(plan)]], rowCount: 1, durationMs: Date.now() - start };
		}
		// Track this aggregate so cancel() can abort it. The signal is honoured by the driver, so
		// a slow toArray() rejects the moment the user hits Cancel instead of running to completion.
		const entry = { abort: new AbortController(), cancelled: false };
		this.activeQuery = entry;
		try {
			const docs = await db.collection(query.collection).aggregate(pipeline, { signal: entry.abort.signal }).toArray();
			// MongoDB reads a non-existent collection as an empty result (collections are created lazily),
			// which looks identical to a real query that matched nothing. When we get zero docs, check the
			// collection actually exists and say so plainly instead of a silent empty grid.
			if (docs.length === 0) {
				const exists = await db.listCollections({ name: query.collection }, { nameOnly: true }).hasNext();
				if (!exists) {
					throw new Error(`Collection "${query.collection}" does not exist in database "${db.databaseName}".`);
				}
			}
			return { ...toQueryResult(docs), durationMs: Date.now() - start };
		} catch (err) {
			// If we asked to cancel this query, surface it as a cancellation, not the raw abort error.
			if (entry.cancelled) {
				throw new QueryCancelledError();
			}
			throw err;
		} finally {
			if (this.activeQuery === entry) {
				this.activeQuery = undefined;
			}
		}
	}

	/** Run a batch of grid writes one op at a time, returning the total number of
	 *  affected documents as the rowCount. Filters/documents arrive as JSON, so ObjectId `_id`s and
	 *  `$date` values are revived first. Stops at the first failing op (the error surfaces to the
	 *  grid's save dialog); Mongo has no cross-document transaction here, so prior ops have applied. */
	private async writeBatch(writes: MongoWrite[]): Promise<QueryResult> {
		const db = this.database();
		const start = Date.now();
		let affected = 0;
		for (const write of writes) {
			const coll = db.collection(write.collection);
			switch (write.op) {
				case 'updateOne': {
					const res = await coll.updateOne(reviveWriteValue(write.filter) as object, reviveWriteValue(write.update) as object);
					affected += res.modifiedCount;
					break;
				}
				case 'insertOne': {
					await coll.insertOne(reviveWriteValue(write.document) as object);
					affected += 1;
					break;
				}
				case 'insertMany': {
					// `ordered: false` so one bad document (a duplicate _id) doesn't abandon the rest of
					// the batch; the driver reports what it wrote and the run counts that.
					const res = await coll.insertMany(write.documents.map((doc) => reviveWriteValue(doc) as object), { ordered: false });
					affected += res.insertedCount;
					break;
				}
				case 'deleteOne': {
					const res = await coll.deleteOne(reviveWriteValue(write.filter) as object);
					affected += res.deletedCount;
					break;
				}
				// The set-based forms only the SQL compiler emits (`UPDATE`/`DELETE`/`TRUNCATE`), where
				// the statement means every matching document rather than one selected row.
				case 'updateMany': {
					const res = await coll.updateMany(reviveWriteValue(write.filter) as object, reviveWriteValue(write.update) as object);
					affected += res.modifiedCount;
					break;
				}
				case 'deleteMany': {
					const res = await coll.deleteMany(reviveWriteValue(write.filter) as object);
					affected += res.deletedCount;
					break;
				}
			}
		}
		return { fields: [], rows: [], rowCount: affected, durationMs: Date.now() - start };
	}

	/** Run a batch of structure ops one at a time — the document-DB analog of
	 *  DDL. createCollection/dropCollection and createIndex/dropIndex map directly to driver calls;
	 *  there's no affected-row count, so the rowCount stays 0. Stops at the first failing op (the
	 *  error surfaces to the confirm dialog); these are independent operations, not a transaction. */
	private async ddlBatch(ops: MongoDdl[]): Promise<QueryResult> {
		const db = this.database();
		const start = Date.now();
		for (const ddl of ops) {
			switch (ddl.op) {
				case 'createCollection':
					await db.createCollection(ddl.collection);
					break;
				case 'dropCollection':
					await db.collection(ddl.collection).drop();
					break;
				case 'createIndex':
					await db.collection(ddl.collection).createIndex(ddl.keys, {
						...(ddl.name ? { name: ddl.name } : {}),
						...(ddl.unique ? { unique: true } : {}),
					});
					break;
				case 'dropIndex':
					await db.collection(ddl.collection).dropIndex(ddl.name);
					break;
			}
		}
		return { fields: [], rows: [], rowCount: 0, durationMs: Date.now() - start };
	}

	async cancel(): Promise<void> {
		const entry = this.activeQuery;
		if (!entry) {
			return;
		}
		entry.cancelled = true;
		// Abort the in-flight aggregate; its toArray() rejects and execute() maps it to a cancellation.
		entry.abort.abort();
	}
}

/** Flatten result documents into the tabular wire shape: fields = union of top-level keys across
 *  the returned docs (`_id` first), rows aligned to those fields with BSON values made wire-safe. */
function toQueryResult(docs: Record<string, unknown>[]): QueryResult {
	const cols: string[] = [];
	const seen = new Set<string>();
	for (const doc of docs) {
		for (const key of Object.keys(doc)) {
			if (!seen.has(key)) {
				seen.add(key);
				cols.push(key);
			}
		}
	}
	cols.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
	const rows = docs.map((doc) => cols.map((c) => (c in doc ? toWire(doc[c]) : null)));
	return {
		fields: cols.map((name) => ({ name })),
		rows,
		rowCount: rows.length,
		durationMs: 0,
	};
}

export function createMongoDriver(): DatabaseDriver {
	return new MongoDriver();
}

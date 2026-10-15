/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Pinecone driver. A vector backend: `execute` receives a `pinecone`
 *  NativeQuery (a similarity / metadata query) rather than SQL, and "introspection" lists the
 *  project's indexes as pseudo-tables (columns: id, score, values, + sampled metadata fields).
 *  Pure REST over the global `fetch` (no npm client → nothing to externalize in esbuild).
 *
 *  Connection model: the connection is a Pinecone *project*, authed by an API key (the resolved
 *  `password`). The control plane (`api.pinecone.io`) lists/describes indexes; each index carries
 *  its own data-plane `host`, which the driver caches and uses for query/list/fetch/upsert/delete.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../../../shared/connection';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../../shared/schema';
import type { DatabaseDriver, IntrospectOptions, QueryResult } from '../databaseDriver';
import { type NativeQuery, type PineconeQuery, type PineconeWrite } from '../../../../shared/engine';

/** Pinecone control-plane root. The API key is project-scoped; index data hosts come from describe. */
const CONTROL_PLANE = 'https://api.pinecone.io';
/** Default data-plane API version header (overridable via ConnectionConfig.pineconeApiVersion). */
const DEFAULT_API_VERSION = '2024-10';
/** How many vectors to sample per index when inferring its metadata-field columns. */
const SAMPLE_SIZE = 5;
/** Sampling costs a list+fetch per namespace; past this many, expose the base columns only rather
 *  than turning one introspection into hundreds of round-trips. */
const SAMPLE_NAMESPACE_LIMIT = 20;
/** Pinecone's `/vectors/list` returns at most this many ids per page; deeper windows page by token. */
const LIST_PAGE_SIZE = 100;

interface IndexMeta {
	name: string;
	host: string;
	dimension?: number;
	metric?: string;
}

/** One vector as the data plane returns it (query matches and fetch both use this shape). */
interface PineconeVector {
	id: string;
	score?: number;
	values?: number[];
	metadata?: Record<string, unknown>;
}

class PineconeDriver implements DatabaseDriver {
	readonly id = 'pinecone';
	readonly displayName = 'Pinecone';
	readonly kind = 'vector' as const;

	private apiKey?: string;
	private apiVersion = DEFAULT_API_VERSION;
	private connected = false;
	/** index name → metadata (host/dim/metric), refreshed on connect + introspect. */
	private indexes = new Map<string, IndexMeta>();

	async connect(config: ConnectionConfig): Promise<void> {
		const key = config.password?.trim();
		if (!key) {
			throw new Error('pinecone: an API key is required.');
		}
		this.apiKey = key;
		this.apiVersion = config.pineconeApiVersion?.trim() || DEFAULT_API_VERSION;
		await this.refreshIndexes();
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		this.apiKey = undefined;
		this.connected = false;
		this.indexes.clear();
	}

	isConnected(): boolean {
		return this.connected;
	}

	async ping(): Promise<void> {
		await this.refreshIndexes();
	}

	private headers(): Record<string, string> {
		if (!this.apiKey) {
			throw new Error('pinecone: not connected');
		}
		return {
			'content-type': 'application/json',
			'Api-Key': this.apiKey,
			'X-Pinecone-API-Version': this.apiVersion,
		};
	}

	/** List the project's indexes from the control plane and cache each one's data host. */
	private async refreshIndexes(): Promise<IndexMeta[]> {
		const res = await fetch(`${CONTROL_PLANE}/indexes`, { headers: this.headers() });
		if (!res.ok) {
			throw new Error(`pinecone ${res.status}: ${await res.text().catch(() => res.statusText)}`);
		}
		const data = (await res.json()) as { indexes?: { name: string; host: string; dimension?: number; metric?: string }[] };
		const list = (data.indexes ?? []).map((i) => ({ name: i.name, host: i.host, dimension: i.dimension, metric: i.metric }));
		this.indexes = new Map(list.map((i) => [i.name, i]));
		return list;
	}

	private indexMeta(name: string): IndexMeta {
		const meta = this.indexes.get(name);
		if (!meta) {
			throw new Error(`pinecone: unknown index '${name}'. Known indexes: ${[...this.indexes.keys()].join(', ') || '(none)'}.`);
		}
		return meta;
	}

	/** Normalize a data host to a full https origin (the control plane returns it bare). */
	private dataUrl(host: string, path: string): string {
		const origin = /^https?:\/\//i.test(host) ? host : `https://${host}`;
		return `${origin.replace(/\/+$/, '')}${path}`;
	}

	async introspectSchema(_options?: IntrospectOptions): Promise<DatabaseSchema> {
		const list = await this.refreshIndexes();
		const tables: TableInfo[] = [];
		for (const meta of list) {
			// A Pinecone namespace partitions an index the way a schema partitions a database, and a
			// query against the wrong one silently returns nothing — so each namespace is its own
			// pseudo-table (SQL addresses it as `FROM "namespace"."index"`). The default namespace has
			// no name and stays unqualified.
			const namespaces = await this.namespacesOf(meta);
			for (const namespace of namespaces) {
				tables.push(await this.introspectIndex(meta, namespace, namespaces.length <= SAMPLE_NAMESPACE_LIMIT));
			}
		}
		tables.sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name));
		return { database: 'pinecone', tables, fetchedAt: Date.now() };
	}

	/** The namespaces holding vectors in an index, default (`''`) first. Falls back to just the
	 *  default namespace when stats aren't available (permissions, a brand-new index). */
	private async namespacesOf(meta: IndexMeta): Promise<string[]> {
		try {
			const res = await fetch(this.dataUrl(meta.host, '/describe_index_stats'), { method: 'POST', headers: this.headers(), body: '{}' });
			if (!res.ok) {
				return [''];
			}
			const data = (await res.json()) as { namespaces?: Record<string, { vectorCount?: number }> };
			const names = Object.keys(data.namespaces ?? {});
			if (names.length === 0) {
				return [''];
			}
			return names.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
		} catch {
			return [''];
		}
	}

	/** An index (in one namespace) → a pseudo-table: fixed id/score/values columns + metadata fields
	 *  sampled from a few vectors. Sampling failures (empty namespace, permissions) — and an index
	 *  with too many namespaces to sample each — degrade to the base columns only. */
	private async introspectIndex(meta: IndexMeta, namespace: string, sample: boolean): Promise<TableInfo> {
		const metaFields = new Map<string, string>();
		if (sample) {
			try {
				const vectors = await this.browseVectors(meta, SAMPLE_SIZE, 0, namespace || undefined, /*includeValues*/ false);
				for (const v of vectors) {
					for (const [k, val] of Object.entries(v.metadata ?? {})) {
						if (!metaFields.has(k)) {
							metaFields.set(k, jsonType(val));
						}
					}
				}
			} catch {
				// No sample available; expose the base columns only.
			}
		}
		const columns: ColumnInfo[] = [
			{ name: 'id', dataType: 'string', nullable: false, isPrimaryKey: true },
			{ name: 'score', dataType: 'double', nullable: true, isPrimaryKey: false },
			{ name: 'values', dataType: meta.dimension ? `vector(${meta.dimension})` : 'vector', nullable: true, isPrimaryKey: false },
			...[...metaFields].map(([name, dataType]) => ({ name, dataType, nullable: true, isPrimaryKey: false })),
		];
		return { name: meta.name, ...(namespace ? { schema: namespace } : {}), kind: 'index', columns, primaryKey: ['id'], foreignKeys: [], indexes: [] };
	}

	/** Cheap fingerprint: index names + dimensions. (Pinecone has no per-row schema to drift.) */
	async structuralDigest(): Promise<string> {
		const list = await this.refreshIndexes();
		return list
			.map((i) => `${i.name}#${i.dimension ?? ''}:${i.metric ?? ''}`)
			.sort()
			.join(';');
	}

	async execute(query: NativeQuery): Promise<QueryResult> {
		if (query.lang === 'pinecone-write') {
			return this.writeBatch(query.writes);
		}
		if (query.lang !== 'pinecone') {
			throw new Error(`pinecone: cannot execute a '${query.lang}' query.`);
		}
		const start = Date.now();
		const meta = this.indexMeta(query.index);
		const vectors = await this.runQuery(meta, query.query);
		return { ...toQueryResult(vectors), durationMs: Date.now() - start };
	}

	/** Run a read query. A query vector or id → `/query` (similarity). A metadata filter alone →
	 *  `/query` against a zero vector (so Pinecone returns the filter-matching vectors). Neither →
	 *  browse via list + fetch (page the index the way the grid pages a table).
	 *
	 *  `offset` has no API equivalent (Pinecone pages by an opaque token), so a windowed read
	 *  over-fetches `offset + topK` and slices — which is what lets the grid's "Next" work here. */
	private async runQuery(meta: IndexMeta, q: PineconeQuery): Promise<PineconeVector[]> {
		if (q.embedText !== undefined) {
			// Main resolves `similar_to('…')` into a vector before dispatch; reaching the driver with the
			// text still on it would silently run an unfiltered browse and look like a similarity search.
			throw new Error('pinecone: this query needs an embedding model to turn its text into a vector, and none is configured.');
		}
		const offset = Math.max(0, q.offset ?? 0);
		const includeValues = q.includeValues ?? false;
		const includeMetadata = q.includeMetadata ?? true;
		if (q.vector || q.id || q.filter) {
			const body: Record<string, unknown> = {
				topK: q.topK + offset,
				includeMetadata,
				includeValues,
			};
			if (q.namespace) {
				body.namespace = q.namespace;
			}
			if (q.filter) {
				body.filter = q.filter;
			}
			if (q.id) {
				body.id = q.id;
			} else {
				// A filter-only query still needs a vector; a zero vector of the index dimension returns
				// the filter-matching vectors (the score is meaningless, but the rows are correct).
				body.vector = q.vector ?? new Array(meta.dimension ?? 0).fill(0);
			}
			const res = await fetch(this.dataUrl(meta.host, '/query'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
			if (!res.ok) {
				throw new Error(`pinecone ${res.status}: ${await res.text().catch(() => res.statusText)}`);
			}
			const data = (await res.json()) as { matches?: PineconeVector[] };
			return (data.matches ?? []).slice(offset);
		}
		return this.browseVectors(meta, q.topK, offset, q.namespace, includeValues, includeMetadata);
	}

	/** Browse an index: list ids (paging by token past the first 100), then fetch the window's
	 *  values + metadata. */
	private async browseVectors(meta: IndexMeta, limit: number, offset = 0, namespace?: string, includeValues = true, includeMetadata = true): Promise<PineconeVector[]> {
		const wanted = limit + offset;
		const ids: string[] = [];
		let token: string | undefined;
		while (ids.length < wanted) {
			const params = new URLSearchParams({ limit: String(Math.min(LIST_PAGE_SIZE, wanted - ids.length)) });
			if (namespace) {
				params.set('namespace', namespace);
			}
			if (token) {
				params.set('paginationToken', token);
			}
			const listRes = await fetch(this.dataUrl(meta.host, `/vectors/list?${params.toString()}`), { headers: this.headers() });
			if (!listRes.ok) {
				throw new Error(`pinecone ${listRes.status}: ${await listRes.text().catch(() => listRes.statusText)}`);
			}
			const listed = (await listRes.json()) as { vectors?: { id: string }[]; pagination?: { next?: string } };
			const page = (listed.vectors ?? []).map((v) => v.id);
			ids.push(...page);
			token = listed.pagination?.next;
			if (!token || page.length === 0) {
				break;
			}
		}
		const window = ids.slice(offset, offset + limit);
		if (window.length === 0) {
			return [];
		}
		if (!includeValues && !includeMetadata) {
			// The SELECT list asked for ids only, so there is nothing left to fetch.
			return window.map((id) => ({ id }));
		}
		const fetchParams = new URLSearchParams();
		for (const id of window) {
			fetchParams.append('ids', id);
		}
		if (namespace) {
			fetchParams.set('namespace', namespace);
		}
		const fetchRes = await fetch(this.dataUrl(meta.host, `/vectors/fetch?${fetchParams.toString()}`), { headers: this.headers() });
		if (!fetchRes.ok) {
			throw new Error(`pinecone ${fetchRes.status}: ${await fetchRes.text().catch(() => fetchRes.statusText)}`);
		}
		const fetched = (await fetchRes.json()) as { vectors?: Record<string, PineconeVector> };
		return window
			.map((id) => fetched.vectors?.[id])
			.filter((v): v is PineconeVector => v !== undefined)
			.map((v) => ({ ...v, ...(includeValues ? {} : { values: undefined }) }));
	}

	/** Run a batch of vector writes (upsert/delete). Returns the total affected count as rowCount.
	 *  Stops at the first failing op (the error surfaces to the caller); no cross-op transaction. */
	private async writeBatch(writes: PineconeWrite[]): Promise<QueryResult> {
		const start = Date.now();
		let affected = 0;
		for (const write of writes) {
			const meta = this.indexMeta(write.index);
			if (write.op === 'upsert') {
				const body: Record<string, unknown> = { vectors: write.vectors };
				if (write.namespace) {
					body.namespace = write.namespace;
				}
				const res = await fetch(this.dataUrl(meta.host, '/vectors/upsert'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
				if (!res.ok) {
					throw new Error(`pinecone ${res.status}: ${await res.text().catch(() => res.statusText)}`);
				}
				const data = (await res.json()) as { upsertedCount?: number };
				affected += data.upsertedCount ?? write.vectors.length;
			} else {
				const body: Record<string, unknown> = { ids: write.ids };
				if (write.namespace) {
					body.namespace = write.namespace;
				}
				const res = await fetch(this.dataUrl(meta.host, '/vectors/delete'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
				if (!res.ok) {
					throw new Error(`pinecone ${res.status}: ${await res.text().catch(() => res.statusText)}`);
				}
				affected += write.ids.length;
			}
		}
		return { fields: [], rows: [], rowCount: affected, durationMs: Date.now() - start };
	}

	async cancel(): Promise<void> {
		// v1: no cancellation (REST requests aren't tracked for abort here). Matches sqlite/mongo.
	}
}

/** A JSON value → a short type label for the inferred-column `dataType`. */
function jsonType(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'int' : 'double';
	}
	if (typeof value === 'boolean') {
		return 'bool';
	}
	if (typeof value === 'string') {
		return 'string';
	}
	return 'object';
}

/** Flatten query/fetch results into the tabular wire shape: id, score, values, then the union of
 *  metadata keys across the returned vectors. Values/metadata objects JSON-stringify in the grid. */
function toQueryResult(vectors: PineconeVector[]): QueryResult {
	const metaKeys: string[] = [];
	const seen = new Set<string>();
	let anyScore = false;
	for (const v of vectors) {
		if (typeof v.score === 'number') {
			anyScore = true;
		}
		for (const k of Object.keys(v.metadata ?? {})) {
			if (!seen.has(k)) {
				seen.add(k);
				metaKeys.push(k);
			}
		}
	}
	const cols = ['id', ...(anyScore ? ['score'] : []), 'values', ...metaKeys];
	const rows = vectors.map((v) =>
		cols.map((c) => {
			if (c === 'id') {
				return v.id;
			}
			if (c === 'score') {
				return v.score ?? null;
			}
			if (c === 'values') {
				return v.values ?? null;
			}
			return v.metadata && c in v.metadata ? v.metadata[c] : null;
		}),
	);
	return { fields: cols.map((name) => ({ name })), rows, rowCount: rows.length, durationMs: 0 };
}

export function createPineconeDriver(): DatabaseDriver {
	return new PineconeDriver();
}

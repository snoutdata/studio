/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The polyglot core contracts. A connection has one native execution form (`NativeQuery`); the
 *  user authors it through one of several input surfaces (`QueryInput`) that all compile down to
 *  that native form. SQL is the cross-DB lingua franca, native is the full-power escape hatch, NL
 *  is the AI path. Pure types only — no runtime deps — so the renderer, main and server all import
 *  from here.
 *--------------------------------------------------------------------------------------------*/

import { describeLogsQuery, type LogsQuery } from './logs';

/**
 * The execution-model family a driver belongs to. Relational drivers execute SQL; document
 * drivers (MongoDB) execute aggregation pipelines; vector drivers (Pinecone) execute
 * topK/filter queries. Keyed by the `QueryLanguageProfile` registry (src/shared/querylang).
 */
export type BackendKind = 'relational' | 'document' | 'vector' | 'telemetry';

/** Driver ids that are document backends (MongoDB) rather than relational. */
const DOCUMENT_DRIVERS = new Set<string>(['mongodb']);
/** Driver ids that are vector backends (Pinecone). */
const VECTOR_DRIVERS = new Set<string>(['pinecone']);
/**
 * Driver ids that are telemetry backends: a cloud LOG service, whose scopes (a CloudWatch log
 * group, an Azure Monitor table, a GCP log) are presented as pseudo-tables and queried with SQL.
 *
 * These ids are deliberately the `CloudServiceId`s of `src/shared/cloud.ts` rather than vendor
 * names: what a connection is pointed at is a SERVICE, and the credential it uses is a vendor
 * account shared with everything else that vendor serves. One vendor growing a second service is
 * then another driver id here and no change to how accounts work.
 */
const TELEMETRY_DRIVERS = new Set<string>(['cloudwatch', 'azureMonitor', 'gcpLogging']);

/**
 * The backend family a driver id belongs to. The single source main consults to pick the
 * {@link BackendKind} (and thus the QueryLanguageProfile + whether SQL needs transcribing) for a
 * connection — main can't import the server's driver classes, so the mapping lives here and must
 * agree with each driver's own `kind`. Defaults to relational for SQL vendors and unknowns.
 */
export function backendKindForDriver(driverId: string | undefined): BackendKind {
	if (driverId && DOCUMENT_DRIVERS.has(driverId)) {
		return 'document';
	}
	if (driverId && VECTOR_DRIVERS.has(driverId)) {
		return 'vector';
	}
	if (driverId && TELEMETRY_DRIVERS.has(driverId)) {
		return 'telemetry';
	}
	return 'relational';
}

/**
 * The concrete form a driver executes. Discriminated on `lang`. A relational driver only ever
 * receives `{ lang: 'sql' }`; a Mongo driver `{ lang: 'mongo' }`; a Pinecone driver
 * `{ lang: 'pinecone' }`. Transcription (in main) is what turns a non-native surface input
 * into the right variant for the connection's backend.
 */
/**
 * A single MongoDB write operation. The grid's in-place edits compile to a batch of these: a
 * changed cell → `updateOne`, a new row → `insertOne`, a deleted row → `deleteOne`. Filters target
 * a document by its `_id` (Mongo's de-facto primary key); the driver revives ObjectId/`$date`
 * operands before issuing the call. Structural changes (collection/index management) are a separate
 * op family — see {@link MongoDdl}.
 */
export type MongoWrite =
	| { op: 'updateOne'; collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }
	| { op: 'insertOne'; collection: string; document: Record<string, unknown> }
	// The batch form, which only a Data Flow emits: a run writes thousands of documents, and
	// one round-trip per document is the difference between a minute and an hour.
	| { op: 'insertMany'; collection: string; documents: Record<string, unknown>[] }
	| { op: 'deleteOne'; collection: string; filter: Record<string, unknown> }
	// The set-based forms, which only the SQL compiler emits: a SQL `UPDATE`/`DELETE` (and
	// `TRUNCATE`) means "every matching document", not "the one the grid has selected".
	| { op: 'updateMany'; collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }
	| { op: 'deleteMany'; collection: string; filter: Record<string, unknown> };

/**
 * A single MongoDB structure operation — the document-DB analog of DDL. The collection-properties
 * panel issues these to create/drop a collection or create/drop a secondary index. `keys` is a
 * Mongo index spec (`{ field: 1 | -1 }`); an omitted index `name` lets the server auto-name it.
 * Kept distinct from {@link MongoWrite} (data) so a structure change can re-introspect.
 */
export type MongoDdl =
	| { op: 'createCollection'; collection: string }
	| { op: 'dropCollection'; collection: string }
	| { op: 'createIndex'; collection: string; name?: string; keys: Record<string, 1 | -1>; unique?: boolean }
	| { op: 'dropIndex'; collection: string; name: string };

/**
 * The read form a Pinecone (vector) index executes. A similarity search by `vector` (the embedded
 * query text) or by `id` (find vectors near an existing one), optionally narrowed by a metadata
 * `filter` (Mongo-style operators). With neither `vector` nor `id`, the driver browses the index
 * (list + fetch the first `topK` vectors) so the grid can page an index the way it pages a table.
 * `namespace` scopes to a Pinecone namespace (default namespace if omitted).
 */
export interface PineconeQuery {
	vector?: number[];
	id?: string;
	topK: number;
	filter?: object;
	namespace?: string;
	/**
	 * A similarity search whose query VECTOR hasn't been computed yet — the text of a
	 * `similar_to('…')` predicate. Main resolves it through the embeddings model and replaces it
	 * with `vector` before dispatch, so a driver never sees one (it would otherwise silently
	 * degrade to an unfiltered browse).
	 */
	embedText?: string;
	/**
	 * Rows to skip before the returned window. Pinecone's API has no offset (it pages by an opaque
	 * token), so the driver over-fetches `offset + topK` and slices — which is what makes the grid's
	 * "Next" work on a vector index at all. Bounded by the same topK ceiling as any query.
	 */
	offset?: number;
	/** Return the raw vector values. Defaults to false: they're large, and the SELECT list usually
	 *  doesn't ask for them. */
	includeValues?: boolean;
	/** Return metadata fields. Defaults to true. */
	includeMetadata?: boolean;
}

/**
 * A single Pinecone write op — the vector-DB analog of {@link MongoWrite}.
 * `upsert` writes vectors (id + values + optional metadata); `delete` removes them by id. Vector
 * values for an upsert come from the embed capability (text → vector via the gateway).
 */
export type PineconeWrite =
	| { op: 'upsert'; index: string; namespace?: string; vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[] }
	| { op: 'delete'; index: string; namespace?: string; ids: string[] };

export type NativeQuery =
	| {
			lang: 'sql';
			sql: string;
			params?: readonly unknown[];
			/** Ask the DATABASE to refuse writes for this one statement, where the engine can
			 *  (`dialect/readOnly.ts`). Set by main for every run the app labels read-only; the lexical
			 *  guard has already passed it. A driver hands its session back as it found it. */
			readOnly?: boolean;
	  }
	/**
	 * A read of one log scope, in the vendor-neutral structured form every telemetry driver
	 * renders into its own query language ({@link LogsQuery}). What the SQL compiler produces.
	 */
	| {
			lang: 'logs';
			query: LogsQuery;
			/** False when the query's window came from the caller's default rather than from the SQL,
			 *  so the result can say which it was. Absent means the same as false. */
			windowFromSql?: boolean;
	  }
	/**
	 * A log query the user authored in the PROVIDER's own language (Logs Insights, KQL, a GCP
	 * filter), passed through untouched — the native surface's escape hatch, the way a Mongo
	 * connection can be handed a pipeline nobody compiled. The window still rides alongside,
	 * because it is not part of any of those languages and a telemetry query is never unbounded.
	 */
	| { lang: 'logs-native'; scope?: string; text: string; start: number; end: number }
	| { lang: 'mongo'; collection: string; pipeline: object[]; explain?: boolean }
	| { lang: 'mongo-write'; writes: MongoWrite[] }
	| { lang: 'mongo-ddl'; ops: MongoDdl[] }
	| { lang: 'pinecone'; index: string; query: PineconeQuery }
	| { lang: 'pinecone-write'; writes: PineconeWrite[] };

/** The languages a `NativeQuery` can be tagged with — the discriminant values of the union. */
export type NativeQueryLang = NativeQuery['lang'];

/**
 * A human-readable one-line rendering of a {@link NativeQuery}, for the query-history list and the
 * results footer (where a relational run shows its SQL). Mongo renders as the shell call it mirrors
 * (`db.coll.aggregate([...])`); Pinecone as a compact query summary; SQL passes its text through.
 */
export function describeNative(query: NativeQuery): string {
	switch (query.lang) {
		case 'sql':
			return query.sql;
		case 'logs':
			return describeLogsQuery(query.query);
		case 'logs-native':
			// The provider's own text is what the user wrote, so it passes through as SQL does; the
			// window is appended because it is the half of the query their language cannot express.
			return `${query.text.trim()}  [${new Date(query.start).toISOString()} .. ${new Date(query.end).toISOString()})`;
		case 'mongo':
			return `db.${query.collection}.aggregate(${JSON.stringify(query.pipeline)})${query.explain ? '.explain()' : ''}`;
		case 'mongo-write':
			return query.writes.map(describeMongoWrite).join('\n');
		case 'mongo-ddl':
			return query.ops.map(describeMongoDdl).join('\n');
		case 'pinecone':
			return `${query.index}.query(${JSON.stringify(query.query)})`;
		case 'pinecone-write':
			return query.writes.map(describePineconeWrite).join('\n');
	}
}

/** A single Pinecone write as the call it mirrors — the per-op rendering used by the query-history
 *  list (one line per op). `upsert` shows the vector count (values are large + uninteresting). */
export function describePineconeWrite(write: PineconeWrite): string {
	const ns = write.namespace ? `, namespace: "${write.namespace}"` : '';
	switch (write.op) {
		case 'upsert':
			return `${write.index}.upsert(${write.vectors.length} vector${write.vectors.length === 1 ? '' : 's'}${ns})`;
		case 'delete':
			return `${write.index}.delete(${JSON.stringify(write.ids)}${ns})`;
	}
}

/** JSON for a Mongo write preview, rendering our Extended-JSON wrappers as their shell forms
 *  (`{"$oid":"x"}` → `ObjectId("x")`, `{"$date":"x"}` → `ISODate("x")`) so the save dialog and
 *  history read like the mongo shell instead of leaking the wire encoding the driver revives. */
function mongoShellJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/\{"\$oid":"([0-9a-fA-F]{24})"\}/g, 'ObjectId("$1")')
		.replace(/\{"\$date":"([^"\\]+)"\}/g, 'ISODate("$1")');
}

/** A single MongoDB write as the shell call it mirrors — the per-statement rendering used by the
 *  grid's save preview and the query-history list (one line per op). */
export function describeMongoWrite(write: MongoWrite): string {
	switch (write.op) {
		case 'updateOne':
			return `db.${write.collection}.updateOne(${mongoShellJson(write.filter)}, ${mongoShellJson(write.update)})`;
		case 'insertOne':
			return `db.${write.collection}.insertOne(${mongoShellJson(write.document)})`;
		case 'insertMany':
			return `db.${write.collection}.insertMany([${write.documents.length} documents])`;
		case 'deleteOne':
			return `db.${write.collection}.deleteOne(${mongoShellJson(write.filter)})`;
		case 'updateMany':
			return `db.${write.collection}.updateMany(${mongoShellJson(write.filter)}, ${mongoShellJson(write.update)})`;
		case 'deleteMany':
			return `db.${write.collection}.deleteMany(${mongoShellJson(write.filter)})`;
	}
}

/** A single MongoDB structure op as the shell call it mirrors — the per-statement rendering used by
 *  the collection-properties confirm preview and the query-history list (one line per op). */
export function describeMongoDdl(ddl: MongoDdl): string {
	switch (ddl.op) {
		case 'createCollection':
			return `db.createCollection("${ddl.collection}")`;
		case 'dropCollection':
			return `db.${ddl.collection}.drop()`;
		case 'createIndex':
			return `db.${ddl.collection}.createIndex(${JSON.stringify(ddl.keys)}${ddl.unique || ddl.name ? `, ${JSON.stringify({ ...(ddl.name ? { name: ddl.name } : {}), ...(ddl.unique ? { unique: true } : {}) })}` : ''})`;
		case 'dropIndex':
			return `db.${ddl.collection}.dropIndex("${ddl.name}")`;
	}
}

/** How the user authored a query before it became a `NativeQuery`. */
export type QuerySurface = 'sql' | 'native' | 'nl';

/**
 * A surface-tagged query authored by the user, before transcription to a `NativeQuery`.
 * - `sql`    — written in the universal SQL editor (identity-transcribed on a relational backend).
 * - `native` — already a `NativeQuery` (the Mongo pipeline / Pinecone query JSON surface).
 * - `nl`     — natural language handed to the AI transcribe path.
 */
export type QueryInput =
	| { surface: 'sql'; sql: string }
	| { surface: 'native'; native: NativeQuery }
	| { surface: 'nl'; text: string };

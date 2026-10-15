/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Column inference over typed DOCUMENTS (JSON, Mongo): which field paths a sample of documents
 *  has, at what nesting, with which BSON types, merged with a `$jsonSchema` when there is one.
 *
 *  What a document backend's introspection runs (the Mongo driver), so it is the dialect's. Data
 *  Flows' textual inference (over CSV and log records) imports the limits and the container test
 *  from here.
 *
 *  Pure and sample-based: the caller decides how many documents to feed in.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo } from '../../schema';


/** How deep to recurse into subdocuments / arrays-of-subdocuments when inferring nested field
 *  paths. Documents can be arbitrarily deep and uneven, so cap the descent. */
export const MAX_NEST_DEPTH = 6;

/** Hard cap on the total number of inferred field paths per source. A wildly heterogeneous
 *  source (every record a different shape) can otherwise explode the field set; stop adding new
 *  paths past this and let the truncation be visible (the caller shows the columns it got). */
export const MAX_FIELDS = 400;

// --- Structural inference (typed records) --------------------------------------------------

/** Options for {@link inferColumns}. */
export interface InferOptions {
	/** A collection's `$jsonSchema` validator body (`listCollections` → `options.validator.$jsonSchema`).
	 *  When present it is authoritative: declared fields take their declared type and required-ness,
	 *  and sampled-only fields are merged on top. */
	jsonSchema?: Record<string, unknown>;
	/** Recursion depth cap (default {@link MAX_NEST_DEPTH}). */
	maxDepth?: number;
	/** Total field-path cap (default {@link MAX_FIELDS}). */
	maxFields?: number;
}

/** One accumulated field path while inferring columns. */
interface FieldAcc {
	/** BSON type labels observed for this path across sampled docs. */
	types: Set<string>;
	/** How many sampled docs contain this path (per-doc, not per-array-element). */
	present: number;
	/** True for a dotted/bracketed nested path (`address.city`, `items[].sku`), false for a
	 *  top-level key. */
	nested: boolean;
	/** A `$jsonSchema` validator declared this path — its type is authoritative. */
	declared?: boolean;
	/** The validator's declared type label (when {@link declared}). */
	declaredType?: string;
	/** The validator lists this path in its parent's `required` array. */
	required?: boolean;
}

/** A JS/BSON value's short type label. */
function bsonType(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value === 'string') {
		return 'string';
	}
	if (typeof value === 'boolean') {
		return 'bool';
	}
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'int' : 'double';
	}
	if (typeof value === 'bigint') {
		return 'long';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	if (value instanceof Date) {
		return 'date';
	}
	const tagged = value as { _bsontype?: string };
	if (tagged._bsontype) {
		return tagged._bsontype.toLowerCase();
	}
	if (typeof value === 'object') {
		return 'object';
	}
	return 'mixed';
}

/** Whether to recurse into a value: plain objects and arrays yes, leaf BSON types (ObjectId,
 *  Binary, Decimal128 — all `_bsontype`-tagged), Dates and byte buffers no. `ArrayBuffer.isView`
 *  rather than `Buffer.isBuffer` keeps this usable in the renderer, where there is no Buffer. */
export function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	if (value instanceof Date || ArrayBuffer.isView(value)) {
		return false;
	}
	if (typeof (value as { _bsontype?: string })._bsontype === 'string') {
		return false;
	}
	return true;
}

/** Get-or-create a field accumulator, honouring the total-field cap (returns undefined once full,
 *  so the caller skips it rather than growing the set unbounded). */
function ensureField(path: string, nested: boolean, fields: Map<string, FieldAcc>, order: string[], maxFields: number): FieldAcc | undefined {
	let acc = fields.get(path);
	if (!acc) {
		if (fields.size >= maxFields) {
			return undefined;
		}
		acc = { types: new Set(), present: 0, nested };
		fields.set(path, acc);
		order.push(path);
	}
	return acc;
}

/** Walk one document, recording every field path (nested subdocuments and arrays-of-subdocuments
 *  included) into `fields`/`order`. `seen` collects the paths in THIS doc so the caller can bump each
 *  path's `present` count exactly once per document. */
function walkDoc(obj: Record<string, unknown>, prefix: string, depth: number, fields: Map<string, FieldAcc>, order: string[], seen: Set<string>, maxDepth: number, maxFields: number): void {
	for (const [key, value] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const acc = ensureField(path, prefix !== '', fields, order, maxFields);
		if (!acc) {
			continue;
		}
		seen.add(path);
		acc.types.add(bsonType(value));
		if (depth >= maxDepth || !isPlainContainer(value)) {
			continue;
		}
		if (Array.isArray(value)) {
			// The field itself is typed `array` (above); recurse into subdocument ELEMENTS under a
			// `[]` segment so `items: [{ sku }]` yields `items[].sku`. Scalar elements add no paths.
			for (const el of value) {
				if (isPlainContainer(el) && !Array.isArray(el)) {
					walkDoc(el as Record<string, unknown>, `${path}[]`, depth + 1, fields, order, seen, maxDepth, maxFields);
				}
			}
		} else {
			walkDoc(value as Record<string, unknown>, path, depth + 1, fields, order, seen, maxDepth, maxFields);
		}
	}
}

/** A `$jsonSchema` property spec → a short type label, from its `bsonType` (or JSON-Schema `type`).
 *  An array of types (`["string","null"]`) joins with ` | `. */
function jsonSchemaType(spec: Record<string, unknown>): string {
	const bt = spec.bsonType ?? spec.type;
	if (typeof bt === 'string') {
		return bt;
	}
	if (Array.isArray(bt)) {
		const names = bt.filter((t): t is string => typeof t === 'string');
		return names.length > 0 ? names.join(' | ') : 'mixed';
	}
	return 'mixed';
}

/** Seed field accumulators from a `$jsonSchema` validator body: recurse `properties` (and array
 *  element `items.properties`) emitting the same dotted/bracketed paths the sampler does, marking
 *  each declared + required-or-not with its authoritative type. */
function collectJsonSchema(schema: Record<string, unknown>, prefix: string, depth: number, fields: Map<string, FieldAcc>, order: string[], maxDepth: number, maxFields: number): void {
	const props = schema.properties;
	if (!props || typeof props !== 'object') {
		return;
	}
	const required = new Set<string>(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
	for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const spec = raw as Record<string, unknown>;
		const path = prefix ? `${prefix}.${key}` : key;
		const acc = ensureField(path, prefix !== '', fields, order, maxFields);
		if (!acc) {
			continue;
		}
		acc.declared = true;
		acc.declaredType = jsonSchemaType(spec);
		acc.required = required.has(key);
		if (depth >= maxDepth) {
			continue;
		}
		if (spec.properties) {
			collectJsonSchema(spec, path, depth + 1, fields, order, maxDepth, maxFields);
		}
		const items = spec.items;
		if (items && typeof items === 'object' && (items as Record<string, unknown>).properties) {
			collectJsonSchema(items as Record<string, unknown>, `${path}[]`, depth + 1, fields, order, maxDepth, maxFields);
		}
	}
}

/** Infer ordered field columns from sampled documents. Recurses into subdocuments and
 *  arrays-of-subdocuments, emitting dotted/bracketed nested paths (`address.city`, `items[].sku`)
 *  alongside top-level keys, each typed from the values seen and nullable when missing in some docs
 *  or explicitly null. If a `$jsonSchema` validator is supplied it is
 *  authoritative for the fields it declares (type + required-ness), with sampled-only fields merged
 *  on top. Recursion depth and total field count are capped. */
export function inferColumns(docs: Record<string, unknown>[], options: InferOptions = {}): ColumnInfo[] {
	const maxDepth = options.maxDepth ?? MAX_NEST_DEPTH;
	const maxFields = options.maxFields ?? MAX_FIELDS;
	const fields = new Map<string, FieldAcc>();
	const order: string[] = [];
	// Validator first, so declared fields keep authoritative order/type before sampled-only ones.
	if (options.jsonSchema) {
		collectJsonSchema(options.jsonSchema, '', 0, fields, order, maxDepth, maxFields);
	}
	for (const doc of docs) {
		const seen = new Set<string>();
		walkDoc(doc, '', 0, fields, order, seen, maxDepth, maxFields);
		for (const path of seen) {
			fields.get(path)!.present += 1;
		}
	}
	// `_id` first, then discovery order (parents precede their children by construction).
	order.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
	return order.map((name) => {
		const acc = fields.get(name)!;
		const nonNull = [...acc.types].filter((t) => t !== 'null');
		let dataType: string;
		let nullable: boolean;
		if (acc.declared) {
			dataType = acc.declaredType ?? (nonNull.length > 0 ? nonNull.sort().join(' | ') : 'mixed');
			// Required declares not-null; but if some sampled doc still lacks it (legacy data), report
			// nullable — the sample is ground truth over the validator's intent.
			nullable = !acc.required || acc.types.has('null') || (acc.present > 0 && acc.present < docs.length);
		} else {
			dataType = (nonNull.length > 0 ? nonNull : ['null']).sort().join(' | ');
			nullable = acc.types.has('null') || acc.present < docs.length;
		}
		return {
			name,
			dataType,
			nullable,
			isPrimaryKey: name === '_id',
			nested: acc.nested ? true : undefined,
		};
	});
}

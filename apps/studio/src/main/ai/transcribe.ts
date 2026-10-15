/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI transcription — the AI half of the hybrid SQL→native transcriber.
 *  When the deterministic compiler (`sqlToMongo`) rejects a query, the model translates it instead,
 *  grounded in the connection's collections + inferred fields. Pure prompt-build + reply-parse here
 *  (so they're node-testable); AiService owns the provider round-trip. Document (MongoDB) only for
 *  now — vector (Pinecone) would plug in alongside.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSchema } from '../../shared/schema';
import { referencedTables, type NativeQuery } from '../../shared/engine';

/** A user-facing AI-transcription failure (model unavailable, or its output can't be parsed into a
 *  valid pipeline). Surfaced in the results grid as a normal error envelope. */
export class AiTranscribeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AiTranscribeError';
	}
}

/** Hard cap on the collections listed in the transcribe prompt, so a huge database can't blow the
 *  context. Collections whose name appears in the SQL are listed first (they're the ones that
 *  matter); the rest fill the remaining slots. */
const MAX_COLLECTIONS = 40;
/** Per-collection field cap — enough to disambiguate field names without dumping a wide doc. */
const MAX_FIELDS = 30;

/** A compact `collection(field1, field2, …)` grounding block: the collections referenced by the SQL
 *  first (so the relevant ones are always present), then others up to {@link MAX_COLLECTIONS}. */
function schemaBlock(schema: DatabaseSchema | null, sql: string): string {
	if (!schema || schema.tables.length === 0) {
		return 'No schema is available; infer collection and field names from the SQL.';
	}
	const referenced = new Set(referencedTables(sql));
	const ordered = [...schema.tables].sort((a, b) => {
		const ar = referenced.has(a.name.toLowerCase()) ? 0 : 1;
		const br = referenced.has(b.name.toLowerCase()) ? 0 : 1;
		return ar - br || a.name.localeCompare(b.name);
	});
	const lines = ordered.slice(0, MAX_COLLECTIONS).map((t) => {
		const fields = t.columns.slice(0, MAX_FIELDS).map((c) => c.name);
		const more = t.columns.length > MAX_FIELDS ? ', …' : '';
		return `- ${t.name}(${fields.join(', ')}${more})`;
	});
	const omitted = ordered.length - Math.min(ordered.length, MAX_COLLECTIONS);
	if (omitted > 0) {
		lines.push(`- … (${omitted} more collections)`);
	}
	return `Collections in this database (with sampled fields):\n${lines.join('\n')}`;
}

/** Build the system+user messages asking a model to translate SQL into a MongoDB aggregation
 *  pipeline. The reply must be a single JSON object `{ collection, pipeline }` — parsed by
 *  {@link parseMongoPipeline}. Deliberately strict about JSON-only output so the parser is simple. */
export function buildMongoTranscribePrompt(sql: string, schema: DatabaseSchema | null): { system: string; user: string } {
	const system = [
		'You translate a user\'s SQL query into an equivalent MongoDB aggregation pipeline.',
		schemaBlock(schema, sql),
		'Reply with ONLY a single JSON object of the form {"collection": "<name>", "pipeline": [ <stages> ]} and nothing else — no prose, no explanation, no markdown code fences.',
		'"collection" is the collection the pipeline runs against (the SQL\'s primary FROM table). "pipeline" is an array of aggregation stages ($match, $project, $group, $sort, $limit, $skip, $lookup, $unwind, $addFields, $count, etc.).',
		'Use collection and field names exactly as they appear above. Map SQL faithfully: WHERE → $match, GROUP BY + aggregates → $group, ORDER BY → $sort, LIMIT/OFFSET → $limit/$skip, JOIN → $lookup (+ $unwind). Represent values as plain JSON; do not wrap ObjectIds or dates in helper calls.',
	].join('\n\n');
	const user = `Translate this SQL to a MongoDB aggregation pipeline:\n\n${sql.trim()}\n\nReturn only the JSON object.`;
	return { system, user };
}

/** Strip a leading/trailing markdown code fence (```json … ```) the model may add despite the
 *  instruction, and trim to the outermost JSON object/array so trailing prose doesn't break parse. */
function unwrapJson(reply: string): string {
	let text = reply.trim();
	const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```/.exec(text);
	if (fenced) {
		text = fenced[1].trim();
	}
	// Clip to the first {...} object or [...] array span so a "Here is the pipeline:" preface or a
	// trailing sentence doesn't defeat JSON.parse.
	const objStart = text.indexOf('{');
	const arrStart = text.indexOf('[');
	const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
	if (start > 0) {
		const open = text[start];
		const close = open === '{' ? '}' : ']';
		const end = text.lastIndexOf(close);
		if (end > start) {
			text = text.slice(start, end + 1);
		}
	}
	return text;
}

/** True when a value is a plain (non-null, non-array) object — a valid aggregation stage. */
function isStage(value: unknown): value is object {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a model reply into a `{ lang: 'mongo' }` {@link NativeQuery}. Accepts the documented
 * `{ collection, pipeline }` object, or a bare pipeline array (the collection is then taken from the
 * SQL's FROM table). Validates that the pipeline is an array of object stages. Throws
 * {@link AiTranscribeError} on anything malformed so the caller can surface a clean error.
 */
export function parseMongoPipeline(reply: string, sql: string): NativeQuery {
	let parsed: unknown;
	try {
		parsed = JSON.parse(unwrapJson(reply));
	} catch {
		throw new AiTranscribeError('The AI translation could not be parsed as a MongoDB pipeline. Try rephrasing, or author a native aggregation pipeline.');
	}
	let collection: string | undefined;
	let pipeline: unknown;
	if (Array.isArray(parsed)) {
		pipeline = parsed;
	} else if (isStage(parsed)) {
		const obj = parsed as { collection?: unknown; pipeline?: unknown };
		collection = typeof obj.collection === 'string' && obj.collection.trim() ? obj.collection.trim() : undefined;
		pipeline = obj.pipeline;
	} else {
		throw new AiTranscribeError('The AI translation was not a MongoDB pipeline object. Try rephrasing, or author a native aggregation pipeline.');
	}
	if (!collection) {
		// Fall back to the SQL's first FROM table when the model omitted the collection.
		collection = referencedTables(sql)[0];
	}
	if (!collection) {
		throw new AiTranscribeError('Could not determine which collection to query from the AI translation. Author a native aggregation pipeline instead.');
	}
	if (!Array.isArray(pipeline) || !pipeline.every(isStage)) {
		throw new AiTranscribeError('The AI translation did not contain a valid aggregation pipeline (an array of stages). Author a native aggregation pipeline instead.');
	}
	return { lang: 'mongo', collection, pipeline: pipeline as object[] };
}

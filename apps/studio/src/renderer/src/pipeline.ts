/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Native MongoDB aggregation-pipeline surface helpers. Pure + DOM-free so
 *  they're unit-testable with `node --test`: parse/validate the JSON the user authors in the
 *  pipeline editor, the starter template, and the stage-operator list the JSON completion offers.
 *--------------------------------------------------------------------------------------------*/

/** The buffer a fresh native pipeline tab opens with: the simplest useful read. */
export const PIPELINE_TEMPLATE = '[\n\t{ "$match": {} },\n\t{ "$limit": 50 }\n]\n';

/** Aggregation-pipeline stage operators, for the JSON editor's completion. */
export const MONGO_STAGES = [
	'$match', '$project', '$group', '$sort', '$limit', '$skip', '$count', '$unwind', '$lookup',
	'$addFields', '$set', '$unset', '$replaceRoot', '$sortByCount', '$sample', '$facet', '$bucket',
	'$bucketAuto', '$out', '$merge',
];

/**
 * Parse the pipeline-editor text into the aggregation pipeline array, throwing a friendly,
 * user-facing message on any problem (empty, bad JSON, not an array, a non-object stage). The
 * thrown message is shown in the status line / results grid, so it reads like guidance, not a stack.
 */
export function parsePipeline(text: string): object[] {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error('The pipeline is empty. Add at least one stage, e.g. [ { "$match": {} } ].');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error('A pipeline must be a JSON array of stages, e.g. [ { "$match": {} } ].');
	}
	parsed.forEach((stage, i) => {
		if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
			throw new Error(`Stage ${i + 1} must be an object like { "$match": { … } }.`);
		}
	});
	return parsed as object[];
}

/** The inputs of the lightweight find bar — how ~90% of Mongo browsing
 *  actually happens (a filter + projection + sort + limit), between the full-SQL and full-pipeline
 *  extremes. Each field is optional; empty ones drop out of the compiled pipeline. */
export interface FindSpec {
	/** A Mongo query document as JSON text, e.g. `{ "status": "active", "age": { "$gt": 18 } }`. */
	filter?: string;
	/** Comma-separated projection fields. A bare name includes it (`name, email`); a `-` prefix
	 *  excludes it (`-password`). Include and exclude can't mix (except excluding `_id`). */
	project?: string;
	/** Comma-separated sort keys, each `field` or `field:dir` where dir is `1`/`asc` or `-1`/`desc`
	 *  (default ascending), e.g. `createdAt:-1, name`. */
	sort?: string;
	/** Max documents to return. */
	limit?: number;
}

/**
 * Compile a {@link FindSpec} into a find-shaped aggregation pipeline
 * (`[{$match},{$project},{$sort},{$limit}]`), the native form the Mongo driver executes. Empty
 * inputs are omitted; an all-empty spec becomes `[{ $match: {} }]` (browse all). Throws a friendly,
 * user-facing message on a bad filter JSON or an illegal include/exclude projection mix. Pure +
 * DOM-free so it's node-testable.
 */
export function buildFindPipeline(spec: FindSpec): object[] {
	const pipeline: object[] = [];

	const filterText = (spec.filter ?? '').trim();
	if (filterText) {
		let filter: unknown;
		try {
			filter = JSON.parse(filterText);
		} catch (err) {
			throw new Error(`Filter is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
			throw new Error('Filter must be a JSON object, e.g. { "status": "active" }.');
		}
		pipeline.push({ $match: filter });
	}

	const projectText = (spec.project ?? '').trim();
	if (projectText) {
		const project: Record<string, 0 | 1> = {};
		let includes = false;
		let excludes = false; // excluding a field other than _id
		for (const raw of projectText.split(',').map((s) => s.trim()).filter(Boolean)) {
			if (raw.startsWith('-')) {
				const field = raw.slice(1).trim();
				if (field) {
					project[field] = 0;
					if (field !== '_id') {
						excludes = true;
					}
				}
			} else {
				project[raw] = 1;
				includes = true;
			}
		}
		if (includes && excludes) {
			throw new Error('A projection can either include fields or exclude them, not both (only -_id may be excluded alongside includes).');
		}
		if (Object.keys(project).length > 0) {
			pipeline.push({ $project: project });
		}
	}

	const sortText = (spec.sort ?? '').trim();
	if (sortText) {
		const sort: Record<string, 1 | -1> = {};
		for (const part of sortText.split(',').map((s) => s.trim()).filter(Boolean)) {
			const [field, dirRaw] = part.split(':').map((s) => s.trim());
			if (!field) {
				continue;
			}
			const d = (dirRaw ?? '').toLowerCase();
			sort[field] = d === '-1' || d === 'desc' ? -1 : 1;
		}
		if (Object.keys(sort).length > 0) {
			pipeline.push({ $sort: sort });
		}
	}

	if (spec.limit !== undefined && spec.limit > 0) {
		pipeline.push({ $limit: Math.floor(spec.limit) });
	}

	if (pipeline.length === 0) {
		pipeline.push({ $match: {} });
	}
	return pipeline;
}

/** One stage in the visual staged-aggregation builder: the stage operator
 *  (`$match`), the JSON text of its body, and whether it's enabled (a disabled stage is kept for
 *  editing but excluded from the compiled pipeline — the value of a builder over raw JSON). */
export interface BuilderStage {
	operator: string;
	/** The stage body as JSON text (the value the operator maps to). */
	body: string;
	enabled: boolean;
}

/** Split a parsed pipeline into builder stages: each stage object contributes its first key as the
 *  operator and the JSON of its value as the (pretty-printed) body. All start enabled. A stage with
 *  no keys is skipped. */
export function stagesFromPipeline(pipeline: object[]): BuilderStage[] {
	const stages: BuilderStage[] = [];
	for (const stage of pipeline) {
		const keys = Object.keys(stage as Record<string, unknown>);
		if (keys.length === 0) {
			continue;
		}
		const operator = keys[0];
		stages.push({ operator, body: JSON.stringify((stage as Record<string, unknown>)[operator], null, 2), enabled: true });
	}
	return stages;
}

/** Compile the ENABLED builder stages back into a pipeline, parsing each body as JSON. Throws a
 *  friendly, per-stage message on a bad body or a missing operator, so the builder can surface which
 *  stage is wrong. Disabled stages are dropped (that's the point of the toggle). */
export function pipelineFromStages(stages: BuilderStage[]): object[] {
	const pipeline: object[] = [];
	stages.forEach((stage, i) => {
		if (!stage.enabled) {
			return;
		}
		const operator = stage.operator.trim();
		if (!operator) {
			throw new Error(`Stage ${i + 1} has no operator (e.g. $match).`);
		}
		const text = stage.body.trim() || '{}';
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (err) {
			throw new Error(`Stage ${i + 1} (${operator}) body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
		pipeline.push({ [operator]: value });
	});
	return pipeline;
}

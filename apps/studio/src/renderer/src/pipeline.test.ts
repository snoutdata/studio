/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFindPipeline, parsePipeline, pipelineFromStages, PIPELINE_TEMPLATE, stagesFromPipeline } from './pipeline';

test('parsePipeline accepts a valid stage array', () => {
	const pipeline = parsePipeline('[ { "$match": { "active": true } }, { "$limit": 5 } ]');
	assert.deepEqual(pipeline, [{ $match: { active: true } }, { $limit: 5 }]);
});

test('parsePipeline accepts the starter template', () => {
	assert.deepEqual(parsePipeline(PIPELINE_TEMPLATE), [{ $match: {} }, { $limit: 50 }]);
});

test('parsePipeline rejects an empty buffer', () => {
	assert.throws(() => parsePipeline('   '), /empty/i);
});

test('parsePipeline rejects invalid JSON', () => {
	assert.throws(() => parsePipeline('[ { $match: {} } ]'), /invalid json/i);
});

test('parsePipeline rejects a non-array', () => {
	assert.throws(() => parsePipeline('{ "$match": {} }'), /array of stages/i);
});

test('parsePipeline rejects a non-object stage', () => {
	assert.throws(() => parsePipeline('[ 1, 2 ]'), /Stage 1 must be an object/);
});

// buildFindPipeline ------------------------------------------------------

test('buildFindPipeline compiles filter + project + sort + limit in order', () => {
	const p = buildFindPipeline({ filter: '{ "status": "active" }', project: 'name, email, -_id', sort: 'createdAt:-1, name', limit: 25 });
	assert.deepEqual(p, [
		{ $match: { status: 'active' } },
		{ $project: { name: 1, email: 1, _id: 0 } },
		{ $sort: { createdAt: -1, name: 1 } },
		{ $limit: 25 },
	]);
});

test('buildFindPipeline: an all-empty spec browses everything', () => {
	assert.deepEqual(buildFindPipeline({}), [{ $match: {} }]);
});

test('buildFindPipeline: bad filter JSON throws a friendly error', () => {
	assert.throws(() => buildFindPipeline({ filter: '{ status: active }' }), /not valid JSON/i);
});

test('buildFindPipeline: a filter that is not an object is rejected', () => {
	assert.throws(() => buildFindPipeline({ filter: '[1,2]' }), /must be a JSON object/i);
});

test('buildFindPipeline: mixing included and excluded fields is rejected', () => {
	assert.throws(() => buildFindPipeline({ project: 'name, -email' }), /include.*or exclude/i);
});

test('buildFindPipeline: excluding only _id alongside includes is allowed', () => {
	assert.deepEqual(buildFindPipeline({ project: 'name, -_id' }), [{ $project: { name: 1, _id: 0 } }]);
});

test('buildFindPipeline: sort accepts asc/desc words', () => {
	assert.deepEqual(buildFindPipeline({ sort: 'a:asc, b:desc' }), [{ $sort: { a: 1, b: -1 } }]);
});

// Visual builder round-trip ----------------------------------------------

test('stagesFromPipeline / pipelineFromStages round-trip an enabled pipeline', () => {
	const pipeline = [{ $match: { active: true } }, { $sort: { name: 1 } }, { $limit: 10 }];
	const stages = stagesFromPipeline(pipeline);
	assert.equal(stages.length, 3);
	assert.equal(stages[0].operator, '$match');
	assert.deepEqual(pipelineFromStages(stages), pipeline);
});

test('pipelineFromStages drops disabled stages', () => {
	const stages = stagesFromPipeline([{ $match: {} }, { $limit: 5 }]);
	stages[1].enabled = false;
	assert.deepEqual(pipelineFromStages(stages), [{ $match: {} }]);
});

test('pipelineFromStages reports which stage has a bad body', () => {
	const stages = stagesFromPipeline([{ $match: {} }, { $sort: {} }]);
	stages[1].body = '{ bad json';
	assert.throws(() => pipelineFromStages(stages), /Stage 2 \(\$sort\)/);
});

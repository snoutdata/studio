/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AiTranscribeError, buildMongoTranscribePrompt, parseMongoPipeline } from './transcribe';
import type { DatabaseSchema } from '../../shared/schema';

const SCHEMA: DatabaseSchema = {
	database: 'shop',
	fetchedAt: 0,
	tables: [
		{ name: 'orders', kind: 'collection', columns: [{ name: '_id', dataType: 'objectid', nullable: false, isPrimaryKey: true }, { name: 'total', dataType: 'double', nullable: true, isPrimaryKey: false }], primaryKey: ['_id'], foreignKeys: [], indexes: [] },
		{ name: 'users', kind: 'collection', columns: [{ name: '_id', dataType: 'objectid', nullable: false, isPrimaryKey: true }, { name: 'email', dataType: 'string', nullable: true, isPrimaryKey: false }], primaryKey: ['_id'], foreignKeys: [], indexes: [] },
	],
};

test('buildMongoTranscribePrompt grounds in collections referenced by the SQL first', () => {
	const { system, user } = buildMongoTranscribePrompt('SELECT total FROM orders WHERE total > 10', SCHEMA);
	assert.match(system, /aggregation pipeline/i);
	assert.match(system, /- orders\(_id, total\)/);
	// The referenced collection (orders) sorts ahead of users.
	assert.ok(system.indexOf('- orders(') < system.indexOf('- users('));
	assert.match(user, /SELECT total FROM orders/);
});

test('parseMongoPipeline accepts the documented {collection, pipeline} object', () => {
	const q = parseMongoPipeline('{"collection":"orders","pipeline":[{"$match":{"total":{"$gt":10}}}]}', 'SELECT * FROM orders');
	assert.deepEqual(q, { lang: 'mongo', collection: 'orders', pipeline: [{ $match: { total: { $gt: 10 } } }] });
});

test('parseMongoPipeline strips a markdown fence and surrounding prose', () => {
	const reply = 'Here is the pipeline:\n```json\n{"collection":"users","pipeline":[{"$limit":5}]}\n```\nHope that helps!';
	const q = parseMongoPipeline(reply, 'SELECT * FROM users');
	assert.deepEqual(q, { lang: 'mongo', collection: 'users', pipeline: [{ $limit: 5 }] });
});

test('parseMongoPipeline accepts a bare array, taking the collection from the SQL FROM', () => {
	const q = parseMongoPipeline('[{"$match":{"email":"a@b.com"}}]', 'SELECT * FROM users WHERE email = \'a@b.com\'');
	assert.deepEqual(q, { lang: 'mongo', collection: 'users', pipeline: [{ $match: { email: 'a@b.com' } }] });
});

test('parseMongoPipeline rejects unparseable / malformed output', () => {
	assert.throws(() => parseMongoPipeline('I cannot translate that.', 'SELECT * FROM orders'), AiTranscribeError);
	// Pipeline not an array of objects.
	assert.throws(() => parseMongoPipeline('{"collection":"orders","pipeline":"nope"}', 'SELECT * FROM orders'), AiTranscribeError);
	// No collection derivable (bare array + no FROM).
	assert.throws(() => parseMongoPipeline('[{"$limit":1}]', 'no sql here'), AiTranscribeError);
});

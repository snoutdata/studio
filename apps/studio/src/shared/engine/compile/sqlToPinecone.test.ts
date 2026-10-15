/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sqlToPinecone } from './sqlToPinecone';
import { CompileError, UnsupportedQueryError } from './sqlToMongo';
import type { DatabaseSchema } from '../../schema';

/** An index in two namespaces, with typed metadata fields. */
const SCHEMA: DatabaseSchema = {
	database: 'pinecone',
	fetchedAt: 0,
	tables: [
		{
			name: 'docs',
			kind: 'index',
			primaryKey: ['id'],
			foreignKeys: [],
			columns: [
				{ name: 'id', dataType: 'string', nullable: false, isPrimaryKey: true },
				{ name: 'score', dataType: 'double', nullable: true, isPrimaryKey: false },
				{ name: 'values', dataType: 'vector(1536)', nullable: true, isPrimaryKey: false },
				{ name: 'genre', dataType: 'string', nullable: true, isPrimaryKey: false },
				{ name: 'year', dataType: 'int', nullable: true, isPrimaryKey: false },
			],
		},
		{
			name: 'docs',
			schema: 'archive',
			kind: 'index',
			primaryKey: ['id'],
			foreignKeys: [],
			columns: [{ name: 'id', dataType: 'string', nullable: false, isPrimaryKey: true }],
		},
	],
};

test('SELECT * → index with default topK, values and metadata', () => {
	assert.deepEqual(sqlToPinecone('SELECT * FROM docs'), { lang: 'pinecone', index: 'docs', query: { topK: 10, includeValues: true } });
});

test('LIMIT → topK', () => {
	assert.deepEqual(sqlToPinecone('SELECT * FROM docs LIMIT 25').query.topK, 25);
});

test('WHERE equality uses an explicit $eq operator', () => {
	const q = sqlToPinecone("SELECT * FROM docs WHERE genre = 'drama' LIMIT 5");
	assert.deepEqual(q, { lang: 'pinecone', index: 'docs', query: { topK: 5, filter: { genre: { $eq: 'drama' } }, includeValues: true } });
});

test('WHERE operators map to Pinecone filter operators', () => {
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE year > 2000').query.filter, { year: { $gt: 2000 } });
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE year <= 2000').query.filter, { year: { $lte: 2000 } });
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE n <> 1').query.filter, { n: { $ne: 1 } });
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE g IN (1,2,3)').query.filter, { g: { $in: [1, 2, 3] } });
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE g NOT IN (1,2)').query.filter, { g: { $nin: [1, 2] } });
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE year BETWEEN 1990 AND 2000').query.filter, { year: { $gte: 1990, $lte: 2000 } });
});

test('IS [NOT] NULL maps to $exists presence', () => {
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE a IS NULL').query.filter, { a: { $exists: false } });
	assert.deepEqual(sqlToPinecone('SELECT * FROM d WHERE a IS NOT NULL').query.filter, { a: { $exists: true } });
});

test('AND/OR nest into $and/$or', () => {
	const q = sqlToPinecone("SELECT * FROM d WHERE year >= 2000 AND genre = 'drama'");
	assert.deepEqual(q.query.filter, { $and: [{ year: { $gte: 2000 } }, { genre: { $eq: 'drama' } }] });
	const o = sqlToPinecone("SELECT * FROM d WHERE genre = 'a' OR genre = 'b'");
	assert.deepEqual(o.query.filter, { $or: [{ genre: { $eq: 'a' } }, { genre: { $eq: 'b' } }] });
});

// `similar_to('…')` is the SQL spelling of a similarity search. It compiles to the query TEXT;
// main turns it into a vector through the embeddings model just before dispatch.
test("similar_to('text') carries the text to embed", () => {
	const q = sqlToPinecone("SELECT * FROM docs WHERE similar_to('a happy dog') LIMIT 5");
	assert.deepEqual(q.query, { topK: 5, embedText: 'a happy dog', includeValues: true });
	// It composes with a metadata filter.
	const both = sqlToPinecone("SELECT * FROM docs WHERE similar_to('dogs') AND genre = 'drama'");
	assert.deepEqual(both.query.filter, { genre: { $eq: 'drama' } });
	assert.equal(both.query.embedText, 'dogs');
	assert.throws(() => sqlToPinecone("SELECT * FROM docs WHERE similar_to('a') AND similar_to('b')"), CompileError);
	assert.throws(() => sqlToPinecone('SELECT * FROM docs WHERE similar_to(1)'), CompileError);
});

// `id` is a pseudo-column, not metadata: filtering on it used to build a metadata filter for a
// field that doesn't exist, so the query silently returned nothing.
test('`id =` is a lookup by vector id, not a metadata filter', () => {
	const q = sqlToPinecone("SELECT * FROM docs WHERE id = 'vec-1'");
	assert.equal(q.query.id, 'vec-1');
	assert.equal(q.query.filter, undefined);
	assert.throws(() => sqlToPinecone("SELECT * FROM docs WHERE id > 'a'"), CompileError);
	assert.throws(() => sqlToPinecone("SELECT * FROM docs WHERE id = 'a' AND similar_to('b')"), CompileError);
	// score/values can't be filtered at all.
	assert.throws(() => sqlToPinecone('SELECT * FROM docs WHERE score > 0.5'), CompileError);
	assert.throws(() => sqlToPinecone('SELECT * FROM docs WHERE values IS NOT NULL'), CompileError);
});

// A namespace partitions an index; querying the wrong one returns nothing at all.
test('a schema qualifier is the namespace', () => {
	const q = sqlToPinecone('SELECT * FROM archive.docs', { schema: SCHEMA });
	assert.equal(q.query.namespace, 'archive');
	assert.equal(q.index, 'docs');
	assert.equal(sqlToPinecone('SELECT * FROM docs', { schema: SCHEMA }).query.namespace, undefined);
});

test('the SELECT list decides whether vector values are fetched', () => {
	// Metadata only: no 1536-float vector per row.
	assert.deepEqual(sqlToPinecone('SELECT id, genre FROM docs').query, { topK: 10 });
	assert.deepEqual(sqlToPinecone('SELECT id, values FROM docs').query, { topK: 10, includeValues: true, includeMetadata: false });
	assert.deepEqual(sqlToPinecone('SELECT id FROM docs').query, { topK: 10, includeMetadata: false });
});

// Pinecone's API has no OFFSET; the driver walks continuation tokens and slices, which is what
// makes the grid's "Next" work on an index.
test('OFFSET compiles to a windowed query', () => {
	assert.deepEqual(sqlToPinecone('SELECT * FROM docs LIMIT 10 OFFSET 20').query, { topK: 10, offset: 20, includeValues: true });
});

test('ORDER BY score is accepted as the no-op it is; anything else is not', () => {
	assert.doesNotThrow(() => sqlToPinecone('SELECT * FROM docs ORDER BY score DESC'));
	assert.throws(() => sqlToPinecone('SELECT * FROM docs ORDER BY score ASC'), UnsupportedQueryError);
	assert.throws(() => sqlToPinecone('SELECT * FROM d ORDER BY year DESC'), UnsupportedQueryError);
});

test('topK is bounded, and an unknown index/field is a hard error', () => {
	assert.throws(() => sqlToPinecone('SELECT * FROM docs LIMIT 50000'), CompileError);
	assert.throws(() => sqlToPinecone('SELECT * FROM nope', { schema: SCHEMA }), CompileError);
	assert.throws(() => sqlToPinecone('SELECT * FROM docs WHERE nope = 1', { schema: SCHEMA }), CompileError);
	// Pinecone can only order numbers.
	assert.throws(() => sqlToPinecone("SELECT * FROM docs WHERE genre > 'a'", { schema: SCHEMA }), CompileError);
});

test('rejects the constructs Pinecone cannot represent', () => {
	assert.throws(() => sqlToPinecone('SELECT * FROM a JOIN b ON a.id = b.id'), UnsupportedQueryError);
	assert.throws(() => sqlToPinecone('SELECT count(*) FROM d GROUP BY genre'), UnsupportedQueryError);
	assert.throws(() => sqlToPinecone("SELECT * FROM d WHERE name LIKE 'foo%'"), UnsupportedQueryError);
	assert.throws(() => sqlToPinecone('UPDATE d SET a = 1'), UnsupportedQueryError);
	assert.throws(() => sqlToPinecone('SELECT * FROM a UNION SELECT * FROM b'), UnsupportedQueryError);
});

test('a metadata field starting with "$" is refused rather than becoming a filter operator', () => {
	assert.throws(() => sqlToPinecone(`SELECT * FROM idx WHERE "$or" = 1`), CompileError);
	assert.throws(() => sqlToPinecone(`SELECT * FROM idx WHERE "$ne" = 'x'`), CompileError);
});

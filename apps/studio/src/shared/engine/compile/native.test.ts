/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backendKindForDriver, describeMongoDdl, describeMongoWrite, describeNative, describePineconeWrite } from './native';

test('backendKindForDriver maps document/vector drivers, defaults relational', () => {
	assert.equal(backendKindForDriver('mongodb'), 'document');
	assert.equal(backendKindForDriver('pinecone'), 'vector');
	assert.equal(backendKindForDriver('postgres'), 'relational');
	assert.equal(backendKindForDriver(undefined), 'relational');
});

test('describeNative passes SQL text through unchanged', () => {
	assert.equal(describeNative({ lang: 'sql', sql: 'SELECT * FROM users WHERE id = 1' }), 'SELECT * FROM users WHERE id = 1');
});

test('describeNative renders a mongo read as the aggregate shell call', () => {
	assert.equal(
		describeNative({ lang: 'mongo', collection: 'orders', pipeline: [{ $match: { paid: true } }, { $limit: 50 }] }),
		'db.orders.aggregate([{"$match":{"paid":true}},{"$limit":50}])',
	);
});

test('describeMongoWrite renders each data op as its shell call', () => {
	assert.equal(
		describeMongoWrite({ op: 'updateOne', collection: 'users', filter: { _id: 7 }, update: { $set: { name: 'Ada' } } }),
		'db.users.updateOne({"_id":7}, {"$set":{"name":"Ada"}})',
	);
	assert.equal(
		describeMongoWrite({ op: 'insertOne', collection: 'users', document: { name: 'Ada' } }),
		'db.users.insertOne({"name":"Ada"})',
	);
	assert.equal(describeMongoWrite({ op: 'deleteOne', collection: 'users', filter: { _id: 7 } }), 'db.users.deleteOne({"_id":7})');
});

test('describeMongoWrite renders $oid/$date wrappers in shell form, not raw JSON', () => {
	assert.equal(
		describeMongoWrite({ op: 'deleteOne', collection: 'users', filter: { _id: { $oid: '6303a1b2c3d4e5f600112233' } } }),
		'db.users.deleteOne({"_id":ObjectId("6303a1b2c3d4e5f600112233")})',
	);
	assert.equal(
		describeMongoWrite({ op: 'updateOne', collection: 'users', filter: { _id: 1 }, update: { $set: { seen: { $date: '2026-06-20T00:00:00.000Z' } } } }),
		'db.users.updateOne({"_id":1}, {"$set":{"seen":ISODate("2026-06-20T00:00:00.000Z")}})',
	);
});

test('describeNative renders a mongo-write batch one op per line', () => {
	assert.equal(
		describeNative({
			lang: 'mongo-write',
			writes: [
				{ op: 'insertOne', collection: 'users', document: { name: 'Ada' } },
				{ op: 'deleteOne', collection: 'users', filter: { _id: 7 } },
			],
		}),
		'db.users.insertOne({"name":"Ada"})\ndb.users.deleteOne({"_id":7})',
	);
});

test('describeMongoDdl renders each structure op as its shell call', () => {
	assert.equal(describeMongoDdl({ op: 'createCollection', collection: 'orders' }), 'db.createCollection("orders")');
	assert.equal(describeMongoDdl({ op: 'dropCollection', collection: 'orders' }), 'db.orders.drop()');
	assert.equal(describeMongoDdl({ op: 'dropIndex', collection: 'orders', name: 'email_idx' }), 'db.orders.dropIndex("email_idx")');
});

test('describeMongoDdl createIndex includes name/unique options only when set', () => {
	assert.equal(
		describeMongoDdl({ op: 'createIndex', collection: 'users', keys: { email: 1 } }),
		'db.users.createIndex({"email":1})',
	);
	assert.equal(
		describeMongoDdl({ op: 'createIndex', collection: 'users', name: 'email_idx', keys: { email: 1 }, unique: true }),
		'db.users.createIndex({"email":1}, {"name":"email_idx","unique":true})',
	);
});

test('describeNative renders a mongo-ddl batch one op per line', () => {
	assert.equal(
		describeNative({ lang: 'mongo-ddl', ops: [{ op: 'createCollection', collection: 'a' }, { op: 'dropCollection', collection: 'b' }] }),
		'db.createCollection("a")\ndb.b.drop()',
	);
});

test('describeNative renders a pinecone read query', () => {
	assert.equal(
		describeNative({ lang: 'pinecone', index: 'docs', query: { topK: 5, filter: { genre: { $eq: 'drama' } } } }),
		'docs.query({"topK":5,"filter":{"genre":{"$eq":"drama"}}})',
	);
});

test('describePineconeWrite renders upsert by count and delete by ids', () => {
	assert.equal(describePineconeWrite({ op: 'upsert', index: 'docs', vectors: [{ id: 'a', values: [0.1, 0.2] }] }), 'docs.upsert(1 vector)');
	assert.equal(
		describePineconeWrite({ op: 'upsert', index: 'docs', namespace: 'ns1', vectors: [{ id: 'a', values: [] }, { id: 'b', values: [] }] }),
		'docs.upsert(2 vectors, namespace: "ns1")',
	);
	assert.equal(describePineconeWrite({ op: 'delete', index: 'docs', ids: ['a', 'b'] }), 'docs.delete(["a","b"])');
});

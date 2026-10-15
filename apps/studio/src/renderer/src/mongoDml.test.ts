/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { QueryField } from '../../shared/query';
import type { TableInfo } from '../../shared/schema';
import { type MongoWrite } from '../../shared/engine';
import { NULL_VALUE, type RowInsert, type RowUpdate } from './dml';
import { buildDocumentUpdate, buildMongoWrites } from './mongoDml';

// A collection introspected MongoDB-style: `_id` first, inferred BSON types.
const COLL: TableInfo = {
	name: 'users',
	kind: 'collection',
	columns: [
		{ name: '_id', dataType: 'objectid', nullable: false, isPrimaryKey: true },
		{ name: 'name', dataType: 'string', nullable: true, isPrimaryKey: false },
		{ name: 'age', dataType: 'int', nullable: true, isPrimaryKey: false },
		{ name: 'active', dataType: 'bool', nullable: true, isPrimaryKey: false },
		{ name: 'score', dataType: 'double', nullable: true, isPrimaryKey: false },
	],
	primaryKey: ['_id'],
	foreignKeys: [],
};

const FIELDS: QueryField[] = [{ name: '_id' }, { name: 'name' }, { name: 'age' }, { name: 'active' }, { name: 'score' }];
const ID = '6303a1b2c3d4e5f600112233';

function writes(result: { writes: MongoWrite[] } | { error: string }): MongoWrite[] {
	if ('error' in result) {
		throw new Error(`expected writes, got error: ${result.error}`);
	}
	return result.writes;
}

describe('buildMongoWrites — updates', () => {
	test('a changed cell → updateOne keyed on _id with $set, typed by column', () => {
		const update: RowUpdate = { original: [ID, 'Ann', 30, true, 1.5], set: new Map([[2, '31'], [1, 'Bea']]) };
		const out = writes(buildMongoWrites({ table: COLL, fields: FIELDS, updates: [update], deletes: [], inserts: [] }));
		assert.deepEqual(out, [
			{ op: 'updateOne', collection: 'users', filter: { _id: { $oid: ID } }, update: { $set: { name: 'Bea', age: 31 } } },
		]);
	});

	test('NULL expr writes a real null; "current time" writes a $date wrapper', () => {
		const update: RowUpdate = { original: [ID, 'Ann', 30, true, 1.5], set: new Map([[1, NULL_VALUE], [4, { sql: 'CURRENT_TIMESTAMP', display: '(current time)' }]]) };
		const out = writes(buildMongoWrites({ table: COLL, fields: FIELDS, updates: [update], deletes: [], inserts: [] }));
		const set = (out[0] as Extract<MongoWrite, { op: 'updateOne' }>).update.$set as Record<string, unknown>;
		assert.equal(set.name, null);
		assert.ok(set.score && typeof set.score === 'object' && '$date' in (set.score as object));
	});

	test('boolean and numeric strings coerce to primitives', () => {
		const update: RowUpdate = { original: [ID, 'Ann', 30, true, 1.5], set: new Map([[3, 'false'], [4, '2.75']]) };
		const out = writes(buildMongoWrites({ table: COLL, fields: FIELDS, updates: [update], deletes: [], inserts: [] }));
		const set = (out[0] as Extract<MongoWrite, { op: 'updateOne' }>).update.$set as Record<string, unknown>;
		assert.equal(set.active, false);
		assert.equal(set.score, 2.75);
	});
});

describe('buildMongoWrites — deletes & inserts', () => {
	test('a deleted row → deleteOne keyed on _id (ObjectId column → explicit $oid wrapper)', () => {
		const out = writes(buildMongoWrites({ table: COLL, fields: FIELDS, updates: [], deletes: [[ID, 'Ann', 30, true, 1.5]], inserts: [] }));
		assert.deepEqual(out, [{ op: 'deleteOne', collection: 'users', filter: { _id: { $oid: ID } } }]);
	});

	test('a new row → insertOne of only the filled fields (no _id, Mongo generates it)', () => {
		const insert: RowInsert = { values: new Map([[1, 'Cy'], [2, '22']]) };
		const out = writes(buildMongoWrites({ table: COLL, fields: FIELDS, updates: [], deletes: [], inserts: [insert] }));
		assert.deepEqual(out, [{ op: 'insertOne', collection: 'users', document: { name: 'Cy', age: 22 } }]);
	});
});

describe('buildMongoWrites — _id type targeting', () => {
	// The fix for the silent no-op write: a collection whose `_id` is a real STRING (that happens to
	// be 24 hex chars) must NOT get the $oid wrapper, or the driver would coerce it to an ObjectId
	// and the filter would match no document.
	const STRING_ID_COLL: TableInfo = { ...COLL, columns: [{ name: '_id', dataType: 'string', nullable: false, isPrimaryKey: true }, ...COLL.columns.slice(1)] };

	test('a string _id that looks like 24 hex stays a bare string (no $oid coercion)', () => {
		const out = writes(buildMongoWrites({ table: STRING_ID_COLL, fields: FIELDS, updates: [], deletes: [[ID, 'Ann', 30, true, 1.5]], inserts: [] }));
		assert.deepEqual(out, [{ op: 'deleteOne', collection: 'users', filter: { _id: ID } }]);
	});

	test('an ObjectId column with a non-hex _id value is left bare (only true hex wraps)', () => {
		const out = writes(buildMongoWrites({ table: COLL, fields: FIELDS, updates: [], deletes: [['not-a-hex-id', 'Ann', 30, true, 1.5]], inserts: [] }));
		assert.deepEqual(out, [{ op: 'deleteOne', collection: 'users', filter: { _id: 'not-a-hex-id' } }]);
	});

	test('a numeric _id is passed through unchanged', () => {
		const numColl: TableInfo = { ...COLL, columns: [{ name: '_id', dataType: 'int', nullable: false, isPrimaryKey: true }, ...COLL.columns.slice(1)] };
		const out = writes(buildMongoWrites({ table: numColl, fields: FIELDS, updates: [], deletes: [[42, 'Ann', 30, true, 1.5]], inserts: [] }));
		assert.deepEqual(out, [{ op: 'deleteOne', collection: 'users', filter: { _id: 42 } }]);
	});
});

describe('buildDocumentUpdate — nested tree edits (Tier 1)', () => {
	// A collection with nested + array-of-subdoc + date fields, introspected as dotted paths.
	const NESTED: TableInfo = {
		name: 'orders',
		kind: 'collection',
		columns: [
			{ name: '_id', dataType: 'objectid', nullable: false, isPrimaryKey: true },
			{ name: 'user', dataType: 'object', nullable: true, isPrimaryKey: false },
			{ name: 'user.name', dataType: 'string', nullable: true, isPrimaryKey: false, nested: true },
			{ name: 'user.address.zip', dataType: 'int', nullable: true, isPrimaryKey: false, nested: true },
			{ name: 'items', dataType: 'array', nullable: true, isPrimaryKey: false },
			{ name: 'items[].sku', dataType: 'string', nullable: true, isPrimaryKey: false, nested: true },
			{ name: 'items[].price', dataType: 'double', nullable: true, isPrimaryKey: false, nested: true },
			{ name: 'placedAt', dataType: 'date', nullable: true, isPrimaryKey: false },
		],
		primaryKey: ['_id'],
		foreignKeys: [],
	};
	const DOC = { _id: ID, user: { name: 'Ann', address: { zip: 10001 } }, items: [{ sku: 'a', price: 1.5 }], placedAt: '2026-01-01T00:00:00.000Z' };

	function update(result: { write: MongoWrite } | { error: string }): Extract<MongoWrite, { op: 'updateOne' }> {
		if ('error' in result) {
			throw new Error(`expected a write, got error: ${result.error}`);
		}
		return result.write as Extract<MongoWrite, { op: 'updateOne' }>;
	}

	test('a nested leaf edit → a correctly-pathed, type-coerced $set (keyed on _id)', () => {
		const w = update(buildDocumentUpdate({ table: NESTED, document: DOC, edits: [{ path: 'user.name', value: 'Bea' }, { path: 'user.address.zip', value: '20002' }] }));
		assert.deepEqual(w.filter, { _id: { $oid: ID } });
		assert.deepEqual(w.update.$set, { 'user.name': 'Bea', 'user.address.zip': 20002 });
	});

	test('an array-element edit collapses its index to `[]` for the type lookup', () => {
		const w = update(buildDocumentUpdate({ table: NESTED, document: DOC, edits: [{ path: 'items.0.price', value: '9.99' }] }));
		// `items.0.price` → typed via `items[].price` (double) → number; the concrete path is kept.
		assert.deepEqual(w.update.$set, { 'items.0.price': 9.99 });
	});

	test('a date-typed field writes a real Date via the $date wrapper', () => {
		const w = update(buildDocumentUpdate({ table: NESTED, document: DOC, edits: [{ path: 'placedAt', value: '2026-06-20T12:00:00Z' }] }));
		const set = w.update.$set as Record<string, unknown>;
		assert.ok(set.placedAt && typeof set.placedAt === 'object' && '$date' in (set.placedAt as object));
		assert.equal((set.placedAt as { $date: string }).$date, '2026-06-20T12:00:00.000Z');
	});

	test('editing _id is ignored (it is the filter key)', () => {
		const res = buildDocumentUpdate({ table: NESTED, document: DOC, edits: [{ path: '_id', value: 'nope' }] });
		assert.ok('error' in res && /No changes/.test(res.error));
	});

	test('a document with no _id is rejected', () => {
		const res = buildDocumentUpdate({ table: NESTED, document: { user: { name: 'x' } }, edits: [{ path: 'user.name', value: 'y' }] });
		assert.ok('error' in res && /_id/.test(res.error));
	});

	test('an unparseable date is left as the raw string rather than written invalid', () => {
		const w = update(buildDocumentUpdate({ table: NESTED, document: DOC, edits: [{ path: 'placedAt', value: 'not a date' }] }));
		assert.equal((w.update.$set as Record<string, unknown>).placedAt, 'not a date');
	});

	test('an ObjectId-typed field edit emits a { $oid } wrapper (Extended-JSON, Tier 3)', () => {
		const table: TableInfo = { ...NESTED, columns: [...NESTED.columns, { name: 'authorId', dataType: 'objectid', nullable: true, isPrimaryKey: false }] };
		const w = update(buildDocumentUpdate({ table, document: DOC, edits: [{ path: 'authorId', value: ID }] }));
		assert.deepEqual((w.update.$set as Record<string, unknown>).authorId, { $oid: ID });
	});
});

describe('buildMongoWrites — guards & ordering', () => {
	test('updates/deletes without an _id field are rejected', () => {
		const noId: QueryField[] = [{ name: 'name' }, { name: 'age' }];
		const result = buildMongoWrites({ table: COLL, fields: noId, updates: [], deletes: [['Ann', 30]], inserts: [] });
		assert.ok('error' in result && /_id/.test(result.error));
	});

	test('inserts alone need no _id', () => {
		const noId: QueryField[] = [{ name: 'name' }];
		const out = writes(buildMongoWrites({ table: { ...COLL, columns: [COLL.columns[1]] }, fields: noId, updates: [], deletes: [], inserts: [{ values: new Map([[0, 'Di']]) }] }));
		assert.deepEqual(out, [{ op: 'insertOne', collection: 'users', document: { name: 'Di' } }]);
	});

	test('emits deletes before updates before inserts', () => {
		const out = writes(buildMongoWrites({
			table: COLL,
			fields: FIELDS,
			updates: [{ original: [ID, 'Ann', 30, true, 1.5], set: new Map([[1, 'Bea']]) }],
			deletes: [['6303a1b2c3d4e5f600112299', 'Zed', 1, false, 0]],
			inserts: [{ values: new Map([[1, 'Cy']]) }],
		}));
		assert.deepEqual(out.map((w) => w.op), ['deleteOne', 'updateOne', 'insertOne']);
	});
});

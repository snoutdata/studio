/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ColumnInfo } from '../../schema';
import { inferColumns } from './documentColumns';

function byName(cols: ColumnInfo[]): Map<string, ColumnInfo> {
	return new Map(cols.map((c) => [c.name, c]));
}

/** Stands in for a leaf BSON value (ObjectId, Decimal128, …) without importing the driver's
 *  client into an engine test — `_bsontype` is exactly what the inference keys on. */
function bson(type: string): Record<string, unknown> {
	return { _bsontype: type };
}

// --- Structural inference (lifted from the Mongo driver) ---------------------------------------

describe('inferColumns (structural)', () => {
	test('emits dotted paths for nested subdocuments', () => {
		const cols = byName(inferColumns([
			{ _id: bson('ObjectId'), user: { name: 'a', address: { city: 'NYC' } } },
		]));
		assert.ok(cols.has('user'));
		assert.equal(cols.get('user')!.dataType, 'object');
		assert.equal(cols.get('user.name')!.dataType, 'string');
		assert.equal(cols.get('user.address')!.dataType, 'object');
		assert.equal(cols.get('user.address.city')!.dataType, 'string');
		// Nested paths are marked; the top-level key is not.
		assert.equal(cols.get('user')!.nested, undefined);
		assert.equal(cols.get('user.address.city')!.nested, true);
		// `_id` is first and the primary key.
		assert.equal(cols.get('_id')!.isPrimaryKey, true);
	});

	test('emits `[]` paths for arrays-of-subdocuments, `array` for scalar arrays', () => {
		const cols = byName(inferColumns([
			{ _id: 1, items: [{ sku: 'x', price: 5 }, { sku: 'y', price: 6 }], tags: ['a', 'b'] },
		]));
		assert.equal(cols.get('items')!.dataType, 'array');
		assert.equal(cols.get('items[].sku')!.dataType, 'string');
		assert.equal(cols.get('items[].price')!.dataType, 'int');
		assert.equal(cols.get('items[].sku')!.nested, true);
		// A scalar array is a leaf: `array` type, no element paths.
		assert.equal(cols.get('tags')!.dataType, 'array');
		assert.equal(cols.has('tags[]'), false);
	});

	test('unions mixed types and marks fields missing in some docs nullable', () => {
		const cols = byName(inferColumns([
			{ _id: 1, qty: 3 },
			{ _id: 2, qty: 'many', note: 'x' },
		]));
		assert.equal(cols.get('qty')!.dataType, 'int | string');
		assert.equal(cols.get('_id')!.nullable, false);
		assert.equal(cols.get('note')!.nullable, true);
	});

	test('counts an array-of-subdocs field present once per doc (nullability)', () => {
		const cols = byName(inferColumns([
			{ _id: 1, items: [{ sku: 'a' }, { sku: 'b' }] },
			{ _id: 2, items: [{ sku: 'c' }] },
		]));
		assert.equal(cols.get('items[].sku')!.nullable, false);
	});

	test('caps recursion depth', () => {
		const cols = byName(inferColumns([{ _id: 1, a: { b: { c: { d: 'deep' } } } }], { maxDepth: 2 }));
		assert.ok(cols.has('a.b'));
		assert.equal(cols.get('a.b.c')!.dataType, 'object');
		assert.equal(cols.has('a.b.c.d'), false);
	});

	test('caps total field count', () => {
		const doc: Record<string, unknown> = { _id: 1 };
		for (let i = 0; i < 50; i++) {
			doc[`f${i}`] = i;
		}
		assert.equal(inferColumns([doc], { maxFields: 10 }).length, 10);
	});

	test('a leaf BSON value is typed, not recursed into', () => {
		const cols = byName(inferColumns([{ _id: bson('ObjectId'), amount: bson('Decimal128') }]));
		assert.equal(cols.get('amount')!.dataType, 'decimal128');
		assert.equal(cols.has('amount._bsontype'), false);
	});

	test('prefers a $jsonSchema validator and merges sampled fields on top', () => {
		const jsonSchema = {
			bsonType: 'object',
			required: ['email'],
			properties: {
				email: { bsonType: 'string' },
				profile: { bsonType: 'object', properties: { age: { bsonType: 'int' } } },
			},
		};
		const cols = byName(inferColumns([{ _id: bson('ObjectId'), email: 'a@b.com', nickname: 'ab' }], { jsonSchema }));
		assert.equal(cols.get('email')!.dataType, 'string');
		assert.equal(cols.get('email')!.nullable, false);
		assert.equal(cols.get('profile.age')!.dataType, 'int');
		assert.equal(cols.get('profile.age')!.nested, true);
		assert.equal(cols.get('nickname')!.dataType, 'string');
	});
});

// --- Textual inference (the CSV-sniffer bar) ------------------------------------------------

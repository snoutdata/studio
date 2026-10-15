/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { compositeCount, isComposite, nodePath, parseType, summarize, valueTree, type ValueNode } from './cellValue';

/** The child of `node` reached by following `keys`. */
function at(node: ValueNode, ...keys: string[]): ValueNode {
	let current = node;
	for (const key of keys) {
		const child = current.children?.find((entry) => entry.key === key);
		assert.ok(child, `no child ${key} under ${current.key}`);
		current = child;
	}
	return current;
}

describe('what counts as a composite value', () => {
	test('arrays and plain objects do, scalars do not', () => {
		assert.equal(isComposite([1, 2]), true);
		assert.equal(isComposite({ a: 1 }), true);
		assert.equal(isComposite('plain'), false);
		assert.equal(isComposite(42), false);
		assert.equal(isComposite(null), false);
	});

	// Postgres `json`, MySQL `JSON` and a plain text column holding a payload all arrive as a
	// string, and a reader wants the same tree for them.
	test('a string holding JSON does, a string that merely starts with a brace does not', () => {
		assert.equal(isComposite('{"a": 1}'), true);
		assert.equal(isComposite('{not json'), false);
	});

	// A Date has its own class, and nobody wants it opened into its internals.
	test('a Date is a scalar', () => {
		assert.equal(isComposite(new Date()), false);
	});

	test('the count and the summary say how much is inside', () => {
		assert.equal(compositeCount([1, 2, 3]), 3);
		assert.equal(compositeCount({ a: 1, b: 2 }), 2);
		assert.equal(compositeCount('x'), undefined);
		assert.equal(summarize([1, 2, 3]), '3 items');
		assert.equal(summarize([1]), '1 item');
		assert.equal(summarize({ a: 1 }), '1 key');
		assert.equal(summarize(7), undefined);
	});
});

describe('the tree of a value', () => {
	test('an array becomes indexed children, an object keyed ones', () => {
		const array = valueTree([10, 20]);
		assert.equal(array.kind, 'array');
		assert.deepEqual(array.children?.map((child) => [child.key, child.text]), [['0', '10'], ['1', '20']]);
		const object = valueTree({ b: 'x' });
		assert.equal(object.kind, 'object');
		assert.equal(at(object, 'b').text, 'x');
	});

	// The declared type is what turns "an object with two keys" into "a Tuple whose id is a UInt64".
	test('a named tuple types and names its fields', () => {
		const tree = valueTree({ id: 1, name: 'x' }, 'Tuple(id UInt64, name String)');
		assert.equal(tree.type, 'Tuple(id UInt64, name String)');
		assert.equal(at(tree, 'id').type, 'UInt64');
		assert.equal(at(tree, 'name').type, 'String');
	});

	test('an unnamed tuple types its children by position', () => {
		const tree = valueTree([1, 'x'], 'Tuple(UInt8, String)');
		assert.equal(at(tree, '0').type, 'UInt8');
		assert.equal(at(tree, '1').type, 'String');
	});

	test('a map types its values, whatever the keys are', () => {
		const tree = valueTree({ a: [1], b: [2, 3] }, 'Map(String, Array(Int64))');
		assert.equal(at(tree, 'b').type, 'Array(Int64)');
		assert.equal(at(tree, 'b', '1').type, 'Int64');
	});

	test('nesting goes as deep as the value does', () => {
		const tree = valueTree([[{ id: 7 }]], 'Array(Array(Tuple(id UInt8)))');
		assert.equal(at(tree, '0', '0', 'id').text, '7');
		assert.equal(at(tree, '0', '0', 'id').type, 'UInt8');
	});

	// Nullable and LowCardinality wrap a type without changing the SHAPE of the value, so the tree
	// has to look straight through them or a Nullable(Array(...)) loses its element types.
	test('Nullable and LowCardinality are looked through', () => {
		const tree = valueTree([1, 2], 'Nullable(Array(LowCardinality(UInt8)))');
		assert.equal(at(tree, '0').type, 'UInt8');
	});

	test('a null inside says it is null rather than printing the word', () => {
		const tree = valueTree([null], 'Array(Nullable(String))');
		assert.equal(at(tree, '0').isNull, true);
		assert.equal(at(tree, '0').text, '');
	});

	// The type is only ever an addition. A wrong one, or a type from another vendor, must not lose
	// the tree the value itself describes.
	test('a type that does not match the value still gives the value\'s own tree', () => {
		const tree = valueTree({ a: 1 }, 'Array(UInt8)');
		assert.equal(at(tree, 'a').text, '1');
		assert.equal(at(tree, 'a').type, undefined);
	});

	test('a string of JSON opens the same way', () => {
		const tree = valueTree('{"items": [1]}', 'jsonb');
		assert.equal(at(tree, 'items', '0').text, '1');
	});
});

describe('reading a declared type', () => {
	test('the shapes ClickHouse writes', () => {
		assert.equal(parseType('String')?.name, 'String');
		assert.equal(parseType('Array(Tuple(id UInt64, at DateTime))')?.args[0].type.name, 'Tuple');
		assert.equal(parseType('Map(String, Array(Int64))')?.args.length, 2);
	});

	// A type carrying literals (an Enum's members, a Decimal's precision) still has to parse, or
	// the tree loses every type inside it.
	test('literal arguments do not break it', () => {
		assert.equal(parseType('Decimal(10, 2)')?.name, 'Decimal');
		assert.equal(parseType("Enum8('a' = 1, 'b' = 2)")?.name, 'Enum8');
		assert.equal(parseType("Array(Enum8('a' = 1))")?.args[0].type.name, 'Enum8');
	});

	test('something that is not a type at all is undefined, not a guess', () => {
		assert.equal(parseType('Array(('), undefined);
		assert.equal(parseType(''), undefined);
	});
});

describe('the path to a node', () => {
	test('is the SQL that reads it', () => {
		assert.equal(nodePath(['items', '0', 'name'], 'payload'), 'payload.items[0].name');
		assert.equal(nodePath(['a key'], 'm'), "m['a key']");
		assert.equal(nodePath([], 'c'), 'c');
	});
});

// The viewer opens a branch that is small enough to read and leaves a big one closed, so the size
// of each subtree is part of the model rather than a guess made while drawing.
describe('how big a subtree is', () => {
	test('counts every node under it, itself included', () => {
		assert.equal(valueTree(1).size, 1);
		assert.equal(valueTree([1, 2]).size, 3);
		assert.equal(valueTree({ a: [1, 2], b: 3 }).size, 5); // root + a + its two items + b
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompileError, sqlToMongo, sqlToMongoRead, UnsupportedQueryError } from './sqlToMongo';
import { SqlSyntaxError } from './sqlAst';
import type { DatabaseSchema } from '../../schema';

/** A document schema for the type-aware tests: one collection with a real BSON type per field. */
const SCHEMA: DatabaseSchema = {
	database: 'app',
	fetchedAt: 0,
	tables: [
		{
			name: 'orders',
			kind: 'collection',
			primaryKey: ['_id'],
			foreignKeys: [],
			columns: [
				{ name: '_id', dataType: 'objectid', nullable: false, isPrimaryKey: true },
				{ name: 'created_at', dataType: 'date', nullable: true, isPrimaryKey: false },
				{ name: 'total', dataType: 'double', nullable: true, isPrimaryKey: false },
				{ name: 'status', dataType: 'string', nullable: true, isPrimaryKey: false },
				{ name: 'paid', dataType: 'bool', nullable: true, isPrimaryKey: false },
				{ name: 'mixed', dataType: 'date | string', nullable: true, isPrimaryKey: false },
				{ name: 'address', dataType: 'object', nullable: true, isPrimaryKey: false },
				{ name: 'address.city', dataType: 'string', nullable: true, isPrimaryKey: false, nested: true },
			],
		},
		{ name: 'customers', kind: 'collection', primaryKey: ['_id'], foreignKeys: [], columns: [{ name: '_id', dataType: 'objectid', nullable: false, isPrimaryKey: true }] },
	],
};

function pipelineOf(sql: string, schema?: DatabaseSchema): object[] {
	return sqlToMongoRead(sql, { schema }).pipeline;
}

test('SELECT * → collection with empty pipeline', () => {
	assert.deepEqual(sqlToMongo('SELECT * FROM users'), { lang: 'mongo', collection: 'users', pipeline: [] });
});

test('EXPLAIN <select> compiles deterministically with the explain flag (no AI)', () => {
	const q = sqlToMongoRead('EXPLAIN SELECT * FROM readings');
	assert.deepEqual(q, { lang: 'mongo', collection: 'readings', pipeline: [], explain: true });
	const q2 = sqlToMongoRead('explain analyze SELECT * FROM t WHERE a = 1');
	assert.equal(q2.explain, true);
	assert.deepEqual(q2.pipeline, [{ $match: { a: 1 } }]);
});

test('column projection suppresses _id and renames aliases', () => {
	assert.deepEqual(pipelineOf('SELECT a, b AS bb FROM users'), [{ $project: { a: 1, bb: '$b', _id: 0 } }]);
});

test('selecting _id keeps it', () => {
	assert.deepEqual(pipelineOf('SELECT _id, a FROM users'), [{ $project: { _id: 1, a: 1 } }]);
});

test('WHERE comparisons → $match', () => {
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE age >= 21 AND name = 'x'"), [
		{ $match: { $and: [{ age: { $gte: 21 } }, { name: 'x' }] } },
	]);
});

// SQL's three-valued logic: a row whose column is NULL is NOT part of a `<>` / NOT IN result. A
// bare $ne/$nin matches documents that are missing the field entirely, which is the opposite.
test('negated predicates exclude missing/null, as SQL does', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a <> 1'), [{ $match: { a: { $nin: [1, null] } } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a != 1'), [{ $match: { a: { $nin: [1, null] } } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a NOT IN (1,2)'), [{ $match: { a: { $nin: [1, 2, null] } } }]);
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE name NOT LIKE 'a%'"), [
		{ $match: { name: { $not: { $regex: '^a.*$' }, $ne: null } } },
	]);
});

test('WHERE operators: in, is null, between', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a IN (1,2,3)'), [{ $match: { a: { $in: [1, 2, 3] } } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a IS NULL'), [{ $match: { a: null } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a IS NOT NULL'), [{ $match: { a: { $ne: null } } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a BETWEEN 1 AND 5'), [{ $match: { a: { $gte: 1, $lte: 5 } } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a NOT BETWEEN 1 AND 5'), [
		{ $match: { $or: [{ a: { $lt: 1 } }, { a: { $gt: 5 } }] } },
	]);
});

// SQL LIKE is case-SENSITIVE; ILIKE is the case-insensitive one. Emitting $options:'i' for LIKE
// (as this compiler used to) silently turned every LIKE into an ILIKE.
test('LIKE is case-sensitive, ILIKE is not', () => {
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE name LIKE 'foo%'"), [{ $match: { name: { $regex: '^foo.*$' } } }]);
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE name ILIKE 'foo%'"), [
		{ $match: { name: { $regex: '^foo.*$', $options: 'i' } } },
	]);
	// $options is illegal inside $not, so a negated case-insensitive match inlines the flag instead.
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE name NOT ILIKE 'foo%'"), [
		{ $match: { name: { $not: { $regex: '(?i)^foo.*$' }, $ne: null } } },
	]);
});

test('NOT pushes down into the predicate rather than wrapping it', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE NOT (a = 1)'), [{ $match: { a: { $nin: [1, null] } } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE NOT (a = 1 AND b > 2)'), [
		{ $match: { $or: [{ a: { $nin: [1, null] } }, { b: { $lte: 2 } }] } },
	]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE NOT (a IS NULL)'), [{ $match: { a: { $ne: null } } }]);
});

test('a bare boolean column is a predicate on its own', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE active'), [{ $match: { active: true } }]);
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE NOT (active)'), [{ $match: { active: false } }]);
});

test('column-to-column and expression predicates compile through $expr', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a > b'), [{ $match: { $expr: { $gt: ['$a', '$b'] } } }]);
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE UPPER(name) = 'X'"), [
		{ $match: { $expr: { $eq: [{ $toUpper: '$name' }, 'X'] } } },
	]);
	// A literal on the left still finds the field form.
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE 5 < a'), [{ $match: { a: { $gt: 5 } } }]);
});

test('OR branches', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t WHERE a = 1 OR b = 2'), [{ $match: { $or: [{ a: 1 }, { b: 2 }] } }]);
});

test('ORDER BY + LIMIT + OFFSET order in pipeline', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t ORDER BY a DESC LIMIT 10 OFFSET 5'), [
		{ $sort: { a: -1 } },
		{ $skip: 5 },
		{ $limit: 10 },
	]);
});

test('LIMIT without OFFSET', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t LIMIT 50'), [{ $limit: 50 }]);
});

// A bare OFFSET used to be read as a LIMIT, silently truncating the result to the offset.
test('a bare OFFSET skips rather than limits', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM t OFFSET 5'), [{ $skip: 5 }]);
});

test('ORDER BY resolves aliases, ordinals and expressions', () => {
	// An alias over a plain column sorts on the source field (the sort may precede the projection).
	assert.deepEqual(pipelineOf('SELECT a AS x FROM t ORDER BY x DESC'), [
		{ $sort: { a: -1 } },
		{ $project: { x: '$a', _id: 0 } },
	]);
	// An alias over a COMPUTED column only exists after the projection, so the projection goes first.
	assert.deepEqual(pipelineOf('SELECT UPPER(a) AS u FROM t ORDER BY u'), [
		{ $project: { u: { $toUpper: '$a' }, _id: 0 } },
		{ $sort: { u: 1 } },
	]);
	assert.deepEqual(pipelineOf('SELECT a FROM t ORDER BY 1'), [{ $sort: { a: 1 } }, { $project: { a: 1, _id: 0 } }]);
	// An expression sort materializes a hidden field, sorts on it, and drops it again.
	assert.deepEqual(pipelineOf('SELECT * FROM t ORDER BY LENGTH(name) DESC'), [
		{ $addFields: { __sort_0: { $strLenCP: '$name' } } },
		{ $sort: { __sort_0: -1 } },
		{ $unset: ['__sort_0'] },
	]);
});

test('GROUP BY with COUNT(*) → $group + $project', () => {
	assert.deepEqual(pipelineOf('SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC'), [
		{ $group: { _id: '$status', n: { $sum: 1 } } },
		{ $project: { _id: 0, status: '$_id', n: 1 } },
		{ $sort: { n: -1 } },
	]);
});

test('GROUP BY with SUM/AVG/MIN/MAX', () => {
	assert.deepEqual(pipelineOf('SELECT region, SUM(amount) AS total, AVG(amount) AS avg FROM sales GROUP BY region'), [
		{ $group: { _id: '$region', total: { $sum: '$amount' }, avg: { $avg: '$amount' } } },
		{ $project: { _id: 0, region: '$_id', total: 1, avg: 1 } },
	]);
});

// The single most common ad-hoc query: an aggregate with no GROUP BY. This used to be rejected
// outright ("only plain column references"), so it fell through to the AI-translation prompt.
test('an aggregate without GROUP BY groups on a null key', () => {
	assert.deepEqual(pipelineOf('SELECT COUNT(*) AS n FROM orders'), [
		{ $group: { _id: null, n: { $sum: 1 } } },
		{ $project: { _id: 0, n: 1 } },
	]);
	assert.deepEqual(pipelineOf('SELECT COUNT(*) FROM t WHERE a = 1'), [
		{ $match: { a: 1 } },
		{ $group: { _id: null, count: { $sum: 1 } } },
		{ $project: { _id: 0, count: 1 } },
	]);
});

// SQL COUNT(col) counts non-null values; counting documents instead is a different number.
test('COUNT(col) skips nulls, COUNT(DISTINCT col) counts distinct values', () => {
	assert.deepEqual(pipelineOf('SELECT COUNT(status) AS n FROM orders'), [
		{ $group: { _id: null, n: { $sum: { $cond: [{ $in: [{ $type: '$status' }, ['missing', 'null']] }, 0, 1] } } } },
		{ $project: { _id: 0, n: 1 } },
	]);
	assert.deepEqual(pipelineOf('SELECT COUNT(DISTINCT status) AS n FROM orders'), [
		{ $group: { _id: null, __set_n: { $addToSet: '$status' } } },
		{ $project: { _id: 0, n: { $size: '$__set_n' } } },
	]);
});

test('HAVING becomes a $match between the group and the projection', () => {
	assert.deepEqual(pipelineOf('SELECT a, COUNT(*) AS n FROM t GROUP BY a HAVING COUNT(*) > 1'), [
		{ $group: { _id: '$a', n: { $sum: 1 } } },
		{ $match: { n: { $gt: 1 } } },
		{ $project: { _id: 0, a: '$_id', n: 1 } },
	]);
	// An aggregate used ONLY in HAVING is computed under a hidden name the projection then drops.
	assert.deepEqual(pipelineOf('SELECT a FROM t GROUP BY a HAVING SUM(total) > 100'), [
		{ $group: { _id: '$a', __having_0: { $sum: '$total' } } },
		{ $match: { __having_0: { $gt: 100 } } },
		{ $project: { _id: 0, a: '$_id' } },
	]);
});

test('SELECT DISTINCT groups by the selected values', () => {
	assert.deepEqual(pipelineOf('SELECT DISTINCT a, b FROM t'), [
		{ $group: { _id: { a: '$a', b: '$b' } } },
		{ $project: { _id: 0, a: '$_id.a', b: '$_id.b' } },
	]);
});

test('expressions in the SELECT list compile to aggregation expressions', () => {
	assert.deepEqual(pipelineOf('SELECT a + b AS s, UPPER(name) AS u FROM t'), [
		{ $project: { s: { $add: ['$a', '$b'] }, u: { $toUpper: '$name' }, _id: 0 } },
	]);
	assert.deepEqual(pipelineOf('SELECT COALESCE(a, 0) AS c FROM t'), [{ $project: { c: { $ifNull: ['$a', 0] }, _id: 0 } }]);
	assert.deepEqual(pipelineOf('SELECT CASE WHEN a > 1 THEN 1 ELSE 0 END AS c FROM t'), [
		{ $project: { c: { $switch: { branches: [{ case: { $gt: ['$a', 1] }, then: 1 }], default: 0 } }, _id: 0 } },
	]);
	assert.deepEqual(pipelineOf('SELECT CAST(a AS INT) AS n FROM t'), [{ $project: { n: { $toInt: '$a' }, _id: 0 } }]);
	// SQL SUBSTRING is 1-based; $substrCP is 0-based.
	assert.deepEqual(pipelineOf('SELECT SUBSTRING(a, 1, 3) AS s FROM t'), [
		{ $project: { s: { $substrCP: ['$a', 0, 3] }, _id: 0 } },
	]);
	// `SELECT *, <expr>` keeps the document and adds the computed field.
	assert.deepEqual(pipelineOf('SELECT *, UPPER(a) AS u FROM t'), [{ $addFields: { u: { $toUpper: '$a' } } }]);
});

test('JOIN compiles to $lookup + $unwind', () => {
	assert.deepEqual(pipelineOf('SELECT * FROM a JOIN b ON a.id = b.aid'), [
		{ $lookup: { from: 'b', localField: 'id', foreignField: 'aid', as: 'b' } },
		{ $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
	]);
	// LEFT JOIN keeps unmatched documents.
	assert.deepEqual(pipelineOf('SELECT * FROM a LEFT JOIN b AS j ON a.id = j.aid'), [
		{ $lookup: { from: 'b', localField: 'id', foreignField: 'aid', as: 'j' } },
		{ $unwind: { path: '$j', preserveNullAndEmptyArrays: true } },
	]);
	// A filter on a BASE field runs before the join (fewer documents to look up)…
	assert.deepEqual(pipelineOf('SELECT * FROM a JOIN b ON a.id = b.aid WHERE a.x = 1'), [
		{ $match: { x: 1 } },
		{ $lookup: { from: 'b', localField: 'id', foreignField: 'aid', as: 'b' } },
		{ $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
	]);
	// …and one on a JOINED field has to run after it.
	assert.deepEqual(pipelineOf('SELECT * FROM a JOIN b ON a.id = b.aid WHERE b.x = 1'), [
		{ $lookup: { from: 'b', localField: 'id', foreignField: 'aid', as: 'b' } },
		{ $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
		{ $match: { 'b.x': 1 } },
	]);
});

test('nested field path via qualifier', () => {
	assert.deepEqual(pipelineOf("SELECT * FROM t WHERE address.city = 'NYC'"), [{ $match: { 'address.city': 'NYC' } }]);
});

// Projecting a nested path under its dotted name rebuilds the nesting, so the grid showed one
// `address` column holding a JSON blob. SQL names the column after the final identifier.
test('a selected nested path becomes a flat column named like SQL names it', () => {
	assert.deepEqual(pipelineOf('SELECT address.city FROM t'), [{ $project: { city: '$address.city', _id: 0 } }]);
	assert.deepEqual(pipelineOf('SELECT b.x FROM a JOIN b ON a.id = b.aid'), [
		{ $lookup: { from: 'b', localField: 'id', foreignField: 'aid', as: 'b' } },
		{ $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
		{ $project: { x: '$b.x', _id: 0 } },
	]);
	// Two paths ending in the same name would collide, so the later one keeps its full path.
	assert.deepEqual(pipelineOf('SELECT x, b.x FROM a JOIN b ON a.id = b.aid'), [
		{ $lookup: { from: 'b', localField: 'id', foreignField: 'aid', as: 'b' } },
		{ $unwind: { path: '$b', preserveNullAndEmptyArrays: false } },
		{ $project: { x: 1, 'b.x': 1, _id: 0 } },
	]);
});

// ---------------------------------------------------------------------------------------------
// Schema-aware compilation
// ---------------------------------------------------------------------------------------------

// Comparing a Date field to a SQL string literal matched nothing at all before: a BSON Date is
// never equal to a string, and Mongo reports no error for it.
test('literals are coerced to the field\'s real BSON type', () => {
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE created_at > '2024-01-01'", SCHEMA), [
		{ $match: { created_at: { $gt: { $date: '2024-01-01T00:00:00.000Z' } } } },
	]);
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE _id = '507f1f77bcf86cd799439011'", SCHEMA), [
		{ $match: { _id: { $oid: '507f1f77bcf86cd799439011' } } },
	]);
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE total > '10'", SCHEMA), [{ $match: { total: { $gt: 10 } } }]);
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE paid = 'true'", SCHEMA), [{ $match: { paid: true } }]);
	// A field that holds more than one type is ambiguous, so it is never coerced.
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE mixed = '2024-01-01'", SCHEMA), [
		{ $match: { mixed: '2024-01-01' } },
	]);
	// Without a schema nothing is coerced — the compiler still works schema-blind.
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE created_at > '2024-01-01'"), [
		{ $match: { created_at: { $gt: '2024-01-01' } } },
	]);
});

test('coercion reaches IN lists and BETWEEN bounds', () => {
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE total IN ('1','2')", SCHEMA), [
		{ $match: { total: { $in: [1, 2] } } },
	]);
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE total BETWEEN '1' AND '9'", SCHEMA), [
		{ $match: { total: { $gte: 1, $lte: 9 } } },
	]);
});

test('an unknown collection is a hard error, not an AI-recoverable one', () => {
	assert.throws(() => sqlToMongo('SELECT * FROM nope', { schema: SCHEMA }), CompileError);
	// Known collections still compile, and a schema-blind compile never rejects a name.
	assert.doesNotThrow(() => sqlToMongo('SELECT * FROM orders', { schema: SCHEMA }));
	assert.doesNotThrow(() => sqlToMongo('SELECT * FROM nope'));
});

// A qualifier that isn't a table/alias used to be read as a nested path, so a typo'd alias
// compiled into a filter on a field that doesn't exist and quietly returned nothing.
test('a qualifier that names neither a source nor a field is rejected', () => {
	assert.throws(() => sqlToMongo('SELECT * FROM orders AS o WHERE p.status = 1', { schema: SCHEMA }), CompileError);
	// A real nested path is still a nested path.
	assert.deepEqual(pipelineOf("SELECT * FROM orders WHERE address.city = 'NYC'", SCHEMA), [
		{ $match: { 'address.city': 'NYC' } },
	]);
});

// ---------------------------------------------------------------------------------------------
// Writes and structure
// ---------------------------------------------------------------------------------------------

test('INSERT compiles to insertOne ops', () => {
	assert.deepEqual(sqlToMongo("INSERT INTO t (a, b) VALUES ('x', 1)"), {
		lang: 'mongo-write',
		writes: [{ op: 'insertOne', collection: 't', document: { a: 'x', b: 1 } }],
	});
	// Values are coerced by the field's type, like any other literal.
	assert.deepEqual(sqlToMongo("INSERT INTO orders (total) VALUES ('5')", { schema: SCHEMA }), {
		lang: 'mongo-write',
		writes: [{ op: 'insertOne', collection: 'orders', document: { total: 5 } }],
	});
});

test('UPDATE and DELETE are set-based, like the SQL they came from', () => {
	assert.deepEqual(sqlToMongo("UPDATE t SET a = 1, b = 'x' WHERE c = 2"), {
		lang: 'mongo-write',
		writes: [{ op: 'updateMany', collection: 't', filter: { c: 2 }, update: { $set: { a: 1, b: 'x' } } }],
	});
	assert.deepEqual(sqlToMongo('DELETE FROM t WHERE a = 1'), {
		lang: 'mongo-write',
		writes: [{ op: 'deleteMany', collection: 't', filter: { a: 1 } }],
	});
	// No WHERE means every document, as it does in SQL.
	assert.deepEqual(sqlToMongo('DELETE FROM t'), {
		lang: 'mongo-write',
		writes: [{ op: 'deleteMany', collection: 't', filter: {} }],
	});
	assert.deepEqual(sqlToMongo('TRUNCATE t'), {
		lang: 'mongo-write',
		writes: [{ op: 'deleteMany', collection: 't', filter: {} }],
	});
});

test('CREATE/DROP compile to the mongo-ddl ops', () => {
	assert.deepEqual(sqlToMongo('CREATE TABLE t (a int)'), { lang: 'mongo-ddl', ops: [{ op: 'createCollection', collection: 't' }] });
	assert.deepEqual(sqlToMongo('DROP TABLE t'), { lang: 'mongo-ddl', ops: [{ op: 'dropCollection', collection: 't' }] });
	assert.deepEqual(sqlToMongo('CREATE INDEX ix ON t (a, b)'), {
		lang: 'mongo-ddl',
		ops: [{ op: 'createIndex', collection: 't', keys: { a: 1, b: 1 }, name: 'ix' }],
	});
	assert.deepEqual(sqlToMongo('CREATE UNIQUE INDEX ix ON t (a DESC)'), {
		lang: 'mongo-ddl',
		ops: [{ op: 'createIndex', collection: 't', keys: { a: -1 }, name: 'ix', unique: true }],
	});
	assert.deepEqual(sqlToMongo('DROP INDEX t.ix'), { lang: 'mongo-ddl', ops: [{ op: 'dropIndex', collection: 't', name: 'ix' }] });
	// Mongo drops an index by collection, so an unqualified name can't be guessed at.
	assert.throws(() => sqlToMongo('DROP INDEX ix'), CompileError);
});

// ---------------------------------------------------------------------------------------------
// What is still (deliberately) out of reach
// ---------------------------------------------------------------------------------------------

test('rejects set operations, CTEs and subqueries rather than compiling one branch', () => {
	assert.throws(() => sqlToMongo('SELECT * FROM a UNION SELECT * FROM b'), UnsupportedQueryError);
	assert.throws(() => sqlToMongo('WITH x AS (SELECT 1) SELECT * FROM x'), UnsupportedQueryError);
	assert.throws(() => sqlToMongo('SELECT * FROM (SELECT 1) x'), UnsupportedQueryError);
	assert.throws(() => sqlToMongo('SELECT * FROM t WHERE a IN (SELECT 1)'), UnsupportedQueryError);
});

test('rejects what it cannot express, with a reason', () => {
	assert.throws(() => sqlToMongo('SELECT a + b FROM t'), UnsupportedQueryError); // needs an alias
	assert.throws(() => sqlToMongo('UPDATE t SET a = a + 1'), UnsupportedQueryError);
	assert.throws(() => sqlToMongo('SELECT * FROM a RIGHT JOIN b ON a.id = b.aid'), UnsupportedQueryError);
	assert.throws(() => sqlToMongo('SELECT DISTINCT * FROM t'), UnsupportedQueryError);
	assert.throws(() => sqlToMongo('SELECT MEDIAN(a) AS m FROM t GROUP BY b'), UnsupportedQueryError);
	// Not SQL at all is a SYNTAX error, deliberately NOT an UnsupportedQueryError: the model cannot
	// translate what does not parse, so it is terminal (see sqlSyntax.ts).
	assert.throws(() => sqlToMongo('NOT SQL AT ALL ;;;'), SqlSyntaxError);
});

test('a name starting with "$" is never a filter operator: refused, with no fallback to a model', () => {
	// Compiled as written, this was `deleteMany({ $comment: 'stale rows' })`: a filter that matches
	// every document, under a statement that reads as a filtered DELETE.
	assert.throws(() => sqlToMongo(`DELETE FROM users WHERE "$comment" = 'stale rows'`), CompileError);
	assert.throws(() => sqlToMongo(`UPDATE users SET a = 1 WHERE "$where" = 'sleep(100000)'`), CompileError);
	assert.throws(() => sqlToMongo(`SELECT * FROM users WHERE "$expr" = 1`), CompileError);
	assert.throws(() => sqlToMongo(`SELECT * FROM users WHERE "$function" = 1`), CompileError);
	// A segment of a dotted path, a qualifier, a SET target, an alias, an INSERT key, an index key.
	assert.throws(() => sqlToMongo(`SELECT * FROM users WHERE "address.$where" = 1`), CompileError);
	assert.throws(() => sqlToMongo(`SELECT * FROM users WHERE "$where".x = 1`), CompileError);
	assert.throws(() => sqlToMongo(`UPDATE users SET "$set" = 1 WHERE a = 1`), CompileError);
	assert.throws(() => sqlToMongo(`SELECT a AS "$where" FROM users`), CompileError);
	assert.throws(() => sqlToMongo(`INSERT INTO users ("$where", b) VALUES (1, 2)`), CompileError);
	assert.throws(() => sqlToMongo(`CREATE INDEX ix ON users ("$where")`), CompileError);
	assert.throws(() => sqlToMongo(`SELECT * FROM users AS "$x" WHERE a = 1`), CompileError);
	// An empty segment is not a path either.
	assert.throws(() => sqlToMongo(`SELECT * FROM users WHERE "a..b" = 1`), CompileError);
});

test('no compiled statement carries an operator that came from a name', () => {
	const operators = /"\$(where|function|expr|comment|accumulator)"/;
	for (const sql of [
		`DELETE FROM users WHERE a = 1`,
		`UPDATE users SET a = 1 WHERE b = 'x'`,
		`SELECT a, b AS c FROM users WHERE "a$b" = 1`,
	]) {
		assert.doesNotMatch(JSON.stringify(sqlToMongo(sql)), operators, sql);
	}
	// "$" inside a name, after its first character, is an ordinary field.
	assert.deepEqual(sqlToMongo(`DELETE FROM t WHERE "a$b" = 1`), { lang: 'mongo-write', writes: [{ op: 'deleteMany', collection: 't', filter: { a$b: 1 } }] });
});

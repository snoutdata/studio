/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NativeQuery } from '../../compile/native';
import { countingSql, profileFor, windowQuery } from './index';
import { MONGO_PROFILE } from './mongo';
import { PINECONE_PROFILE } from './pinecone';
import { SQL_PROFILE, referencedTables } from './sql';

test('profileFor resolves profiles by kind and falls back to SQL', () => {
	assert.equal(profileFor('relational'), SQL_PROFILE);
	assert.equal(profileFor('document'), MONGO_PROFILE);
	assert.equal(profileFor('vector'), PINECONE_PROFILE);
	// An undefined/unknown kind falls back to SQL so callers never get undefined.
	assert.equal(profileFor(undefined), SQL_PROFILE);
});

test('sql profile exposes the relational surface constants', () => {
	assert.equal(SQL_PROFILE.kind, 'relational');
	assert.equal(SQL_PROFILE.monacoLanguage, 'sql');
	assert.equal(SQL_PROFILE.fenceId, 'sql');
});

test('aiDisplayName is per-vendor, generic when unknown', () => {
	assert.equal(SQL_PROFILE.aiDisplayName('postgres'), 'PostgreSQL');
	assert.equal(SQL_PROFILE.aiDisplayName('oracle'), 'Oracle');
	assert.equal(SQL_PROFILE.aiDisplayName(undefined), 'SQL');
	assert.equal(SQL_PROFILE.aiDisplayName('nope'), 'SQL');
});

test('isDestructive flags writes/DDL and passes SELECTs', () => {
	assert.equal(SQL_PROFILE.isDestructive({ lang: 'sql', sql: 'SELECT * FROM t' }), false);
	assert.equal(SQL_PROFILE.isDestructive({ lang: 'sql', sql: 'DELETE FROM t WHERE id = 1' }), true);
	assert.equal(SQL_PROFILE.isDestructive({ lang: 'sql', sql: 'DROP TABLE t' }), true);
	// A non-SQL query handed to the relational profile is never "destructive" here — the
	// owning profile guards it. (Defensive: this path shouldn't occur in practice.)
	assert.equal(SQL_PROFILE.isDestructive({ lang: 'mongo', collection: 'c', pipeline: [] }), false);
});

test('referencedEntities extracts FROM/JOIN tables (deduped, lowercased, unqualified)', () => {
	assert.deepEqual(SQL_PROFILE.referencedEntities('SELECT * FROM Users u JOIN Orders o ON o.uid = u.id'), [
		'users',
		'orders',
	]);
	// A dotted db-qualified name keeps only the table part.
	assert.deepEqual(SQL_PROFILE.referencedEntities('SELECT * FROM app.Customers'), ['customers']);
	// A single backtick-quoted name is unquoted.
	assert.deepEqual(SQL_PROFILE.referencedEntities('SELECT * FROM `Customers`'), ['customers']);
	assert.deepEqual(referencedTables('select 1'), []);
});

test('sql profile browse builds a paginated SELECT for the dialect', () => {
	const q = SQL_PROFILE.browse({ name: 'users' }, { limit: 50, offset: 100 }, 'postgres');
	assert.deepEqual(q, { lang: 'sql', sql: 'SELECT * FROM "users" LIMIT 50 OFFSET 100' });
	// OFFSET..FETCH dialect (SQL Server) needs a deterministic ORDER BY; falls back to ordinal 1.
	const ms = SQL_PROFILE.browse({ name: 't', schema: 'dbo' }, { limit: 10, offset: 0 }, 'sqlserver');
	assert.equal(ms.lang, 'sql');
	assert.match((ms as { sql: string }).sql, /\[dbo\]\.\[t\].*ORDER BY 1 OFFSET 0 ROWS FETCH NEXT 10/s);
});

test('mongo profile surface', () => {
	assert.equal(MONGO_PROFILE.kind, 'document');
	assert.equal(MONGO_PROFILE.monacoLanguage, 'json');
	assert.equal(MONGO_PROFILE.fenceId, 'json');
	assert.equal(MONGO_PROFILE.aiDisplayName(), 'MongoDB aggregation pipeline');
});

test('mongo profile browse builds a skip/limit pipeline (skip omitted at 0)', () => {
	assert.deepEqual(MONGO_PROFILE.browse({ name: 'users' }, { limit: 50, offset: 0 }), {
		lang: 'mongo',
		collection: 'users',
		pipeline: [{ $limit: 50 }],
	});
	assert.deepEqual(MONGO_PROFILE.browse({ name: 'users' }, { limit: 50, offset: 100 }), {
		lang: 'mongo',
		collection: 'users',
		pipeline: [{ $skip: 100 }, { $limit: 50 }],
	});
});

test('mongo isDestructive flags $out/$merge writes only', () => {
	assert.equal(MONGO_PROFILE.isDestructive({ lang: 'mongo', collection: 'c', pipeline: [{ $match: { a: 1 } }] }), false);
	assert.equal(MONGO_PROFILE.isDestructive({ lang: 'mongo', collection: 'c', pipeline: [{ $out: 'dump' }] }), true);
	assert.equal(
		MONGO_PROFILE.isDestructive({ lang: 'mongo', collection: 'c', pipeline: [{ $merge: { into: 'x' } }] }),
		true,
	);
});

test('mongo isDestructive flags write + structure (DDL) batches', () => {
	assert.equal(MONGO_PROFILE.isDestructive({ lang: 'mongo-write', writes: [{ op: 'deleteOne', collection: 'c', filter: { _id: 1 } }] }), true);
	assert.equal(MONGO_PROFILE.isDestructive({ lang: 'mongo-ddl', ops: [{ op: 'createCollection', collection: 'c' }] }), true);
	assert.equal(MONGO_PROFILE.isDestructive({ lang: 'mongo-ddl', ops: [{ op: 'dropCollection', collection: 'c' }] }), true);
});

// windowQuery — "the same query, one window further in". This is the single gate the results grid
// reads to decide whether "Next" may fetch past the rows already loaded, so the negative cases
// matter as much as the positive ones.

test('windowQuery pages SQL per dialect, offset 0 matching the auto-LIMIT', () => {
	const q: NativeQuery = { lang: 'sql', sql: 'SELECT * FROM users' };
	assert.deepEqual(windowQuery(q, { limit: 200, offset: 200 }, 'postgres'), {
		lang: 'sql', sql: 'SELECT * FROM users\nLIMIT 200 OFFSET 200', params: undefined,
	});
	assert.deepEqual(windowQuery(q, { limit: 200, offset: 0 }, 'postgres'), {
		lang: 'sql', sql: 'SELECT * FROM users\nLIMIT 200', params: undefined,
	});
	// A trailing semicolon is stripped, WITH is a read, and an unknown driver gets the generic dialect.
	assert.match((windowQuery({ lang: 'sql', sql: 'WITH x AS (SELECT 1) SELECT * FROM x;' }, { limit: 10, offset: 10 }, 'nope') as { sql: string }).sql, /\nLIMIT 10 OFFSET 10$/);
});

test('windowQuery refuses SQL that is already capped, not a read, or multi-statement', () => {
	// Already capped: the user asked for exactly those rows.
	assert.equal(windowQuery({ lang: 'sql', sql: 'SELECT * FROM t LIMIT 5' }, { limit: 200, offset: 200 }, 'postgres'), null);
	assert.equal(windowQuery({ lang: 'sql', sql: 'SELECT TOP 5 * FROM t' }, { limit: 200, offset: 200 }, 'sqlserver'), null);
	// Not a read, and not a single statement.
	assert.equal(windowQuery({ lang: 'sql', sql: 'UPDATE t SET a = 1' }, { limit: 200, offset: 200 }, 'postgres'), null);
	assert.equal(windowQuery({ lang: 'sql', sql: 'SELECT 1; SELECT 2' }, { limit: 200, offset: 200 }, 'postgres'), null);
});

test('windowQuery pages a Mongo pipeline with $skip/$limit appended last', () => {
	const q: NativeQuery = { lang: 'mongo', collection: 'users', pipeline: [{ $match: { active: true } }, { $sort: { name: 1 } }] };
	// Appended at the END, so the window is over the pipeline's own output (after $match/$sort).
	assert.deepEqual(windowQuery(q, { limit: 200, offset: 200 }), {
		lang: 'mongo', collection: 'users',
		pipeline: [{ $match: { active: true } }, { $sort: { name: 1 } }, { $skip: 200 }, { $limit: 200 }],
	});
	// Offset 0 is the auto-LIMIT form: no $skip.
	assert.deepEqual(windowQuery(q, { limit: 200, offset: 0 }), {
		lang: 'mongo', collection: 'users',
		pipeline: [{ $match: { active: true } }, { $sort: { name: 1 } }, { $limit: 200 }],
	});
	// The source pipeline is never mutated.
	assert.equal(q.pipeline.length, 2);
});

test('windowQuery refuses a self-capped, writing or explained pipeline', () => {
	const capped: NativeQuery = { lang: 'mongo', collection: 'c', pipeline: [{ $match: {} }, { $limit: 50 }] };
	assert.equal(windowQuery(capped, { limit: 200, offset: 200 }), null);
	assert.equal(windowQuery({ lang: 'mongo', collection: 'c', pipeline: [{ $out: 'dump' }] }, { limit: 200, offset: 200 }), null);
	assert.equal(windowQuery({ lang: 'mongo', collection: 'c', pipeline: [{ $match: {} }], explain: true }, { limit: 200, offset: 200 }), null);
	assert.equal(windowQuery({ lang: 'mongo-write', writes: [{ op: 'deleteOne', collection: 'c', filter: { _id: 1 } }] }, { limit: 200, offset: 200 }), null);
});

test('windowQuery pages SQL against a vector connection, but not a native vector query', () => {
	// A native Pinecone query's `topK` IS the cap its author asked for — the same rule as SQL that
	// carries its own LIMIT.
	assert.equal(windowQuery({ lang: 'pinecone', index: 'i', query: { topK: 200 } }, { limit: 200, offset: 200 }), null);
	// SQL against a Pinecone connection IS windowable: `sqlToPinecone` compiles OFFSET to
	// `PineconeQuery.offset`, which the driver serves by walking continuation tokens and slicing.
	assert.deepEqual(windowQuery({ lang: 'sql', sql: 'SELECT * FROM idx' }, { limit: 200, offset: 200 }, 'pinecone'), {
		lang: 'sql', sql: 'SELECT * FROM idx\nLIMIT 200 OFFSET 200', params: undefined,
	});
	// The same statement against a Mongo connection IS windowable (sqlToMongo compiles OFFSET → $skip).
	assert.notEqual(windowQuery({ lang: 'sql', sql: 'SELECT * FROM coll' }, { limit: 200, offset: 200 }, 'mongodb'), null);
});

test('countingSql wraps a relational read as a derived table', () => {
	assert.equal(
		countingSql('SELECT id FROM users WHERE x = 1;', 'relational'),
		'SELECT COUNT(*) AS snout_total FROM (SELECT id FROM users WHERE x = 1) AS snout_count',
	);
	// Not a single read: nothing honest to count.
	assert.equal(countingSql('UPDATE users SET x = 1', 'relational'), null);
	assert.equal(countingSql('SELECT 1; SELECT 2', 'relational'), null);
});

test('countingSql rewrites a log query in place, keeping its window', () => {
	// A log service reads ONE scope and `sqlToLogs` refuses a subquery in FROM, so the derived-table
	// wrap could never run — "Count total" on a CloudWatch result just failed. The projection becomes
	// count(*) and the WHERE survives, which is what makes the count cover the same time window as
	// the rows on screen; ORDER BY and LIMIT go, a count has no use for either.
	assert.equal(
		countingSql(`SELECT ts, message FROM "/aws/lambda/checkout" WHERE ts >= ago('24h') ORDER BY ts DESC LIMIT 100`, 'telemetry'),
		`SELECT count(*) AS snout_total FROM "/aws/lambda/checkout" WHERE ts >= ago('24h')`,
	);
	// A literal that merely CONTAINS a clause keyword is not a clause (the scan is masked).
	assert.equal(
		countingSql(`SELECT ts FROM "/aws/lambda/checkout" WHERE message LIKE '%order by%' LIMIT 50`, 'telemetry'),
		`SELECT count(*) AS snout_total FROM "/aws/lambda/checkout" WHERE message LIKE '%order by%'`,
	);
	// Grouped: the total is a count of GROUPS, and this rewrite would count events instead. The
	// footer hides the button rather than showing a number that answers a different question.
	assert.equal(countingSql('SELECT level, count(*) FROM logs GROUP BY level', 'telemetry'), null);
});

test('what a backend lets you create is the profile\'s answer', () => {
	// The connection tree's "+" reads this. A log service creates nothing (its scopes are the cloud
	// provider's), and Pinecone indexes are made in Pinecone's own console, so both say so by
	// having no label at all rather than by offering a button that leads nowhere.
	assert.equal(profileFor('relational').newEntityLabel, 'New table');
	assert.equal(profileFor('document').newEntityLabel, 'New collection');
	assert.equal(profileFor('telemetry').newEntityLabel, undefined);
	assert.equal(profileFor('vector').newEntityLabel, undefined);
});

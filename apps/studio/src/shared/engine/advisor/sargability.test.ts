/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintSargability } from './sargability';
import type { DatabaseSchema } from '../../schema';

// A fixture schema: `events` has an index on event_date + a PK on id; `people` has an index on
// email (string) and a plain non-indexed `notes` column.
const schema: DatabaseSchema = {
	database: 'test',
	fetchedAt: 0,
	tables: [
		{
			name: 'events', kind: 'table',
			columns: [
				{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true },
				{ name: 'event_date', dataType: 'timestamp', nullable: true, isPrimaryKey: false },
				{ name: 'note', dataType: 'text', nullable: true, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [{ name: 'idx_event_date', columns: ['event_date'], unique: false }],
		},
		{
			name: 'people', kind: 'table',
			columns: [
				{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
				{ name: 'email', dataType: 'varchar(255)', nullable: true, isPrimaryKey: false },
				{ name: 'account_no', dataType: 'varchar(50)', nullable: true, isPrimaryKey: false },
				{ name: 'notes', dataType: 'text', nullable: true, isPrimaryKey: false },
			],
			primaryKey: ['id'],
			foreignKeys: [],
			indexes: [
				{ name: 'idx_email', columns: ['email'], unique: true },
				{ name: 'idx_account', columns: ['account_no'], unique: false },
			],
		},
	],
};

test('DATE() wrapping an indexed column is flagged with a range rewrite', () => {
	const out = lintSargability("SELECT * FROM events WHERE DATE(event_date) = '2020-01-01'", schema, 'postgres');
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'non-sargable-function');
	assert.equal(out[0].table, 'events');
	assert.equal(out[0].column, 'event_date');
	// Vendor-neutral half-open range with the correct next-day boundary (no engine-specific interval math).
	assert.equal(out[0].suggestedSql, "event_date >= '2020-01-01' AND event_date < '2020-01-02'");
	assert.doesNotMatch(out[0].suggestedSql ?? '', /interval|::date/i);
	assert.ok(out[0].range, 'should locate the DATE(event_date) span');
});

test('LOWER() on an indexed string column is flagged', () => {
	const out = lintSargability("SELECT * FROM people WHERE LOWER(email) = 'x@y.com'", schema, 'postgres');
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'non-sargable-function');
	assert.equal(out[0].column, 'email');
});

test('function wrapping a NON-indexed column is NOT flagged (no index to defeat)', () => {
	const out = lintSargability("SELECT * FROM events WHERE UPPER(note) = 'X'", schema, 'postgres');
	assert.deepEqual(out, []);
});

test('CAST of an indexed column is flagged', () => {
	const out = lintSargability('SELECT * FROM people WHERE CAST(email AS TEXT) = \'a\'', schema, 'postgres');
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'non-sargable-cast');
});

test('arithmetic on an indexed column is flagged', () => {
	const out = lintSargability('SELECT * FROM people WHERE id + 1 = 5', schema, 'postgres');
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'non-sargable-arith');
	assert.equal(out[0].column, 'id');
});

test('leading-wildcard LIKE on an indexed column is flagged', () => {
	const out = lintSargability("SELECT * FROM people WHERE email LIKE '%gmail.com'", schema, 'postgres');
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'leading-wildcard-like');
});

test('trailing-wildcard LIKE (sargable) is NOT flagged', () => {
	const out = lintSargability("SELECT * FROM people WHERE email LIKE 'admin%'", schema, 'postgres');
	assert.deepEqual(out, []);
});

test('string column compared to a numeric literal is flagged as a type mismatch', () => {
	const out = lintSargability('SELECT * FROM people WHERE account_no = 12345', schema, 'mysql-aurora');
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, 'type-mismatch');
	assert.equal(out[0].column, 'account_no');
});

test('a clean, sargable query produces no advisories (no false positives)', () => {
	const out = lintSargability("SELECT * FROM events e JOIN people p ON e.id = p.id WHERE e.event_date >= '2020-01-01' AND p.email = 'x@y.com'", schema, 'postgres');
	assert.deepEqual(out, []);
});

test('qualified column via alias resolves to the right table', () => {
	const out = lintSargability("SELECT * FROM events e WHERE DATE(e.event_date) = '2020-01-01'", schema, 'postgres');
	assert.equal(out.length, 1);
	assert.equal(out[0].table, 'events');
});

test('unparseable / empty input is silent', () => {
	assert.deepEqual(lintSargability('SELECT * FROM', schema, 'postgres'), []);
	assert.deepEqual(lintSargability('', schema, 'postgres'), []);
	assert.deepEqual(lintSargability('SELECT 1', undefined, 'postgres'), []);
});

test('ambiguous unqualified column across joined tables is not flagged', () => {
	// `id` exists on both events and people; DATE(id) can't be resolved unambiguously → silent.
	const out = lintSargability('SELECT * FROM events, people WHERE DATE(id) = 1', schema, 'postgres');
	assert.deepEqual(out, []);
});

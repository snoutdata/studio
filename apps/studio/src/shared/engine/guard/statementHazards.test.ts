/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyHazardFixes, statementHazards } from './statementHazards';

// The rule: `AND` where a comma was meant is one assignment of a boolean, not two assignments.
test('flags an AND-separated SET clause as a single assignment', () => {
	const sql = 'update products set discount = null and promo_code = null;';
	const hazards = statementHazards(sql);
	assert.equal(hazards.length, 1);
	assert.equal(hazards[0].kind, 'set-boolean-expression');
	assert.match(hazards[0].message, /Only "discount" is assigned/);
	assert.match(hazards[0].message, /"promo_code" will NOT be updated/);
	assert.equal(sql.slice(hazards[0].range.start, hazards[0].range.end), 'discount = null and promo_code = null');
});

test('suggests the comma form, and applying it yields the intended statement', () => {
	const sql = 'update products set discount = null and promo_code = null;';
	const hazards = statementHazards(sql);
	assert.equal(hazards[0].suggestedSql, 'discount = null, promo_code = null');
	assert.equal(applyHazardFixes(sql, hazards), 'update products set discount = null, promo_code = null;');
});

test('names every column the boolean expression swallows', () => {
	const hazards = statementHazards('UPDATE t SET a = 1 AND b = 2 AND c = 3 WHERE id = 9');
	assert.equal(hazards.length, 1);
	assert.match(hazards[0].message, /"b" and "c" will NOT be updated/);
	assert.equal(hazards[0].suggestedSql, 'a = 1, b = 2, c = 3');
});

test('the comma form is applied per assignment, leaving the rest of the statement alone', () => {
	const sql = 'UPDATE t SET a = 1 AND b = 2, c = 3 WHERE id = 9';
	assert.equal(applyHazardFixes(sql, statementHazards(sql)), 'UPDATE t SET a = 1, b = 2, c = 3 WHERE id = 9');
});

test('a correct comma-separated UPDATE is clean', () => {
	assert.deepEqual(statementHazards('update products set discount = null, promo_code = null where id = 1'), []);
});

test('a parenthesised boolean value is deliberate, not a hazard', () => {
	assert.deepEqual(statementHazards('UPDATE t SET is_ready = (a AND b) WHERE id = 1'), []);
});

test('AND in the WHERE clause is not a SET hazard', () => {
	assert.deepEqual(statementHazards("UPDATE t SET a = 1 WHERE b = 2 AND c = 3"), []);
});

test('AND inside a string literal or an identifier is ignored', () => {
	assert.deepEqual(statementHazards("UPDATE t SET note = 'x and y = z' WHERE id = 1"), []);
	assert.deepEqual(statementHazards('UPDATE t SET `a and b` = 1 WHERE id = 1'), []);
});

test('AND inside a function call is not top level', () => {
	assert.deepEqual(statementHazards('UPDATE t SET a = IF(x AND y, 1, 2) WHERE id = 1'), []);
});

test('a quoted column name is reported unquoted', () => {
	const hazards = statementHazards('UPDATE t SET `discount` = null AND `promo_code` = null');
	assert.match(hazards[0].message, /Only "discount" is assigned/);
	assert.match(hazards[0].message, /"promo_code" will NOT be updated/);
});

test('a qualified column keeps only its last segment', () => {
	const hazards = statementHazards('UPDATE t SET t.a = 1 AND t.b = 2');
	assert.match(hazards[0].message, /Only "a" is assigned/);
	assert.match(hazards[0].message, /"b" will NOT be updated/);
});

test('OR is flagged the same way as AND', () => {
	const hazards = statementHazards('UPDATE t SET a = 1 OR b = 2');
	assert.equal(hazards.length, 1);
	assert.match(hazards[0].rationale, /^OR does not separate assignments/);
});

test('each statement in a buffer is checked, with buffer-relative offsets', () => {
	const sql = 'select 1;\nupdate t set a = 1 and b = 2;';
	const hazards = statementHazards(sql);
	assert.equal(hazards.length, 1);
	assert.equal(sql.slice(hazards[0].range.start, hazards[0].range.end), 'a = 1 and b = 2');
});

test('flags "= NULL" in a WHERE clause', () => {
	const hazards = statementHazards('select * from t where token = NULL');
	assert.equal(hazards.length, 1);
	assert.equal(hazards[0].kind, 'null-comparison');
	assert.match(hazards[0].rationale, /Use IS NULL instead/);
});

test('flags "<> NULL" as the negated form', () => {
	const hazards = statementHazards('delete from t where token <> null');
	assert.equal(hazards[0].kind, 'null-comparison');
	assert.match(hazards[0].rationale, /Use IS NOT NULL instead/);
});

test('IS NULL, NULLIF and a SET of NULL are all fine', () => {
	assert.deepEqual(statementHazards('select * from t where token is null'), []);
	assert.deepEqual(statementHazards('select nullif(a, b) from t where c = 1'), []);
	assert.deepEqual(statementHazards('update t set a = null where id = 1'), []);
});

test('comments cannot smuggle a false positive', () => {
	assert.deepEqual(statementHazards('update t set a = 1 -- and b = 2\nwhere id = 1'), []);
	assert.deepEqual(statementHazards('update t set a = 1 /* and b = 2 */ where id = 1'), []);
});

test('never throws on partial or empty input', () => {
	for (const sql of ['', '   ', 'update', 'update t set', 'update t set a =', "update t set a = 'unclosed", 'update t set a = (1 and']) {
		assert.doesNotThrow(() => statementHazards(sql));
	}
});

test('a ClickHouse mutation says it is a rewrite, and a DELETE points at the lightweight one', () => {
	const sql = 'ALTER TABLE shop.events DELETE WHERE kind = 3';
	const [hazard] = statementHazards(sql);
	assert.equal(hazard.kind, 'clickhouse-mutation');
	assert.equal(sql.slice(hazard.range.start, hazard.range.end), 'DELETE');
	assert.match(hazard.message, /rewrites every part of shop\.events/);
	assert.match(hazard.rationale, /DELETE FROM shop\.events WHERE/);
	// It offers no rewrite of its own: a lightweight DELETE is not available on every server.
	assert.equal(hazard.suggestedSql, undefined);
	const update = statementHazards('ALTER TABLE t ON CLUSTER default UPDATE a = 1 WHERE id = 2');
	assert.deepEqual(update.map((h) => h.kind), ['clickhouse-mutation']);
	// The words in a string, or other ALTERs, are not mutations.
	assert.deepEqual(statementHazards("SELECT 'ALTER TABLE t DELETE WHERE 1'"), []);
	assert.deepEqual(statementHazards('ALTER TABLE t DROP COLUMN c'), []);
});

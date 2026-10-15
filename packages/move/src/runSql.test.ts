/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chunks, copyProgressFromPg, createDatabaseSql, pgRowCountsSql, pgSequencesSql, pgTableSizesSql, tableCountsFromPg, tableEstimatesFromPg } from './runSql.js';

// Whether these statements RUN is the live test's (`runner/live.test.ts`); this is their text.

test('nothing selected asks nothing, rather than writing `in ()`', () => {
	assert.match(pgTableSizesSql([], []), /'\[\]'::json/);
	assert.match(pgRowCountsSql([]), /'\[\]'::json/);
	assert.match(pgSequencesSql([]), /'\[\]'::json/);
});

test('names reach the statements as literals and identifiers, never as SQL', () => {
	const sizes = pgTableSizesSql(["it's"], [{ schema: 'public', table: 'x"y', reason: 'r' }]);
	assert.match(sizes, /in \(E'it''s'\)/);
	assert.match(sizes, /c\.relname = E'x"y'/);
	assert.match(pgRowCountsSql([{ schema: 'a', table: "b'c" }]), /\(E'a', E'b''c'\)/);
	assert.equal(createDatabaseSql('Shop "copy"'), 'create database "Shop ""copy"""');
});

test('answers are read from JSON or its text, and a malformed row is skipped', () => {
	assert.deepEqual(tableEstimatesFromPg('[{"schema":"public","table":"t","bytes":"8192","rows":null},{"nope":1}]'), [
		{ schema: 'public', table: 't', bytes: 8192, rows: null }
	]);
	assert.deepEqual(tableCountsFromPg([{ schema: 's', table: 't', rows: null }]), [{ schema: 's', table: 't', rows: null }]);
	assert.deepEqual(copyProgressFromPg(null), []);
});

test('chunks keeps every item, in order', () => {
	assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { excerpt } from './context.js';
describe('excerpt', () => {
	// Both of these came out of the first review of a real migration.
	const NL = String.fromCharCode(10);

	test('a line comment above the statement is not the statement', () => {
		// `splitStatements` starts a statement at the comments above it, because that is what
		// decides its line number. They are the author's note, not the thing being reviewed.
		const sql = ['-- Every order gets a ship date now.', 'ALTER TABLE orders MODIFY ship_date DATE NOT NULL;'].join(NL);
		assert.equal(excerpt(sql), 'ALTER TABLE orders MODIFY ship_date DATE NOT NULL;');
	});

	test('a comment INSIDE the statement keeps its own line, or it swallows the SQL', () => {
		// This is the one that matters. A line comment ends at the newline, so flattening puts
		// everything after it inside the comment: the block reads as a no-op and anybody who
		// copies it runs nothing.
		const sql = ['UPDATE orders', '-- only the unshipped ones', "SET status = 'x';"].join(NL);
		const out = excerpt(sql);
		assert.equal(out, ['UPDATE orders', '-- only the unshipped ones', "SET status = 'x';"].join(NL));
		assert.ok(!/-- only the unshipped ones SET/.test(out));
	});

	test('a statement with no comment is still one flat line', () => {
		const sql = ['SELECT status, COUNT(*)', 'FROM orders', 'GROUP BY status;'].join(NL);
		assert.equal(excerpt(sql), 'SELECT status, COUNT(*) FROM orders GROUP BY status;');
	});

	test('two dashes inside a string are not a comment', () => {
		const sql = ["INSERT INTO notes (body)", "VALUES ('a -- b');"].join(NL);
		assert.ok(excerpt(sql).includes("'a -- b'"));
	});

	test('a long statement is capped with an ellipsis', () => {
		assert.ok(excerpt('SELECT ' + 'x'.repeat(400)).endsWith(String.fromCharCode(8230)));
	});
});

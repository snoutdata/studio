/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeResultDump } from './canvas';

/*
 * The "show the query, not the rows" hint.
 *
 * The app's answer to an agent pasting a result set is to say so in the RESULT of the call that did
 * it, not to refuse the call. What has to be right is which markdown counts: a table that is the
 * point (a short comparison) must not be nagged, and rows out of a query must be.
 */

function table(rows: number): string {
	const body = Array.from({ length: rows }, (_, i) => `| ${i} | user${i} | user${i}@example.com |`).join('\n');
	return `Here they are:\n\n| id | name | email |\n| --- | --- | --- |\n${body}\n`;
}

describe('looksLikeResultDump', () => {
	test('a page of fetched rows is one', () => {
		assert.equal(looksLikeResultDump(table(5)), true);
		assert.equal(looksLikeResultDump(table(40)), true);
	});

	test('a short table making a point is not', () => {
		// A two- or three-row table is a comparison, a plan summary, a before/after. Nagging about
		// those would train the agent to stop using tables at all.
		assert.equal(looksLikeResultDump(table(1)), false);
		assert.equal(looksLikeResultDump(table(3)), false);
	});

	test('prose and a SQL card are exactly what we asked for', () => {
		const good = 'Five users, all in Portugal bar one.\n\n```sql\nselect * from user limit 5;\n```\n';
		assert.equal(looksLikeResultDump(good), false);
	});

	test('two small tables are not one big one', () => {
		// Counted per table, so a document of short tables reads as short tables.
		assert.equal(looksLikeResultDump(`${table(2)}\nand also\n\n${table(2)}`), false);
	});

	test('the separator row is the frame, not a row', () => {
		assert.equal(looksLikeResultDump('| a |\n| --- |\n| 1 |\n| 2 |\n| 3 |\n'), false);
		assert.equal(looksLikeResultDump('| a |\n| :-- |\n| 1 |\n| 2 |\n| 3 |\n| 4 |\n'), true);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { jsonCell, pgLiteral } from './projectSql';

test('a json cell reads the same whether the local driver parsed it or the cloud sent its text', () => {
	const row = { series: 'metrics', partitions: 20 };
	assert.deepEqual(jsonCell(row), row);
	assert.deepEqual(jsonCell(JSON.stringify(row)), row);
	// Nothing to read is an empty object, never a throw that blanks the whole section.
	assert.deepEqual(jsonCell(null), {});
	assert.deepEqual(jsonCell('not json'), {});
});

test('a literal doubles its quotes and refuses a control character', () => {
	assert.equal(pgLiteral("it's"), "'it''s'");
	assert.throws(() => pgLiteral('a\u0000b'));
});

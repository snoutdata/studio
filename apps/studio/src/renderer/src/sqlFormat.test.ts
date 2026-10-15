/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql } from './sqlFormat';

test('formats a query onto multiple lines', () => {
	const out = formatSql('select a,b from t where x=1', 'mysql-aurora', 'preserve');
	assert.match(out, /\bfrom\b/);
	assert.ok(out.includes('\n'), 'expected multi-line output');
});

test('keywordCase upper uppercases keywords', () => {
	const out = formatSql('select 1', 'postgres', 'upper');
	assert.match(out, /SELECT/);
});

test('keywordCase preserve leaves lowercase keywords lowercase', () => {
	const out = formatSql('select 1', 'postgres', 'preserve');
	assert.match(out, /select/);
	assert.doesNotMatch(out, /SELECT/);
});

test('sqlserver formats via the transactsql dialect', () => {
	const out = formatSql('select top 1 a from t', 'sqlserver', 'upper');
	assert.match(out, /SELECT/);
	assert.match(out, /TOP/);
});

test('unparseable input is returned unchanged', () => {
	const junk = '))) not ; valid (((';
	assert.equal(formatSql(junk, undefined, 'preserve'), junk);
});

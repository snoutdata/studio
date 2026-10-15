/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildFixPrompt, buildErrorHelpPrompt, buildExplainQueryPrompt, buildOptimizeQueryPrompt, buildOptimizeFollowUp } from './aiFix';
import { dialectFor } from '../../shared/engine';

test('buildFixPrompt embeds the error and the SQL in a fenced block', () => {
	const prompt = buildFixPrompt('SELECT id_ FROM user;', "Unknown column 'id_' in 'field list'");
	assert.match(prompt, /Unknown column 'id_' in 'field list'/);
	assert.match(prompt, /```sql\nSELECT id_ FROM user;\n```/);
	assert.match(prompt, /corrected SQL in a single ```sql block/);
});

test('buildFixPrompt trims surrounding whitespace from inputs', () => {
	const prompt = buildFixPrompt('\n  SELECT 1  \n', '  boom  ');
	assert.match(prompt, /SQL:\n```sql\nSELECT 1\n```/);
	assert.match(prompt, /Error:\nboom\n/);
});

test('buildErrorHelpPrompt embeds the title and detail and asks for a plain fix', () => {
	const prompt = buildErrorHelpPrompt('Connection failed', 'Failed to connect to 127.0.0.1:1433 - Could not connect (sequence)');
	assert.match(prompt, /Connection failed/);
	assert.match(prompt, /127\.0\.0\.1:1433/);
	assert.match(prompt, /Error:/);
	assert.match(prompt, /what it means and the most likely fix/);
});

test('buildErrorHelpPrompt omits an empty detail line', () => {
	const prompt = buildErrorHelpPrompt('Sign-in failed', '');
	assert.match(prompt, /Error:\nSign-in failed\n/);
});

test('buildExplainQueryPrompt embeds the statement + flavour and asks for diagnosis, no SQL', () => {
	const prompt = buildExplainQueryPrompt('  SELECT * FROM orders WHERE status = 1  ', dialectFor('mysql-aurora'));
	assert.match(prompt, /heaviest statements by total execution time on a connected MySQL database/);
	assert.match(prompt, /```sql\nSELECT \* FROM orders WHERE status = 1\n```/);
	assert.match(prompt, /Do NOT propose a fix or write any SQL yet/);
});

test('buildOptimizeQueryPrompt embeds the statement, the flavour, asks to EXPLAIN first, and injects vendor tuning levers', () => {
	const prompt = buildOptimizeQueryPrompt('  SELECT * FROM orders WHERE status = 1  ', dialectFor('postgres'));
	assert.match(prompt, /heaviest by total execution time on the connected PostgreSQL database/);
	assert.match(prompt, /```sql\nSELECT \* FROM orders WHERE status = 1\n```/);
	assert.match(prompt, /confirm the plan by running EXPLAIN/);
	assert.match(prompt, /PostgreSQL tuning levers/);
	assert.match(prompt, /EXPLAIN \(ANALYZE, BUFFERS\)/);
	assert.match(prompt, /single ```sql block/);
});

test('buildOptimizeQueryPrompt falls back cleanly for an engine with no tuning levers', () => {
	const prompt = buildOptimizeQueryPrompt('SELECT 1', { aiDisplayName: 'SQL' });
	assert.match(prompt, /smallest effective fix: a covering\/filtering index or a query rewrite/);
	assert.doesNotMatch(prompt, /tuning levers/);
});

test('buildOptimizeFollowUp reuses the prior analysis and carries the vendor levers', () => {
	const prompt = buildOptimizeFollowUp(dialectFor('mysql-aurora'));
	assert.match(prompt, /building on your analysis above/);
	assert.match(prompt, /MySQL tuning levers/);
	assert.match(prompt, /composite index/);
	assert.match(prompt, /one ```sql block/);
});

test('a resource limit is not sent to the model as a naming problem', () => {
	const prompt = buildFixPrompt('SELECT * FROM events', 'Code: 241. DB::Exception: memory limit exceeded. (MEMORY_LIMIT_EXCEEDED)');
	assert.match(prompt, /This is a resource limit, not a syntax or naming error/);
	assert.doesNotMatch(buildFixPrompt('SELECT x FROM t', 'Code: 47. DB::Exception: Unknown expression identifier `x`'), /resource limit|ran out of time/);
});

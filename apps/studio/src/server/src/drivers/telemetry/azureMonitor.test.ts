/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kqlBracket, kqlSource } from './azureMonitor';

const WINDOW = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 2) };

test('kqlBracket escapes a quote', () => {
	assert.equal(kqlBracket("it's"), "['it\\'s']");
});

test('kqlBracket escapes a trailing backslash, so it cannot escape the closing quote', () => {
	assert.equal(kqlBracket('a\\'), "['a\\\\']");
});

test('kqlBracket escapes the backslash before the quote it precedes', () => {
	// `a\'` must become `a\\\'`: an escaped backslash, then an escaped quote. Escaping only the quote
	// would give `a\\'`, which ends the literal at that quote.
	assert.equal(kqlBracket("a\\'"), "['a\\\\\\'']");
});

test('a table name ending in a backslash stays one quoted identifier', () => {
	const kql = kqlSource({ scope: 'My-Table\\', ...WINDOW });
	assert.ok(kql.startsWith("['My-Table\\\\'] | where TimeGenerated >= "), kql);
});

test('a column name with a quote or a trailing backslash stays one quoted identifier', () => {
	const kql = kqlSource({
		scope: 'AppTraces',
		...WINDOW,
		where: [
			{ op: '=', field: "o'brien", value: 'x' },
			{ op: 'is null', field: 'path\\' },
		],
	});
	assert.ok(kql.includes("| where ['o\\'brien'] = \"x\""), kql);
	assert.ok(kql.includes("| where isnull(['path\\\\'])"), kql);
});

test('a plain identifier is not quoted', () => {
	assert.ok(kqlSource({ scope: 'AppTraces', ...WINDOW }).startsWith('AppTraces | where '));
});

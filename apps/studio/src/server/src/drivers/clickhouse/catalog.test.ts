/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { introspectClickHouseCatalog } from './catalog';
import type { ClickHouseRowRunner } from './introspection';

const FUNCTIONS = [
	{ name: 'sum', is_aggregate: 1, alias_to: '', description: '\n    Calculates the sum.\n    ', syntax: 'sum(num)', arguments: '- `num`', returned_value: 'The sum.', examples: 'SELECT sum(x)' },
	{ name: 'toStartOfHour', is_aggregate: 0, alias_to: '', description: 'Rounds down to the hour.', syntax: '', arguments: '', returned_value: '', examples: '' },
	{ name: 'SUM', is_aggregate: 1, alias_to: 'sum', description: '', syntax: '', arguments: '', returned_value: '', examples: '' },
];

const SETTINGS = [
	{ name: 'max_threads', value: '8', type: 'MaxThreads', description: 'How many threads.', tier: 'Production' },
	{ name: 'allow_experimental_json_type', value: '0', type: 'Bool', description: 'Try the JSON type.', tier: 'Experimental' },
];

/** A server that answers everything: the rich projection of every list. */
const full: ClickHouseRowRunner = async (sql) => {
	if (sql.includes('system.functions')) {
		return FUNCTIONS;
	}
	if (sql.includes('aggregate_function_combinators')) {
		return [{ name: 'If', description: 'Filters the rows.', syntax: '', examples: '' }, { name: 'State', description: 'Keeps the intermediate state.', syntax: '', examples: '' }];
	}
	if (sql.includes('system.table_functions')) {
		return [{ name: 's3', description: 'Reads files from S3.' }];
	}
	if (sql.includes('system.table_engines')) {
		return [{ name: 'MergeTree', description: 'The one.', supports_sort_order: 1, supports_settings: 1, supports_skipping_indices: 1, supports_projections: 1, supports_ttl: 1, supports_replication: 0, supports_deduplication: 0 }];
	}
	if (sql.includes('data_type_families')) {
		return [{ name: 'UInt64', alias_to: '', description: 'An unsigned 64-bit integer.', syntax: '' }];
	}
	if (sql.includes('system.formats')) {
		return [{ name: 'Pretty', is_input: 0, is_output: 1, description: 'A table drawn in text.' }, { name: 'Parquet', is_input: 1, is_output: 1, description: '' }];
	}
	if (sql.includes('system.settings')) {
		return SETTINGS;
	}
	return [];
};

describe('the ClickHouse catalog', () => {
	test('reads every list, with the server\'s own prose', async () => {
		const catalog = await introspectClickHouseCatalog(full);
		assert.equal(catalog.driverId, 'clickhouse');
		assert.equal(catalog.functions.length, 3);
		assert.equal(catalog.combinators.length, 2);
		assert.equal(catalog.tableFunctions[0].description, 'Reads files from S3.');
		assert.equal(catalog.dataTypes[0].name, 'UInt64');
		assert.equal(catalog.formats.find((f) => f.name === 'Pretty')?.output, true);
		assert.equal(catalog.formats.find((f) => f.name === 'Pretty')?.input, undefined);
		assert.equal(catalog.settings.find((s) => s.name === 'max_threads')?.value, '8');
	});

	test('an aggregate says so, an alias says what it is an alias of', async () => {
		const { functions } = await introspectClickHouseCatalog(full);
		assert.equal(functions.find((f) => f.name === 'sum')?.aggregate, true);
		assert.equal(functions.find((f) => f.name === 'toStartOfHour')?.aggregate, undefined);
		assert.equal(functions.find((f) => f.name === 'SUM')?.aliasTo, 'sum');
	});

	// The server writes its descriptions inside C++ raw strings, so they arrive wrapped in the
	// indentation of the source file. Shown as they came, every hover starts with a blank line.
	test('the prose is trimmed of the indentation it was written in', async () => {
		const { functions } = await introspectClickHouseCatalog(full);
		assert.equal(functions.find((f) => f.name === 'sum')?.description, 'Calculates the sum.');
	});

	// ClickHouse writes its argument lists with a dash between the name and what it means. We put
	// no dashes in the UI, so the punctuation is ours and the words stay theirs.
	test('a dash between an argument and its meaning becomes a colon', async () => {
		const args = ['- `datetime` — A date or date with time.', '- `timezone` — Optional. The timezone.'].join('\n');
		const dashed: ClickHouseRowRunner = async (sql) => (sql.includes('system.functions')
			? [{ name: 'toYYYYMM', is_aggregate: 0, alias_to: '', description: 'Converts a date — with a timezone — to a number.', syntax: '', arguments: args, returned_value: '', examples: '' }]
			: []);
		const { functions } = await introspectClickHouseCatalog(dashed);
		assert.equal(functions[0].arguments, ['- `datetime`: A date or date with time.', '- `timezone`: Optional. The timezone.'].join('\n'));
		assert.equal(functions[0].description, 'Converts a date, with a timezone, to a number.');
	});

	test('a production setting carries no tier, anything else does', async () => {
		const { settings } = await introspectClickHouseCatalog(full);
		assert.equal(settings.find((s) => s.name === 'max_threads')?.tier, undefined);
		assert.equal(settings.find((s) => s.name === 'allow_experimental_json_type')?.tier, 'Experimental');
	});

	test('a table engine says what it supports, in one line', async () => {
		const { tableEngines } = await introspectClickHouseCatalog(full);
		assert.equal(tableEngines[0].supports, 'sort order, settings, skip indexes, projections, TTL');
	});

	// An older server has `name` and not `description`, and asking for a column it has not got is an
	// error, not an empty string. Each list falls back to the columns every version has.
	test('a server missing the rich columns still gives the names', async () => {
		const older: ClickHouseRowRunner = async (sql) => {
			if (sql.includes('description')) {
				throw new Error("Missing columns: 'description'");
			}
			return sql.includes('system.functions') ? [{ name: 'sum', is_aggregate: 1, alias_to: '' }] : [];
		};
		const catalog = await introspectClickHouseCatalog(older);
		assert.deepEqual(catalog.functions, [{ name: 'sum', aggregate: true }]);
	});

	// A restricted user is refused `system.functions` outright. That loses completion for functions
	// and must lose nothing else — least of all the connection.
	test('a refused read empties one list and never throws', async () => {
		const refused: ClickHouseRowRunner = async (sql) => {
			if (sql.includes('system.functions')) {
				throw new Error('Not enough privileges');
			}
			return sql.includes('system.formats') ? [{ name: 'Parquet', is_input: 1, is_output: 1 }] : [];
		};
		const catalog = await introspectClickHouseCatalog(refused);
		assert.deepEqual(catalog.functions, []);
		assert.equal(catalog.formats.length, 1);
	});
});

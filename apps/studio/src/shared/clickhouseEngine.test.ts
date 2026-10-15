/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	blankEngineDraft,
	engineById,
	engineClause,
	engineName,
	engineProblems,
	MERGE_TREE_ENGINES,
	onClusterClause,
} from './clickhouseEngine';

const PATH = { database: 'shop', table: 'events' };

describe('engineName', () => {
	test('a plain engine takes no parentheses', () => {
		assert.equal(engineName(blankEngineDraft(), PATH), 'MergeTree');
	});

	test('an engine parameter is written as typed', () => {
		assert.equal(engineName({ ...blankEngineDraft(), engine: 'ReplacingMergeTree', parameter: 'updated_at' }, PATH), 'ReplacingMergeTree(updated_at)');
	});

	// The Keeper path and the replica name come BEFORE the engine's own argument, and the database
	// and table are spelled out so the path is exact on a server without {database}/{table} macros.
	test('a replicated engine puts the Keeper path and replica first', () => {
		assert.equal(
			engineName({ ...blankEngineDraft(), engine: 'ReplacingMergeTree', parameter: 'ver', replicated: true, cluster: 'default' }, PATH),
			"ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/shop/events', '{replica}', ver)",
		);
	});

	test('{shard} and {replica} stay macros; nothing else does', () => {
		const name = engineName({ ...blankEngineDraft(), replicated: true, cluster: 'default' }, PATH);
		assert.ok(name.includes('{shard}'));
		assert.ok(name.includes('{replica}'));
		assert.ok(!name.includes('{database}'));
		assert.ok(!name.includes('{table}'));
	});
});

describe('engineClause', () => {
	// PARTITION BY has to come before ORDER BY: the other way round is a syntax error.
	test('writes the clauses in the order ClickHouse requires', () => {
		const clause = engineClause(
			{ engine: 'MergeTree', parameter: '', replicated: false, cluster: '', partitionBy: 'toYYYYMM(ts)', ttl: 'ts + INTERVAL 90 DAY', settings: 'index_granularity = 8192' },
			'(kind, ts)',
			PATH,
		);
		const order = ['ENGINE = MergeTree', 'PARTITION BY toYYYYMM(ts)', 'ORDER BY (kind, ts)', 'TTL ts + INTERVAL 90 DAY', 'SETTINGS index_granularity = 8192'];
		let at = -1;
		for (const part of order) {
			const found = clause.indexOf(part);
			assert.ok(found > at, `${part} out of order in:\n${clause}`);
			at = found;
		}
	});

	test('an empty clause is left out entirely, not written empty', () => {
		const clause = engineClause(blankEngineDraft(), '(id)', PATH);
		assert.equal(clause, 'ENGINE = MergeTree\nORDER BY (id)');
	});

	test('a table with no key columns is ordered by nothing, which is legal', () => {
		assert.match(engineClause(blankEngineDraft(), 'tuple()', PATH), /ORDER BY tuple\(\)/);
	});
});

describe('onClusterClause', () => {
	test('a cluster name with a backslash before a backtick stays one identifier', () => {
		assert.equal(onClusterClause({ ...blankEngineDraft(), replicated: true, cluster: 'c\\`x' }), ' ON CLUSTER `c\\\\``x`');
	});

	test('only when the table is replicated AND a cluster was named', () => {
		assert.equal(onClusterClause(blankEngineDraft()), '');
		assert.equal(onClusterClause({ ...blankEngineDraft(), replicated: true, cluster: '' }), '');
		assert.equal(onClusterClause({ ...blankEngineDraft(), replicated: true, cluster: 'default' }), ' ON CLUSTER `default`');
	});
});

describe('engineProblems', () => {
	test('a CollapsingMergeTree without its sign column will not be created', () => {
		const problems = engineProblems({ ...blankEngineDraft(), engine: 'CollapsingMergeTree' }, '(id)');
		assert.equal(problems.length, 1);
		assert.equal(problems[0].blocking, true);
		assert.match(problems[0].message, /sign column/i);
	});

	test('given its sign column it is fine', () => {
		assert.deepEqual(engineProblems({ ...blankEngineDraft(), engine: 'CollapsingMergeTree', parameter: 'sign' }, '(id)'), []);
	});

	// Legal, does exactly what it says, and is essentially never what was meant.
	test('a deduplicating engine with no sort key is warned about, not refused', () => {
		const problems = engineProblems({ ...blankEngineDraft(), engine: 'ReplacingMergeTree' }, 'tuple()');
		assert.equal(problems.length, 1);
		assert.equal(problems[0].blocking, false);
		assert.match(problems[0].message, /whole table merges into one/);
	});

	test('a plain MergeTree with no sort key is normal and says nothing', () => {
		assert.deepEqual(engineProblems(blankEngineDraft(), 'tuple()'), []);
	});

	test('a TTL with no partitioning is worth a word', () => {
		const problems = engineProblems({ ...blankEngineDraft(), ttl: 'ts + INTERVAL 1 DAY' }, '(id)');
		assert.equal(problems.length, 1);
		assert.equal(problems[0].blocking, false);
		assert.match(problems[0].message, /whole partition be dropped/);
	});

	test('replicating without naming a cluster will not be created', () => {
		const problems = engineProblems({ ...blankEngineDraft(), replicated: true }, '(id)');
		assert.ok(problems.some((p) => p.blocking && /cluster/i.test(p.message)));
	});
});

describe('the catalogue', () => {
	test('every engine is a MergeTree, has a hint, and a required parameter has a placeholder', () => {
		for (const engine of MERGE_TREE_ENGINES) {
			assert.match(engine.id, /MergeTree$/, engine.id);
			assert.ok(engine.hint.length > 20, engine.id);
			if (engine.parameter?.required) {
				assert.ok(engine.parameter.placeholder !== '', engine.id);
			}
		}
	});

	test('the default draft names an engine the catalogue has', () => {
		assert.ok(engineById(blankEngineDraft().engine));
	});
});

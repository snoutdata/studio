/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CLICKHOUSE_EXPLAIN_VARIANTS,
	explainTarget,
	explainText,
	parseExplainPlan,
	planReads,
	readExplainEstimate,
} from './explain';

// A real `EXPLAIN PLAN json = 1, indexes = 1, projections = 1` answer from ClickHouse 26.8, cut to
// the two nodes that matter: the aggregate above and the MergeTree read below it.
const PLAN_JSON = JSON.stringify([
	{
		Plan: {
			'Node Type': 'Aggregating',
			'Node Id': 'Aggregating_4',
			Keys: ['__table1.kind'],
			'Skip merging': false,
			Plans: [
				{
					'Node Type': 'ReadFromMergeTree',
					'Node Id': 'ReadFromMergeTree_0',
					Description: 'shop.events',
					Indexes: [
						{ Type: 'Min-Max', Keys: ['ts'], Condition: '(ts in [1717200001, +Inf))', 'Initial Parts': 588, 'Selected Parts': 588, 'Initial Granules': 1194, 'Selected Granules': 1194 },
						{ Type: 'Partition', Keys: ['toYYYYMM(ts)'], 'Initial Parts': 588, 'Selected Parts': 588, 'Initial Granules': 1194, 'Selected Granules': 1194 },
						{ Type: 'PrimaryKey', Keys: ['kind', 'ts'], 'Search Algorithm': 'binary search', 'Initial Parts': 588, 'Selected Parts': 8, 'Initial Granules': 1194, 'Selected Granules': 210 },
					],
				},
			],
		},
	},
]);

describe('explainTarget', () => {
	test('drops the trailing semicolon', () => {
		assert.equal(explainTarget('SELECT 1;  '), 'SELECT 1');
	});

	// The FORMAT belongs to the user's SELECT, but on an EXPLAIN it reformats the PLAN, so the
	// answer comes back as CSV text and nothing can read it.
	test('drops a trailing FORMAT clause', () => {
		assert.equal(explainTarget('SELECT * FROM t FORMAT CSV'), 'SELECT * FROM t');
		assert.equal(explainTarget('SELECT * FROM t FORMAT JSONEachRow ;'), 'SELECT * FROM t');
	});

	// SETTINGS changes the plan, which is usually the reason it was typed.
	test('keeps a trailing SETTINGS clause', () => {
		assert.equal(explainTarget('SELECT * FROM t SETTINGS max_threads = 1'), 'SELECT * FROM t SETTINGS max_threads = 1');
	});

	test('a FORMAT inside a string or a subquery is not the tail', () => {
		assert.equal(explainTarget("SELECT 'FORMAT CSV'"), "SELECT 'FORMAT CSV'");
		assert.equal(explainTarget('SELECT * FROM (SELECT 1 FORMAT CSV)'), 'SELECT * FROM (SELECT 1 FORMAT CSV)');
	});

	test('a column called format survives', () => {
		assert.equal(explainTarget('SELECT format FROM t'), 'SELECT format FROM t');
	});
});

describe('ClickHouse explain variants', () => {
	test('the plan asks richest first, and every attempt is a plan of the same query', () => {
		const plan = CLICKHOUSE_EXPLAIN_VARIANTS.find((v) => v.id === 'plan');
		assert.ok(plan);
		const attempts = plan.statements('SELECT 1;');
		assert.equal(attempts.length, 3);
		assert.match(attempts[0], /^EXPLAIN PLAN json = 1, indexes = 1, projections = 1 SELECT 1$/);
		// The last attempt must ask for nothing a very old server has not got.
		assert.match(attempts[attempts.length - 1], /^EXPLAIN PLAN json = 1 SELECT 1$/);
		for (const attempt of attempts) {
			assert.ok(attempt.endsWith('SELECT 1'));
		}
	});

	test('every variant builds at least one statement and none of them runs the query', () => {
		for (const variant of CLICKHOUSE_EXPLAIN_VARIANTS) {
			const attempts = variant.statements('SELECT 1 FORMAT CSV');
			assert.ok(attempts.length > 0, variant.id);
			for (const attempt of attempts) {
				assert.match(attempt, /^EXPLAIN /, variant.id);
				assert.ok(!/FORMAT CSV/.test(attempt), variant.id);
			}
		}
	});
});

describe('parseExplainPlan', () => {
	test('reads the tree, its facts and the read under it', () => {
		const nodes = parseExplainPlan(PLAN_JSON);
		assert.ok(nodes);
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0].type, 'Aggregating');
		assert.deepEqual(nodes[0].facts.find((f) => f.label === 'Keys'), { label: 'Keys', value: '__table1.kind' });
		// `Skip merging: false` is a fact, not an absent one: false is what the server said.
		assert.deepEqual(nodes[0].facts.find((f) => f.label === 'Skip merging'), { label: 'Skip merging', value: 'false' });
		assert.equal(nodes[0].children.length, 1);
		assert.equal(nodes[0].children[0].type, 'ReadFromMergeTree');
	});

	test('a read is what the FIRST index started with and the LAST one kept', () => {
		const reads = planReads(parseExplainPlan(PLAN_JSON) ?? []);
		assert.equal(reads.length, 1);
		assert.equal(reads[0].target, 'shop.events');
		assert.equal(reads[0].fromProjection, false);
		assert.deepEqual(reads[0].granules, { initial: 1194, selected: 210 });
		assert.deepEqual(reads[0].parts, { initial: 588, selected: 8 });
		assert.equal(reads[0].indexes.length, 3);
		assert.equal(reads[0].indexes[2].type, 'PrimaryKey');
		assert.deepEqual(reads[0].indexes[2].keys, ['kind', 'ts']);
	});

	// A read answered from a projection names the projection, which has no database prefix.
	test('a projection read is marked as one', () => {
		const plan = JSON.stringify([{ Plan: { 'Node Type': 'ReadFromMergeTree', Description: 'by_country', Indexes: [{ Type: 'PrimaryKey', 'Initial Granules': 40, 'Selected Granules': 2 }] } }]);
		const reads = planReads(parseExplainPlan(plan) ?? []);
		assert.equal(reads[0].fromProjection, true);
		assert.deepEqual(reads[0].granules, { initial: 40, selected: 2 });
	});

	// `indexes = 1` refused (an old server took the fallback): the tree still draws, the reading
	// behind it is simply absent rather than invented.
	test('a plan without Indexes has nodes but no reads', () => {
		const plan = JSON.stringify([{ Plan: { 'Node Type': 'ReadFromMergeTree', Description: 'shop.events' } }]);
		const nodes = parseExplainPlan(plan);
		assert.ok(nodes);
		assert.equal(planReads(nodes).length, 0);
	});

	test('anything that is not a plan document is refused rather than drawn empty', () => {
		assert.equal(parseExplainPlan('not json'), null);
		assert.equal(parseExplainPlan('[]'), null);
		assert.equal(parseExplainPlan(undefined), null);
	});
});

describe('readExplainEstimate', () => {
	test('reads by column name, and 64-bit counts that arrived as digits', () => {
		const fields = [{ name: 'database' }, { name: 'table' }, { name: 'parts' }, { name: 'rows' }, { name: 'marks' }];
		const rows = readExplainEstimate(fields, [['shop', 'events', 7, '57344', 7]]);
		assert.deepEqual(rows, [{ database: 'shop', table: 'events', parts: 7, rows: 57344, marks: 7 }]);
	});

	test('an answer without the columns it needs is empty, not wrong', () => {
		assert.deepEqual(readExplainEstimate([{ name: 'explain' }], [['(Expression)']]), []);
	});
});

describe('explainText', () => {
	test('puts the one-cell-per-line answer back together', () => {
		assert.equal(explainText([['(Expression)'], ['ExpressionTransform × 8'], [null]]), '(Expression)\nExpressionTransform × 8\n');
	});
});

describe('parseExplainPlan on a Postgres 18 plan', () => {
	// 18's EXPLAIN ANALYZE includes BUFFERS without being asked and an index scan reports its
	// Index Searches; both arrive as plain facts, and the document's timing keys are not nodes.
	test('reads the tree, with the buffer counts and index searches as facts', () => {
		const plan = JSON.stringify([{
			Plan: {
				'Node Type': 'Index Scan',
				'Relation Name': 'users',
				'Index Name': 'users_tenant_email_idx',
				'Actual Rows': 1,
				'Index Searches': 3,
				'Shared Hit Blocks': 124,
				'Shared Read Blocks': 2,
			},
			Planning: { 'Shared Hit Blocks': 12 },
			'Planning Time': 0.21,
			Triggers: [],
			'Execution Time': 0.5,
		}]);
		const nodes = parseExplainPlan(plan);
		assert.ok(nodes);
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0].type, 'Index Scan');
		assert.deepEqual(nodes[0].facts.find((f) => f.label === 'Index Searches'), { label: 'Index Searches', value: '3' });
		assert.deepEqual(nodes[0].facts.find((f) => f.label === 'Shared Hit Blocks'), { label: 'Shared Hit Blocks', value: '124' });
		assert.equal(nodes[0].read, undefined);
		assert.equal(nodes[0].children.length, 0);
	});
});

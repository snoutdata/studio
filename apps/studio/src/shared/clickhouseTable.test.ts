/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	anatomySql,
	isMergeTreeEngine,
	missingSystemTable,
	partitionsSql,
	PARTITION_ACTIONS,
	projectionsSql,
	qualified,
	readAnatomy,
	settingsOf,
	skipIndexSql,
	ttlOf,
} from './clickhouseTable';

// A real `system.tables` row from ClickHouse 26.8.
const ANAT = {
	engine: 'MergeTree',
	engine_full: 'MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (intHash64(uid), ts) SAMPLE BY intHash64(uid) TTL ts + toIntervalYear(2) SETTINGS index_granularity = 8192',
	partition_key: 'toYYYYMM(ts)',
	sorting_key: 'intHash64(uid), ts',
	primary_key: 'intHash64(uid), ts',
	sampling_key: 'intHash64(uid)',
	storage_policy: 'default',
	total_rows: 50000,
	total_bytes: 669320,
	parts: 2,
	active_parts: 1,
	total_marks: 14,
};

describe('readAnatomy', () => {
	test('reads the clauses the server broke out, in the order they are written', () => {
		const a = readAnatomy(ANAT);
		assert.equal(a.engine, 'MergeTree');
		assert.deepEqual(a.clauses.map((c) => c.label), ['PARTITION BY', 'ORDER BY', 'SAMPLE BY', 'TTL']);
		assert.equal(a.clauses[1].value, 'intHash64(uid), ts');
		assert.equal(a.clauses[3].value, 'ts + toIntervalYear(2)');
		assert.deepEqual(a.settings, [{ label: 'index_granularity', value: '8192' }]);
		assert.equal(a.isMergeTree, true);
	});

	// A PRIMARY KEY equal to the ORDER BY is the usual case and teaches nobody anything; it earns
	// a line only when the sparse index is SHORTER than the sort order.
	test('PRIMARY KEY is a line only when it differs from ORDER BY', () => {
		assert.equal(readAnatomy(ANAT).clauses.find((c) => c.label === 'PRIMARY KEY'), undefined);
		const shorter = readAnatomy({ ...ANAT, primary_key: 'intHash64(uid)' });
		assert.equal(shorter.clauses.find((c) => c.label === 'PRIMARY KEY')?.value, 'intHash64(uid)');
	});

	test('a table with no key clauses at all says nothing rather than empty lines', () => {
		const memory = readAnatomy({ engine: 'Memory', engine_full: 'Memory', partition_key: '', sorting_key: '', primary_key: '', sampling_key: '', storage_policy: '', total_rows: 0 });
		assert.deepEqual(memory.clauses, []);
		assert.deepEqual(memory.settings, []);
		assert.equal(memory.isMergeTree, false);
	});

	test('a count the server sent as digits (64-bit) is still a number', () => {
		assert.equal(readAnatomy({ ...ANAT, total_rows: '5001140' }).rows, 5001140);
		assert.equal(readAnatomy({ ...ANAT, total_rows: null }).rows, undefined);
	});
});

describe('ttlOf and settingsOf', () => {
	test('the TTL runs to the SETTINGS, or to the end', () => {
		assert.equal(ttlOf('MergeTree ORDER BY a TTL ts + toIntervalDay(7) SETTINGS index_granularity = 8192'), 'ts + toIntervalDay(7)');
		assert.equal(ttlOf('MergeTree ORDER BY a TTL ts + toIntervalDay(7)'), 'ts + toIntervalDay(7)');
		assert.equal(ttlOf('MergeTree ORDER BY a'), '');
	});

	// `storage_policy = 'hot, cold'` is one setting, not two: the split is at the top level and
	// the mask has already blanked what is inside the quotes.
	test('a setting whose value holds a comma is one setting', () => {
		assert.deepEqual(settingsOf("MergeTree ORDER BY a SETTINGS index_granularity = 8192, storage_policy = 'hot, cold'"), [
			{ label: 'index_granularity', value: '8192' },
			{ label: 'storage_policy', value: "'hot, cold'" },
		]);
	});

	test('no SETTINGS is an empty list', () => {
		assert.deepEqual(settingsOf('MergeTree ORDER BY a'), []);
	});
});

describe('the statements', () => {
	test('name the table as a literal, escaped, and never interpolate it raw', () => {
		const nasty = "ev'il";
		for (const sql of [anatomySql('db', nasty), partitionsSql('db', nasty), projectionsSql('db', nasty), skipIndexSql('db', nasty)]) {
			assert.ok(sql.includes("'ev\\'il'"), sql.slice(0, 120));
		}
	});

	test('only ACTIVE parts are counted, or a partition holds its rows twice', () => {
		assert.match(partitionsSql('db', 't'), /AND active\b/);
		assert.match(projectionsSql('db', 't'), /AND active\b/);
	});
});

describe('qualified', () => {
	test('quotes both halves, and a backtick in a name', () => {
		assert.equal(qualified('shop', 'events'), '`shop`.`events`');
		assert.equal(qualified('a`b', 'c'), '`a``b`.`c`');
	});
});

describe('PARTITION_ACTIONS', () => {
	const row = { partition: '202601', partitionId: '202601', parts: 4, rows: 50000, diskMb: 12, rawMb: 40 };

	// The DISPLAY form of a tuple partition key is `('gb', 2026)`, which would have to be quoted
	// back correctly; the id is exact and is always a plain string.
	test('every action addresses the partition by ID, never by its displayed expression', () => {
		for (const action of PARTITION_ACTIONS) {
			const sql = action.sql('`db`.`t`', row);
			assert.match(sql, /PARTITION ID '202601'/, action.id);
			assert.ok(sql.includes('`db`.`t`'), action.id);
		}
	});

	test('merging is not destructive; detaching and dropping are', () => {
		const byId = Object.fromEntries(PARTITION_ACTIONS.map((a) => [a.id, a]));
		assert.equal(byId.optimize.danger, false);
		assert.equal(byId.detach.danger, true);
		assert.equal(byId.drop.danger, true);
	});

	test('each one says what it does to the rows before it is run', () => {
		for (const action of PARTITION_ACTIONS) {
			assert.match(action.confirm('`db`.`t`', row), /50,000/, action.id);
		}
	});

	test('drop says it cannot be undone and detach says it can', () => {
		const byId = Object.fromEntries(PARTITION_ACTIONS.map((a) => [a.id, a]));
		assert.match(byId.drop.confirm('t', row), /cannot be undone/);
		assert.match(byId.detach.confirm('t', row), /ATTACH PARTITION/);
	});
});

describe('isMergeTreeEngine', () => {
	test('every engine whose data lives in parts, and nothing else', () => {
		for (const engine of ['MergeTree', 'ReplacingMergeTree', 'SummingMergeTree', 'ReplicatedAggregatingMergeTree', 'GraphiteMergeTree']) {
			assert.equal(isMergeTreeEngine(engine), true, engine);
		}
		for (const engine of ['Memory', 'Distributed', 'Dictionary', 'View', 'MaterializedView', 'Log']) {
			assert.equal(isMergeTreeEngine(engine), false, engine);
		}
	});
});

describe('missingSystemTable', () => {
	test('reads the version fact apart from a real failure', () => {
		assert.equal(missingSystemTable("Code: 60. DB::Exception: Table system.projections does not exist."), true);
		assert.equal(missingSystemTable('Code: 241. DB::Exception: Memory limit exceeded'), false);
	});
});

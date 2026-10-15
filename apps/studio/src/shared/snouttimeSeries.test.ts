/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { blankSeriesDraft, seriesProblems, seriesStatements, timeColumnCandidates, timeKind, type SeriesColumn } from './snouttimeSeries';

const COLS: SeriesColumn[] = [
	{ name: 'host', dataType: 'text', nullable: false, isPrimaryKey: false },
	{ name: 'ts', dataType: 'timestamptz', nullable: false, isPrimaryKey: false },
	{ name: 'seq', dataType: 'bigint', nullable: false, isPrimaryKey: false },
];

describe('make this a series table', () => {
	test('timestamps are offered first, then integers, and nothing else', () => {
		assert.deepEqual(timeColumnCandidates(COLS), ['ts', 'seq']);
		assert.equal(timeKind('timestamp with time zone'), 'time');
		assert.equal(timeKind('date'), 'time');
		assert.equal(timeKind('int8'), 'integer');
		assert.equal(timeKind('text'), undefined);
	});

	test('good settings have no problems and become the SnoutTime calls', () => {
		const draft = { ...blankSeriesDraft('ts'), retention: '30 days' };
		assert.deepEqual(seriesProblems(draft, COLS), []);
		assert.deepEqual(seriesStatements(draft, '"public"."metrics"', 'timestamptz'), [
			`SELECT snouttime.create_series('"public"."metrics"', 'ts', partition_interval => interval '1 day');`,
			`SELECT snouttime.set_retention('"public"."metrics"', interval '30 days');`,
			`SELECT snouttime.set_sealing('"public"."metrics"', interval '1 day');`,
		]);
	});

	test('an integer time column is partitioned by a width', () => {
		const draft = { timeColumn: 'seq', interval: '100000', retention: '', sealAfter: '' };
		assert.deepEqual(seriesProblems(draft, COLS), []);
		assert.deepEqual(seriesStatements(draft, 'events', 'bigint'), [
			`SELECT snouttime.create_series('events', 'seq', partition_width => 100000::bigint);`,
		]);
		assert.match(seriesProblems({ ...draft, interval: '1 day' }, COLS).join(), /whole number/);
	});

	test('the two things SnoutTime would refuse are said first, in the designer\'s words', () => {
		const nullable = COLS.map((c) => (c.name === 'ts' ? { ...c, nullable: true } : c));
		assert.match(seriesProblems(blankSeriesDraft('ts'), nullable).join(), /ts must not allow NULL/);
		const keyed = COLS.map((c) => (c.name === 'host' ? { ...c, isPrimaryKey: true } : c));
		assert.match(seriesProblems(blankSeriesDraft('ts'), keyed).join(), /primary key must include ts/);
		assert.match(seriesProblems(blankSeriesDraft('host'), COLS).join(), /host is text/);
		assert.match(seriesProblems(blankSeriesDraft(''), COLS).join(), /Choose the column/);
		assert.match(seriesProblems({ ...blankSeriesDraft('ts'), interval: 'daily' }, COLS).join(), /interval such as 1 day/);
	});

	test('a quote in a name cannot end the literal', () => {
		assert.match(seriesStatements(blankSeriesDraft("t's"), `"o'k"`, 'date')[0], /\('"o''k"', 't''s'/);
	});
});

test('an integer size that is not a whole number stays inside a literal, which Postgres then refuses', () => {
	const statements = seriesStatements({ timeColumn: 'seq', interval: '100); DROP TABLE events; --', retention: '', sealAfter: '' }, 'events', 'bigint');
	assert.deepEqual(statements, [`SELECT snouttime.create_series('events', 'seq', partition_width => '100); DROP TABLE events; --'::bigint);`]);
});

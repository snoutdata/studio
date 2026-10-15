/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
	bulkExportExtension,
	bulkFormatById,
	bulkFormatsFor,
	bulkLoadWarnings,
	describeBulkLoad,
	emitBulkExport,
	emitBulkLoad,
	encodingForFile,
	formatForFile,
	nameWithoutEncoding,
	serverExportRefusal,
} from './bulkLoad';

function format(id: string) {
	const found = bulkFormatById('clickhouse', id);
	assert.ok(found, `${id} is not one of ClickHouse's formats`);
	return found;
}

describe('which engines take a file', () => {
	test('ClickHouse does; nothing else does yet', () => {
		assert.ok(bulkFormatsFor('clickhouse').length > 0);
		for (const driver of ['postgres', 'mysql-aurora', 'sqlserver', 'oracle', 'sqlite', 'duckdb', 'mongodb']) {
			assert.deepEqual(bulkFormatsFor(driver), [], `${driver} must not offer a file load it cannot do`);
		}
	});

	test('a format id that is not the engine\'s own resolves to nothing', () => {
		// The statement interpolates the id unquoted, so this lookup is the only thing between a
		// saved choice (or an agent's tool argument) and the FORMAT clause.
		assert.equal(bulkFormatById('clickhouse', 'Parquet FORMAT CSV; DROP TABLE t'), undefined);
		assert.equal(bulkFormatById('clickhouse', 'parquet'), undefined);
		assert.equal(bulkFormatById('postgres', 'Parquet'), undefined);
	});
});

describe('what a file name means', () => {
	test('the ordinary extensions', () => {
		assert.equal(formatForFile('clickhouse', 'events.parquet')?.id, 'Parquet');
		assert.equal(formatForFile('clickhouse', 'events.csv')?.id, 'CSVWithNames');
		assert.equal(formatForFile('clickhouse', 'events.tsv')?.id, 'TabSeparatedWithNames');
		assert.equal(formatForFile('clickhouse', 'events.jsonl')?.id, 'JSONEachRow');
		assert.equal(formatForFile('clickhouse', 'events.ndjson')?.id, 'JSONEachRow');
		assert.equal(formatForFile('clickhouse', 'events.orc')?.id, 'ORC');
	});

	test('case and a full path do not change the answer', () => {
		assert.equal(formatForFile('clickhouse', 'C:\\Users\\alex\\Downloads\\EVENTS.CSV')?.id, 'CSVWithNames');
		assert.equal(formatForFile('clickhouse', '/home/alex/data/events.Parquet')?.id, 'Parquet');
	});

	test('a compression suffix is seen through, not read as the format', () => {
		assert.equal(nameWithoutEncoding('events.csv.gz'), 'events.csv');
		assert.equal(nameWithoutEncoding('events.csv'), 'events.csv');
		assert.equal(formatForFile('clickhouse', 'events.csv.gz')?.id, 'CSVWithNames');
		assert.equal(formatForFile('clickhouse', 'events.jsonl.zst')?.id, 'JSONEachRow');
		assert.equal(encodingForFile('events.csv.gz'), 'gzip');
		assert.equal(encodingForFile('events.jsonl.zst'), 'zstd');
		assert.equal(encodingForFile('events.csv'), undefined);
	});

	test('a name with no extension, and one that is only a dotfile, are not a guess', () => {
		assert.equal(formatForFile('clickhouse', 'events'), undefined);
		assert.equal(formatForFile('clickhouse', '.gitignore'), undefined);
		assert.equal(formatForFile('clickhouse', 'events.xlsx'), undefined);
	});
});

describe('the statement', () => {
	test('qualified, quoted, and the format last', () => {
		assert.equal(
			emitBulkLoad('clickhouse', { schema: 'shop', table: 'events' }, format('Parquet')),
			'INSERT INTO `shop`.`events` FORMAT Parquet');
	});

	test('no database when the target has none', () => {
		assert.equal(
			emitBulkLoad('clickhouse', { table: 'events' }, format('CSVWithNames')),
			'INSERT INTO `events` FORMAT CSVWithNames');
	});

	test('a column list is quoted one name at a time', () => {
		assert.equal(
			emitBulkLoad('clickhouse', { schema: 'shop', table: 'events', columns: ['id', 'at'] }, format('CSV')),
			'INSERT INTO `shop`.`events` (`id`, `at`) FORMAT CSV');
	});

	test('a hostile identifier cannot leave its quotes', () => {
		const sql = emitBulkLoad('clickhouse', { schema: 'sh`op', table: 'ev`ents', columns: ['i`d'] }, format('CSV'));
		assert.equal(sql, 'INSERT INTO `sh``op`.`ev``ents` (`i``d`) FORMAT CSV');
	});
});

describe('what the person is told first', () => {
	test('a format with no names is the warning that matters', () => {
		const warnings = bulkLoadWarnings(format('CSV'), undefined, false);
		assert.ok(warnings[0].includes('ORDER'), warnings[0]);
		assert.ok(warnings.some((w) => w.includes('not inside a transaction')));
	});

	test('a named format does not carry the ordering warning', () => {
		const warnings = bulkLoadWarnings(format('CSVWithNames'), undefined, false);
		assert.ok(!warnings.some((w) => w.includes('column ORDER')));
	});

	test('a guess and a compressed file each add their own line', () => {
		const warnings = bulkLoadWarnings(format('Parquet'), 'gzip', true);
		assert.ok(warnings.some((w) => w.includes("file's name")));
		assert.ok(warnings.some((w) => w.includes('sent compressed')));
	});

	test('the sentence says which way the columns are matched', () => {
		assert.ok(describeBulkLoad({ schema: 'shop', table: 'events' }, format('Parquet')).includes('by column name'));
		assert.ok(describeBulkLoad({ schema: 'shop', table: 'events' }, format('CSV')).includes('by column position'));
	});
});

describe('the export statement', () => {
	test('the format goes on the end', () => {
		assert.equal(emitBulkExport('SELECT * FROM t', format('Parquet')), 'SELECT * FROM t FORMAT Parquet');
	});

	test("a trailing semicolon and the user's own FORMAT come off", () => {
		assert.equal(emitBulkExport('SELECT * FROM t;', format('Parquet')), 'SELECT * FROM t FORMAT Parquet');
		assert.equal(emitBulkExport('SELECT * FROM t FORMAT CSV', format('Parquet')), 'SELECT * FROM t FORMAT Parquet');
	});

	test('a trailing SETTINGS stays, and the format goes after it', () => {
		// ClickHouse's own order. The other way round is a syntax error.
		assert.equal(
			emitBulkExport('SELECT * FROM t SETTINGS max_threads = 1', format('Parquet')),
			'SELECT * FROM t SETTINGS max_threads = 1 FORMAT Parquet');
	});

	test('a column called format, or one in a string, is not a FORMAT clause', () => {
		assert.equal(emitBulkExport("SELECT 'FORMAT CSV'", format('Parquet')), "SELECT 'FORMAT CSV' FORMAT Parquet");
		assert.equal(emitBulkExport('SELECT format FROM t', format('Parquet')), 'SELECT format FROM t FORMAT Parquet');
	});

	test('the file name an export suggests', () => {
		assert.equal(bulkExportExtension(format('Parquet')), '.parquet');
		assert.equal(bulkExportExtension(format('CSVWithNames')), '.csv');
		// A format that claims no extension of its own still names one.
		assert.equal(bulkExportExtension(format('CSV')), '.csv');
	});
});

describe('what an export from the server may run', () => {
	test('a read passes, with its own SETTINGS and once its FORMAT is on the end', () => {
		for (const sql of ['SELECT * FROM events', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SELECT count() FROM events SETTINGS max_threads = 2', emitBulkExport('SELECT * FROM events', format('Parquet')), 'SHOW TABLES']) {
			assert.equal(serverExportRefusal(sql, 'clickhouse'), undefined, sql);
		}
	});

	test('a statement that writes is refused, whatever the connection, and says why in the export\'s words', () => {
		for (const sql of ['ALTER TABLE events DELETE WHERE 1', 'DROP TABLE events', 'TRUNCATE TABLE events', 'INSERT INTO a SELECT * FROM b', 'OPTIMIZE TABLE events FINAL', 'SET readonly = 0']) {
			const refusal = serverExportRefusal(sql, 'clickhouse');
			assert.ok(refusal, sql);
			assert.match(refusal, /^Export from the server only runs a read/);
			assert.doesNotMatch(refusal, /agent/);
		}
	});
});

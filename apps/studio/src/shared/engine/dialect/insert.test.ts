/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { emitClearTable, emitInsertRows, emitUpsertRows, qualifiedName, sqlLiteral, supportsUpsert, upsertCaveat } from './insert';
import type { FlowRow } from './rows';

const TARGET = { table: 'people', columns: ['id', 'name'] };

describe('sqlLiteral', () => {
	test('null, numbers and booleans per vendor', () => {
		assert.equal(sqlLiteral('postgres', null), 'NULL');
		assert.equal(sqlLiteral('postgres', 42), '42');
		assert.equal(sqlLiteral('postgres', -1.5), '-1.5');
		assert.equal(sqlLiteral('postgres', true), 'TRUE');
		assert.equal(sqlLiteral('mysql-aurora', true), '1');
		assert.equal(sqlLiteral('sqlserver', false), '0');
		assert.equal(sqlLiteral('oracle', true), '1');
	});

	// The escaping tests are the point of this file: a CSV full of apostrophes and backslashes is
	// the everyday case, and getting any of these wrong is injection-shaped.
	test('doubles single quotes everywhere', () => {
		assert.equal(sqlLiteral('postgres', "O'Brien"), "'O''Brien'");
		assert.equal(sqlLiteral('mysql-aurora', "O'Brien"), "'O''Brien'");
		assert.equal(sqlLiteral('oracle', "O'Brien"), "'O''Brien'");
	});

	test('escapes backslashes where a backslash is an escape: the MySQL family and ClickHouse', () => {
		assert.equal(sqlLiteral('mysql-aurora', 'C:\\temp'), "'C:\\\\temp'");
		assert.equal(sqlLiteral('mariadb', 'C:\\temp'), "'C:\\\\temp'");
		// A trailing backslash would otherwise escape the closing quote.
		assert.equal(sqlLiteral('clickhouse', 'a\\'), "'a\\\\'");
		// Postgres with standard_conforming_strings (the default since 9.1) treats it literally.
		assert.equal(sqlLiteral('postgres', 'C:\\temp'), "'C:\\temp'");
	});

	test('a quote-and-backslash payload cannot break out on MySQL', () => {
		// The classic: `\'` would escape the quote if the backslash were left alone.
		assert.equal(sqlLiteral('mysql-aurora', "\\' OR 1=1 --"), "'\\\\'' OR 1=1 --'");
	});

	test('SQL Server strings are national literals', () => {
		assert.equal(sqlLiteral('sqlserver', 'café'), "N'café'");
		assert.equal(sqlLiteral('sqlserver', "it's"), "N'it''s'");
	});

	test('NUL is removed rather than corrupting the statement', () => {
		assert.equal(sqlLiteral('postgres', 'a\u0000b'), "'ab'");
	});

	test('newlines and tabs survive inside a literal', () => {
		assert.equal(sqlLiteral('postgres', 'a\nb\tc'), "'a\nb\tc'");
	});

	test('dates render as UTC text, and Oracle gets an explicit conversion', () => {
		const date = new Date('2026-01-05T10:11:12.345Z');
		assert.equal(sqlLiteral('postgres', date), "'2026-01-05 10:11:12.345'");
		assert.equal(sqlLiteral('sqlserver', date), "N'2026-01-05 10:11:12.345'");
		assert.equal(sqlLiteral('oracle', date), "TO_TIMESTAMP('2026-01-05 10:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3')");
	});

	test('refuses values a column cannot hold', () => {
		assert.throws(() => sqlLiteral('postgres', Number.NaN));
		assert.throws(() => sqlLiteral('postgres', Number.POSITIVE_INFINITY));
		assert.throws(() => sqlLiteral('postgres', new Date('nope')));
	});
});

describe('emitInsertRows', () => {
	const rows: FlowRow[] = [[1, 'Ann'], [2, "O'Neil"]];

	test('one multi-row statement per batch', () => {
		const [sql, ...rest] = emitInsertRows('postgres', TARGET, rows);
		assert.equal(rest.length, 0);
		assert.equal(sql, 'INSERT INTO "people" ("id", "name") VALUES\n\t(1, \'Ann\'),\n\t(2, \'O\'\'Neil\')');
	});

	test('identifiers are quoted per vendor, never concatenated', () => {
		assert.match(emitInsertRows('mysql-aurora', TARGET, rows)[0], /^INSERT INTO `people` \(`id`, `name`\)/);
		assert.match(emitInsertRows('sqlserver', TARGET, rows)[0], /^INSERT INTO \[people\] \(\[id\], \[name\]\)/);
	});

	test('a table named like a reserved word still round-trips', () => {
		const sql = emitInsertRows('postgres', { table: 'order', columns: ['user'] }, [['x']])[0];
		assert.match(sql, /INSERT INTO "order" \("user"\)/);
	});

	test('schema qualification', () => {
		assert.equal(qualifiedName('postgres', 'sales', 'people'), '"sales"."people"');
		assert.match(emitInsertRows('postgres', { ...TARGET, schema: 'sales' }, rows)[0], /INSERT INTO "sales"\."people"/);
	});

	test('Oracle uses INSERT ALL, since it has no multi-row VALUES', () => {
		const sql = emitInsertRows('oracle', TARGET, rows)[0];
		assert.match(sql, /^INSERT ALL/);
		assert.equal(sql.match(/INTO "people"/g)?.length, 2);
		assert.match(sql, /SELECT \* FROM dual$/);
	});

	test('splits past the vendor row ceiling', () => {
		const many: FlowRow[] = Array.from({ length: 2500 }, (_v, i) => [i, 'x']);
		assert.equal(emitInsertRows('postgres', TARGET, many).length, 3); // 1000-row default cap
		assert.equal(emitInsertRows('sqlserver', TARGET, many).length, 3); // T-SQL hard limit of 1000
		assert.equal(emitInsertRows('oracle', TARGET, many).length, 5); // 500-row chunks
	});

	test('splits past the character budget', () => {
		const wide: FlowRow[] = Array.from({ length: 10 }, (_v, i) => [i, 'x'.repeat(100)]);
		// Each tuple is ~107 characters, so a 300-character budget fits two per statement.
		const statements = emitInsertRows('postgres', TARGET, wide, { maxStatementChars: 300 });
		assert.equal(statements.length, 5);
		assert.ok(statements.every((sql) => sql.length < 600));
	});

	test('empty batches emit nothing', () => {
		assert.deepEqual(emitInsertRows('postgres', TARGET, []), []);
	});

	test('a row whose width disagrees with the batch is a bug, not a guess', () => {
		assert.throws(() => emitInsertRows('postgres', TARGET, [[1]]), /2 columns/);
	});
});

describe('emitUpsertRows', () => {
	/*
	 * The escaping rules are `sqlLiteral`'s and are already exhausted above; what is tested here is
	 * the SHAPE per vendor, because there are four of them and the differences are not cosmetic.
	 *
	 * The `mergeUnion` vendors get the most attention, because their source is assembled by taking
	 * an already-rendered tuple apart again — which is exactly the kind of string surgery this
	 * file's header forbids doing carelessly.
	 */
	const rows: FlowRow[] = [[1, 'Ann'], [2, "O'Neil"]];
	const KEYED = { table: 'people', columns: ['id', 'name', 'town'] };
	/** The first row of a `mergeUnion` source, so a count of aliases is about the ROW. */
	const selectLine = (sql: string): string => sql.split('\n').find((line) => line.includes('SELECT')) ?? '';
	const keyedRows: FlowRow[] = [[1, 'Ann', 'Leeds']];

	test('ON CONFLICT names the target and updates only the non-key columns', () => {
		const sql = emitUpsertRows('postgres', KEYED, keyedRows, ['id'])[0];
		assert.equal(
			sql,
			'INSERT INTO "people" ("id", "name", "town") VALUES\n\t(1, \'Ann\', \'Leeds\')\n'
			+ 'ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "town" = EXCLUDED."town"',
		);
	});

	test('SQLite and DuckDB take the same shape as Postgres', () => {
		for (const driver of ['sqlite', 'duckdb']) {
			assert.match(emitUpsertRows(driver, KEYED, keyedRows, ['id'])[0], /ON CONFLICT \("id"\) DO UPDATE SET/, driver);
		}
	});

	test('a composite key is matched on every column of it', () => {
		const sql = emitUpsertRows('postgres', KEYED, keyedRows, ['id', 'town'])[0];
		assert.match(sql, /ON CONFLICT \("id", "town"\) DO UPDATE SET "name" = EXCLUDED\."name"/);
		// And the key columns are NOT assigned: Postgres allows it, Oracle forbids it outright, and
		// setting a column to the value it was matched on is noise in every dialect.
		assert.doesNotMatch(sql, /"town" = EXCLUDED\."town"/);
	});

	test('nothing to update becomes DO NOTHING, not an empty SET', () => {
		// `DO UPDATE SET` with an empty list is a syntax error, and this is reachable: a table whose
		// every column is part of the key.
		const sql = emitUpsertRows('postgres', { table: 'tags', columns: ['a', 'b'] }, [['x', 'y']], ['a', 'b'])[0];
		assert.match(sql, /ON CONFLICT \("a", "b"\) DO NOTHING$/);
	});

	test('MySQL uses ON DUPLICATE KEY, and says so in a caveat', () => {
		const sql = emitUpsertRows('mysql-aurora', KEYED, keyedRows, ['id'])[0];
		assert.match(sql, /ON DUPLICATE KEY UPDATE `name` = VALUES\(`name`\), `town` = VALUES\(`town`\)/);
		// The semantic difference is real and cannot be expressed away, so it is SAID rather than
		// left for somebody to discover on run two.
		assert.match(upsertCaveat('mysql-aurora'), /any unique column/);
		assert.equal(upsertCaveat('postgres'), '');
	});

	test('MySQL with nothing to update assigns the key to itself rather than emitting nothing', () => {
		// MySQL has no DO NOTHING. An empty UPDATE list is a syntax error, so the no-op idiom stands
		// in for it and keeps the statement valid.
		const sql = emitUpsertRows('mariadb', { table: 'tags', columns: ['a'] }, [['x']], ['a'])[0];
		assert.match(sql, /ON DUPLICATE KEY UPDATE `a` = VALUES\(`a`\)$/);
	});

	test('SQL Server MERGE carries its required semicolon', () => {
		const sql = emitUpsertRows('sqlserver', KEYED, keyedRows, ['id'])[0];
		assert.match(sql, /^MERGE INTO \[people\] AS \[tgt\]/);
		assert.match(sql, /USING \(VALUES\n\t\t\(1, N'Ann', N'Leeds'\)\) AS \[src\] \(\[id\], \[name\], \[town\]\)/);
		assert.match(sql, /ON \(\[tgt\]\.\[id\] = \[src\]\.\[id\]\)/);
		assert.match(sql, /WHEN MATCHED THEN UPDATE SET \[tgt\]\.\[name\] = \[src\]\.\[name\]/);
		assert.match(sql, /WHEN NOT MATCHED THEN INSERT \(\[id\], \[name\], \[town\]\) VALUES \(\[src\]\.\[id\], \[src\]\.\[name\], \[src\]\.\[town\]\);$/);
	});

	test('only SQL Server gets the semicolon', () => {
		assert.doesNotMatch(emitUpsertRows('db2', KEYED, keyedRows, ['id'])[0], /;$/);
		assert.doesNotMatch(emitUpsertRows('oracle', KEYED, keyedRows, ['id'])[0], /;$/);
	});

	test('Oracle takes no AS on a table alias, which is a syntax error there and not a style', () => {
		const sql = emitUpsertRows('oracle', KEYED, keyedRows, ['id'])[0];
		assert.match(sql, /^MERGE INTO "people" "tgt"/);
		assert.doesNotMatch(sql, /MERGE INTO "people" AS/);
		// Every other MERGE vendor does use it.
		assert.match(emitUpsertRows('hana', KEYED, keyedRows, ['id'])[0], /^MERGE INTO "people" AS "tgt"/);
	});

	test('the UNION source spells out one SELECT per row, aliased only on the first', () => {
		const sql = emitUpsertRows('oracle', KEYED, [[1, 'Ann', 'Leeds'], [2, 'Bo', 'Hull']], ['id'])[0];
		assert.match(sql, /SELECT 1 AS "id", 'Ann' AS "name", 'Leeds' AS "town" FROM dual/);
		// The second row carries values only: repeating the aliases is legal in neither Oracle nor
		// HANA once the first SELECT has named the columns.
		assert.match(sql, /UNION ALL SELECT 2, 'Bo', 'Hull' FROM dual/);
	});

	test('HANA selects FROM DUMMY and Snowflake from nothing at all', () => {
		assert.match(emitUpsertRows('hana', KEYED, keyedRows, ['id'])[0], /FROM DUMMY/);
		const snow = emitUpsertRows('snowflake', KEYED, keyedRows, ['id'])[0];
		assert.match(snow, /SELECT 1 AS "id", 'Ann' AS "name", 'Leeds' AS "town"\n/);
		assert.doesNotMatch(snow, /FROM (dual|DUMMY)/);
	});

	test('A COMMA INSIDE A STRING DOES NOT SPLIT THE ROW', () => {
		/*
		 * The one that would be silent. The UNION source takes an already-rendered `(1, 'a, b')`
		 * apart to alias each value, and a naive split on "," cuts that literal in half — producing
		 * a statement with the wrong number of columns, or worse, one that parses.
		 *
		 * Both cases: a plain comma, and a comma next to an escaped quote.
		 */
		const sql = emitUpsertRows('oracle', KEYED, [[1, "Smith, Ann", "O'Neil, Leeds"]], ['id'])[0];
		assert.match(sql, /SELECT 1 AS "id", 'Smith, Ann' AS "name", 'O''Neil, Leeds' AS "town" FROM dual/);
		// And the row still has exactly three values, which is what a bad split would break.
		assert.equal(selectLine(sql).match(/ AS "/g)?.length, 3);
	});

	test('a value that is only quotes survives the split', () => {
		// The value is a comma between two quotes, so the literal is quote, escaped-quote, comma,
		// escaped-quote, quote. If the splitter tracked strings wrongly it would cut here.
		const sql = emitUpsertRows('snowflake', { table: 't', columns: ['id', 'v'] }, [[1, "','"]], ['id'])[0];
		assert.match(sql, /SELECT 1 AS "id", ''',''' AS "v"/);
		// Counted on the SELECT line alone: the statement's other `AS` is the target alias, and
		// counting the whole thing would make this assertion about aliasing rather than splitting.
		assert.equal(selectLine(sql).match(/ AS "/g)?.length, 2, 'still two values, not three');
	});

	test('chunking matches emitInsertRows, so a big batch is still one statement per chunk', () => {
		const many: FlowRow[] = Array.from({ length: 2500 }, (_v, i) => [i, 'x', 'y']);
		assert.equal(emitUpsertRows('postgres', KEYED, many, ['id']).length, 3);
		// SQL Server's 1000-row ceiling is a hard error, and the cap applies to a MERGE source too.
		assert.equal(emitUpsertRows('sqlserver', KEYED, many, ['id']).length, 3);
	});

	test('empty batches emit nothing', () => {
		assert.deepEqual(emitUpsertRows('postgres', KEYED, [], ['id']), []);
	});

	test('REDSHIFT IS REFUSED, rather than given a plausible statement', () => {
		// It forked from Postgres 8.0.2, long before ON CONFLICT existed, and its MERGE is recent
		// enough that nobody here has run one. Emitting something that looks right would move the
		// failure to run time, on somebody's warehouse. `validateSpec` asks this at design time.
		assert.equal(supportsUpsert('redshift'), false);
		assert.throws(() => emitUpsertRows('redshift', KEYED, keyedRows, ['id']), /cannot update and insert in one statement/);
		for (const driver of ['postgres', 'sqlite', 'duckdb', 'mysql-aurora', 'mariadb', 'sqlserver', 'db2', 'oracle', 'hana', 'snowflake']) {
			assert.equal(supportsUpsert(driver), true, driver);
		}
	});

	test('an upsert with no key is refused: it would be an append claiming not to be one', () => {
		assert.throws(() => emitUpsertRows('postgres', KEYED, keyedRows, []), /needs a key/);
	});

	test('a key that is not among the columns being written is refused', () => {
		// Otherwise the statement matches on a column the rows do not carry, which the engine either
		// rejects or - worse - resolves against something else.
		assert.throws(() => emitUpsertRows('postgres', KEYED, keyedRows, ['missing']), /is not among the columns/);
	});

	test('a row whose width disagrees with the batch is a bug, not a guess', () => {
		assert.throws(() => emitUpsertRows('postgres', KEYED, [[1, 'Ann']], ['id']));
		assert.throws(() => emitUpsertRows('oracle', KEYED, [[1, 'Ann']], ['id']));
	});

	test('schema qualification, and the key still resolves', () => {
		const sql = emitUpsertRows('postgres', { ...KEYED, schema: 'sales' }, keyedRows, ['id'])[0];
		assert.match(sql, /INSERT INTO "sales"\."people"/);
		assert.match(emitUpsertRows('sqlserver', { ...KEYED, schema: 'sales' }, keyedRows, ['id'])[0], /MERGE INTO \[sales\]\.\[people\]/);
	});

	test('the key is matched case-insensitively against the column list', () => {
		// The proposal stores what the user typed; the catalog may hold it folded. A key of "ID"
		// against a column "id" is the same column, and refusing it would be a false alarm.
		const sql = emitUpsertRows('postgres', KEYED, keyedRows, ['ID'])[0];
		assert.match(sql, /ON CONFLICT \("ID"\) DO UPDATE SET "name" = EXCLUDED\."name", "town" = EXCLUDED\."town"/);
		assert.doesNotMatch(sql, /"id" = EXCLUDED\."id"/);
	});

	test('reserved words survive as identifiers', () => {
		const sql = emitUpsertRows('postgres', { table: 'order', columns: ['user', 'select'] }, [['a', 'b']], ['user'])[0];
		assert.match(sql, /INSERT INTO "order" \("user", "select"\)/);
		assert.match(sql, /ON CONFLICT \("user"\) DO UPDATE SET "select" = EXCLUDED\."select"/);
	});

	test('rows unchanged from emitInsertRows: the VALUES half is byte-identical', () => {
		// The upsert path must not quietly render literals differently from the insert path, or the
		// dry-run preview and the run would disagree about what is being written.
		const insert = emitInsertRows('postgres', KEYED, keyedRows)[0];
		const upsert = emitUpsertRows('postgres', KEYED, keyedRows, ['id'])[0];
		assert.ok(upsert.startsWith(insert), `${upsert}\n\ndoes not start with\n\n${insert}`);
	});
});

describe('emitClearTable', () => {
	test('TRUNCATE where it exists, DELETE on SQLite', () => {
		assert.equal(emitClearTable('postgres', undefined, 'people'), 'TRUNCATE TABLE "people"');
		assert.equal(emitClearTable('sqlite', undefined, 'people'), 'DELETE FROM "people"');
	});
});

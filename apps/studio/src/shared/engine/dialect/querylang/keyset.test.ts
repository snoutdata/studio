/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ColumnInfo, TableInfo } from '../../../schema';
import { browseShape, keysetCursorFrom, keysetKeyFor, keysetKeyForColumns, keysetOrderBy, keysetSelect, seekPredicate } from './keyset';

function column(name: string, opts?: Partial<ColumnInfo>): ColumnInfo {
	return { name, dataType: 'int', nullable: false, isPrimaryKey: false, ...opts };
}

function table(opts?: Partial<TableInfo>): TableInfo {
	return {
		name: 'orders',
		schema: 'public',
		kind: 'table',
		columns: [
			column('id', { isPrimaryKey: true }),
			column('name', { dataType: 'varchar(64)' }),
			column('created_at', { dataType: 'timestamp' }),
			column('note', { dataType: 'varchar(64)', nullable: true }),
		],
		primaryKey: ['id'],
		foreignKeys: [],
		indexes: [],
		...opts,
	} as TableInfo;
}

// --- eligibility (the correctness gate) ---

test('keysetKeyFor uses the primary key for an unsorted browse', () => {
	assert.deepEqual(keysetKeyFor(table()), { columns: [{ name: 'id', dir: 'asc' }] });
});

test('keysetKeyFor appends the primary key to a user sort, so the tuple stays unique', () => {
	// `name` alone ties across rows; without the PK every row sharing the boundary value would be
	// skipped between pages.
	assert.deepEqual(keysetKeyFor(table(), { column: 'name', dir: 'desc' }), {
		columns: [{ name: 'name', dir: 'desc' }, { name: 'id', dir: 'desc' }],
	});
});

test('keysetKeyFor does not repeat a sort column that IS the primary key', () => {
	assert.deepEqual(keysetKeyFor(table(), { column: 'id', dir: 'desc' }), { columns: [{ name: 'id', dir: 'desc' }] });
});

test('keysetKeyFor refuses a nullable sort column', () => {
	// NULL > x is unknown, so a nullable key column silently drops rows.
	assert.equal(keysetKeyFor(table(), { column: 'note', dir: 'asc' }), null);
});

test('keysetKeyFor refuses a table with no primary key', () => {
	assert.equal(keysetKeyFor(table({ primaryKey: [], columns: [column('a')] })), null);
});

test('a primary-key column the CATALOG calls nullable is still a key', () => {
	/*
	 * A primary-key column cannot hold NULL in any engine, so its catalog nullability is not the
	 * question the seek predicate has to ask — the column's TYPE still is (the temporal rule below
	 * is unaffected).
	 *
	 * SQLite is why this matters and is not theoretical: `id INTEGER PRIMARY KEY` is the rowid
	 * alias, `PRAGMA table_info` reports `notnull = 0` for it, and the strict check refused the key.
	 * Every SQLite table with the most ordinary primary key there is paged by OFFSET, and the flow
	 * wizard told the user "this table has no usable primary key" about a table whose key was on
	 * the screen above the sentence.
	 */
	const sqliteRowidAlias = table({
		primaryKey: ['id'],
		columns: [column('id', { isPrimaryKey: true, nullable: true }), column('name', { dataType: 'varchar(64)' })],
	});
	assert.deepEqual(keysetKeyFor(sqliteRowidAlias), { columns: [{ name: 'id', dir: 'asc' }] });
	// Chosen explicitly (a flow's incremental key), the same holds.
	assert.deepEqual(keysetKeyForColumns(sqliteRowidAlias, ['id']), { columns: [{ name: 'id', dir: 'asc' }] });
	// A nullable column that is NOT part of the key is still refused, both ways in.
	assert.equal(keysetKeyFor(sqliteRowidAlias, { column: 'note', dir: 'asc' }), null);
	assert.equal(keysetKeyForColumns(table(), ['note']), null);
});

test('keysetKeyFor accepts only a base table — never a view or a document collection', () => {
	// A view's primary key isn't a uniqueness guarantee; a Mongo collection's `_id` would push
	// synthesised seek SQL through the SQL-to-Mongo compiler.
	assert.equal(keysetKeyFor(table({ kind: 'view' })), null);
	assert.equal(keysetKeyFor(table({ kind: 'collection', primaryKey: ['_id'], columns: [column('_id', { dataType: 'string', isPrimaryKey: true })] })), null);
});

test('keysetKeyFor refuses a temporal key — an ISO literal does not compare as the datetime it came from', () => {
	// The value reaches the renderer JSON-serialised; MySQL would not compare it as a DATETIME, and
	// the seek would return wrong rows silently rather than failing.
	assert.equal(keysetKeyFor(table({ primaryKey: ['created_at'] })), null);
	assert.equal(keysetKeyFor(table(), { column: 'created_at', dir: 'asc' }), null);
});

test('keysetKeyFor accepts the numeric and character types we can literal exactly', () => {
	for (const dataType of ['int(11)', 'bigint unsigned', 'integer', 'serial', 'numeric(10,2)', 'double', 'varchar(64)', 'char(3)', 'text', 'uuid', 'uniqueidentifier', 'NVARCHAR(50)']) {
		assert.notEqual(keysetKeyFor(table({ primaryKey: ['k'], columns: [column('k', { dataType, isPrimaryKey: true })] })), null, dataType);
	}
	for (const dataType of ['datetime', 'timestamp', 'date', 'time', 'blob', 'varbinary(16)', 'json', 'bit(1)', 'enum("a","b")']) {
		assert.equal(keysetKeyFor(table({ primaryKey: ['k'], columns: [column('k', { dataType, isPrimaryKey: true })] })), null, dataType);
	}
});

test('keysetCursorFrom fails closed on a non-primitive value that slipped past the type gate', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(keysetCursorFrom(key, [{ name: 'id' }], [new Date()], literal), null);
	assert.equal(keysetCursorFrom(key, [{ name: 'id' }], [{ buf: 1 }], literal), null);
});

test('keysetKeyFor matches column names case-insensitively', () => {
	assert.deepEqual(keysetKeyFor(table({ primaryKey: ['ID'] })), { columns: [{ name: 'id', dir: 'asc' }] });
});

// --- the seek predicate ---

test('seekPredicate is empty for the first page', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(seekPredicate(key, undefined, 'postgres'), '');
	assert.equal(seekPredicate(key, [], 'postgres'), '');
});

test('seekPredicate on a single ascending key is a plain >', () => {
	assert.equal(seekPredicate({ columns: [{ name: 'id', dir: 'asc' }] }, ['42'], 'postgres'), '"id" > 42');
});

test('seekPredicate flips to < for a descending column', () => {
	assert.equal(seekPredicate({ columns: [{ name: 'id', dir: 'desc' }] }, ['42'], 'postgres'), '"id" < 42');
});

test('seekPredicate expands a composite key lexicographically, per-column direction', () => {
	const key = { columns: [{ name: 'created_at', dir: 'desc' as const }, { name: 'id', dir: 'asc' as const }] };
	assert.equal(
		seekPredicate(key, ["'2026-01-01'", '7'], 'postgres'),
		`("created_at" < '2026-01-01' OR ("created_at" = '2026-01-01' AND "id" > 7))`,
	);
});

test('seekPredicate quotes per vendor', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(seekPredicate(key, ['1'], 'mysql-aurora'), '`id` > 1');
	assert.equal(seekPredicate(key, ['1'], 'sqlserver'), '[id] > 1');
});

test('seekPredicate refuses a cursor whose arity does not match the key', () => {
	// Comparing against the wrong columns returns wrong rows silently, so treat it as no seek.
	const key = { columns: [{ name: 'a', dir: 'asc' as const }, { name: 'b', dir: 'asc' as const }] };
	assert.equal(seekPredicate(key, ['1'], 'postgres'), '');
});

// --- the assembled page ---

test('keysetSelect builds the first page with ORDER BY and the vendor row cap', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(
		keysetSelect({ select: 'SELECT * FROM "orders"', key, limit: 200 }, 'postgres'),
		'SELECT * FROM "orders" ORDER BY "id" LIMIT 200 OFFSET 0',
	);
});

test('keysetSelect seeks past the cursor on later pages — no OFFSET at any depth', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	const sql = keysetSelect({ select: 'SELECT * FROM "orders"', key, after: ['5000000'], limit: 200 }, 'postgres');
	assert.equal(sql, 'SELECT * FROM "orders" WHERE "id" > 5000000 ORDER BY "id" LIMIT 200 OFFSET 0');
	assert.ok(!/OFFSET [1-9]/.test(sql));
});

test('keysetSelect ANDs the seek predicate onto the caller own conditions', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(
		keysetSelect({ select: 'SELECT * FROM "orders"', conditions: [`"status" = 'open'`], key, after: ['10'], limit: 50 }, 'postgres'),
		`SELECT * FROM "orders" WHERE "status" = 'open' AND "id" > 10 ORDER BY "id" LIMIT 50 OFFSET 0`,
	);
});

test('keysetSelect caps the way each vendor does', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	const page = { select: 'SELECT * FROM [orders]', key, after: ['10'], limit: 25 };
	// SQL Server / Oracle window with OFFSET..FETCH, which needs the ORDER BY keyset always supplies.
	assert.match(keysetSelect(page, 'sqlserver'), /ORDER BY \[id\] OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY$/);
	assert.match(keysetSelect(page, 'oracle'), /OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY$/);
	assert.match(keysetSelect({ ...page, select: 'SELECT * FROM `orders`' }, 'mysql-aurora'), /ORDER BY `id` LIMIT 25 OFFSET 0$/);
});

test('keysetOrderBy renders direction per column', () => {
	assert.equal(
		keysetOrderBy({ columns: [{ name: 'created_at', dir: 'desc' }, { name: 'id', dir: 'asc' }] }, 'postgres'),
		' ORDER BY "created_at" DESC, "id"',
	);
});

// --- browse-shape recognition (the gate on the results-grid path) ---

test('browseShape accepts a plain SELECT and reports the table', () => {
	assert.deepEqual(browseShape('SELECT * FROM orders'), { select: 'SELECT * FROM orders', conditions: [], table: 'orders', schema: undefined });
});

test('browseShape keeps the qualifier and the alias', () => {
	const shape = browseShape('select a, b from public.orders o');
	assert.equal(shape?.table, 'orders');
	assert.equal(shape?.schema, 'public');
	assert.equal(shape?.select, 'select a, b from public.orders o');
});

test('browseShape parenthesizes the WHERE so an OR cannot rebind under the seek', () => {
	// Bare `a = 1 OR b = 2 AND seek` would return rows the author never asked for.
	assert.deepEqual(browseShape('SELECT * FROM t WHERE a = 1 OR b = 2')?.conditions, ['(a = 1 OR b = 2)']);
	assert.equal(browseShape('SELECT * FROM t WHERE a = 1 OR b = 2')?.select, 'SELECT * FROM t');
});

test('browseShape allows a subquery inside WHERE', () => {
	const shape = browseShape('SELECT * FROM orders WHERE id IN (SELECT order_id FROM lines ORDER BY id)');
	// The nested ORDER BY belongs to the subquery, not the statement being paged.
	assert.deepEqual(shape?.conditions, ['(id IN (SELECT order_id FROM lines ORDER BY id))']);
	assert.equal(shape?.table, 'orders');
});

test('browseShape rejects anything that is not a plain single-table read', () => {
	for (const sql of [
		'SELECT * FROM a JOIN b ON a.id = b.id',
		'SELECT * FROM a, b',
		'SELECT DISTINCT x FROM t',
		'SELECT count(*) FROM t',
		'SELECT * FROM t GROUP BY x',
		'SELECT * FROM t ORDER BY x',
		'SELECT * FROM t LIMIT 10',
		'SELECT TOP 10 * FROM t',
		'SELECT * FROM t OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY',
		'SELECT * FROM a UNION SELECT * FROM b',
		'SELECT * FROM (SELECT * FROM t) x',
		'SELECT * FROM t; SELECT 1',
		'WITH c AS (SELECT 1) SELECT * FROM c',
		'UPDATE t SET x = 1',
		'SELECT * FROM t WHERE',
		'SELECT * FROM t FOR UPDATE',
	]) {
		assert.equal(browseShape(sql), null, sql);
	}
});

test('browseShape refuses a statement carrying a comment', () => {
	// A keyset page appends WHERE/ORDER BY/LIMIT inline, so a trailing line comment would swallow
	// them and leave an unclosed paren. The OFFSET fallback appends on a new line and survives.
	assert.equal(browseShape('SELECT * FROM t WHERE a = 1 -- note'), null);
	assert.equal(browseShape('SELECT * FROM t WHERE a = 1 # note'), null);
	assert.equal(browseShape('SELECT /* cols */ * FROM t'), null);
});

test('keysetCursorFrom refuses a value containing a backslash (MySQL escape semantics)', () => {
	const key = { columns: [{ name: 'code', dir: 'asc' as const }] };
	assert.equal(keysetCursorFrom(key, [{ name: 'code' }], ['a\\'], literal), null);
	assert.deepEqual(keysetCursorFrom(key, [{ name: 'code' }], ['ok'], literal), [`'ok'`]);
});

test('keysetCursorFrom refuses an integer past 2^53 — it arrived already rounded', () => {
	// mysql2 returns BIGINT as a JS number unless supportBigNumbers is set, and our pool doesn't set
	// it. Seeking from a rounded key skips or repeats the rows around it.
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(keysetCursorFrom(key, [{ name: 'id' }], [12345678901234567890], literal), null);
	assert.deepEqual(keysetCursorFrom(key, [{ name: 'id' }], [Number.MAX_SAFE_INTEGER], literal), [String(Number.MAX_SAFE_INTEGER)]);
	// A non-integer (DECIMAL/FLOAT read as a number) is not the BIGINT case and stays allowed.
	assert.deepEqual(keysetCursorFrom(key, [{ name: 'id' }], [1.5], literal), ['1.5']);
});

test('browseShape refuses a statement whose quoting does not close', () => {
	// An unterminated literal hides everything after it from the clause scanner, so a real ORDER BY
	// goes unseen and a second one gets appended. `'O\'Brien'` (MySQL backslash escape) does this.
	assert.equal(browseShape("SELECT * FROM t WHERE a = 'O\\'Brien' ORDER BY x"), null);
	assert.equal(browseShape("SELECT * FROM t WHERE a = 'unclosed"), null);
	// Doubled quotes are the portable escape and scan cleanly, so this one is refused for the honest
	// reason instead: it carries its own ORDER BY.
	assert.equal(browseShape("SELECT * FROM t WHERE a = 'O''Brien' ORDER BY x"), null);
	assert.deepEqual(browseShape("SELECT * FROM t WHERE a = 'O''Brien'")?.conditions, [`(a = 'O''Brien')`]);
});

test('browseShape refuses vendor clauses that can trail a WHERE', () => {
	// These would be swallowed into the parenthesized predicate and emit a syntax error.
	assert.equal(browseShape('SELECT * FROM t WHERE a = 1 QUALIFY row_number() OVER (PARTITION BY b) = 1'), null);
	assert.equal(browseShape('SELECT * FROM t WHERE a = 1 WINDOW w AS (ORDER BY b)'), null);
	assert.equal(browseShape('SELECT * FROM a MINUS SELECT * FROM b'), null);
	assert.equal(browseShape('SELECT * FROM t START WITH id = 1 CONNECT BY PRIOR id = pid'), null);
});

test('browseShape is not fooled by keywords inside string literals', () => {
	const shape = browseShape(`SELECT * FROM notes WHERE body = 'order by nothing'`);
	assert.equal(shape?.table, 'notes');
	assert.deepEqual(shape?.conditions, [`(body = 'order by nothing')`]);
});

// --- the structural invariant, over a corpus ---
//
// Every bug found reviewing this module by hand was the same shape: a statement `browseShape`
// accepted, whose appended tail then landed somewhere it didn't belong — inside a comment, inside an
// unterminated string, or after a clause that swallowed it. Rather than keep re-reading the scanner,
// assert the property those bugs all violated: whatever comes out of `keysetSelect` must be a
// statement whose tail is actually at the top level. This is the regression net for the next person
// who widens the gate.

/** Structural facts about generated SQL, computed the way a parser would see it: quoted regions and
 *  parens tracked, so a keyword inside either doesn't count. */
function structure(sql: string): { balancedQuotes: boolean; parenDepth: number; topLevel: Record<string, number> } {
	const counts: Record<string, number> = { order: 0, where: 0, limit: 0, select: 0 };
	let depth = 0;
	let balancedQuotes = true;
	const lower = sql.toLowerCase();
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
			const close = ch === '[' ? ']' : ch;
			i++;
			while (i < sql.length && sql[i] !== close) {
				i++;
			}
			if (i >= sql.length) {
				balancedQuotes = false;
			}
			continue;
		}
		if (ch === '(') {
			depth++;
			continue;
		}
		if (ch === ')') {
			depth--;
			continue;
		}
		if (depth !== 0) {
			continue;
		}
		for (const word of Object.keys(counts)) {
			if (!lower.startsWith(word, i)) {
				continue;
			}
			const before = i === 0 ? ' ' : sql[i - 1];
			const after = sql[i + word.length] ?? ' ';
			if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
				counts[word]++;
			}
		}
	}
	return { balancedQuotes, parenDepth: depth, topLevel: counts };
}

// Realistic statements, including every one that broke a previous version of this module.
const CORPUS = [
	'SELECT * FROM orders',
	'select * from token',
	'SELECT a, b FROM public.orders o',
	'SELECT * FROM orders WHERE status = 1',
	'SELECT * FROM orders WHERE a = 1 OR b = 2',
	"SELECT * FROM notes WHERE body = 'order by nothing'",
	"SELECT * FROM notes WHERE body = 'O''Brien'",
	'SELECT * FROM orders WHERE id IN (SELECT order_id FROM lines ORDER BY id)',
	'SELECT * FROM orders WHERE (a = 1 AND b = 2) OR c = 3',
	'SELECT * FROM t WHERE a = 1 -- note',
	'SELECT * FROM t WHERE a = 1 # note',
	'SELECT /* cols */ * FROM t',
	"SELECT * FROM t WHERE a = 'O\\'Brien' ORDER BY x",
	"SELECT * FROM t WHERE a = 'unclosed",
	'SELECT * FROM t WHERE a = 1 QUALIFY row_number() OVER (PARTITION BY b) = 1',
	'SELECT * FROM t WHERE a = 1 WINDOW w AS (ORDER BY b)',
	'SELECT * FROM a MINUS SELECT * FROM b',
	'SELECT * FROM t START WITH id = 1 CONNECT BY PRIOR id = pid',
	'SELECT * FROM t TABLESAMPLE BERNOULLI (10)',
	'SELECT * FROM a JOIN b ON a.id = b.id',
	'SELECT * FROM a, b',
	'SELECT DISTINCT x FROM t',
	'SELECT count(*) FROM t',
	'SELECT * FROM t GROUP BY x',
	'SELECT * FROM t ORDER BY x',
	'SELECT * FROM t LIMIT 10',
	'SELECT TOP 10 * FROM t',
	'SELECT * FROM a UNION SELECT * FROM b',
	'SELECT * FROM (SELECT * FROM t) x',
	'SELECT * FROM t; SELECT 1',
	'WITH c AS (SELECT 1) SELECT * FROM c',
	'UPDATE t SET x = 1',
	'SELECT * FROM t FOR UPDATE',
	'SELECT * FROM `order`',
	'SELECT * FROM t WHERE tags[1] = 2',
];

test('INVARIANT: anything browseShape accepts produces a well-formed keyset page', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	let accepted = 0;
	for (const sql of CORPUS) {
		const shape = browseShape(sql);
		if (!shape) {
			continue;
		}
		accepted++;
		for (const driver of ['postgres', 'mysql-aurora', 'sqlserver', 'oracle']) {
			for (const after of [undefined, ['5']]) {
				const out = keysetSelect({ ...shape, key, after, limit: 200 }, driver);
				const s = structure(out);
				assert.ok(s.balancedQuotes, `unbalanced quotes: ${sql} [${driver}] → ${out}`);
				assert.equal(s.parenDepth, 0, `unbalanced parens: ${sql} [${driver}] → ${out}`);
				assert.ok(!/--|#|\/\*/.test(out), `comment marker survived: ${sql} [${driver}] → ${out}`);
				// The tail we appended has to BE the statement's ordering, not a second one hiding
				// behind a comment or a swallowed clause. This is what bugs 5, 7 and 8 all broke.
				assert.equal(s.topLevel.order, 1, `expected exactly one top-level ORDER BY: ${sql} [${driver}] → ${out}`);
				assert.equal(s.topLevel.where, after ? 1 : (shape.conditions.length > 0 ? 1 : 0), `WHERE count: ${sql} [${driver}] → ${out}`);
				assert.equal(s.topLevel.select, 1, `expected one top-level SELECT: ${sql} [${driver}] → ${out}`);
			}
		}
	}
	// Guard the guard: if a future change made browseShape reject everything, the loop above would
	// pass vacuously and prove nothing.
	assert.ok(accepted >= 8, `corpus should exercise the accept path, got ${accepted}`);
});

// --- reading the cursor back out of a page ---

const literal = (v: unknown): string => (typeof v === 'number' ? String(v) : `'${String(v)}'`);

test('keysetCursorFrom reads the key values out of the last row', () => {
	const key = { columns: [{ name: 'created_at', dir: 'desc' as const }, { name: 'id', dir: 'asc' as const }] };
	const fields = [{ name: 'id' }, { name: 'created_at' }, { name: 'note' }];
	assert.deepEqual(keysetCursorFrom(key, fields, [7, '2026-01-01', 'x'], literal), [`'2026-01-01'`, '7']);
});

test('keysetCursorFrom fails closed when a key column is not projected', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(keysetCursorFrom(key, [{ name: 'note' }], ['x'], literal), null);
});

test('keysetCursorFrom fails closed on a NULL key value', () => {
	const key = { columns: [{ name: 'id', dir: 'asc' as const }] };
	assert.equal(keysetCursorFrom(key, [{ name: 'id' }], [null], literal), null);
});

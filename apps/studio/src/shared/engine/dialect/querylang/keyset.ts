/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Keyset ("seek") pagination — the fetch engine's replacement for deep OFFSET.
 *
 *  `LIMIT 200 OFFSET 5000000` makes the engine walk and discard five million rows to hand back
 *  two hundred, so every page costs more than the last. A keyset page instead asks for the rows
 *  AFTER the last one already seen — `WHERE pk > :last ORDER BY pk LIMIT 200` — which is one
 *  index descent regardless of depth. Page 1 and page 50,000 cost the same.
 *
 *  Two things make that correct rather than merely fast, and both are enforced here:
 *
 *  1. The key must be a TOTAL order — unique and NOT NULL across the rows being paged. A
 *     non-unique key loses rows at the page boundary (every row tying the last key value is
 *     skipped); a nullable one silently drops rows, since `NULL > x` is unknown, not true.
 *     {@link keysetKeyFor} is the single gate that decides whether a table + sort qualifies.
 *  2. Every page of one sequence must share ONE ordering. A first page fetched in heap order
 *     and a second fetched in key order do not compose. Callers therefore record that a result
 *     was opened as a keyset sequence and keep paging it that way, or stay on OFFSET for the
 *     whole result.
 *
 *  Pure like the rest of the engine: it builds SQL text and decides eligibility. Values arrive
 *  as already-formatted SQL literals (the caller's `literalFromValue`), so nothing here needs to
 *  know how a vendor spells a date or a boolean.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, TableInfo } from '../../../schema';
import { dialectFor } from '../index';

/** One column of a keyset key, in key order, with the direction it is scanned in. */
export interface KeysetKeyColumn {
	name: string;
	dir: 'asc' | 'desc';
}

/** The ordering a result is being paged by, once {@link keysetKeyFor} has approved it. */
export interface KeysetKey {
	/** Key columns in order. Unique + NOT NULL as a tuple, which is what makes paging exact. */
	columns: readonly KeysetKeyColumn[];
}

/** A request for the page that follows `after` in `key` order. */
export interface KeysetPage {
	/** The statement up to but excluding WHERE, e.g. `SELECT * FROM "public"."orders"`. */
	select: string;
	/** The caller's own WHERE conditions (already-built SQL), AND'd with the seek predicate. */
	conditions?: readonly string[];
	key: KeysetKey;
	/** SQL literals of the key values of the last row on the previous page, aligned to
	 *  `key.columns`. Absent (or empty) means the first page: no seek predicate is emitted. */
	after?: readonly string[];
	limit: number;
}

/**
 * The seek predicate: everything strictly after the `after` tuple in key order.
 *
 * Emitted as the lexicographic expansion rather than a row-value constructor
 * (`(a, b) > (1, 2)`), because row-value comparison is not portable — SQL Server and Oracle
 * reject it, and it does not express mixed ASC/DESC directions at all:
 *
 *     (a > 1) OR (a = 1 AND b > 2) OR (a = 1 AND b = 2 AND c > 3)
 *
 * Each column's comparison flips to `<` when that column is scanned DESC, so a key of
 * `(created_at DESC, id ASC)` pages in exactly the order the user is looking at.
 *
 * Returns `''` when there is nothing to seek past (the first page).
 */
export function seekPredicate(key: KeysetKey, after: readonly string[] | undefined, driverId?: string): string {
	if (!after || after.length === 0) {
		return '';
	}
	const dialect = dialectFor(driverId);
	// A short tuple would compare against the wrong columns, which silently returns wrong rows
	// rather than failing — treat it as "no seek" instead of guessing.
	if (after.length !== key.columns.length) {
		return '';
	}
	const terms: string[] = [];
	for (let i = 0; i < key.columns.length; i++) {
		const parts: string[] = [];
		for (let j = 0; j < i; j++) {
			parts.push(`${dialect.quoteIdent(key.columns[j].name)} = ${after[j]}`);
		}
		const op = key.columns[i].dir === 'desc' ? '<' : '>';
		parts.push(`${dialect.quoteIdent(key.columns[i].name)} ${op} ${after[i]}`);
		terms.push(parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0]);
	}
	return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
}

/** The ORDER BY tail for a keyset key (leading space, as {@link PageRequest.orderBy} wants). */
export function keysetOrderBy(key: KeysetKey, driverId?: string): string {
	const dialect = dialectFor(driverId);
	const cols = key.columns.map((c) => `${dialect.quoteIdent(c.name)}${c.dir === 'desc' ? ' DESC' : ''}`);
	return ` ORDER BY ${cols.join(', ')}`;
}

/**
 * Build one keyset page. The row cap goes through the dialect's own `paginatedSelect` at offset
 * 0, so each vendor caps the way it already does elsewhere (LIMIT / TOP / OFFSET..FETCH) and no
 * new per-vendor branch is introduced here.
 */
export function keysetSelect(page: KeysetPage, driverId?: string): string {
	const seek = seekPredicate(page.key, page.after, driverId);
	const conditions = [...(page.conditions ?? []), ...(seek ? [seek] : [])];
	const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
	const orderBy = keysetOrderBy(page.key, driverId);
	return dialectFor(driverId).paginatedSelect(`${page.select}${where}`, {
		limit: page.limit,
		offset: 0,
		orderBy,
		// Never consulted: a keyset page always supplies its own ORDER BY.
		fallbackOrderBy: '1',
	});
}

/** The pieces of a statement simple enough to be re-issued as a keyset page. */
export interface BrowseShape {
	/** The statement up to but excluding WHERE, e.g. `SELECT * FROM orders o`. */
	select: string;
	/** The author's own WHERE predicate, ALREADY PARENTHESIZED. Non-negotiable: ANDing the seek
	 *  onto a bare `a = 1 OR b = 2` would rebind as `a = 1 OR (b = 2 AND seek)` and return rows
	 *  the author never asked for. Empty when the statement has no WHERE. */
	conditions: string[];
	/** The table being read, unqualified — the name to look a keyset key up by in the schema. */
	table: string;
	/** The schema/database qualifier as written, when the statement qualified the table. */
	schema?: string;
}

/**
 * Whether every string literal and quoted identifier closes. The clause scanner below skips quoted
 * regions, so an unterminated one hides everything after it — and "hidden" means a real `ORDER BY`
 * is not seen, the statement is accepted as a plain browse, and a SECOND `ORDER BY` gets appended.
 *
 * The realistic source is MySQL's backslash escape: `'O\'Brien'` is balanced to MySQL but not to a
 * scanner that doesn't implement backslash escaping (and whether it applies depends on the server's
 * `NO_BACKSLASH_ESCAPES` mode, which we can't see from here). So rather than model escaping, treat
 * anything we can't scan cleanly as not-a-browse and let it take the OFFSET path.
 */
function hasBalancedQuoting(sql: string): boolean {
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (ch !== "'" && ch !== '"' && ch !== '`' && ch !== '[') {
			continue;
		}
		const close = ch === '[' ? ']' : ch;
		i++;
		while (i < sql.length && sql[i] !== close) {
			i++;
		}
		if (i >= sql.length) {
			return false;
		}
	}
	return true;
}

/** Index of `keyword` at paren depth 0 and outside any string/quoted identifier, or -1. Used to
 *  find real clause boundaries: `WHERE x IN (SELECT … ORDER BY y)` must not read as an ORDER BY
 *  of the outer statement, and `'from'` inside a literal is not a FROM. */
function topLevelKeywordIndex(sql: string, keyword: string): number {
	const lower = sql.toLowerCase();
	let depth = 0;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
			const close = ch === '[' ? ']' : ch;
			i++;
			while (i < sql.length && sql[i] !== close) {
				i++;
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
		if (depth !== 0 || !lower.startsWith(keyword, i)) {
			continue;
		}
		const before = i === 0 ? ' ' : sql[i - 1];
		const after = sql[i + keyword.length] ?? ' ';
		if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
			return i;
		}
	}
	return -1;
}

/**
 * Clauses whose presence means the statement is not a plain browse: it joins, reshapes, orders or
 * caps its own rows, any of which the keyset rewrite would change the meaning of.
 *
 * Most also fail the single-table-reference test further down, but not the ones that can follow a
 * WHERE — a trailing `QUALIFY`/`WINDOW` would be swallowed into the parenthesized predicate and
 * emit a syntax error. Vendor-specific spellings are included deliberately: `minus` is Oracle's
 * `except`, `qualify` is Snowflake's, `connect`/`start` are Oracle hierarchical queries, `sample`
 * covers `TABLESAMPLE`. Over-rejecting costs the OFFSET path; under-rejecting costs a broken query.
 */
const NON_BROWSE_CLAUSES = ['join', 'group', 'having', 'order', 'union', 'intersect', 'except', 'minus', 'limit', 'offset', 'fetch', 'top', 'into', 'for', 'qualify', 'window', 'connect', 'start', 'sample'];

/**
 * Recognise `SELECT <cols> FROM <one table> [WHERE …]` — and nothing more elaborate — so it can
 * be re-issued as a keyset page. Returns `null` for anything else, which is the caller's signal to
 * keep the OFFSET path.
 *
 * Deliberately narrow. A false negative costs the old behavior; a false positive silently returns
 * wrong rows, so every construct whose interaction with an appended `ORDER BY key` + seek
 * predicate isn't obvious is rejected: joins and multi-table FROMs (the key isn't unique across
 * the product), GROUP BY / DISTINCT / aggregates (the output rows aren't table rows), set
 * operations, an ORDER BY of the author's own (the sequence would have two orderings), and any
 * self-imposed cap. Parentheses are allowed only inside WHERE, where a subquery is just a
 * predicate; in the projection or FROM they would mean a function or a derived table.
 */
export function browseShape(sql: string): BrowseShape | null {
	const trimmed = sql.trim().replace(/;\s*$/, '');
	if (trimmed.includes(';') || !/^select\b/i.test(trimmed)) {
		return null;
	}
	// A comment anywhere disqualifies the statement. A keyset page appends its WHERE, ORDER BY and
	// row cap INLINE, so a trailing line comment would swallow all of it — `WHERE (a = 1 -- note)
	// AND id > 5 ORDER BY …` is an unclosed paren, not a query. (The OFFSET window this falls back to
	// survives because it appends on a NEW line.) Block comments are refused too rather than teaching
	// the clause scanner to skip them: over-rejecting costs the old path, misreading costs a query.
	if (/--|#|\/\*/.test(trimmed) || !hasBalancedQuoting(trimmed)) {
		return null;
	}
	const whereIndex = topLevelKeywordIndex(trimmed, 'where');
	const head = whereIndex >= 0 ? trimmed.slice(0, whereIndex) : trimmed;
	const predicate = whereIndex >= 0 ? trimmed.slice(whereIndex + 'where'.length).trim() : '';
	for (const clause of NON_BROWSE_CLAUSES) {
		if (topLevelKeywordIndex(trimmed, clause) >= 0) {
			return null;
		}
	}
	const fromIndex = topLevelKeywordIndex(head, 'from');
	if (fromIndex < 0) {
		return null;
	}
	const projection = head.slice('select'.length, fromIndex);
	// A function call or a subquery in the projection means the rows aren't plain table rows.
	if (projection.includes('(') || /\bdistinct\b/i.test(projection) || projection.trim() === '') {
		return null;
	}
	// One table reference, optionally aliased. A comma here is an implicit join.
	const ref = head.slice(fromIndex + 'from'.length).trim();
	const match = /^([A-Za-z0-9_$."`\[\]]+)(?:\s+(?:as\s+)?[A-Za-z0-9_$]+)?$/i.exec(ref);
	if (!match) {
		return null;
	}
	const parts = match[1].replace(/[`"\[\]]/g, '').split('.').filter((p) => p !== '');
	const name = parts[parts.length - 1];
	if (!name) {
		return null;
	}
	if (whereIndex >= 0 && predicate === '') {
		return null;
	}
	return {
		select: head.trimEnd(),
		conditions: predicate ? [`(${predicate})`] : [],
		table: name,
		schema: parts.length > 1 ? parts[parts.length - 2] : undefined,
	};
}

/**
 * Types whose value we can round-trip into a SQL literal that compares the SAME way the engine
 * ordered it. Numbers and character types qualify: the literal is exact, and `>` uses the same
 * collation the `ORDER BY` did, so the seek and the sort always agree.
 *
 * Everything else is REFUSED, and temporal types are the reason this gate exists. A DATETIME
 * arrives in a result row as a JS Date, reaches the renderer JSON-serialised, and formats as an
 * ISO-8601 string — which MySQL does not compare as the datetime it came from. The seek would then
 * silently return the wrong rows instead of failing. Same story for binary, JSON, blob and bit.
 * A refusal only costs the OFFSET path; a bad literal costs correctness.
 */
const KEYABLE_TYPE = /^(?:tiny|small|medium|big)?int|^integer|^serial|^bigserial|^dec|^numeric|^number|^float|^double|^real|^char|^varchar|^nchar|^nvarchar|^varchar2|^text|^string|^uuid|^uniqueidentifier|^citext/i;

/** A column can carry a keyset key only if it is NOT NULL and of a safely comparable type.
 *  NOT NULL because `NULL > x` is unknown, so a nullable key column silently drops every row
 *  holding a NULL there; the type gate is {@link KEYABLE_TYPE}. */
function isKeyable(column: ColumnInfo | undefined): column is ColumnInfo {
	return column !== undefined && !column.nullable && KEYABLE_TYPE.test(column.dataType.trim());
}

/**
 * The same, for a column that is part of the PRIMARY KEY: its type has to be seekable, but its
 * nullability is not asked about, because a primary-key column cannot hold NULL in any engine.
 *
 * SQLite is why this exists. `id INTEGER PRIMARY KEY` is the rowid alias, and `PRAGMA table_info`
 * reports `notnull = 0` for it, so the catalog says nullable and the strict check above refused the
 * key. Every SQLite table with the most ordinary primary key there is therefore paged by OFFSET,
 * and the flow wizard told the user "this table has no usable primary key" about a table whose
 * primary key was right there on the screen above it.
 */
function isKeyablePrimaryKeyColumn(column: ColumnInfo | undefined): column is ColumnInfo {
	return column !== undefined && KEYABLE_TYPE.test(column.dataType.trim());
}

/** Look a column up by name, case-insensitively (catalogs fold case differently per vendor). */
function columnByName(table: TableInfo, name: string): ColumnInfo | undefined {
	const lower = name.toLowerCase();
	return table.columns.find((c) => c.name.toLowerCase() === lower);
}

/** The table's primary-key column names (explicit PK list, else the flagged columns). */
function primaryKeyColumns(table: TableInfo): string[] {
	return table.primaryKey && table.primaryKey.length > 0
		? [...table.primaryKey]
		: table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
}

/**
 * Decide the key a browse of `table` can be paged by, or `null` when it can't be (the caller
 * then keeps its OFFSET path). This is the ONE place the eligibility rule lives.
 *
 * - **Unsorted browse** → the primary key, in its declared order.
 * - **User-sorted browse** → the sort column FOLLOWED BY the primary key. The sort column alone
 *   is almost never unique, and a non-unique key drops every row that ties the last value at the
 *   page boundary; appending the PK makes the tuple total while preserving the order the user
 *   asked for. A sort column that is nullable disqualifies the whole key (see {@link isKeyable}).
 * - **No usable primary key** (none, or any PK column nullable or of an unsafe type) → `null`.
 *
 * Only a base `table` qualifies. A **view**'s `primaryKey` is not a uniqueness guarantee we can
 * rely on, and a **collection** (MongoDB) is not a relational row source at all — its `_id` looks
 * like a primary key, but rewriting a document browse into seek SQL would push a synthesised
 * `ORDER BY`/`WHERE` through the SQL-to-Mongo compiler, which is not what this was built or
 * tested for. Both keep the paging they already had.
 */
export function keysetKeyFor(table: TableInfo | undefined, sort?: { column: string; dir: 'asc' | 'desc' }): KeysetKey | null {
	if (!table || table.kind !== 'table') {
		return null;
	}
	const pk = primaryKeyColumns(table);
	if (pk.length === 0 || !pk.every((name) => isKeyablePrimaryKeyColumn(columnByName(table, name)))) {
		return null;
	}
	const columns: KeysetKeyColumn[] = [];
	if (sort) {
		const sortColumn = columnByName(table, sort.column);
		if (!isKeyable(sortColumn)) {
			return null;
		}
		columns.push({ name: sortColumn.name, dir: sort.dir });
	}
	for (const name of pk) {
		// A sort on a PK column is already covered by the leading term; repeating it would emit a
		// contradictory `x > v AND x = v` pair in the seek predicate.
		if (columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
			continue;
		}
		// Take the CATALOG's spelling, not the constraint's: they can differ in case, and the
		// generated SQL quotes these names, where a wrong case is a wrong identifier on a
		// case-sensitive vendor.
		columns.push({ name: columnByName(table, name)?.name ?? name, dir: sort?.dir ?? 'asc' });
	}
	return columns.length > 0 ? { columns } : null;
}

/**
 * The key for an explicitly NAMED set of columns, made total by appending the primary key — what
 * a Data Flow's incremental read uses (`incremental.keyColumns`: "move only the rows whose
 * `updated_at` is past where the last run stopped").
 *
 * Same gate as {@link keysetKeyFor}, deliberately: every named column must be NOT NULL and of a
 * safely comparable type, and the table's own primary key must qualify, or the answer is `null`
 * and the caller falls back to re-reading. Note what this rules out — an `updated_at` that is
 * nullable, or a DATETIME, is refused, because a temporal literal does not always compare the way
 * the engine ordered it (see {@link KEYABLE_TYPE}); an incremental read built on one would skip
 * rows silently, which is the worst failure this feature can have.
 */
export function keysetKeyForColumns(table: TableInfo | undefined, names: readonly string[], dir: 'asc' | 'desc' = 'asc'): KeysetKey | null {
	if (!table || table.kind !== 'table' || names.length === 0) {
		return null;
	}
	const columns: KeysetKeyColumn[] = [];
	const inPrimaryKey = new Set(primaryKeyColumns(table).map((name) => name.toLowerCase()));
	for (const name of names) {
		const column = columnByName(table, name);
		// A chosen column has to be seekable AND not nullable — unless it is part of the primary
		// key, which cannot be null whatever the catalog says about it (see
		// {@link isKeyablePrimaryKeyColumn}: SQLite reports its rowid-alias key as nullable, so
		// "move only new rows by id" was refused for the most ordinary key there is).
		const ok = inPrimaryKey.has(name.toLowerCase()) ? isKeyablePrimaryKeyColumn(column) : isKeyable(column);
		if (!ok || column === undefined) {
			return null;
		}
		if (!columns.some((c) => c.name.toLowerCase() === column.name.toLowerCase())) {
			columns.push({ name: column.name, dir });
		}
	}
	const pk = primaryKeyColumns(table);
	if (pk.length === 0 || !pk.every((name) => isKeyablePrimaryKeyColumn(columnByName(table, name)))) {
		return null;
	}
	for (const name of pk) {
		if (columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
			continue;
		}
		columns.push({ name: columnByName(table, name)?.name ?? name, dir });
	}
	return { columns };
}

/**
 * Read the key values out of a result row, as SQL literals ready for the next page's `after`.
 * `fields` are the result's column names in row order; `format` is the caller's literal builder
 * (`literalFromValue`), which is where vendor value formatting stays.
 *
 * Returns `null` when a key column is missing from the projection (a `SELECT` of specific
 * columns that omits the key) or its value is NULL — in both cases the sequence cannot be
 * continued exactly, so the caller falls back rather than paging from a wrong position.
 */
export function keysetCursorFrom(
	key: KeysetKey,
	fields: readonly { name: string }[],
	row: readonly unknown[],
	format: (value: unknown) => string,
): string[] | null {
	const cursor: string[] = [];
	for (const column of key.columns) {
		const index = fields.findIndex((f) => f.name.toLowerCase() === column.name.toLowerCase());
		if (index < 0) {
			return null;
		}
		const value = row[index];
		if (value === null || value === undefined) {
			return null;
		}
		// Second gate, on the VALUE rather than the declared type: only a primitive formats into a
		// literal that compares the way the engine sorted it. A Date or a Buffer reaching here means
		// the column type slipped past `KEYABLE_TYPE` (a vendor spelling we don't know), and paging
		// from a mangled literal returns wrong rows silently — so fail closed and let the caller
		// fall back instead.
		if (typeof value === 'object') {
			return null;
		}
		// MySQL/MariaDB treat backslash as an escape character inside string literals (unless
		// NO_BACKSLASH_ESCAPES is set), so a key value ending in one turns the closing quote into an
		// escaped quote and the rest of the statement into string content. Refuse rather than emit a
		// literal whose meaning depends on a server mode we don't check.
		if (typeof value === 'string' && value.includes('\\')) {
			return null;
		}
		// A number past 2^53 has already lost precision before it reached us — mysql2 returns BIGINT
		// as a JS number unless `supportBigNumbers` is set, and our pool does not set it. Seeking from
		// a rounded key silently skips or repeats the rows around it, so refuse: a BIGINT id in that
		// range keeps the OFFSET path until the driver hands back exact values.
		if (typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value)) {
			return null;
		}
		cursor.push(format(value));
	}
	return cursor;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Batched INSERT emission.
 *
 *  Desktop tools insert row-by-row and get benchmarked for it; a multi-row INSERT is the visible
 *  speed win the flow sink ships with. This module turns a batch of already-cast
 *  rows into the fewest statements the vendor will accept.
 *
 *  THIS IS THE HIGHEST-RISK CODE IN THE FEATURE. It renders values as SQL literals, so an escaping
 *  mistake here is injection-shaped even though the "attacker" is usually just a CSV with an
 *  apostrophe in it. Rules that must not be relaxed:
 *
 *    - Every string literal is single-quoted with `'` doubled. The MySQL family ALSO treats `\` as
 *      an escape character by default, so it is doubled there and nowhere else.
 *    - NUL is removed. Postgres rejects it in text outright and it terminates strings in several
 *      client libraries; dropping it is the only option that neither corrupts nor explodes.
 *    - Only the five cell types exist (`FlowCell`). Anything else is a bug upstream in casting and
 *      throws rather than being coerced into a literal.
 *    - Identifiers go through the dialect's `quoteIdent`, never string concatenation.
 *
 *  A parameterized bulk-insert driver API would retire the escaping entirely; it is the noted
 *  future upgrade, and until then this file carries exhaustive tests.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from './index';
import type { FlowCell, FlowRow } from './rows';

/** Where a batch is going. */
export interface InsertTarget {
	schema?: string;
	table: string;
	/** Column order every row in the batch is aligned to. */
	columns: string[];
}

export interface InsertOptions {
	/** Rows per statement, below the vendor's own ceiling. */
	maxRowsPerStatement?: number;
	/** Character budget per statement, so one wide batch can't exceed a server's packet limit. */
	maxStatementChars?: number;
}

/** Vendor ceilings on rows in one statement. SQL Server's 1000-row VALUES limit is a hard error;
 *  the others are prudence, not law. */
const VENDOR_ROW_CAP: Record<string, number> = {
	sqlserver: 1000,
	oracle: 500,
	db2: 500,
	hana: 500,
};

const DEFAULT_ROW_CAP = 1000;
/** Keeps a statement comfortably under MySQL's default 64 MB max_allowed_packet and every other
 *  vendor's practical limit, without splitting so eagerly that the batching stops paying. */
const DEFAULT_CHAR_CAP = 512 * 1024;

/** `"schema"."table"`, quoted for the vendor. */
export function qualifiedName(driverId: string, schema: string | undefined, table: string): string {
	const q = dialectFor(driverId).quoteIdent;
	return schema ? `${q(schema)}.${q(table)}` : q(table);
}

/** Two digits, for date-literal assembly. */
function pad(n: number, width = 2): string {
	return String(n).padStart(width, '0');
}

/** A UTC date as `YYYY-MM-DD HH:MM:SS.mmm` — the one format every engine here parses the same way. */
function dateText(value: Date): string {
	return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} `
		+ `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}`;
}

/** Quote and escape a string for the vendor. See the header: this is the security-relevant line. */
function stringLiteral(driverId: string, value: string): string {
	// NUL cannot survive a round-trip through Postgres text or several C-based clients.
	let body = value.replace(/\0/g, '');
	if (dialectFor(driverId).backslashEscapes) {
		body = body.replace(/\\/g, '\\\\');
	}
	body = body.replace(/'/g, "''");
	// N'' so SQL Server carries non-ASCII into an NVARCHAR column instead of transliterating it.
	return driverId === 'sqlserver' ? `N'${body}'` : `'${body}'`;
}

/**
 * One cell as a SQL literal for `driverId`. Exported because the dry-run report shows the exact
 * statements a run would issue, and "exact" has to mean the same function.
 */
export function sqlLiteral(driverId: string, value: FlowCell): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (typeof value === 'boolean') {
		return dialectFor(driverId).booleanLiteral(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(`Cannot write ${String(value)} to a database column.`);
		}
		return String(value);
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new Error('Cannot write an invalid date to a database column.');
		}
		const text = dateText(value);
		// Oracle will not implicitly parse a bare string into a DATE/TIMESTAMP under every NLS
		// setting, so it gets an explicit conversion instead of a literal.
		return driverId === 'oracle'
			? `TO_TIMESTAMP('${text}', 'YYYY-MM-DD HH24:MI:SS.FF3')`
			: stringLiteral(driverId, text);
	}
	if (typeof value === 'string') {
		return stringLiteral(driverId, value);
	}
	throw new Error(`Unsupported value type ${typeof value} in a row batch.`);
}

/** `(1, 'x', NULL)` for one row. */
function tuple(driverId: string, row: FlowRow, width: number): string {
	if (row.length !== width) {
		throw new Error(`Row has ${row.length} values but the batch has ${width} columns.`);
	}
	return `(${row.map((cell) => sqlLiteral(driverId, cell)).join(', ')})`;
}

/**
 * Turn a batch of rows into INSERT statements for `driverId`. Usually one statement; more when the
 * batch exceeds the vendor's row ceiling or the character budget. Oracle has no multi-row VALUES,
 * so it gets `INSERT ALL … SELECT * FROM dual`, which is the same trip in one statement.
 */
export function emitInsertRows(driverId: string, target: InsertTarget, rows: FlowRow[], options: InsertOptions = {}): string[] {
	if (rows.length === 0) {
		return [];
	}
	if (target.columns.length === 0) {
		throw new Error('Cannot insert rows with no columns.');
	}
	const q = dialectFor(driverId).quoteIdent;
	const name = qualifiedName(driverId, target.schema, target.table);
	const columnList = target.columns.map(q).join(', ');
	const rowCap = Math.max(1, Math.min(options.maxRowsPerStatement ?? DEFAULT_ROW_CAP, VENDOR_ROW_CAP[driverId] ?? DEFAULT_ROW_CAP));
	const charCap = options.maxStatementChars ?? DEFAULT_CHAR_CAP;
	const width = target.columns.length;

	const statements: string[] = [];
	let chunk: string[] = [];
	let chunkChars = 0;

	const flush = (): void => {
		if (chunk.length === 0) {
			return;
		}
		statements.push(driverId === 'oracle'
			? `INSERT ALL\n\tINTO ${name} (${columnList}) VALUES ${chunk.join(`\n\tINTO ${name} (${columnList}) VALUES `)}\nSELECT * FROM dual`
			: `INSERT INTO ${name} (${columnList}) VALUES\n\t${chunk.join(',\n\t')}`);
		chunk = [];
		chunkChars = 0;
	};

	for (const row of rows) {
		const text = tuple(driverId, row, width);
		if (chunk.length > 0 && (chunk.length >= rowCap || chunkChars + text.length > charCap)) {
			flush();
		}
		chunk.push(text);
		chunkChars += text.length + 2;
	}
	flush();
	return statements;
}

/*---------------------------------------------------------------------------------------------
 *  UPSERT.
 *
 *  "Update the rows that are already there and add the rest" is what makes a bucket of CORRECTED
 *  files work: an append duplicates every corrected row, and `replace` throws away everything the
 *  flow did not read this time. It is the third option the destination question always needed.
 *
 *  Four shapes, and the differences between them are not cosmetic:
 *
 *    ON CONFLICT      postgres, sqlite, duckdb. Names the conflict target explicitly, so it does
 *                     what it says. REQUIRES a unique index on exactly those columns; without one
 *                     the engine raises "no unique or exclusion constraint matching" and the run
 *                     stops, which is the correct outcome and not one we can prevent from here.
 *    ON DUPLICATE KEY mysql-aurora, mariadb. It does NOT take a conflict target: it fires on ANY
 *                     unique index on the table, not the one we named. A row matching some other
 *                     unique column is therefore UPDATED rather than rejected. That is a real
 *                     semantic difference from every other vendor here, it cannot be expressed
 *                     away, and `upsertCaveat` returns the sentence that says so.
 *    MERGE + VALUES   sqlserver, db2. A table constructor is the row source.
 *                     SQL Server's MERGE must be terminated with a semicolon - not style, the
 *                     parser requires it.
 *    MERGE + UNION    oracle (FROM dual), hana (FROM DUMMY), snowflake (no FROM at all). None
 *                     of the three takes a VALUES constructor in USING, so the source is spelled
 *                     out as SELECT ... UNION ALL SELECT .... Oracle also rejects `AS` on a table
 *                     alias, which is a syntax error rather than a preference.
 *
 *  And one refusal. Redshift has no ON CONFLICT (it forked from Postgres 8.0.2, long before it
 *  existed) and its MERGE is recent enough that nobody here has run one. Emitting a plausible
 *  statement for it would move the failure from design time to run time, on somebody's warehouse,
 *  so `supportsUpsert` says no and `validateSpec` refuses the flow instead.
 *
 *  Every rule in this file's header applies unchanged: literals through `sqlLiteral`, identifiers
 *  through `quoteIdent`, never string concatenation.
 *--------------------------------------------------------------------------------------------*/

/** How a vendor spells "update the ones that are there, insert the rest". */
type UpsertShape = 'onConflict' | 'onDuplicateKey' | 'mergeValues' | 'mergeUnion';

const UPSERT_SHAPE: Record<string, UpsertShape> = {
	postgres: 'onConflict',
	sqlite: 'onConflict',
	duckdb: 'onConflict',
	'mysql-aurora': 'onDuplicateKey',
	mariadb: 'onDuplicateKey',
	sqlserver: 'mergeValues',
	db2: 'mergeValues',
	oracle: 'mergeUnion',
	hana: 'mergeUnion',
	// Snowflake reaches a VALUES constructor only through `SELECT * FROM VALUES (…)`, never bare in
	// USING, and it needs no FROM at all for a row of literals. So it is a UNION source with none.
	snowflake: 'mergeUnion',
};

/**
 * What a `mergeUnion` vendor selects FROM for a row of literals. An empty string means no FROM
 * clause at all, which Snowflake allows and the other two do not.
 */
const MERGE_UNION_FROM: Record<string, string> = { oracle: 'dual', hana: 'DUMMY', snowflake: '' };

/**
 * Vendors that reject `AS` on a table alias. Oracle is the whole list, and this is not a style
 * preference: `MERGE INTO t AS tgt` is a syntax error there.
 */
const NO_ALIAS_KEYWORD = new Set(['oracle']);

/**
 * Can this vendor upsert at all?
 *
 * Asked at DESIGN time by `validateSpec`, which is the whole point: a destination that cannot do
 * this should stop the flow on the screen where it was chosen, not on somebody's warehouse at
 * 3am on the second run.
 */
export function supportsUpsert(driverId: string): boolean {
	return UPSERT_SHAPE[driverId] !== undefined;
}

/**
 * What is true of this vendor's upsert but not of the others, or an empty string when there is
 * nothing to say. Surfaced as a warning rather than buried here, because it changes what the
 * feature DOES.
 */
export function upsertCaveat(driverId: string): string {
	if (UPSERT_SHAPE[driverId] === 'onDuplicateKey') {
		return 'MySQL and MariaDB match on any unique column, not only the key you chose: a row that collides on some other unique column is updated rather than added.';
	}
	return '';
}

/**
 * Turn a batch of rows into UPSERT statements: rows whose key already exists are updated, the rest
 * are inserted. Chunked exactly as {@link emitInsertRows} is, and for the same reasons.
 *
 * Throws rather than emitting something plausible when the vendor cannot do this or the key is
 * empty. Both are caught by `validateSpec` long before a run, so reaching either throw is a bug in
 * this app rather than a mistake a user can make.
 */
export function emitUpsertRows(
	driverId: string,
	target: InsertTarget,
	rows: FlowRow[],
	keyColumns: string[],
	options: InsertOptions = {},
): string[] {
	if (rows.length === 0) {
		return [];
	}
	if (target.columns.length === 0) {
		throw new Error('Cannot write rows with no columns.');
	}
	if (keyColumns.length === 0) {
		// An upsert with no key is an append that claims not to be one. It would insert every row
		// on every run and report itself as keeping the table up to date.
		throw new Error('An upsert needs a key: without one there is nothing to match a row against.');
	}
	const missing = keyColumns.filter((key) => !target.columns.some((column) => column.toLowerCase() === key.toLowerCase()));
	if (missing.length > 0) {
		// The key has to be IN the batch, or the statement matches on a column the rows do not carry.
		throw new Error(`The key ${missing.join(', ')} is not among the columns being written.`);
	}
	const shape = UPSERT_SHAPE[driverId];
	if (!shape) {
		throw new Error(`${dialectFor(driverId).displayName} cannot update and insert in one statement, so this flow cannot upsert into it.`);
	}

	const q = dialectFor(driverId).quoteIdent;
	const name = qualifiedName(driverId, target.schema, target.table);
	const columnList = target.columns.map(q).join(', ');
	const keys = new Set(keyColumns.map((key) => key.toLowerCase()));
	// The columns actually written on a match. When the key IS every column there is nothing to
	// update, and each vendor has its own way of saying "leave it alone" (see the flush below).
	const updatable = target.columns.filter((column) => !keys.has(column.toLowerCase()));
	const rowCap = Math.max(1, Math.min(options.maxRowsPerStatement ?? DEFAULT_ROW_CAP, VENDOR_ROW_CAP[driverId] ?? DEFAULT_ROW_CAP));
	const charCap = options.maxStatementChars ?? DEFAULT_CHAR_CAP;
	const width = target.columns.length;

	const statements: string[] = [];
	let chunk: string[] = [];
	let chunkChars = 0;

	const flush = (): void => {
		if (chunk.length === 0) {
			return;
		}
		statements.push(upsertStatement(driverId, shape, name, target.columns, columnList, keyColumns, updatable, chunk, q));
		chunk = [];
		chunkChars = 0;
	};

	for (const row of rows) {
		const text = tuple(driverId, row, width);
		if (chunk.length > 0 && (chunk.length >= rowCap || chunkChars + text.length > charCap)) {
			flush();
		}
		chunk.push(text);
		chunkChars += text.length + 2;
	}
	flush();
	return statements;
}

/** One statement, for one chunk of already-rendered `(…)` tuples. */
function upsertStatement(
	driverId: string,
	shape: UpsertShape,
	name: string,
	columns: string[],
	columnList: string,
	keyColumns: string[],
	updatable: string[],
	chunk: string[],
	q: (name: string) => string,
): string {
	const keyList = keyColumns.map(q).join(', ');

	if (shape === 'onConflict') {
		const values = `INSERT INTO ${name} (${columnList}) VALUES\n\t${chunk.join(',\n\t')}`;
		// Nothing to update means the row is already exactly what we would write. DO NOTHING is the
		// honest statement for that, and `DO UPDATE SET` with an empty list is a syntax error.
		if (updatable.length === 0) {
			return `${values}\nON CONFLICT (${keyList}) DO NOTHING`;
		}
		const sets = updatable.map((column) => `${q(column)} = EXCLUDED.${q(column)}`).join(', ');
		return `${values}\nON CONFLICT (${keyList}) DO UPDATE SET ${sets}`;
	}

	if (shape === 'onDuplicateKey') {
		const values = `INSERT INTO ${name} (${columnList}) VALUES\n\t${chunk.join(',\n\t')}`;
		// MySQL has no DO NOTHING. Assigning a key column to itself is the documented no-op idiom,
		// and it keeps the statement valid when every column is part of the key.
		const sets = (updatable.length === 0 ? keyColumns : updatable)
			.map((column) => `${q(column)} = VALUES(${q(column)})`)
			.join(', ');
		return `${values}\nON DUPLICATE KEY UPDATE ${sets}`;
	}

	const source = shape === 'mergeValues'
		? `(VALUES\n\t\t${chunk.join(',\n\t\t')}) AS ${q('src')} (${columnList})`
		// Oracle, HANA and Snowflake take no VALUES constructor in USING, so the source is spelled
		// out a row at a time. The column names come from the FIRST select's aliases, which is why
		// only it is aliased.
		: `(\n\t\t${chunk.map((row, index) => selectRow(driverId, row, columns, q, index === 0)).join('\n\t\tUNION ALL ')}\n\t) ${q('src')}`;

	const on = keyColumns.map((column) => `${q('tgt')}.${q(column)} = ${q('src')}.${q(column)}`).join(' AND ');
	const insertValues = columns.map((column) => `${q('src')}.${q(column)}`).join(', ');
	const matched = updatable.length === 0
		? ''
		: `\nWHEN MATCHED THEN UPDATE SET ${updatable.map((column) => `${q('tgt')}.${q(column)} = ${q('src')}.${q(column)}`).join(', ')}`;
	const as = NO_ALIAS_KEYWORD.has(driverId) ? '' : 'AS ';
	const statement = `MERGE INTO ${name} ${as}${q('tgt')}\nUSING ${source}\nON (${on})${matched}`
		+ `\nWHEN NOT MATCHED THEN INSERT (${columnList}) VALUES (${insertValues})`;
	// SQL Server's parser REQUIRES the terminating semicolon on MERGE. The others tolerate it.
	return driverId === 'sqlserver' ? `${statement};` : statement;
}

/** `SELECT 1 AS "a", 'x' AS "b" FROM dual` — one row of a `mergeUnion` source. */
function selectRow(driverId: string, tupleText: string, columns: string[], q: (name: string) => string, aliased: boolean): string {
	// `tuple()` produced `(a, b, c)`; the values are needed unwrapped here. Splitting the rendered
	// text would be a parser; the tuple is rebuilt from the same literals instead.
	const values = tupleText.slice(1, -1);
	const from = MERGE_UNION_FROM[driverId] ?? 'dual';
	// Snowflake needs no FROM for a row of literals; the other two require one.
	const tail = from ? ` FROM ${from}` : '';
	const parts = splitTuple(values);
	if (parts.length !== columns.length) {
		throw new Error(`Row has ${parts.length} values but the batch has ${columns.length} columns.`);
	}
	const select = parts
		.map((value, index) => (aliased ? `${value} AS ${q(columns[index])}` : value))
		.join(', ');
	return `SELECT ${select}${tail}`;
}

/**
 * Split `1, 'a, b', NULL` on the commas that are BETWEEN values.
 *
 * A plain `split(',')` cuts a string literal containing a comma in half, which is the exact bug
 * this whole file exists to avoid. Only single-quoted literals need tracking, because `sqlLiteral`
 * emits nothing else that can contain a comma, and inside one a `''` is an escaped quote rather
 * than the end of the literal.
 */
function splitTuple(text: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "'") {
			if (inString && text[i + 1] === "'") {
				i += 1;
				continue;
			}
			inString = !inString;
			continue;
		}
		if (ch === ',' && !inString) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(text.slice(start).trim());
	return parts;
}

/**
 * Empty a table before a `replace`-mode run. TRUNCATE where it exists (it is cheaper and resets
 * the table), DELETE where it does not. Destructive by definition: the caller shows it in the
 * dry-run report and takes a confirmation.
 */
export function emitClearTable(driverId: string, schema: string | undefined, table: string): string {
	const name = qualifiedName(driverId, schema, table);
	// SQLite has no TRUNCATE at all; its optimizer turns an unqualified DELETE into the same thing.
	return driverId === 'sqlite' ? `DELETE FROM ${name}` : `TRUNCATE TABLE ${name}`;
}

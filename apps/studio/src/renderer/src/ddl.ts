/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clickhouseColumnType, dialectFor, generatedColumnClause, sqlLiteral, type AutoIncrement } from '../../shared/engine';
import { blankEngineDraft, engineClause, onClusterClause, type EngineDraft } from '../../shared/clickhouseEngine';
import type { TableInfo } from '../../shared/schema';
import { seriesStatements, type SeriesDraft } from '../../shared/snouttimeSeries';

// Pure, driver-aware DDL generation for the table designer. Kept free of DOM/React so
// it stays node-testable (like sqlGuard/sqlFormat/exportData). The designer edits a
// TableDraft; here we turn it into CREATE TABLE (create mode) or a minimal set of
// ALTER TABLE statements diffed against the original (edit mode). Identifier quoting and
// other cross-cutting bits come from the central dialect strategy; the ALTER-statement
// shape still branches by vendor here: MySQL/Aurora (`CHANGE COLUMN` redefines in one
// shot), Postgres (one `ALTER COLUMN` per attribute), SQL Server (`ALTER COLUMN` for
// type/nullability, `sp_rename` for renames, defaults/PKs as named constraints) and
// Oracle (`MODIFY (col …)`, `RENAME COLUMN`, schema-scoped `DROP INDEX`).

export interface ColumnDraft {
	/** The column's name in the database when editing; undefined for a newly added column. */
	originalName?: string;
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	/** Raw default expression as typed (e.g. `0`, `'active'`, `CURRENT_TIMESTAMP`); empty = none. */
	default: string;
	/** The column's description as the database reports it (MySQL `COLUMN_COMMENT`, Postgres
	 *  `pg_description`, SQL Server `MS_Description`). Read-only in the designer today: it is
	 *  carried so the grid can SHOW it, and the diff in {@link alterTableSql} deliberately
	 *  ignores it. Making it editable means emitting per-dialect comment DDL. */
	comment?: string;
	/** Server-generated on insert: whatever this engine calls it (MySQL AUTO_INCREMENT, SQL Server
	 *  IDENTITY, Postgres/Oracle/Db2 GENERATED AS IDENTITY, Snowflake AUTOINCREMENT). The spelling
	 *  comes from {@link Dialect.autoIncrement}; a dialect without one has no such column, and the
	 *  designer hides the checkbox. */
	autoIncrement?: boolean;
	/** How this column is compressed, as it would be written inside `CODEC(...)`
	 *  (`Delta, ZSTD(3)`). ClickHouse only: on a columnar store the codec is the difference
	 *  between a column costing 8 bytes a row and costing one bit, and it is chosen per column
	 *  because the right answer depends on what is IN the column. Empty = the server's default. */
	codec?: string;
}

export interface TableDraft {
	schema?: string;
	name: string;
	columns: ColumnDraft[];
	/** The physical shape of a ClickHouse table: which MergeTree, what it is partitioned by, its
	 *  TTL and settings. Optional and ignored by every other dialect, the way
	 *  {@link ColumnDraft.autoIncrement} is; absent means the plain MergeTree this wrote before there
	 *  was a choice. */
	engine?: EngineDraft;
	/** Postgres with SnoutTime only: make the new table a series (`shared/snouttimeSeries.ts`).
	 *  Absent means an ordinary table. */
	series?: SeriesDraft;
}

/** Quote an identifier for the driver (postgres/oracle → "x", sqlserver → [x], mysql/aurora → `x`). */
export function quoteIdent(name: string, driver: string): string {
	return dialectFor(driver).quoteIdent(name);
}

function qualified(schema: string | undefined, name: string, driver: string): string {
	return schema ? `${quoteIdent(schema, driver)}.${quoteIdent(name, driver)}` : quoteIdent(name, driver);
}

/** A SQL string literal, single quotes doubled — for COMMENT clauses and table options. */
function stringLiteral(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

/** A column definition body shared by CREATE and (MySQL) CHANGE/ADD: `name TYPE [NULL|NOT NULL]
 *  [DEFAULT x]`. Oracle wants the DEFAULT clause *before* the nullability clause, so the order
 *  flips there. Db2 also puts DEFAULT first and has no `NULL` keyword (nullable = omit it).
 *
 *  The auto-increment clause is placed where this engine wants it (SQL Server's IDENTITY(1,1)
 *  precedes NOT NULL, MySQL's AUTO_INCREMENT follows it) and suppresses the DEFAULT, since the
 *  sequence is the value.
 *
 *  MySQL's CHANGE COLUMN REDEFINES the column from this clause alone, so anything omitted is
 *  dropped from the table. The column COMMENT is therefore re-stated from the draft: without it,
 *  retyping a column quietly removed any description the DBA had written. It is carried, never
 *  edited (see {@link ColumnDraft.comment}). */
function columnClause(col: ColumnDraft, driver: string): string {
	const dialect = dialectFor(driver);
	const driverId = dialect.driverId;
	if (driverId === 'clickhouse') {
		return clickhouseColumnClause(col, driver);
	}
	const auto = col.autoIncrement ? dialect.autoIncrement : undefined;
	let clause = `${quoteIdent(col.name, driver)} ${col.dataType.trim()}`;
	if (auto && auto.placement === 'after-type') {
		clause += ` ${auto.clause}`;
	}
	// The sequence supplies the value, so a DEFAULT beside it is a contradiction (Postgres and
	// Oracle reject the pair outright) — an auto-increment column never carries one.
	const def = auto ? '' : col.default.trim();
	// Db2 has no NULL keyword: a nullable column simply omits the nullability clause. Postgres,
	// Oracle, HANA and SQLite reject an explicit one on an identity column, which is implicitly
	// NOT NULL — hence `allowsNullability`.
	let nullability: string;
	if (auto && !auto.allowsNullability) {
		nullability = '';
	} else if (driverId === 'db2') {
		nullability = col.nullable ? '' : ' NOT NULL';
	} else {
		nullability = col.nullable ? ' NULL' : ' NOT NULL';
	}
	// Oracle and Db2 want the DEFAULT clause *before* the nullability clause; everyone else after.
	if (driverId === 'oracle' || driverId === 'db2') {
		if (def !== '') {
			clause += ` DEFAULT ${def}`;
		}
		clause += nullability;
	} else {
		clause += nullability;
		if (def !== '') {
			clause += ` DEFAULT ${def}`;
		}
	}
	if (auto && auto.placement === 'after-nullability') {
		clause += ` ${auto.clause}`;
	}
	if ((driverId === 'mysql-aurora' || driverId === 'mariadb') && col.comment) {
		clause += ` COMMENT ${stringLiteral(col.comment)}`;
	}
	return clause;
}

/** This engine's auto-increment spelling, or null when it has none (DuckDB, the document/vector
 *  backends). The designer shows its column only when this is non-null. */
export function autoIncrementFor(driver: string): AutoIncrement | null {
	return dialectFor(driver).autoIncrement ?? null;
}

/**
 * True when an EXISTING column can be turned into (or out of) an auto-increment one with ALTER
 * TABLE. SQL Server, Snowflake, Redshift, HANA and SQLite cannot: the property is fixed when the
 * column is created and changing it means rebuilding the table, so the designer disables the
 * checkbox rather than generating DDL the engine will refuse. A newly ADDED column still gets it
 * everywhere except SQLite, whose syntax exists only inside CREATE TABLE.
 */
export function canAlterAutoIncrement(driver: string): boolean {
	const driverId = dialectFor(driver).driverId;
	return driverId === 'mysql-aurora' || driverId === 'mariadb' || driverId === 'postgres' || driverId === 'oracle' || driverId === 'db2';
}

/** Build a fresh draft from a persisted table (edit mode seed). */
export function draftFromTable(table: TableInfo): TableDraft {
	return {
		schema: table.schema,
		name: table.name,
		columns: table.columns.map((c) => ({
			originalName: c.name,
			name: c.name,
			dataType: c.dataType,
			nullable: c.nullable,
			isPrimaryKey: c.isPrimaryKey,
			default: c.default ?? '',
			comment: c.comment,
			autoIncrement: c.autoIncrement,
		})),
		// An existing series comes back as its settings, so the designer can show them and
		// change what can be changed in place (its retention). The seal window is not in the
		// schema, so it is left empty and never rewritten from here.
		series: table.series
			? { timeColumn: table.series.timeColumn, interval: table.series.partitionSize, retention: table.series.retention ?? '', sealAfter: '' }
			: undefined,
	};
}

/**
 * The SnoutTime half of saving an existing Postgres table: an ordinary table the user switched to
 * a series becomes one, and a series whose retention was edited gets it set. Partition size and
 * the time column are fixed once a series exists, so nothing else is diffed. Runs after
 * {@link alterTableSql}, so a time column made NOT NULL in the same save is NOT NULL by the time the
 * series is made.
 */
export function seriesAlterSql(original: TableInfo, draft: TableDraft, driver: string): string[] {
	if (dialectFor(driver).driverId !== 'postgres' || !draft.series) {
		return [];
	}
	const relation = qualified(original.schema, original.name, driver);
	const column = draft.columns.find((c) => c.name === draft.series?.timeColumn);
	if (!original.series) {
		return column ? seriesStatements(draft.series, relation, column.dataType) : [];
	}
	const before = original.series.retention ?? '';
	const after = draft.series.retention.trim();
	if (after === before.trim()) {
		return [];
	}
	const integer = original.series.timeType !== '' && /int/i.test(original.series.timeType);
	// An edited retention is not checked by the form: a whole number is written as one, anything
	// else stays inside a literal, which Postgres then refuses to cast.
	const quoted = `'${after.replace(/'/g, "''")}'`;
	const value = after === '' ? (integer ? 'NULL::bigint' : 'NULL::interval') : integer ? `${/^\d+$/.test(after) ? after : quoted}::bigint` : `interval ${quoted}`;
	return [`SELECT snouttime.set_retention('${relation.replace(/'/g, "''")}', ${value});`];
}

export function blankColumn(): ColumnDraft {
	return { name: '', dataType: '', nullable: true, isPrimaryKey: false, default: '' };
}

/** A ClickHouse column: nullability is part of the TYPE (`Nullable(String)`), not a clause, and
 *  the compression codec is part of the column rather than of an index. */
function clickhouseColumnClause(col: ColumnDraft, driver: string): string {
	let clause = `${quoteIdent(col.name, driver)} ${clickhouseColumnType({ name: col.name, dataType: col.dataType.trim(), nullable: col.nullable, isPrimaryKey: col.isPrimaryKey })}`;
	const def = col.default.trim();
	if (def !== '') {
		clause += ` DEFAULT ${def}`;
	}
	const codec = (col.codec ?? '').trim();
	if (codec !== '') {
		// Written as typed. A codec list is `Delta, ZSTD(3)`, and someone who typed the whole
		// `CODEC(...)` has said the same thing, so it is not wrapped twice.
		clause += /^CODEC\s*\(/i.test(codec) ? ` ${codec}` : ` CODEC(${codec})`;
	}
	return clause;
}

/**
 * A ClickHouse table is a MergeTree ordered by its key: the columns ticked as primary key become the
 * ORDER BY (and cannot be Nullable), and a table with none is ordered by nothing (`tuple()`).
 *
 * Everything else about the physical table - which MergeTree, what it is partitioned by, its TTL
 * and its settings - is the draft's engine (`shared/clickhouseEngine.ts`). A draft without one
 * still writes the plain MergeTree this wrote before there was a choice.
 */
function clickhouseCreateTableSql(draft: TableDraft, driver: string): string {
	const lines = draft.columns.map((c) => `  ${clickhouseColumnClause(c.isPrimaryKey ? { ...c, nullable: false } : c, driver)}`);
	const pk = draft.columns.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(c.name, driver));
	const orderBy = pk.length > 0 ? `(${pk.join(', ')})` : 'tuple()';
	const engine = draft.engine ?? blankEngineDraft();
	const clause = engineClause(engine, orderBy, { database: draft.schema ?? '', table: draft.name });
	return `CREATE TABLE ${qualified(draft.schema, draft.name, driver)}${onClusterClause(engine)} (\n${lines.join(',\n')}\n) ${clause};`;
}

/**
 * The designer's ALTER for ClickHouse: drop, add, rename, then one MODIFY COLUMN per changed column
 * (it restates type, nullability and default together). The primary key is the order the data is
 * stored in and cannot be changed in place, so a key change is refused in a comment, not attempted.
 */
function clickhouseAlterTableSql(original: TableInfo, draft: TableDraft, driver: string): string {
	const table = qualified(draft.schema ?? original.schema, draft.name, driver);
	const statements: string[] = [];
	const kept = new Set(draft.columns.map((c) => c.originalName).filter((n): n is string => Boolean(n)));
	const originalByName = new Map(original.columns.map((c) => [c.name, c]));
	if (draft.columns.some((c) => c.isPrimaryKey !== (c.originalName ? originalByName.get(c.originalName)?.isPrimaryKey === true : false) && c.originalName)) {
		statements.push('-- ClickHouse cannot change the primary key of an existing table: it is the order the data is stored in. Create a new table with the new ORDER BY and copy the rows into it.');
	}
	for (const col of original.columns) {
		if (!kept.has(col.name)) {
			statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(col.name, driver)};`);
		}
	}
	for (const col of draft.columns) {
		if (!col.originalName) {
			statements.push(`ALTER TABLE ${table} ADD COLUMN ${clickhouseColumnClause(col, driver)};`);
			continue;
		}
		const orig = originalByName.get(col.originalName);
		if (!orig) {
			continue;
		}
		if (col.name !== orig.name) {
			statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(orig.name, driver)} TO ${quoteIdent(col.name, driver)};`);
		}
		const typeChanged = col.dataType.trim() !== orig.dataType;
		const nullChanged = col.nullable !== orig.nullable;
		const defChanged = (col.default.trim() || null) !== (orig.default ?? null);
		if (typeChanged || nullChanged || defChanged) {
			statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${clickhouseColumnClause(col, driver)};`);
		}
		// MODIFY COLUMN without a DEFAULT keeps the old one; clearing it takes its own statement.
		if (defChanged && col.default.trim() === '') {
			statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${quoteIdent(col.name, driver)} REMOVE DEFAULT;`);
		}
	}
	return statements.join('\n');
}

export function createTableSql(draft: TableDraft, driver: string): string {
	if (dialectFor(driver).driverId === 'clickhouse') {
		return clickhouseCreateTableSql(draft, driver);
	}
	const lines = draft.columns.map((c) => `  ${columnClause(c, driver)}`);
	// SQLite writes the key inline on the AUTOINCREMENT column, so a table-level PRIMARY KEY line
	// beside it would be a duplicate. That shape only covers a single-column key, which is all
	// SQLite allows there anyway; a composite key falls back to the table-level line and simply
	// gets no AUTOINCREMENT, exactly as the engine requires.
	const autoCol = draft.columns.find((c) => c.autoIncrement);
	const pkDraft = draft.columns.filter((c) => c.isPrimaryKey);
	const inlinePk = dialectFor(driver).autoIncrement?.inlinePrimaryKey === true
		&& autoCol !== undefined && pkDraft.length === 1 && pkDraft[0] === autoCol;
	const pk = inlinePk ? [] : pkDraft.map((c) => quoteIdent(c.name, driver));
	if (pk.length > 0) {
		// Name the PK on SQL Server (CONSTRAINT [PK_<table>]) so the designer's ALTER path
		// can drop it by the same conventional name; MySQL/Postgres/Oracle leave it server-named
		// (Oracle's ALTER path uses DROP PRIMARY KEY, which needs no name).
		const pkPrefix = dialectFor(driver).driverId === 'sqlserver' ? `CONSTRAINT ${quoteIdent(`PK_${draft.name}`, driver)} ` : '';
		lines.push(`  ${pkPrefix}PRIMARY KEY (${pk.join(', ')})`);
	}
	const create = `CREATE TABLE ${qualified(draft.schema, draft.name, driver)} (\n${lines.join(',\n')}\n);`;
	const timeColumn = draft.series ? draft.columns.find((c) => c.name === draft.series?.timeColumn) : undefined;
	if (draft.series && timeColumn && dialectFor(driver).driverId === 'postgres') {
		return [create, ...seriesStatements(draft.series, qualified(draft.schema, draft.name, driver), timeColumn.dataType)].join('\n');
	}
	return create;
}

export interface IndexDraft {
	schema?: string;
	table: string;
	name: string;
	unique: boolean;
	columns: string[];
}

export function createIndexSql(index: IndexDraft, driver: string): string {
	const cols = index.columns.map((c) => quoteIdent(c, driver)).join(', ');
	return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name, driver)} ON ${qualified(index.schema, index.table, driver)} (${cols});`;
}

export function dropIndexSql(index: { schema?: string; table: string; name: string }, driver: string): string {
	// Postgres, Oracle and Db2 indexes are schema-scoped objects; MySQL/SQL Server drop them
	// relative to the table.
	const driverId = dialectFor(driver).driverId;
	if (driverId === 'postgres' || driverId === 'oracle' || driverId === 'db2') {
		return `DROP INDEX ${qualified(index.schema, index.name, driver)};`;
	}
	return `DROP INDEX ${quoteIdent(index.name, driver)} ON ${qualified(index.schema, index.table, driver)};`;
}

/** Which table a primary-key statement is about. */
export interface PrimaryKeyTarget {
	schema?: string;
	name: string;
	/** The existing constraint's own name, when the driver reported one. */
	constraintName?: string;
}

/**
 * DROP the table's primary key.
 *
 * MySQL and Oracle drop it positionally (`DROP PRIMARY KEY`) and need no name. Postgres, SQL
 * Server and Db2 drop it BY NAME, so the real constraint name is used when introspection
 * reported one and the vendor's default naming is the fallback — a table whose key was named by
 * hand and whose driver doesn't report names is the one case this can miss, which is why the
 * drop is written IF EXISTS rather than failing the whole batch.
 */
export function dropPrimaryKeySql(target: PrimaryKeyTarget, driver: string): string {
	const table = qualified(target.schema, target.name, driver);
	const driverId = dialectFor(driver).driverId;
	if (driverId === 'postgres') {
		return `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdent(target.constraintName ?? `${target.name}_pkey`, driver)};`;
	}
	if (driverId === 'sqlserver' || driverId === 'db2') {
		return `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdent(target.constraintName ?? `PK_${target.name}`, driver)};`;
	}
	return `ALTER TABLE ${table} DROP PRIMARY KEY;`;
}

/**
 * True when this engine can add, replace or drop a primary key on an EXISTING table.
 *
 * SQLite and DuckDB cannot: SQLite's ALTER TABLE does RENAME, ADD COLUMN and DROP COLUMN and
 * nothing else, so a key is fixed at CREATE TABLE and changing it means rebuilding the table and
 * copying the rows. Offering the button there would only produce a statement the engine refuses,
 * so the Constraints editor says so instead.
 */
export function canAlterPrimaryKey(driver: string): boolean {
	const driverId = dialectFor(driver).driverId;
	return driverId !== 'sqlite' && driverId !== 'duckdb';
}

/**
 * Make one column NOT NULL, on its own.
 *
 * A key column cannot be null, and only Postgres and MySQL promote the columns for you when the
 * key is added — SQL Server and Oracle refuse the statement instead. So the primary-key path in
 * the Constraints editor states it explicitly for every engine, which is also the honest thing to
 * put in front of the user before they run it. Redundant where the engine would have done it
 * anyway; never wrong.
 *
 * (Separate from {@link alterTableSql}'s nullability branch, which is entangled with type and
 * default changes because MySQL's CHANGE COLUMN restates the whole definition at once.)
 */
export function notNullSql(target: PrimaryKeyTarget, column: string, dataType: string, driver: string): string {
	const table = qualified(target.schema, target.name, driver);
	const col = quoteIdent(column, driver);
	const driverId = dialectFor(driver).driverId;
	if (driverId === 'sqlserver') {
		return `ALTER TABLE ${table} ALTER COLUMN ${col} ${dataType} NOT NULL;`;
	}
	if (driverId === 'mysql-aurora' || driverId === 'mariadb') {
		return `ALTER TABLE ${table} MODIFY COLUMN ${col} ${dataType} NOT NULL;`;
	}
	if (driverId === 'oracle') {
		return `ALTER TABLE ${table} MODIFY (${col} NOT NULL);`;
	}
	return `ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL;`;
}

/**
 * ADD a primary key over `columns`. SQL Server gets the conventional `PK_<table>` name so
 * {@link dropPrimaryKeySql} can find it again on a table this app created; the others leave it
 * server-named, which is what their own tooling does.
 */
export function addPrimaryKeySql(target: PrimaryKeyTarget, columns: string[], driver: string): string {
	const table = qualified(target.schema, target.name, driver);
	const cols = columns.map((n) => quoteIdent(n, driver)).join(', ');
	const named = dialectFor(driver).driverId === 'sqlserver'
		? `CONSTRAINT ${quoteIdent(`PK_${target.name}`, driver)} ` : '';
	return `ALTER TABLE ${table} ADD ${named}PRIMARY KEY (${cols});`;
}

/** A reasonable default index name from the table + chosen columns, e.g. users_email_status_idx. */
export function suggestIndexName(table: string, columns: string[]): string {
	const parts = [table, ...columns].map((s) => s.replace(/[^A-Za-z0-9_]/g, '')).filter((s) => s !== '');
	// Cap the stem so the `_idx` suffix survives the 64-char identifier limit.
	return `${parts.join('_').slice(0, 60)}_idx`;
}

/** The charset half of a MySQL collation (`utf8mb4_0900_ai_ci` → `utf8mb4`). */
function charsetOf(collation: string): string {
	return collation.split('_')[0] ?? '';
}

/**
 * Render a table's full CREATE TABLE for the DDL view: columns (with defaults, auto-increment
 * and comments), primary key, foreign keys, secondary indexes and vendor table options.
 *
 * This synthesizes from our own {@link TableInfo} rather than asking the server for
 * SHOW CREATE TABLE, so the goal is a statement that would actually recreate the table. Anything
 * in the model that the output drops is a silent lie about what the table is, which is why
 * indexes and comments are emitted here rather than left to the Indexes tab.
 *
 * Where a vendor has no inline syntax the trailing statements carry it: Postgres/Oracle/Db2 take
 * `COMMENT ON`, SQL Server takes `sp_addextendedproperty`, and every non-MySQL vendor takes
 * separate `CREATE INDEX` statements.
 */
export function tableDdl(table: TableInfo, driver: string): string {
	// The engine's own statement, where one was introspected, is the only faithful one (ClickHouse:
	// ENGINE, ORDER BY, PARTITION BY, TTL, SETTINGS would all be lost rebuilding it).
	if (table.createStatement) {
		return `${table.createStatement.trim().replace(/;\s*$/, '')};`;
	}
	const driverId = dialectFor(driver).driverId;
	const mysql = driverId === 'mysql-aurora' || driverId === 'mariadb';
	const sqlserver = driverId === 'sqlserver';
	const supportsInlineComment = mysql;
	const supportsCommentOn = driverId === 'postgres' || driverId === 'oracle' || driverId === 'db2' || driverId === 'hana';

	// Where the auto-increment clause goes is the dialect's business (SQL Server's IDENTITY(1,1)
	// precedes NOT NULL, MySQL's AUTO_INCREMENT follows it). A column that already carries the
	// sequence in its DEFAULT — a Postgres serial's nextval() — needs no keyword and must not get
	// one, and SQLite's spelling lives inside the PRIMARY KEY line rather than the column.
	const autoSpelling = dialectFor(driver).autoIncrement;
	const auto = autoSpelling && !autoSpelling.inlinePrimaryKey ? autoSpelling : undefined;
	const lines = table.columns.map((c) => {
		const hasDefault = !c.generatedAs && c.default !== null && c.default !== undefined && c.default !== '';
		const generated = c.autoIncrement && !hasDefault ? auto : undefined;
		let line = `  ${quoteIdent(c.name, driver)} ${c.dataType}`;
		if (c.generatedAs) {
			line += ` ${generatedColumnClause(c.generatedAs)}`;
		}
		if (generated && generated.placement === 'after-type') {
			line += ` ${generated.clause}`;
		}
		if (!generated || generated.allowsNullability) {
			line += c.nullable ? ' NULL' : ' NOT NULL';
		}
		if (hasDefault) {
			line += ` DEFAULT ${c.default}`;
		}
		if (generated && generated.placement === 'after-nullability') {
			line += ` ${generated.clause}`;
		}
		if (c.comment && supportsInlineComment) {
			line += ` COMMENT ${stringLiteral(c.comment)}`;
		}
		return line;
	});
	const pk = table.primaryKey && table.primaryKey.length > 0
		? table.primaryKey
		: table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
	if (pk.length > 0) {
		lines.push(`  PRIMARY KEY (${pk.map((n) => quoteIdent(n, driver)).join(', ')})`);
	}
	// MySQL scripts secondary indexes inside the CREATE TABLE; everyone else uses a separate
	// CREATE INDEX statement, appended after the table.
	if (mysql) {
		for (const index of table.indexes ?? []) {
			lines.push(`  ${index.unique ? 'UNIQUE KEY' : 'KEY'} ${quoteIdent(index.name, driver)} (${index.columns.map((n) => quoteIdent(n, driver)).join(', ')})`);
		}
	}
	for (const fk of table.foreignKeys) {
		lines.push(`  CONSTRAINT ${quoteIdent(fk.constraintName, driver)} FOREIGN KEY (${fk.columns.map((n) => quoteIdent(n, driver)).join(', ')})`
			+ ` REFERENCES ${quoteIdent(fk.referencedTable, driver)} (${fk.referencedColumns.map((n) => quoteIdent(n, driver)).join(', ')})`);
	}

	// Vendor table options. Everything here comes from catalog stats, so a driver that doesn't
	// report them simply contributes nothing rather than guessing a default.
	const options: string[] = [];
	if (mysql) {
		const stats = table.stats;
		if (stats?.engine) {
			options.push(`ENGINE=${stats.engine}`);
		}
		if (stats?.autoIncrement !== undefined) {
			options.push(`AUTO_INCREMENT=${stats.autoIncrement}`);
		}
		if (stats?.collation) {
			const charset = charsetOf(stats.collation);
			if (charset) {
				options.push(`DEFAULT CHARSET=${charset}`);
			}
			options.push(`COLLATE=${stats.collation}`);
		}
		if (table.comment) {
			options.push(`COMMENT=${stringLiteral(table.comment)}`);
		}
	}
	const tail = options.length > 0 ? ` ${options.join(' ')}` : '';
	const qualifiedName = qualified(table.schema, table.name, driver);
	const statements = [`CREATE TABLE ${qualifiedName} (\n${lines.join(',\n')}\n)${tail};`];

	if (!mysql) {
		for (const index of table.indexes ?? []) {
			statements.push(createIndexSql({ schema: table.schema, table: table.name, name: index.name, unique: index.unique, columns: index.columns }, driver));
		}
	}
	if (supportsCommentOn) {
		if (table.comment) {
			statements.push(`COMMENT ON TABLE ${qualifiedName} IS ${stringLiteral(table.comment)};`);
		}
		for (const c of table.columns) {
			if (c.comment) {
				statements.push(`COMMENT ON COLUMN ${qualifiedName}.${quoteIdent(c.name, driver)} IS ${stringLiteral(c.comment)};`);
			}
		}
	}
	if (sqlserver) {
		// SSMS scripts descriptions as extended properties; @level2 identifies a column.
		const schema = stringLiteral(table.schema ?? 'dbo');
		if (table.comment) {
			statements.push(`EXEC sp_addextendedproperty @name = N'MS_Description', @value = N${stringLiteral(table.comment)}, @level0type = N'SCHEMA', @level0name = ${schema}, @level1type = N'TABLE', @level1name = ${stringLiteral(table.name)};`);
		}
		for (const c of table.columns) {
			if (c.comment) {
				statements.push(`EXEC sp_addextendedproperty @name = N'MS_Description', @value = N${stringLiteral(c.comment)}, @level0type = N'SCHEMA', @level0name = ${schema}, @level1type = N'TABLE', @level1name = ${stringLiteral(table.name)}, @level2type = N'COLUMN', @level2name = ${stringLiteral(c.name)};`);
			}
		}
	}
	return statements.join('\n');
}

/** The original primary-key columns, from the PK list or the per-column flags. */
function originalPk(table: TableInfo): string[] {
	if (table.primaryKey && table.primaryKey.length > 0) {
		return table.primaryKey;
	}
	return table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
}

/**
 * Diff `original` against `draft` and emit the ALTER statements needed to reconcile
 * them, ordered drop-PK → drop columns → add columns → modify columns → add-PK so each
 * step is valid. Returns "" when nothing changed.
 */
export function alterTableSql(original: TableInfo, draft: TableDraft, driver: string): string {
	if (dialectFor(driver).driverId === 'clickhouse') {
		return clickhouseAlterTableSql(original, draft, driver);
	}
	const table = qualified(draft.schema ?? original.schema, draft.name, driver);
	const driverId = dialectFor(driver).driverId;
	const pg = driverId === 'postgres';
	const ss = driverId === 'sqlserver';
	const ora = driverId === 'oracle';
	const db2 = driverId === 'db2';
	// The engines whose ALTER can add or remove the property in place (Postgres, Oracle, Db2 —
	// MySQL's CHANGE COLUMN restates the whole definition, so `columnClause` covers it there).
	// Everyone else is refused by {@link canAlterAutoIncrement} before the designer offers it.
	const identityClause = dialectFor(driver).autoIncrement?.clause ?? 'GENERATED BY DEFAULT AS IDENTITY';
	const statements: string[] = [];

	const originalByName = new Map(original.columns.map((c) => [c.name, c]));
	const renameMap = new Map<string, string>();
	for (const c of draft.columns) {
		if (c.originalName) {
			renameMap.set(c.originalName, c.name);
		}
	}
	const keptOriginalNames = new Set(renameMap.keys());

	// Primary-key diff (compare original PK names, mapped through renames, to the draft's).
	const origPk = originalPk(original).map((n) => renameMap.get(n) ?? n);
	const draftPk = draft.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
	const pkChanged = origPk.length !== draftPk.length || origPk.some((n, i) => n !== draftPk[i]);

	// 1. Drop the old PK first if it's changing (so column drops/redefs don't fight it).
	const pkTarget: PrimaryKeyTarget = { schema: draft.schema ?? original.schema, name: draft.name, constraintName: original.primaryKeyName };
	if (pkChanged && originalPk(original).length > 0) {
		// Named after the ORIGINAL table, since a rename hasn't happened at this point.
		statements.push(dropPrimaryKeySql({ ...pkTarget, name: original.name }, driver));
	}

	// 2. Dropped columns (present originally, no draft column points back to them).
	for (const col of original.columns) {
		if (!keptOriginalNames.has(col.name)) {
			statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(col.name, driver)};`);
		}
	}

	// 3. Added columns. T-SQL has no COLUMN keyword on ADD; Oracle parenthesises the column list.
	for (const col of draft.columns) {
		if (!col.originalName) {
			if (ora) {
				statements.push(`ALTER TABLE ${table} ADD (${columnClause(col, driver)});`);
			} else {
				statements.push(`ALTER TABLE ${table} ${ss ? 'ADD' : 'ADD COLUMN'} ${columnClause(col, driver)};`);
			}
		}
	}

	// 4. Modified columns (rename / type / nullability / default).
	for (const col of draft.columns) {
		if (!col.originalName) {
			continue;
		}
		const orig = originalByName.get(col.originalName);
		if (!orig) {
			continue;
		}
		const renamed = col.name !== orig.name;
		const typeChanged = col.dataType.trim() !== orig.dataType;
		const nullChanged = col.nullable !== orig.nullable;
		const defChanged = (col.default.trim() || null) !== (orig.default ?? null);
		const autoChanged = (col.autoIncrement === true) !== (orig.autoIncrement === true);
		if (!renamed && !typeChanged && !nullChanged && !defChanged && !autoChanged) {
			continue;
		}
		if (pg) {
			if (renamed) {
				statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(orig.name, driver)} TO ${quoteIdent(col.name, driver)};`);
			}
			const target = quoteIdent(col.name, driver);
			if (typeChanged) {
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} TYPE ${col.dataType.trim()};`);
			}
			if (nullChanged) {
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} ${col.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
			}
			if (defChanged) {
				const def = col.default.trim();
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} ${def ? `SET DEFAULT ${def}` : 'DROP DEFAULT'};`);
			}
			// Last, because an identity column has to be NOT NULL and carry no default: the two
			// statements above have just made that true. IF EXISTS on the drop so unticking a
			// serial column (whose sequence lives in the DEFAULT, not in an identity) is a no-op
			// rather than an error — the DROP DEFAULT above is what actually de-serialises it.
			if (autoChanged) {
				statements.push(col.autoIncrement
					? `ALTER TABLE ${table} ALTER COLUMN ${target} ADD ${identityClause};`
					: `ALTER TABLE ${table} ALTER COLUMN ${target} DROP IDENTITY IF EXISTS;`);
			}
		} else if (ss) {
			// T-SQL: rename via sp_rename, then one ALTER COLUMN carries both type and nullability.
			// Defaults are named constraints (drop-then-add); an existing default with a
			// server-generated name won't match the conventional DF_<table>_<col> drop (best-effort).
			// sp_rename's arguments are STRINGS, so each is the dialect's string literal: the old
			// path bracket-quoted part by part (a dot or a bracket in a name is not a separator), the
			// new name as it is (sp_rename would keep brackets as part of it).
			if (renamed) {
				const objSchema = draft.schema ?? original.schema;
				const objPath = [objSchema, draft.name, orig.name].filter((p) => p).map((p) => quoteIdent(p as string, driver)).join('.');
				statements.push(`EXEC sp_rename ${sqlLiteral(driver, objPath)}, ${sqlLiteral(driver, col.name)}, 'COLUMN';`);
			}
			const target = quoteIdent(col.name, driver);
			if (typeChanged || nullChanged) {
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} ${col.dataType.trim()} ${col.nullable ? 'NULL' : 'NOT NULL'};`);
			}
			if (defChanged) {
				const dfName = quoteIdent(`DF_${draft.name}_${col.name}`, driver);
				statements.push(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${dfName};`);
				const def = col.default.trim();
				if (def) {
					statements.push(`ALTER TABLE ${table} ADD CONSTRAINT ${dfName} DEFAULT ${def} FOR ${target};`);
				}
			}
		} else if (ora) {
			// Oracle: rename via RENAME COLUMN, then a single MODIFY carries type, default and
			// nullability together. MODIFY rejects re-stating an unchanged nullability, so the
			// explicit NULL/NOT NULL is best-effort (left to the AI-fix path on conflict).
			if (renamed) {
				statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(orig.name, driver)} TO ${quoteIdent(col.name, driver)};`);
			}
			if (typeChanged || nullChanged || defChanged) {
				const def = col.default.trim();
				let mod = `${quoteIdent(col.name, driver)} ${col.dataType.trim()}`;
				if (defChanged) {
					mod += def ? ` DEFAULT ${def}` : ' DEFAULT NULL';
				}
				if (nullChanged) {
					mod += col.nullable ? ' NULL' : ' NOT NULL';
				}
				statements.push(`ALTER TABLE ${table} MODIFY (${mod});`);
			}
			if (autoChanged) {
				statements.push(`ALTER TABLE ${table} MODIFY (${quoteIdent(col.name, driver)} ${col.autoIncrement ? identityClause : 'DROP IDENTITY'});`);
			}
		} else if (db2) {
			// Db2: rename via RENAME COLUMN; type, nullability and default are each their own
			// ALTER COLUMN clause (Db2 has no one-shot redefine and no NULL keyword).
			if (renamed) {
				statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(orig.name, driver)} TO ${quoteIdent(col.name, driver)};`);
			}
			const target = quoteIdent(col.name, driver);
			if (typeChanged) {
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} SET DATA TYPE ${col.dataType.trim()};`);
			}
			if (nullChanged) {
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} ${col.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
			}
			if (defChanged) {
				const def = col.default.trim();
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} ${def ? `SET DEFAULT ${def}` : 'DROP DEFAULT'};`);
			}
			if (autoChanged) {
				statements.push(`ALTER TABLE ${table} ALTER COLUMN ${target} ${col.autoIncrement ? `SET ${identityClause}` : 'DROP IDENTITY'};`);
			}
		} else {
			// MySQL CHANGE COLUMN redefines (and optionally renames) the column in one statement.
			statements.push(`ALTER TABLE ${table} CHANGE COLUMN ${quoteIdent(orig.name, driver)} ${columnClause(col, driver)};`);
		}
	}

	// 5. Add the new PK last (SQL Server names it so the drop above can find it).
	if (pkChanged && draftPk.length > 0) {
		statements.push(addPrimaryKeySql(pkTarget, draftPk, driver));
	}

	return statements.join('\n');
}

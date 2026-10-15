/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'node:path';

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../shared/schema';

/**
 * Runs one read-only catalog query and yields its rows as plain objects (named columns).
 * Injectable so the unit test can feed canned information_schema / duckdb_* rows without a live
 * file; the driver supplies a runner backed by `@duckdb/node-api`'s `getRowObjectsJson()` (which
 * already coerces DuckDB's rich value types — timestamps, decimals, LISTs — to JSON-safe values).
 */
export type DuckDbRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

// DuckDB's information_schema (Postgres-shaped) plus the system catalogs we never introspect.
const SYSTEM_SCHEMAS = "('information_schema', 'pg_catalog')";

interface TableRow {
	table_schema: string;
	table_name: string;
	table_type: string;
}

interface ColumnRow {
	table_schema: string;
	table_name: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
}

interface ConstraintRow {
	schema_name: string;
	table_name: string;
	constraint_type: string;
	/** DuckDB returns these as LIST(VARCHAR); getRowObjectsJson yields real JS arrays. */
	constraint_column_names: string[];
	referenced_table: string | null;
	referenced_column_names: string[];
}

interface IndexRow {
	schema_name: string;
	table_name: string;
	index_name: string;
	is_unique: boolean;
	sql: string | null;
}

interface ViewRow {
	schema_name: string;
	view_name: string;
	sql: string | null;
}

interface DigestRow {
	table_schema: string;
	table_name: string;
	column_name: string;
	data_type: string;
	ordinal_position: number;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/** 32-bit FNV-1a over a string — folds the structural fingerprint client-side. DuckDB has a SQL
 *  `hash()` but SUM over UBIGINT can overflow, so we fold in JS (matching the SQLite/Db2 drivers). */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Cheap structural fingerprint: a column count plus an order-independent sum of FNV-1a over each
 * column's `schema:table:column:type:position`. Any added/dropped/renamed/retyped/reordered column
 * moves the fingerprint, so the live schema index detects DDL with one query.
 */
export async function duckdbStructuralDigest(run: DuckDbRowRunner): Promise<string> {
	const rows = await run(
		`SELECT table_schema, table_name, column_name, data_type, ordinal_position
		 FROM information_schema.columns
		 WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}`,
	) as unknown as DigestRow[];
	let acc = 0;
	for (const row of rows) {
		acc = (acc + fnv1a(`${row.table_schema}:${row.table_name}:${row.column_name}:${row.data_type}:${row.ordinal_position}`)) >>> 0;
	}
	return `${rows.length}:${acc}`;
}

/** Parse the indexed column names out of a `CREATE INDEX … ON tbl(col, …)` statement. DuckDB's
 *  `duckdb_indexes()` has no per-column breakdown, so this is best-effort: composite indexes work,
 *  expression indexes yield whatever text sits between the outermost parens. */
function indexColumns(sql: string | null): string[] {
	if (!sql) {
		return [];
	}
	const open = sql.indexOf('(');
	const close = sql.lastIndexOf(')');
	if (open === -1 || close <= open) {
		return [];
	}
	return sql.slice(open + 1, close)
		.split(',')
		.map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
		.filter((part) => part.length > 0);
}

/**
 * Introspect a DuckDB database into the shared schema shape. DuckDB is an embedded, file-based
 * analytical engine with a Postgres-shaped information_schema and its own `duckdb_*` catalog table
 * functions. Tables/views/columns come from information_schema; primary and foreign keys from
 * `duckdb_constraints()` (which exposes referenced table + columns directly, unlike the info_schema
 * join dance); secondary indexes from `duckdb_indexes()`; view bodies from `duckdb_views()`. DuckDB
 * has no triggers and no stored routines, so those stay undefined.
 */
export async function introspectDuckDb(run: DuckDbRowRunner, filePath: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const tableTypes = includeViews ? "('BASE TABLE', 'VIEW')" : "('BASE TABLE')";
	const tableRows = await run(
		`SELECT table_schema, table_name, table_type
		 FROM information_schema.tables
		 WHERE table_schema NOT IN ${SYSTEM_SCHEMAS} AND table_type IN ${tableTypes}
		 ORDER BY table_schema, table_name`,
	) as unknown as TableRow[];
	const columnRows = await run(
		`SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
		 FROM information_schema.columns
		 WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}
		 ORDER BY table_schema, table_name, ordinal_position`,
	) as unknown as ColumnRow[];
	const constraintRows = await run(
		`SELECT schema_name, table_name, constraint_type, constraint_column_names, referenced_table, referenced_column_names
		 FROM duckdb_constraints()
		 WHERE schema_name NOT IN ${SYSTEM_SCHEMAS} AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
		 ORDER BY schema_name, table_name`,
	) as unknown as ConstraintRow[];
	const indexRows = await run(
		`SELECT schema_name, table_name, index_name, is_unique, sql
		 FROM duckdb_indexes()
		 WHERE schema_name NOT IN ${SYSTEM_SCHEMAS}
		 ORDER BY schema_name, table_name, index_name`,
	) as unknown as IndexRow[];
	const viewRows = includeViews
		? await run(
			`SELECT schema_name, view_name, sql FROM duckdb_views() WHERE NOT internal AND schema_name NOT IN ${SYSTEM_SCHEMAS}`,
		) as unknown as ViewRow[]
		: [];

	// Primary keys and foreign keys, both carried by duckdb_constraints() as ordered column lists.
	const primaryKeyByTable = new Map<string, string[]>();
	const foreignKeysByTable = new Map<string, ForeignKeyInfo[]>();
	for (const row of constraintRows) {
		const key = tableKey(row.schema_name, row.table_name);
		if (row.constraint_type === 'PRIMARY KEY') {
			primaryKeyByTable.set(key, [...(row.constraint_column_names ?? [])]);
		} else {
			// FKs in DuckDB are anonymous, so synthesise a stable constraint name from the columns.
			const columns = [...(row.constraint_column_names ?? [])];
			const list = foreignKeysByTable.get(key) ?? [];
			list.push({
				constraintName: `fk_${row.table_name}_${columns.join('_')}`,
				columns,
				referencedTable: row.referenced_table ?? '',
				referencedColumns: [...(row.referenced_column_names ?? [])],
			});
			foreignKeysByTable.set(key, list);
		}
	}

	const primaryKeyColumns = new Map<string, Set<string>>();
	for (const [key, columns] of primaryKeyByTable) {
		primaryKeyColumns.set(key, new Set(columns));
	}

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = columnsByTable.get(key) ?? [];
		list.push({
			name: row.column_name,
			dataType: row.data_type,
			nullable: row.is_nullable === 'YES',
			isPrimaryKey: primaryKeyColumns.get(key)?.has(row.column_name) ?? false,
			default: row.column_default,
			comment: undefined,
		});
		columnsByTable.set(key, list);
	}

	const indexesByTable = new Map<string, IndexInfo[]>();
	for (const row of indexRows) {
		const key = tableKey(row.schema_name, row.table_name);
		const list = indexesByTable.get(key) ?? [];
		list.push({ name: row.index_name, columns: indexColumns(row.sql), unique: row.is_unique });
		indexesByTable.set(key, list);
	}

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.sql) {
			viewDefByTable.set(tableKey(row.schema_name, row.view_name), row.sql);
		}
	}

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.table_schema, row.table_name);
		const isView = row.table_type === 'VIEW';
		return {
			name: row.table_name,
			schema: row.table_schema,
			kind: isView ? 'view' : 'table',
			definition: isView ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: primaryKeyByTable.get(key) ?? [],
			foreignKeys: foreignKeysByTable.get(key) ?? [],
			indexes: indexesByTable.get(key) ?? [],
			triggers: undefined,
			comment: undefined,
		};
	});

	return {
		database: filePath ? basename(filePath) : 'DuckDB',
		tables,
		fetchedAt: Date.now(),
	};
}

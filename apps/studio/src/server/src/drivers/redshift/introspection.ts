/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, TableInfo } from '../../../../shared/schema';

/**
 * A query runner: takes a SQL string and resolves to named-column rows. The driver supplies one
 * backed by a real `pg` pool against Redshift; tests inject a stub that returns canned catalog
 * rows, so the introspection assembly is exercised without a live cluster.
 */
export type RedshiftRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * Redshift speaks the Postgres wire protocol but does NOT carry Postgres's catalog: pg_index /
 * pg_get_triggerdef / pg_stat_user_tables and most of information_schema's constraint views are
 * either absent, empty or leader-node-only. The reliable sources are Redshift's own SVV_* system
 * views, so every query here reads those:
 *
 *   SVV_ALL_TABLES   tables + views + external (Spectrum) + datashared objects
 *   SVV_ALL_COLUMNS  their columns, with a composed data_type string
 *   SVV_TABLE_INFO   per-table size/rows/staleness (local tables only)
 *   SVV_REDSHIFT_*   PK/FK are declared-but-not-enforced constraints; read from pg_catalog
 *
 * A query that a given cluster generation doesn't have raises `relation … does not exist`. Rather
 * than fail the whole introspection over one optional view, each non-essential query goes through
 * {@link optional}, which swallows the error and yields no rows. Tables + columns are the only
 * hard requirements.
 */
interface TableRow {
	schema_name: string;
	table_name: string;
	table_type: string;
}

interface ColumnRow {
	schema_name: string;
	table_name: string;
	column_name: string;
	data_type: string;
	is_nullable: string | boolean | null;
	column_default: string | null;
}

interface KeyRow {
	schema_name: string;
	table_name: string;
	constraint_name: string;
	column_name: string;
	referenced_table: string | null;
	referenced_column: string | null;
}

interface ViewRow {
	schema_name: string;
	table_name: string;
	definition: string | null;
}

interface StatsRow {
	schema_name: string;
	table_name: string;
	row_count: string | number | null;
	size_mb: string | number | null;
	unsorted: string | number | null;
	stats_off: string | number | null;
}

interface DigestRow {
	n: string | number;
	h: string | number | null;
}

/** Redshift's own catalog/system schemas — never user data. */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_internal', 'catalog_history'];

const SYS_LIST = SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ');

/** `<col> NOT IN (…) AND <col> NOT LIKE 'pg_temp%'` — the user-schema filter for a schema column. */
function schemaFilter(col: string): string {
	return `${col} NOT IN (${SYS_LIST}) AND ${col} NOT LIKE 'pg_temp%'`;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * Run an optional catalog query, yielding no rows when the view doesn't exist on this cluster
 * generation (Serverless / RA3 / DC2 expose different SVV_* and SYS_* sets). Introspection must
 * still produce tables + columns on any of them, so only those two queries are mandatory.
 */
async function optional(run: RedshiftRowRunner, sql: string): Promise<Record<string, unknown>[]> {
	try {
		return await run(sql);
	} catch {
		return [];
	}
}

/** Redshift reports nullability as the boolean-ish `is_nullable`; normalise both spellings. */
function isNullable(value: string | boolean | null): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	const text = (value ?? '').toString().toLowerCase();
	return text === 'yes' || text === 'true' || text === 't';
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectRedshift: a column count plus an
 * order-independent SUM over a 32-bit slice of each column's MD5 identity. Any added/dropped/
 * renamed/retyped/reordered column changes it, so the live schema index can detect DDL with one
 * aggregate query. (Redshift has no `hashtext`; MD5 + STRTOL is the portable equivalent.)
 */
export async function redshiftStructuralDigest(run: RedshiftRowRunner): Promise<string> {
	const rows = (await run(
		`SELECT COUNT(*) AS n,
		        COALESCE(SUM(STRTOL(SUBSTRING(MD5(schema_name || ':' || table_name || ':' || column_name || ':' || data_type || ':' || ordinal_position::varchar), 1, 8), 16)), 0) AS h
		   FROM svv_all_columns
		  WHERE ${schemaFilter('schema_name')}`,
	)) as unknown as DigestRow[];
	const row = rows[0];
	return row ? `${row.n}:${row.h ?? 0}` : '0:0';
}

/**
 * Introspect tables, columns, primary/foreign keys, view bodies and table stats from Redshift's
 * SVV_* system views, covering every user schema the connected user can see.
 *
 * Deliberately absent (not deferred — the engine has no such objects): **indexes** and
 * **triggers**. Redshift replaces indexes with sort/distribution keys and has no trigger support at
 * all, so those come back empty rather than as a lie the explorer would render. **Stored
 * procedures** are best-effort: they live in a view only newer clusters expose.
 *
 * PK/FK constraints on Redshift are DECLARED BUT NOT ENFORCED — the planner uses them, the engine
 * never validates them. They're still worth reading: completion, the FK-join suggestions and the
 * grid's foreign-key navigation all key off them.
 */
export async function introspectRedshift(run: RedshiftRowRunner, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	// SVV_ALL_TABLES.table_type: 'TABLE' | 'VIEW' | 'EXTERNAL TABLE' | 'SHARED TABLE'. Everything
	// that isn't a VIEW is browsable like a table.
	const tableRows = (await run(
		`SELECT schema_name, table_name, table_type
		   FROM svv_all_tables
		  WHERE ${schemaFilter('schema_name')}${includeViews ? '' : " AND table_type <> 'VIEW'"}
		  ORDER BY schema_name, table_name`,
	)) as unknown as TableRow[];

	const columnRows = (await run(
		`SELECT schema_name, table_name, column_name, data_type, is_nullable, column_default
		   FROM svv_all_columns
		  WHERE ${schemaFilter('schema_name')}
		  ORDER BY schema_name, table_name, ordinal_position`,
	)) as unknown as ColumnRow[];

	// Declared primary keys. Redshift keeps them in the Postgres-inherited pg_constraint, but has no
	// `unnest … WITH ORDINALITY` to explode conkey, so the constraint views are read instead — they
	// exist on the leader node for local tables and already give one row per column, in order.
	const pkRows = (await optional(
		run,
		`SELECT tc.table_schema AS schema_name, tc.table_name, tc.constraint_name, kcu.column_name,
		        NULL AS referenced_table, NULL AS referenced_column
		   FROM information_schema.table_constraints tc
		   JOIN information_schema.key_column_usage kcu
		     ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
		  WHERE tc.constraint_type = 'PRIMARY KEY' AND ${schemaFilter('tc.table_schema')}
		  ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
	)) as unknown as KeyRow[];

	const fkRows = (await optional(
		run,
		`SELECT tc.table_schema AS schema_name, tc.table_name, tc.constraint_name, kcu.column_name,
		        ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
		   FROM information_schema.table_constraints tc
		   JOIN information_schema.key_column_usage kcu
		     ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
		   JOIN information_schema.constraint_column_usage ccu
		     ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
		  WHERE tc.constraint_type = 'FOREIGN KEY' AND ${schemaFilter('tc.table_schema')}
		  ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
	)) as unknown as KeyRow[];

	// View bodies. pg_get_viewdef works on the leader node for local (and late-binding) views.
	const viewRows = includeViews
		? ((await optional(
			run,
			`SELECT n.nspname AS schema_name, c.relname AS table_name, pg_get_viewdef(c.oid, true) AS definition
			   FROM pg_class c
			   JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE c.relkind = 'v' AND ${schemaFilter('n.nspname')}`,
		)) as unknown as ViewRow[])
		: [];

	// Per-table size + staleness. SVV_TABLE_INFO covers only local, non-empty tables (an untouched
	// table simply has no row), and `size` is in 1 MB blocks.
	const statsRows = (await optional(
		run,
		`SELECT "schema" AS schema_name, "table" AS table_name, tbl_rows AS row_count,
		        size AS size_mb, unsorted, stats_off
		   FROM svv_table_info
		  WHERE ${schemaFilter('"schema"')}`,
	)) as unknown as StatsRow[];

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.definition) {
			viewDefByTable.set(tableKey(row.schema_name, row.table_name), row.definition);
		}
	}

	const primaryKeyColumns = new Map<string, Set<string>>();
	const primaryKeyByTable = new Map<string, string[]>();
	for (const row of pkRows) {
		const key = tableKey(row.schema_name, row.table_name);
		const columns = primaryKeyColumns.get(key) ?? new Set<string>();
		columns.add(row.column_name);
		primaryKeyColumns.set(key, columns);
		const ordered = primaryKeyByTable.get(key) ?? [];
		ordered.push(row.column_name);
		primaryKeyByTable.set(key, ordered);
	}

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const key = tableKey(row.schema_name, row.table_name);
		const list = columnsByTable.get(key) ?? [];
		const def = row.column_default === null || row.column_default === undefined ? null : String(row.column_default).trim();
		list.push({
			name: row.column_name,
			dataType: row.data_type,
			nullable: isNullable(row.is_nullable),
			isPrimaryKey: primaryKeyColumns.get(key)?.has(row.column_name) ?? false,
			default: def === '' ? null : def,
			comment: undefined,
		});
		columnsByTable.set(key, list);
	}

	const foreignKeysByTable = new Map<string, Map<string, ForeignKeyInfo>>();
	for (const row of fkRows) {
		const key = tableKey(row.schema_name, row.table_name);
		const fks = foreignKeysByTable.get(key) ?? new Map<string, ForeignKeyInfo>();
		const fk = fks.get(row.constraint_name) ?? {
			constraintName: row.constraint_name,
			columns: [],
			referencedTable: row.referenced_table ?? '',
			referencedColumns: [],
		};
		fk.columns.push(row.column_name);
		if (row.referenced_column) {
			fk.referencedColumns.push(row.referenced_column);
		}
		fks.set(row.constraint_name, fk);
		foreignKeysByTable.set(key, fks);
	}

	const statsByTable = new Map<string, NonNullable<TableInfo['stats']>>();
	for (const row of statsRows) {
		const sizeMb = row.size_mb == null ? undefined : Number(row.size_mb);
		statsByTable.set(tableKey(row.schema_name, row.table_name), {
			rowCount: row.row_count == null ? undefined : Number(row.row_count),
			// SVV_TABLE_INFO reports size in 1 MB blocks, and doesn't split data from indexes
			// (Redshift has none), so the block total is the whole table.
			totalBytes: sizeMb === undefined ? undefined : sizeMb * 1024 * 1024,
			dataBytes: sizeMb === undefined ? undefined : sizeMb * 1024 * 1024,
		});
	}

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.schema_name, row.table_name);
		const isView = row.table_type.toUpperCase() === 'VIEW';
		return {
			name: row.table_name,
			schema: row.schema_name,
			kind: isView ? 'view' : 'table',
			definition: isView ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: primaryKeyByTable.get(key) ?? [],
			foreignKeys: [...(foreignKeysByTable.get(key)?.values() ?? [])],
			// Redshift has no secondary indexes and no triggers — not deferred, absent by design.
			indexes: [],
			triggers: undefined,
			stats: statsByTable.get(key),
			comment: undefined,
		};
	});

	return {
		database: database ?? '(all schemas)',
		tables,
		fetchedAt: Date.now(),
	};
}

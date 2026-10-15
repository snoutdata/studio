/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../../shared/schema';

/**
 * A query runner: takes a SQL string and resolves to named-column rows. The driver supplies one
 * backed by a real Snowflake connection; tests inject a stub that returns canned rows, so the
 * introspection assembly is exercised without a live Snowflake account.
 */
export type SnowflakeRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

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
	character_maximum_length: number | null;
	numeric_precision: number | null;
	numeric_scale: number | null;
	is_nullable: string;
	column_default: string | null;
}

interface ViewRow {
	table_schema: string;
	table_name: string;
	view_definition: string | null;
}

interface DigestRow {
	n: number;
	h: number | string | null;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * Compose a readable column type from the INFORMATION_SCHEMA parts, e.g. `NUMBER(10,2)`,
 * `VARCHAR(255)`. Snowflake reports the base type plus separate precision/scale/length columns.
 */
function composeType(row: ColumnRow): string {
	const base = row.data_type;
	const t = base.toUpperCase();
	if ((t === 'NUMBER' || t === 'DECIMAL' || t === 'NUMERIC') && row.numeric_precision !== null) {
		return row.numeric_scale !== null && row.numeric_scale !== 0
			? `${base}(${row.numeric_precision},${row.numeric_scale})`
			: `${base}(${row.numeric_precision})`;
	}
	if (['TEXT', 'VARCHAR', 'CHAR', 'CHARACTER', 'STRING', 'BINARY', 'VARBINARY'].includes(t) && row.character_maximum_length) {
		return `${base}(${row.character_maximum_length})`;
	}
	return base;
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectSnowflake: a column count plus an
 * order-independent SUM of Snowflake's HASH() over each column's identity. Any added/dropped/
 * renamed/retyped/reordered column changes it, so the live schema index can detect DDL with one
 * query. HASH() returns a signed 64-bit integer, which can arrive as a string for large values.
 */
export async function snowflakeStructuralDigest(run: SnowflakeRowRunner, database: string): Promise<string> {
	const db = quoteDb(database);
	const rows = (await run(
		`SELECT COUNT(*) AS "n",
		        COALESCE(SUM(HASH(table_schema || ':' || table_name || ':' || column_name || ':' || data_type || ':' || ordinal_position)), 0) AS "h"
		   FROM ${db}.INFORMATION_SCHEMA.COLUMNS
		  WHERE table_schema <> 'INFORMATION_SCHEMA'`,
	)) as unknown as DigestRow[];
	const row = rows[0];
	return row ? `${row.n}:${row.h ?? 0}` : '0:0';
}

/** Quote a database identifier for the INFORMATION_SCHEMA reference (Snowflake double-quoting). */
function quoteDb(database: string): string {
	return '"' + database.replace(/"/g, '""') + '"';
}

/**
 * Introspect tables, columns and views from a database's INFORMATION_SCHEMA. Snowflake has no
 * indexes, and primary/foreign keys are informational-only (not enforced) and exposed via SHOW
 * commands rather than INFORMATION_SCHEMA, so keys/indexes/triggers/routines are deferred for this
 * read-leaning first cut — enough to drive completion, hover, the schema explorer and the grid.
 */
export async function introspectSnowflake(run: SnowflakeRowRunner, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	if (!database) {
		// Snowflake INFORMATION_SCHEMA is per-database; a connection must name one.
		return { database: '(no database)', tables: [], fetchedAt: Date.now() };
	}
	const db = quoteDb(database);

	const tableRows = (await run(
		`SELECT table_schema AS "table_schema", table_name AS "table_name", table_type AS "table_type"
		   FROM ${db}.INFORMATION_SCHEMA.TABLES
		  WHERE table_schema <> 'INFORMATION_SCHEMA'${includeViews ? '' : " AND table_type <> 'VIEW'"}
		  ORDER BY "table_schema", "table_name"`,
	)) as unknown as TableRow[];

	const columnRows = (await run(
		`SELECT table_schema AS "table_schema", table_name AS "table_name", column_name AS "column_name",
		        data_type AS "data_type", character_maximum_length AS "character_maximum_length",
		        numeric_precision AS "numeric_precision", numeric_scale AS "numeric_scale",
		        is_nullable AS "is_nullable", column_default AS "column_default"
		   FROM ${db}.INFORMATION_SCHEMA.COLUMNS
		  WHERE table_schema <> 'INFORMATION_SCHEMA'
		  ORDER BY table_schema, table_name, ordinal_position`,
	)) as unknown as ColumnRow[];

	const viewRows = includeViews
		? (await run(
			`SELECT table_schema AS "table_schema", table_name AS "table_name", view_definition AS "view_definition"
			   FROM ${db}.INFORMATION_SCHEMA.VIEWS
			  WHERE table_schema <> 'INFORMATION_SCHEMA'`,
		)) as unknown as ViewRow[]
		: [];

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.view_definition) {
			viewDefByTable.set(tableKey(row.table_schema, row.table_name), row.view_definition);
		}
	}

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = columnsByTable.get(key) ?? [];
		const def = row.column_default === null || row.column_default === undefined ? null : String(row.column_default).trim();
		list.push({
			name: row.column_name,
			dataType: composeType(row),
			nullable: row.is_nullable === 'YES',
			isPrimaryKey: false,
			default: def === '' ? null : def,
			comment: undefined,
		});
		columnsByTable.set(key, list);
	}

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.table_schema, row.table_name);
		const isView = row.table_type.toUpperCase() === 'VIEW';
		return {
			name: row.table_name,
			schema: row.table_schema,
			kind: isView ? 'view' : 'table',
			definition: isView ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: [],
			foreignKeys: [],
			indexes: [],
			triggers: undefined,
			stats: undefined,
			comment: undefined,
		};
	});

	return {
		database,
		tables,
		fetchedAt: Date.now(),
	};
}

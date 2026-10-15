/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionPool } from 'mssql';

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineParam, TableInfo, TriggerInfo } from '../../../../shared/schema';

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
	char_len: number | null;
	num_precision: number | null;
	num_scale: number | null;
	dt_precision: number | null;
	is_nullable: string;
	column_default: string | null;
}

interface PrimaryKeyRow {
	table_schema: string;
	table_name: string;
	column_name: string;
}

interface ForeignKeyRow {
	table_schema: string;
	table_name: string;
	constraint_name: string;
	column_name: string;
	referenced_table: string;
	referenced_column: string;
}

interface IndexRow {
	table_schema: string;
	table_name: string;
	index_name: string;
	is_unique: boolean;
	column_name: string;
}

interface TriggerRow {
	table_schema: string;
	table_name: string;
	trigger_name: string;
	timing: string;
	events: string | null;
	statement: string | null;
}

interface ViewRow {
	table_schema: string;
	table_name: string;
	definition: string | null;
}

interface CommentRow {
	table_schema: string;
	table_name: string;
	/** 0 for the table's own description; otherwise the described column's column_id. */
	minor_id: number;
	column_name: string | null;
	description: string | null;
}

interface IdentityRow {
	table_schema: string;
	table_name: string;
	column_name: string;
}

interface RoutineRow {
	routine_schema: string;
	routine_name: string;
	routine_type: string;
	return_type: string | null;
	definition: string | null;
}

interface ParameterRow {
	routine_schema: string;
	routine_name: string;
	parameter_name: string | null;
	data_type: string | null;
	parameter_mode: string | null;
}

interface StatsRow {
	table_schema: string;
	table_name: string;
	row_count: string | number | null;
	data_bytes: string | number | null;
	used_bytes: string | number | null;
	total_bytes: string | number | null;
	create_date: Date | string | null;
	modify_date: Date | string | null;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * Run a query in object-row mode (the pool leaves arrayRowMode per-request; introspection
 * wants named columns, the editor's execute() wants arrays). Returns the primary recordset.
 */
async function rows<T>(pool: ConnectionPool, sql: string): Promise<T[]> {
	const request = pool.request();
	request.arrayRowMode = false;
	const result = await request.query(sql);
	return (result.recordset ?? []) as unknown as T[];
}

/** Compose a readable column type from INFORMATION_SCHEMA parts, e.g. `varchar(255)`, `nvarchar(max)`, `decimal(10,2)`. */
function composeType(row: ColumnRow): string {
	const base = row.data_type;
	const t = base.toLowerCase();
	if (['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(t)) {
		if (row.char_len === -1) {
			return `${base}(max)`;
		}
		if (row.char_len !== null) {
			return `${base}(${row.char_len})`;
		}
	}
	if ((t === 'decimal' || t === 'numeric') && row.num_precision !== null) {
		return `${base}(${row.num_precision}${row.num_scale !== null ? `,${row.num_scale}` : ''})`;
	}
	if (['datetime2', 'datetimeoffset', 'time'].includes(t) && row.dt_precision !== null) {
		return `${base}(${row.dt_precision})`;
	}
	return base;
}

function toEpochMs(value: Date | string | null): number | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	return new Date(value).getTime();
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectSqlServer: a column count plus
 * an order-independent CHECKSUM_AGG over each column's identity. Any added/dropped/renamed/
 * retyped/reordered column changes it, so the live schema index can detect DDL with one query.
 */
export async function sqlServerStructuralDigest(pool: ConnectionPool): Promise<string> {
	// The second aggregate covers MS_Description extended properties, which live in sys.* rather
	// than INFORMATION_SCHEMA.COLUMNS. Folded in as its own component so that describing a column
	// in SSMS refreshes here too, instead of leaving a cached schema with no descriptions.
	const result = await rows<{ n: number; h: number; d: number }>(
		pool,
		`SELECT COUNT(*) AS n,
		        COALESCE(CHECKSUM_AGG(CHECKSUM(TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION)), 0) AS h,
		        (SELECT COALESCE(CHECKSUM_AGG(CHECKSUM(major_id, minor_id, CAST(value AS nvarchar(max)))), 0)
		         FROM sys.extended_properties WHERE class = 1 AND name = 'MS_Description') AS d
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')`,
	);
	const row = result[0];
	return row ? `${row.n}:${row.h}:${row.d}` : '0:0:0';
}

/**
 * Introspect tables, columns, primary keys, foreign keys, indexes, triggers and routines from a
 * SQL Server database via INFORMATION_SCHEMA + the sys.* catalog, covering all user schemas.
 * `database` scoping is handled by the connection's current database (the pool's `database`).
 */
export async function introspectSqlServer(pool: ConnectionPool, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const tableTypes = includeViews ? "('BASE TABLE', 'VIEW')" : "('BASE TABLE')";

	const tableRows = await rows<TableRow>(
		pool,
		`SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
		 FROM INFORMATION_SCHEMA.TABLES
		 WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA') AND TABLE_TYPE IN ${tableTypes}
		 ORDER BY TABLE_SCHEMA, TABLE_NAME`,
	);
	const columnRows = await rows<ColumnRow>(
		pool,
		`SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
		        DATA_TYPE AS data_type, CHARACTER_MAXIMUM_LENGTH AS char_len, NUMERIC_PRECISION AS num_precision,
		        NUMERIC_SCALE AS num_scale, DATETIME_PRECISION AS dt_precision, IS_NULLABLE AS is_nullable,
		        COLUMN_DEFAULT AS column_default
		 FROM INFORMATION_SCHEMA.COLUMNS
		 WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
		 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
	);
	// Table + column descriptions. SQL Server has no COMMENT syntax; the convention every
	// tool uses (SSMS, DBeaver) is an extended property named MS_Description, minor_id 0 for
	// the table itself and the column_id for a column. `value` is sql_variant, hence the CAST.
	const commentRows = await rows<CommentRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name, ep.minor_id,
		        c.name AS column_name, CAST(ep.value AS nvarchar(max)) AS description
		 FROM sys.extended_properties ep
		 JOIN sys.objects t ON t.object_id = ep.major_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 LEFT JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
		 WHERE ep.class = 1 AND ep.name = 'MS_Description'
		   AND t.type IN ('U', 'V') AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')`,
	);
	// Identity columns — needed for a runnable CREATE TABLE (an IDENTITY column must not be
	// given a value on insert, and the DDL view lies if it omits the keyword).
	const identityRows = await rows<IdentityRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name, c.name AS column_name
		 FROM sys.columns c
		 JOIN sys.tables t ON t.object_id = c.object_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 WHERE c.is_identity = 1 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')`,
	);
	const pkRows = await rows<PrimaryKeyRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name, c.name AS column_name
		 FROM sys.key_constraints kc
		 JOIN sys.tables t ON t.object_id = kc.parent_object_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
		 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		 WHERE kc.type = 'PK' AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
		 ORDER BY s.name, t.name, ic.key_ordinal`,
	);
	const fkRows = await rows<ForeignKeyRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name, fk.name AS constraint_name,
		        pc.name AS column_name, rt.name AS referenced_table, rc.name AS referenced_column
		 FROM sys.foreign_keys fk
		 JOIN sys.tables t ON t.object_id = fk.parent_object_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
		 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
		 JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
		 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
		 WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
		 ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id`,
	);
	// Secondary indexes (skip the PK index, heaps, and included columns).
	const indexRows = await rows<IndexRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name, i.name AS index_name,
		        i.is_unique AS is_unique, c.name AS column_name
		 FROM sys.indexes i
		 JOIN sys.tables t ON t.object_id = i.object_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
		 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
		 WHERE i.is_primary_key = 0 AND i.type > 0 AND i.is_hypothetical = 0 AND ic.is_included_column = 0
		   AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
		 ORDER BY s.name, t.name, i.name, ic.key_ordinal`,
	);
	// Triggers — SQL Server fires AFTER (FOR) or INSTEAD OF (no BEFORE); events are aggregated
	// from sys.trigger_events, and OBJECT_DEFINITION returns the CREATE TRIGGER body.
	const triggerRows = await rows<TriggerRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name, tr.name AS trigger_name,
		        CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
		        STUFF((SELECT ', ' + te.type_desc FROM sys.trigger_events te
		               WHERE te.object_id = tr.object_id ORDER BY te.type_desc FOR XML PATH('')), 1, 2, '') AS events,
		        OBJECT_DEFINITION(tr.object_id) AS statement
		 FROM sys.triggers tr
		 JOIN sys.tables t ON t.object_id = tr.parent_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 WHERE tr.is_ms_shipped = 0 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
		 ORDER BY s.name, t.name, tr.name`,
	);
	// View bodies (the full CREATE VIEW) so schema-sync can recreate them; only queried
	// when views are in scope.
	const viewRows = includeViews
		? await rows<ViewRow>(
			pool,
			`SELECT s.name AS table_schema, v.name AS table_name, OBJECT_DEFINITION(v.object_id) AS definition
			 FROM sys.views v
			 JOIN sys.schemas s ON s.schema_id = v.schema_id
			 WHERE v.is_ms_shipped = 0 AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')`,
		)
		: [];
	const routineRows = await rows<RoutineRow>(
		pool,
		`SELECT ROUTINE_SCHEMA AS routine_schema, ROUTINE_NAME AS routine_name,
		        ROUTINE_TYPE AS routine_type, DATA_TYPE AS return_type,
		        OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(ROUTINE_SCHEMA) + '.' + QUOTENAME(ROUTINE_NAME))) AS definition
		 FROM INFORMATION_SCHEMA.ROUTINES
		 WHERE ROUTINE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
		 ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
	);
	// Routine parameters; ORDINAL_POSITION 0 is a function's return value, so it's excluded.
	const parameterRows = await rows<ParameterRow>(
		pool,
		`SELECT SPECIFIC_SCHEMA AS routine_schema, SPECIFIC_NAME AS routine_name,
		        PARAMETER_NAME AS parameter_name, DATA_TYPE AS data_type, PARAMETER_MODE AS parameter_mode
		 FROM INFORMATION_SCHEMA.PARAMETERS
		 WHERE SPECIFIC_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA') AND ORDINAL_POSITION > 0
		 ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`,
	);
	// Approximate per-table stats from the partition-stats DMV (cheap; not an exact COUNT).
	const statsRows = await rows<StatsRow>(
		pool,
		`SELECT s.name AS table_schema, t.name AS table_name,
		        SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS row_count,
		        SUM(ps.in_row_data_page_count) * 8192 AS data_bytes,
		        SUM(ps.used_page_count) * 8192 AS used_bytes,
		        SUM(ps.reserved_page_count) * 8192 AS total_bytes,
		        MAX(t.create_date) AS create_date, MAX(t.modify_date) AS modify_date
		 FROM sys.dm_db_partition_stats ps
		 JOIN sys.tables t ON t.object_id = ps.object_id
		 JOIN sys.schemas s ON s.schema_id = t.schema_id
		 WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
		 GROUP BY s.name, t.name`,
	);

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.definition) {
			viewDefByTable.set(tableKey(row.table_schema, row.table_name), row.definition);
		}
	}

	const paramsByRoutine = new Map<string, RoutineParam[]>();
	for (const row of parameterRows) {
		const key = tableKey(row.routine_schema, row.routine_name);
		const list = paramsByRoutine.get(key) ?? [];
		list.push({ name: row.parameter_name ?? '', dataType: row.data_type ?? '', mode: row.parameter_mode ?? undefined });
		paramsByRoutine.set(key, list);
	}

	const routines: RoutineInfo[] = routineRows.map((row) => ({
		name: row.routine_name,
		schema: row.routine_schema,
		kind: row.routine_type === 'PROCEDURE' ? 'procedure' : 'function',
		returnType: row.return_type ?? undefined,
		parameters: paramsByRoutine.get(tableKey(row.routine_schema, row.routine_name)) ?? [],
		definition: row.definition ?? undefined,
	}));

	const primaryKeyColumns = new Map<string, Set<string>>();
	const primaryKeyByTable = new Map<string, string[]>();
	for (const row of pkRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const columns = primaryKeyColumns.get(key) ?? new Set<string>();
		columns.add(row.column_name);
		primaryKeyColumns.set(key, columns);
		const ordered = primaryKeyByTable.get(key) ?? [];
		ordered.push(row.column_name);
		primaryKeyByTable.set(key, ordered);
	}

	const tableCommentByTable = new Map<string, string>();
	const columnCommentByColumn = new Map<string, string>();
	for (const row of commentRows) {
		if (!row.description) {
			continue;
		}
		const key = tableKey(row.table_schema, row.table_name);
		if (row.minor_id === 0) {
			tableCommentByTable.set(key, row.description);
		} else if (row.column_name) {
			columnCommentByColumn.set(`${key}.${row.column_name}`, row.description);
		}
	}

	const identityColumns = new Set<string>();
	for (const row of identityRows) {
		identityColumns.add(`${tableKey(row.table_schema, row.table_name)}.${row.column_name}`);
	}

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = columnsByTable.get(key) ?? [];
		list.push({
			name: row.column_name,
			dataType: composeType(row),
			nullable: row.is_nullable === 'YES',
			isPrimaryKey: primaryKeyColumns.get(key)?.has(row.column_name) ?? false,
			default: row.column_default,
			comment: columnCommentByColumn.get(`${key}.${row.column_name}`),
			autoIncrement: identityColumns.has(`${key}.${row.column_name}`) || undefined,
		});
		columnsByTable.set(key, list);
	}

	const foreignKeysByTable = new Map<string, Map<string, ForeignKeyInfo>>();
	for (const row of fkRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const fks = foreignKeysByTable.get(key) ?? new Map<string, ForeignKeyInfo>();
		const fk = fks.get(row.constraint_name) ?? {
			constraintName: row.constraint_name,
			columns: [],
			referencedTable: row.referenced_table,
			referencedColumns: [],
		};
		fk.columns.push(row.column_name);
		fk.referencedColumns.push(row.referenced_column);
		fks.set(row.constraint_name, fk);
		foreignKeysByTable.set(key, fks);
	}

	const indexesByTable = new Map<string, Map<string, IndexInfo>>();
	for (const row of indexRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const byName = indexesByTable.get(key) ?? new Map<string, IndexInfo>();
		const index = byName.get(row.index_name) ?? { name: row.index_name, columns: [], unique: row.is_unique };
		index.columns.push(row.column_name);
		byName.set(row.index_name, index);
		indexesByTable.set(key, byName);
	}

	const triggersByTable = new Map<string, TriggerInfo[]>();
	for (const row of triggerRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = triggersByTable.get(key) ?? [];
		list.push({ name: row.trigger_name, timing: row.timing, event: row.events ?? '', statement: row.statement ?? undefined });
		triggersByTable.set(key, list);
	}

	const statsByTable = new Map<string, NonNullable<TableInfo['stats']>>();
	for (const row of statsRows) {
		const used = row.used_bytes == null ? undefined : Number(row.used_bytes);
		const data = row.data_bytes == null ? undefined : Number(row.data_bytes);
		// Index bytes aren't reported directly; approximate as used (data + index pages) minus data.
		const indexBytes = used !== undefined && data !== undefined ? Math.max(0, used - data) : undefined;
		statsByTable.set(tableKey(row.table_schema, row.table_name), {
			rowCount: row.row_count == null ? undefined : Number(row.row_count),
			dataBytes: data,
			indexBytes,
			totalBytes: row.total_bytes == null ? undefined : Number(row.total_bytes),
			createdAt: toEpochMs(row.create_date),
			updatedAt: toEpochMs(row.modify_date),
		});
	}

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.table_schema, row.table_name);
		const triggers = triggersByTable.get(key);
		return {
			name: row.table_name,
			schema: row.table_schema,
			kind: row.table_type === 'VIEW' ? 'view' : 'table',
			definition: row.table_type === 'VIEW' ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: primaryKeyByTable.get(key) ?? [],
			foreignKeys: [...(foreignKeysByTable.get(key)?.values() ?? [])],
			indexes: [...(indexesByTable.get(key)?.values() ?? [])],
			triggers: triggers && triggers.length > 0 ? triggers : undefined,
			stats: statsByTable.get(key),
			comment: tableCommentByTable.get(key),
		};
	});

	return {
		database: database ?? '(current database)',
		tables,
		routines: routines.length > 0 ? routines : undefined,
		fetchedAt: Date.now(),
	};
}

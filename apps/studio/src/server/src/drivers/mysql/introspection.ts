/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Pool, RowDataPacket } from 'mysql2/promise';

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineParam, TableInfo, TriggerInfo } from '../../../../shared/schema';

/** MySQL/Aurora system schemas excluded when no specific database is targeted. */
const SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys'];

interface TableRow extends RowDataPacket {
	TABLE_SCHEMA: string;
	TABLE_NAME: string;
	TABLE_TYPE: string;
	TABLE_COMMENT: string | null;
	TABLE_ROWS: number | string | null;
	DATA_LENGTH: number | string | null;
	INDEX_LENGTH: number | string | null;
	AVG_ROW_LENGTH: number | string | null;
	DATA_FREE: number | string | null;
	AUTO_INCREMENT: number | string | null;
	ENGINE: string | null;
	TABLE_COLLATION: string | null;
	CREATE_TIME: Date | string | null;
	UPDATE_TIME: Date | string | null;
}

interface TriggerRow extends RowDataPacket {
	EVENT_OBJECT_SCHEMA: string;
	EVENT_OBJECT_TABLE: string;
	TRIGGER_NAME: string;
	ACTION_TIMING: string;
	EVENT_MANIPULATION: string;
	ACTION_STATEMENT: string | null;
	ACTION_ORIENTATION: string | null;
}

interface ColumnRow extends RowDataPacket {
	TABLE_SCHEMA: string;
	TABLE_NAME: string;
	COLUMN_NAME: string;
	COLUMN_TYPE: string;
	IS_NULLABLE: string;
	COLUMN_KEY: string;
	COLUMN_DEFAULT: string | null;
	COLUMN_COMMENT: string | null;
	EXTRA: string | null;
}

/** Expression defaults MySQL 5.7 reports with an empty EXTRA (8.0 marks them DEFAULT_GENERATED).
 *  Matched case-insensitively, with or without the empty argument list, so they survive
 *  {@link mysqlDefaultExpression} unquoted instead of becoming the string `'CURRENT_TIMESTAMP'`. */
const MYSQL_BARE_DEFAULT_FUNCTIONS = /^(?:current_timestamp|now|localtime|localtimestamp|current_date|curdate|current_time|curtime|utc_timestamp|utc_date|utc_time)(?:\s*\(\s*\d*\s*\))?$/i;

/** Column types whose default is a bare numeric/bit literal, never a quoted string. */
const MYSQL_NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|bit|year)\b/i;

/**
 * Turn MySQL's `COLUMN_DEFAULT` into a SQL expression that can be pasted after `DEFAULT`.
 *
 * INFORMATION_SCHEMA reports string defaults UNQUOTED — a `varchar(1) DEFAULT 'N'` column comes
 * back as the two characters `N`. Emitting that verbatim produced `DEFAULT N`, which is not valid
 * SQL, so every generated CREATE/ALTER for a table with a string default was broken. Numeric
 * columns, expression defaults (MySQL 8 flags those in `EXTRA` as `DEFAULT_GENERATED`) and the
 * 5.7-era bare time functions are passed through untouched; everything else is quoted as a string
 * literal with embedded quotes and backslashes escaped.
 */
export function mysqlDefaultExpression(raw: string | null, columnType: string, extra: string | null): string | null {
	if (raw === null) {
		return null;
	}
	if ((extra ?? '').toUpperCase().includes('DEFAULT_GENERATED')) {
		return raw;
	}
	if (MYSQL_NUMERIC_TYPE.test(columnType) || MYSQL_BARE_DEFAULT_FUNCTIONS.test(raw.trim())) {
		return raw;
	}
	// NULL arrives as a real null above, so the literal string "NULL" here is the four
	// characters, not the keyword — quote it like any other string.
	return `'${raw.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

interface KeyRow extends RowDataPacket {
	TABLE_SCHEMA: string;
	TABLE_NAME: string;
	CONSTRAINT_NAME: string;
	COLUMN_NAME: string;
	REFERENCED_TABLE_NAME: string | null;
	REFERENCED_COLUMN_NAME: string | null;
}

interface IndexRow extends RowDataPacket {
	TABLE_SCHEMA: string;
	TABLE_NAME: string;
	INDEX_NAME: string;
	NON_UNIQUE: number | string;
	COLUMN_NAME: string;
}

interface ViewRow extends RowDataPacket {
	TABLE_SCHEMA: string;
	TABLE_NAME: string;
	VIEW_DEFINITION: string | null;
}

interface RoutineRow extends RowDataPacket {
	ROUTINE_SCHEMA: string;
	ROUTINE_NAME: string;
	ROUTINE_TYPE: string;
	DATA_TYPE: string | null;
	ROUTINE_DEFINITION: string | null;
	EXTERNAL_LANGUAGE: string | null;
}

interface ParameterRow extends RowDataPacket {
	SPECIFIC_SCHEMA: string;
	SPECIFIC_NAME: string;
	ORDINAL_POSITION: number;
	PARAMETER_MODE: string | null;
	PARAMETER_NAME: string | null;
	DTD_IDENTIFIER: string | null;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectMySql: a column count
 * plus an order-independent sum of CRC32 over each column's identity (schema, table,
 * name, type, position). Any added/dropped/renamed/retyped/reordered column changes
 * it, so the live schema index can detect DDL with one aggregate query.
 *
 * COLUMN_COMMENT is part of that identity so documenting a column in another tool refreshes
 * here too. Without it a comment-only change moved nothing, and the app kept serving a cached
 * schema with no descriptions until a manual Refresh — which is exactly how it looks when the
 * feature is simply missing.
 */
export async function mysqlStructuralDigest(pool: Pool, database: string | undefined): Promise<string> {
	const schemaFilter = database ? 'TABLE_SCHEMA = ?' : `TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(', ')})`;
	const args = database ? [database] : SYSTEM_SCHEMAS;
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT_WS(0x1f, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, ORDINAL_POSITION, COLUMN_COMMENT))), 0) AS h FROM INFORMATION_SCHEMA.COLUMNS WHERE ${schemaFilter}`,
		args,
	);
	const row = rows[0] as { n: number | string; h: number | string } | undefined;
	return row ? `${row.n}:${row.h}` : '0:0';
}

/**
 * Introspect tables, columns, primary keys and foreign keys from
 * INFORMATION_SCHEMA. When `database` is given, scope to it; otherwise cover all
 * non-system schemas. Each table carries its owning schema so the explorer can
 * group connection → databases → tables.
 */
export async function introspectMySql(pool: Pool, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const schemaFilter = database ? 'TABLE_SCHEMA = ?' : `TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(', ')})`;
	const args = database ? [database] : SYSTEM_SCHEMAS;

	const tableTypes = includeViews ? ['BASE TABLE', 'VIEW'] : ['BASE TABLE'];

	const [tableRows] = await pool.query<TableRow[]>(
		`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AVG_ROW_LENGTH, DATA_FREE, AUTO_INCREMENT, ENGINE, TABLE_COLLATION, CREATE_TIME, UPDATE_TIME FROM INFORMATION_SCHEMA.TABLES WHERE ${schemaFilter} AND TABLE_TYPE IN (${tableTypes.map(() => '?').join(', ')}) ORDER BY TABLE_SCHEMA, TABLE_NAME`,
		[...args, ...tableTypes],
	);

	// Triggers — one row per trigger, attached to its event-object (the table). The
	// ACTION_STATEMENT body is reconstructed into a CREATE TRIGGER … for the properties
	// panel; viewer needs to see code, not just metadata.
	const [triggerRows] = await pool.query<TriggerRow[]>(
		`SELECT EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT, ACTION_ORIENTATION FROM INFORMATION_SCHEMA.TRIGGERS WHERE ${schemaFilter.replace(/TABLE_SCHEMA/g, 'EVENT_OBJECT_SCHEMA')} ORDER BY EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, TRIGGER_NAME`,
		args,
	);

	const [columnRows] = await pool.query<ColumnRow[]>(
		`SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT, EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE ${schemaFilter} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
		args,
	);

	// Primary keys (ordered) and foreign keys both come from KEY_COLUMN_USAGE.
	const [keyRows] = await pool.query<KeyRow[]>(
		`SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE ${schemaFilter} AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL) ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
		args,
	);

	// Stored routines (procedures + functions). EXTERNAL_LANGUAGE may not exist on
	// older MySQL — guarded with a NULL-safe alias so the select succeeds either way.
	const [routineRows] = await pool.query<RoutineRow[]>(
		`SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, ROUTINE_DEFINITION, NULL AS EXTERNAL_LANGUAGE FROM INFORMATION_SCHEMA.ROUTINES WHERE ${schemaFilter.replace(/TABLE_SCHEMA/g, 'ROUTINE_SCHEMA')} ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
		args,
	);

	// Routine parameters (ORDINAL_POSITION 0 is a function's RETURN value — skipped; the
	// return type comes from ROUTINES.DATA_TYPE). SPECIFIC_NAME == routine name in MySQL.
	const [parameterRows] = await pool.query<ParameterRow[]>(
		`SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION, PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER FROM INFORMATION_SCHEMA.PARAMETERS WHERE ${schemaFilter.replace(/TABLE_SCHEMA/g, 'SPECIFIC_SCHEMA')} AND ORDINAL_POSITION > 0 ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION`,
		args,
	);

	// Secondary indexes from STATISTICS (one row per indexed column, key-ordered);
	// PRIMARY is excluded since the PK is carried separately.
	const [indexRows] = await pool.query<IndexRow[]>(
		`SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE ${schemaFilter} AND INDEX_NAME <> 'PRIMARY' ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
		args,
	);

	// View bodies (the SELECT each view wraps) so schema-sync can recreate them; only
	// queried when views are in scope.
	const viewRows = includeViews
		? (await pool.query<ViewRow[]>(
			`SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION FROM INFORMATION_SCHEMA.VIEWS WHERE ${schemaFilter}`,
			args,
		))[0]
		: [];

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const key = tableKey(row.TABLE_SCHEMA, row.TABLE_NAME);
		const list = columnsByTable.get(key) ?? [];
		list.push({
			name: row.COLUMN_NAME,
			dataType: row.COLUMN_TYPE,
			nullable: row.IS_NULLABLE === 'YES',
			isPrimaryKey: row.COLUMN_KEY === 'PRI',
			default: mysqlDefaultExpression(row.COLUMN_DEFAULT, row.COLUMN_TYPE, row.EXTRA),
			comment: row.COLUMN_COMMENT || undefined,
			autoIncrement: (row.EXTRA ?? '').toLowerCase().includes('auto_increment') || undefined,
		});
		columnsByTable.set(key, list);
	}

	const primaryKeyByTable = new Map<string, string[]>();
	const foreignKeysByTable = new Map<string, Map<string, ForeignKeyInfo>>();
	for (const row of keyRows) {
		const key = tableKey(row.TABLE_SCHEMA, row.TABLE_NAME);
		if (row.CONSTRAINT_NAME === 'PRIMARY' && !row.REFERENCED_TABLE_NAME) {
			const pk = primaryKeyByTable.get(key) ?? [];
			pk.push(row.COLUMN_NAME);
			primaryKeyByTable.set(key, pk);
		} else if (row.REFERENCED_TABLE_NAME && row.REFERENCED_COLUMN_NAME) {
			const fks = foreignKeysByTable.get(key) ?? new Map<string, ForeignKeyInfo>();
			const fk = fks.get(row.CONSTRAINT_NAME) ?? {
				constraintName: row.CONSTRAINT_NAME,
				columns: [],
				referencedTable: row.REFERENCED_TABLE_NAME,
				referencedColumns: [],
			};
			fk.columns.push(row.COLUMN_NAME);
			fk.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
			fks.set(row.CONSTRAINT_NAME, fk);
			foreignKeysByTable.set(key, fks);
		}
	}

	const triggersByTable = new Map<string, TriggerInfo[]>();
	for (const row of triggerRows) {
		const key = tableKey(row.EVENT_OBJECT_SCHEMA, row.EVENT_OBJECT_TABLE);
		const list = triggersByTable.get(key) ?? [];
		const body = row.ACTION_STATEMENT ?? '';
		const orientation = row.ACTION_ORIENTATION ?? 'ROW';
		const statement = body
			? `CREATE TRIGGER \`${row.TRIGGER_NAME}\` ${row.ACTION_TIMING} ${row.EVENT_MANIPULATION} ON \`${row.EVENT_OBJECT_SCHEMA}\`.\`${row.EVENT_OBJECT_TABLE}\`\nFOR EACH ${orientation}\n${body}`
			: undefined;
		list.push({ name: row.TRIGGER_NAME, timing: row.ACTION_TIMING, event: row.EVENT_MANIPULATION, statement });
		triggersByTable.set(key, list);
	}

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.VIEW_DEFINITION) {
			viewDefByTable.set(tableKey(row.TABLE_SCHEMA, row.TABLE_NAME), row.VIEW_DEFINITION);
		}
	}

	const indexesByTable = new Map<string, Map<string, IndexInfo>>();
	for (const row of indexRows) {
		const key = tableKey(row.TABLE_SCHEMA, row.TABLE_NAME);
		const byName = indexesByTable.get(key) ?? new Map<string, IndexInfo>();
		const index = byName.get(row.INDEX_NAME) ?? { name: row.INDEX_NAME, columns: [], unique: Number(row.NON_UNIQUE) === 0 };
		index.columns.push(row.COLUMN_NAME);
		byName.set(row.INDEX_NAME, index);
		indexesByTable.set(key, byName);
	}

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.TABLE_SCHEMA, row.TABLE_NAME);
		const triggers = triggersByTable.get(key);
		const rowCount = row.TABLE_ROWS == null ? undefined : Number(row.TABLE_ROWS);
		const dataBytes = row.DATA_LENGTH == null ? undefined : Number(row.DATA_LENGTH);
		const indexBytes = row.INDEX_LENGTH == null ? undefined : Number(row.INDEX_LENGTH);
		const avgRowBytes = row.AVG_ROW_LENGTH == null ? undefined : Number(row.AVG_ROW_LENGTH);
		const dataFreeBytes = row.DATA_FREE == null ? undefined : Number(row.DATA_FREE);
		const autoIncrement = row.AUTO_INCREMENT == null ? undefined : Number(row.AUTO_INCREMENT);
		const engine = row.ENGINE ?? undefined;
		const collation = row.TABLE_COLLATION ?? undefined;
		const createdAt = row.CREATE_TIME == null ? undefined : new Date(row.CREATE_TIME).getTime();
		const updatedAt = row.UPDATE_TIME == null ? undefined : new Date(row.UPDATE_TIME).getTime();
		const hasStats = rowCount !== undefined || dataBytes !== undefined || indexBytes !== undefined
			|| avgRowBytes !== undefined || dataFreeBytes !== undefined || autoIncrement !== undefined
			|| engine !== undefined || collation !== undefined || createdAt !== undefined || updatedAt !== undefined;
		const stats = hasStats
			? { rowCount, dataBytes, indexBytes, avgRowBytes, dataFreeBytes, autoIncrement, engine, collation, createdAt, updatedAt }
			: undefined;
		return {
			name: row.TABLE_NAME,
			schema: row.TABLE_SCHEMA,
			kind: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
			definition: row.TABLE_TYPE === 'VIEW' ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: primaryKeyByTable.get(key) ?? [],
			foreignKeys: [...(foreignKeysByTable.get(key)?.values() ?? [])],
			indexes: [...(indexesByTable.get(key)?.values() ?? [])],
			triggers: triggers && triggers.length > 0 ? triggers : undefined,
			stats,
			comment: row.TABLE_COMMENT || undefined,
		};
	});

	const paramsByRoutine = new Map<string, RoutineParam[]>();
	for (const row of parameterRows) {
		const key = `${row.SPECIFIC_SCHEMA}.${row.SPECIFIC_NAME}`;
		const list = paramsByRoutine.get(key) ?? [];
		list.push({ name: row.PARAMETER_NAME ?? '', dataType: row.DTD_IDENTIFIER ?? '', mode: row.PARAMETER_MODE ?? undefined });
		paramsByRoutine.set(key, list);
	}

	const routines: RoutineInfo[] = routineRows.map((row) => {
		const kind = row.ROUTINE_TYPE === 'PROCEDURE' ? 'procedure' : 'function';
		const params = paramsByRoutine.get(`${row.ROUTINE_SCHEMA}.${row.ROUTINE_NAME}`) ?? [];
		// INFORMATION_SCHEMA only exposes the body (BEGIN…END / RETURN …), not the full
		// CREATE; reconstruct a readable header from the metadata so the detail view shows
		// proper DDL (mirrors how triggers are reconstructed from ACTION_STATEMENT).
		const body = row.ROUTINE_DEFINITION ?? '';
		let definition: string | undefined;
		if (body) {
			const signature = params.map((p) => `${p.mode ? `${p.mode} ` : ''}\`${p.name}\` ${p.dataType}`).join(', ');
			const returns = kind === 'function' && row.DATA_TYPE ? `\nRETURNS ${row.DATA_TYPE}` : '';
			definition = `CREATE ${kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'} \`${row.ROUTINE_SCHEMA}\`.\`${row.ROUTINE_NAME}\`(${signature})${returns}\n${body}`;
		}
		return {
			name: row.ROUTINE_NAME,
			schema: row.ROUTINE_SCHEMA,
			kind,
			returnType: row.DATA_TYPE ?? undefined,
			language: row.EXTERNAL_LANGUAGE ?? undefined,
			parameters: params,
			definition,
		};
	});

	return {
		database: database ?? '(all schemas)',
		tables,
		routines: routines.length > 0 ? routines : undefined,
		fetchedAt: Date.now(),
	};
}

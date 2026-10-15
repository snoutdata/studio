/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineParam, TableInfo, TriggerInfo } from '../../../../shared/schema';

/**
 * A query runner: takes a SQL string and resolves to named-column rows. The driver supplies one
 * backed by a real `@sap/hana-client` connection; tests inject a stub that returns canned catalog
 * rows, so introspection assembly is exercised without a HANA instance.
 */
export type HanaRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

interface TableRow {
	schema_name: string;
	table_name: string;
	table_kind: string;
}

interface ColumnRow {
	schema_name: string;
	table_name: string;
	column_name: string;
	data_type_name: string;
	length: number | null;
	scale: number | null;
	is_nullable: string;
	default_value: string | null;
	comments: string | null;
}

interface PrimaryKeyRow {
	schema_name: string;
	table_name: string;
	column_name: string;
}

interface ForeignKeyRow {
	schema_name: string;
	table_name: string;
	constraint_name: string;
	column_name: string;
	referenced_table: string;
	referenced_column: string;
}

interface IndexRow {
	schema_name: string;
	table_name: string;
	index_name: string;
	index_type: string;
	column_name: string;
}

interface TriggerRow {
	schema_name: string;
	table_name: string;
	trigger_name: string;
	action_time: string;
	trigger_event: string;
	definition: string | null;
}

interface ViewRow {
	schema_name: string;
	table_name: string;
	definition: string | null;
}

interface RoutineRow {
	routine_schema: string;
	routine_name: string;
	routine_kind: string;
	definition: string | null;
}

interface ParameterRow {
	routine_schema: string;
	routine_name: string;
	routine_kind: string;
	parameter_name: string | null;
	data_type_name: string | null;
	parameter_type: string | null;
}

interface StatsRow {
	schema_name: string;
	table_name: string;
	record_count: number | string | null;
	table_size: number | string | null;
}

interface DigestRow {
	schema_name: string;
	table_name: string;
	column_name: string;
	data_type_name: string;
	position: number;
}

/**
 * The user-schema filter. HANA's own objects live in SYS and in the `_SYS_*` family (_SYS_BIC,
 * _SYS_REPO, _SYS_STATISTICS, …). `LEFT(...)` is used rather than `LIKE '_SYS%'` because `_` is a
 * single-character wildcard in LIKE — the LIKE form would also match a user schema named "XSYS…".
 * SYSTEM is deliberately NOT excluded: it is a normal user schema and demo/dev instances put real
 * tables there.
 */
function schemaFilter(col: string): string {
	return `${col} <> 'SYS' AND LEFT(${col}, 4) <> '_SYS'`;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * Compose a readable column type from the catalog parts, e.g. `DECIMAL(10,2)`, `NVARCHAR(255)`.
 * HANA's LENGTH is the character length for string types and the precision for the decimal types;
 * SCALE applies to the decimal types. Date/time and fixed-width numerics carry no suffix.
 */
function composeType(row: ColumnRow): string {
	const base = (row.data_type_name ?? '').trim();
	const t = base.toUpperCase();
	if ((t === 'DECIMAL' || t === 'SMALLDECIMAL') && row.length !== null) {
		return row.scale !== null && row.scale !== 0 ? `${base}(${row.length},${row.scale})` : `${base}(${row.length})`;
	}
	const sized = ['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'ALPHANUM', 'VARBINARY', 'SHORTTEXT'];
	if (sized.includes(t) && row.length) {
		return `${base}(${row.length})`;
	}
	return base;
}

/** HANA reports flags as the strings 'TRUE'/'FALSE'. */
function isTrue(value: unknown): boolean {
	return String(value ?? '').toUpperCase() === 'TRUE';
}

/** SYS.PROCEDURE_PARAMETERS / FUNCTION_PARAMETERS PARAMETER_TYPE is already IN / OUT / INOUT. */
function paramMode(parameterType: string | null): string | undefined {
	const t = (parameterType ?? '').toUpperCase();
	return t === 'IN' || t === 'OUT' || t === 'INOUT' ? t : undefined;
}

/** A small deterministic 32-bit string hash (FNV-1a). HANA's hash functions return binary digests
 *  that can't be summed in SQL, so the structural fingerprint is folded client-side instead (the
 *  same approach the Db2 driver takes). */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectHana: a column count plus an
 * order-independent hash over each column's identity. Any added/dropped/renamed/retyped/reordered
 * column changes it, so the live schema index can detect DDL with one query. The `/* digest *​/`
 * marker keeps it distinguishable from the full column introspection query.
 */
export async function hanaStructuralDigest(run: HanaRowRunner): Promise<string> {
	const rows = (await run(
		`SELECT /* digest */ SCHEMA_NAME AS "schema_name", TABLE_NAME AS "table_name", COLUMN_NAME AS "column_name",
		        DATA_TYPE_NAME AS "data_type_name", POSITION AS "position"
		   FROM SYS.TABLE_COLUMNS WHERE ${schemaFilter('SCHEMA_NAME')}`,
	)) as unknown as DigestRow[];
	let sum = 0;
	for (const row of rows) {
		sum = (sum + fnv1a(`${row.schema_name}:${row.table_name}:${row.column_name}:${row.data_type_name}:${row.position}`)) >>> 0;
	}
	return `${rows.length}:${sum}`;
}

/**
 * Introspect tables, columns, primary keys, foreign keys, indexes, triggers, views, routines and
 * table stats from HANA's SYS.* system views, covering every user schema the connected user can
 * see. Column comments come from the catalog; table comments and per-column stats are deferred.
 *
 * Views and their columns live in separate catalog views from tables (SYS.VIEWS /
 * SYS.VIEW_COLUMNS vs SYS.TABLES / SYS.TABLE_COLUMNS), so both are read and merged — otherwise a
 * view would show up in the explorer with no columns.
 */
export async function introspectHana(run: HanaRowRunner, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const tableRows = (await run(
		`SELECT SCHEMA_NAME AS "schema_name", TABLE_NAME AS "table_name", 'TABLE' AS "table_kind"
		   FROM SYS.TABLES WHERE ${schemaFilter('SCHEMA_NAME')}
		  ORDER BY SCHEMA_NAME, TABLE_NAME`,
	)) as unknown as TableRow[];

	const viewObjectRows = includeViews
		? ((await run(
			`SELECT SCHEMA_NAME AS "schema_name", VIEW_NAME AS "table_name", DEFINITION AS "definition"
			   FROM SYS.VIEWS WHERE ${schemaFilter('SCHEMA_NAME')}
			  ORDER BY SCHEMA_NAME, VIEW_NAME`,
		)) as unknown as ViewRow[])
		: [];

	const columnRows = (await run(
		`SELECT SCHEMA_NAME AS "schema_name", TABLE_NAME AS "table_name", COLUMN_NAME AS "column_name",
		        DATA_TYPE_NAME AS "data_type_name", LENGTH AS "length", SCALE AS "scale",
		        IS_NULLABLE AS "is_nullable", DEFAULT_VALUE AS "default_value", COMMENTS AS "comments"
		   FROM SYS.TABLE_COLUMNS WHERE ${schemaFilter('SCHEMA_NAME')}
		  ORDER BY SCHEMA_NAME, TABLE_NAME, POSITION`,
	)) as unknown as ColumnRow[];

	const viewColumnRows = includeViews
		? ((await run(
			`SELECT SCHEMA_NAME AS "schema_name", VIEW_NAME AS "table_name", COLUMN_NAME AS "column_name",
			        DATA_TYPE_NAME AS "data_type_name", LENGTH AS "length", SCALE AS "scale",
			        IS_NULLABLE AS "is_nullable", DEFAULT_VALUE AS "default_value", COMMENTS AS "comments"
			   FROM SYS.VIEW_COLUMNS WHERE ${schemaFilter('SCHEMA_NAME')}
			  ORDER BY SCHEMA_NAME, VIEW_NAME, POSITION`,
		)) as unknown as ColumnRow[])
		: [];

	// SYS.CONSTRAINTS carries one row per constrained column, with POSITION giving its place in
	// the key; IS_PRIMARY_KEY separates the PK from the plain unique/not-null constraints.
	const pkRows = (await run(
		`SELECT SCHEMA_NAME AS "schema_name", TABLE_NAME AS "table_name", COLUMN_NAME AS "column_name"
		   FROM SYS.CONSTRAINTS
		  WHERE IS_PRIMARY_KEY = 'TRUE' AND ${schemaFilter('SCHEMA_NAME')}
		  ORDER BY SCHEMA_NAME, TABLE_NAME, POSITION`,
	)) as unknown as PrimaryKeyRow[];

	// SYS.REFERENTIAL_CONSTRAINTS already pairs each FK column with the column it references, so
	// no join back through the parent constraint is needed (unlike Oracle/Db2).
	const fkRows = (await run(
		`SELECT SCHEMA_NAME AS "schema_name", TABLE_NAME AS "table_name", CONSTRAINT_NAME AS "constraint_name",
		        COLUMN_NAME AS "column_name", REFERENCED_TABLE_NAME AS "referenced_table",
		        REFERENCED_COLUMN_NAME AS "referenced_column"
		   FROM SYS.REFERENTIAL_CONSTRAINTS WHERE ${schemaFilter('SCHEMA_NAME')}
		  ORDER BY SCHEMA_NAME, TABLE_NAME, CONSTRAINT_NAME, POSITION`,
	)) as unknown as ForeignKeyRow[];

	// Secondary indexes only: the index backing a primary key has CONSTRAINT = 'PRIMARY KEY', and
	// the PK is carried separately. INDEX_TYPE spells out uniqueness ('BTREE UNIQUE', 'CPBTREE
	// UNIQUE INVERTED VALUE', …), so a substring test is what distinguishes a unique index.
	const indexRows = (await run(
		`SELECT i.SCHEMA_NAME AS "schema_name", i.TABLE_NAME AS "table_name", i.INDEX_NAME AS "index_name",
		        i.INDEX_TYPE AS "index_type", ic.COLUMN_NAME AS "column_name"
		   FROM SYS.INDEXES i
		   JOIN SYS.INDEX_COLUMNS ic
		     ON ic.SCHEMA_NAME = i.SCHEMA_NAME AND ic.TABLE_NAME = i.TABLE_NAME AND ic.INDEX_NAME = i.INDEX_NAME
		  WHERE (i."CONSTRAINT" IS NULL OR i."CONSTRAINT" <> 'PRIMARY KEY') AND ${schemaFilter('i.SCHEMA_NAME')}
		  ORDER BY i.SCHEMA_NAME, i.TABLE_NAME, i.INDEX_NAME, ic.POSITION`,
	)) as unknown as IndexRow[];

	const triggerRows = (await run(
		`SELECT SUBJECT_TABLE_SCHEMA AS "schema_name", SUBJECT_TABLE_NAME AS "table_name",
		        TRIGGER_NAME AS "trigger_name", TRIGGER_ACTION_TIME AS "action_time",
		        TRIGGER_EVENT AS "trigger_event", DEFINITION AS "definition"
		   FROM SYS.TRIGGERS WHERE ${schemaFilter('SUBJECT_TABLE_SCHEMA')}
		  ORDER BY SUBJECT_TABLE_SCHEMA, SUBJECT_TABLE_NAME, TRIGGER_NAME`,
	)) as unknown as TriggerRow[];

	// Procedures and functions are separate catalog views with the same shape; UNION ALL keeps them
	// as one routine list with a `routine_kind` discriminator (which also keys the parameter join).
	const routineRows = (await run(
		`SELECT SCHEMA_NAME AS "routine_schema", PROCEDURE_NAME AS "routine_name",
		        'procedure' AS "routine_kind", DEFINITION AS "definition"
		   FROM SYS.PROCEDURES WHERE ${schemaFilter('SCHEMA_NAME')}
		  UNION ALL
		 SELECT SCHEMA_NAME AS "routine_schema", FUNCTION_NAME AS "routine_name",
		        'function' AS "routine_kind", DEFINITION AS "definition"
		   FROM SYS.FUNCTIONS WHERE ${schemaFilter('SCHEMA_NAME')}
		  ORDER BY "routine_schema", "routine_name"`,
	)) as unknown as RoutineRow[];

	const parameterRows = (await run(
		`SELECT SCHEMA_NAME AS "routine_schema", PROCEDURE_NAME AS "routine_name", 'procedure' AS "routine_kind",
		        PARAMETER_NAME AS "parameter_name", DATA_TYPE_NAME AS "data_type_name", PARAMETER_TYPE AS "parameter_type", POSITION AS "position"
		   FROM SYS.PROCEDURE_PARAMETERS WHERE ${schemaFilter('SCHEMA_NAME')}
		  UNION ALL
		 SELECT SCHEMA_NAME AS "routine_schema", FUNCTION_NAME AS "routine_name", 'function' AS "routine_kind",
		        PARAMETER_NAME AS "parameter_name", DATA_TYPE_NAME AS "data_type_name", PARAMETER_TYPE AS "parameter_type", POSITION AS "position"
		   FROM SYS.FUNCTION_PARAMETERS WHERE ${schemaFilter('SCHEMA_NAME')}
		  ORDER BY "routine_schema", "routine_name", "position"`,
	)) as unknown as ParameterRow[];

	// M_TABLES is the in-memory runtime view: RECORD_COUNT is the live row count (not an estimate,
	// HANA keeps it) and TABLE_SIZE the bytes resident in memory. A partitioned table has one row
	// per partition, so the parts are summed back into a per-table figure.
	const statsRows = (await run(
		`SELECT SCHEMA_NAME AS "schema_name", TABLE_NAME AS "table_name",
		        SUM(RECORD_COUNT) AS "record_count", SUM(TABLE_SIZE) AS "table_size"
		   FROM SYS.M_TABLES WHERE ${schemaFilter('SCHEMA_NAME')}
		  GROUP BY SCHEMA_NAME, TABLE_NAME`,
	)) as unknown as StatsRow[];

	const viewDefByTable = new Map<string, string>();
	for (const row of viewObjectRows) {
		if (row.definition) {
			viewDefByTable.set(tableKey(row.schema_name, row.table_name), row.definition);
		}
	}

	const paramsByRoutine = new Map<string, RoutineParam[]>();
	for (const row of parameterRows) {
		const key = `${row.routine_kind}:${tableKey(row.routine_schema, row.routine_name)}`;
		const list = paramsByRoutine.get(key) ?? [];
		list.push({ name: row.parameter_name ?? '', dataType: (row.data_type_name ?? '').trim(), mode: paramMode(row.parameter_type) });
		paramsByRoutine.set(key, list);
	}

	const routines: RoutineInfo[] = routineRows.map((row) => ({
		name: row.routine_name,
		schema: row.routine_schema,
		kind: row.routine_kind === 'procedure' ? 'procedure' : 'function',
		parameters: paramsByRoutine.get(`${row.routine_kind}:${tableKey(row.routine_schema, row.routine_name)}`) ?? [],
		definition: row.definition ?? undefined,
	}));

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
	for (const row of [...columnRows, ...viewColumnRows]) {
		const key = tableKey(row.schema_name, row.table_name);
		const list = columnsByTable.get(key) ?? [];
		const def = row.default_value === null || row.default_value === undefined ? null : String(row.default_value).trim();
		list.push({
			name: row.column_name,
			dataType: composeType(row),
			nullable: isTrue(row.is_nullable),
			isPrimaryKey: primaryKeyColumns.get(key)?.has(row.column_name) ?? false,
			default: def === '' ? null : def,
			comment: row.comments ?? undefined,
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
		const key = tableKey(row.schema_name, row.table_name);
		const byName = indexesByTable.get(key) ?? new Map<string, IndexInfo>();
		const index = byName.get(row.index_name) ?? {
			name: row.index_name,
			columns: [],
			unique: (row.index_type ?? '').toUpperCase().includes('UNIQUE'),
		};
		index.columns.push(row.column_name);
		byName.set(row.index_name, index);
		indexesByTable.set(key, byName);
	}

	const triggersByTable = new Map<string, TriggerInfo[]>();
	for (const row of triggerRows) {
		const key = tableKey(row.schema_name, row.table_name);
		const list = triggersByTable.get(key) ?? [];
		list.push({ name: row.trigger_name, timing: row.action_time, event: row.trigger_event, statement: row.definition ?? undefined });
		triggersByTable.set(key, list);
	}

	const statsByTable = new Map<string, NonNullable<TableInfo['stats']>>();
	for (const row of statsRows) {
		statsByTable.set(tableKey(row.schema_name, row.table_name), {
			rowCount: row.record_count == null ? undefined : Number(row.record_count),
			totalBytes: row.table_size == null ? undefined : Number(row.table_size),
			dataBytes: row.table_size == null ? undefined : Number(row.table_size),
		});
	}

	const objects: TableRow[] = [
		...tableRows,
		...viewObjectRows.map((row) => ({ schema_name: row.schema_name, table_name: row.table_name, table_kind: 'VIEW' })),
	];

	const tables: TableInfo[] = objects.map((row) => {
		const key = tableKey(row.schema_name, row.table_name);
		const isView = row.table_kind === 'VIEW';
		const triggers = triggersByTable.get(key);
		return {
			name: row.table_name,
			schema: row.schema_name,
			kind: isView ? 'view' : 'table',
			definition: isView ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: primaryKeyByTable.get(key) ?? [],
			foreignKeys: [...(foreignKeysByTable.get(key)?.values() ?? [])],
			indexes: [...(indexesByTable.get(key)?.values() ?? [])],
			triggers: triggers && triggers.length > 0 ? triggers : undefined,
			stats: statsByTable.get(key),
			comment: undefined,
		};
	});

	return {
		database: database ?? '(all schemas)',
		tables,
		routines: routines.length > 0 ? routines : undefined,
		fetchedAt: Date.now(),
	};
}

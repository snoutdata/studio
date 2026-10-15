/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineParam, TableInfo, TriggerInfo } from '../../../../shared/schema';

/**
 * A query runner: takes a SQL string and resolves to named-column rows. The driver supplies one
 * backed by a real oracledb connection (OUT_FORMAT_OBJECT); tests inject a stub that returns
 * canned rows, so introspection assembly is exercised without an Oracle server.
 */
export type OracleRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

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
	data_precision: number | null;
	data_scale: number | null;
	data_length: number | null;
	char_length: number | null;
	nullable: string;
	data_default: string | null;
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
	uniqueness: string;
	column_name: string;
}

interface TriggerRow {
	table_schema: string;
	table_name: string;
	trigger_name: string;
	trigger_type: string;
	triggering_event: string;
	trigger_body: string | null;
}

interface ViewRow {
	table_schema: string;
	table_name: string;
	definition: string | null;
}

interface RoutineRow {
	routine_schema: string;
	routine_name: string;
	routine_type: string;
}

interface ParameterRow {
	routine_schema: string;
	routine_name: string;
	parameter_name: string | null;
	data_type: string | null;
	parameter_mode: string | null;
}

interface DigestRow {
	n: number;
	h: number | null;
}

// Oracle-internal schemas: never user data, so excluded from introspection (mirrors the
// pg_catalog/INFORMATION_SCHEMA exclusion the other drivers do).
const SYSTEM_SCHEMAS = [
	'SYS', 'SYSTEM', 'OUTLN', 'XDB', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'OLAPSYS', 'WMSYS',
	'DBSNMP', 'APPQOSSYS', 'GSMADMIN_INTERNAL', 'AUDSYS', 'DVSYS', 'LBACSYS', 'ANONYMOUS', 'GGSYS',
	'SYS$UMF', 'DBSFWUSER', 'GSMCATUSER', 'GSMUSER', 'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'DIP',
	'ORACLE_OCM', 'REMOTE_SCHEDULER_AGENT', 'MDDATA', 'SI_INFORMTN_SCHEMA', 'FLOWS_FILES', 'OJVMSYS',
];

const SYS_LIST = SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ');

/** `<col> NOT IN ('SYS', …)` — the user-schema filter for a given owner column. */
function ownerFilter(col: string): string {
	return `${col} NOT IN (${SYS_LIST})`;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/** Compose a readable column type from the dictionary parts, e.g. `NUMBER(10,2)`, `VARCHAR2(255)`.
 *  Oracle already bakes the precision into the data_type string for TIMESTAMP/INTERVAL types, so
 *  only NUMBER / character / RAW / FLOAT get a synthesised length suffix. */
function composeType(row: ColumnRow): string {
	const base = row.data_type;
	const t = base.toUpperCase();
	if (t === 'NUMBER') {
		if (row.data_precision !== null) {
			return row.data_scale !== null && row.data_scale !== 0
				? `NUMBER(${row.data_precision},${row.data_scale})`
				: `NUMBER(${row.data_precision})`;
		}
		return 'NUMBER';
	}
	if (t === 'FLOAT' && row.data_precision !== null) {
		return `FLOAT(${row.data_precision})`;
	}
	if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR'].includes(t) && row.char_length) {
		return `${base}(${row.char_length})`;
	}
	if (t === 'RAW' && row.data_length) {
		return `${base}(${row.data_length})`;
	}
	return base;
}

/** Oracle trigger_type, e.g. "BEFORE EACH ROW" / "AFTER STATEMENT" / "INSTEAD OF", → our timing. */
function triggerTiming(triggerType: string): string {
	const t = triggerType.toUpperCase();
	if (t.includes('INSTEAD OF')) {
		return 'INSTEAD OF';
	}
	return t.startsWith('BEFORE') ? 'BEFORE' : 'AFTER';
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectOracle: a column count plus an
 * order-independent SUM of ORA_HASH over each column's identity. Any added/dropped/renamed/
 * retyped/reordered column changes it, so the live schema index can detect DDL with one query.
 */
export async function oracleStructuralDigest(run: OracleRowRunner): Promise<string> {
	const rows = (await run(
		`SELECT COUNT(*) AS "n",
		        NVL(SUM(ORA_HASH(owner || ':' || table_name || ':' || column_name || ':' || data_type || ':' || column_id)), 0) AS "h"
		   FROM all_tab_columns
		  WHERE ${ownerFilter('owner')}`,
	)) as unknown as DigestRow[];
	const row = rows[0];
	return row ? `${row.n}:${row.h ?? 0}` : '0:0';
}

/**
 * Introspect tables, columns, primary keys, foreign keys, indexes, triggers and routines from the
 * ALL_* data-dictionary views, covering every user schema the connected user can see. Stats,
 * comments and routine bodies are deferred (best-effort, not populated in this first cut).
 */
export async function introspectOracle(run: OracleRowRunner, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const viewArm = includeViews
		? `\n\t\tUNION ALL\n\t\tSELECT owner, view_name, 'VIEW' FROM all_views WHERE ${ownerFilter('owner')}`
		: '';
	const tableRows = (await run(
		`SELECT owner AS "table_schema", table_name AS "table_name", 'TABLE' AS "table_type"
		   FROM all_tables WHERE ${ownerFilter('owner')}${viewArm}
		  ORDER BY "table_schema", "table_name"`,
	)) as unknown as TableRow[];

	const columnRows = (await run(
		`SELECT owner AS "table_schema", table_name AS "table_name", column_name AS "column_name",
		        data_type AS "data_type", data_precision AS "data_precision", data_scale AS "data_scale",
		        data_length AS "data_length", char_length AS "char_length", nullable AS "nullable",
		        data_default AS "data_default", column_id AS "column_id"
		   FROM all_tab_columns WHERE ${ownerFilter('owner')}
		  ORDER BY owner, table_name, column_id`,
	)) as unknown as ColumnRow[];

	const pkRows = (await run(
		`SELECT c.owner AS "table_schema", c.table_name AS "table_name", cc.column_name AS "column_name"
		   FROM all_constraints c
		   JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
		  WHERE c.constraint_type = 'P' AND ${ownerFilter('c.owner')}
		  ORDER BY c.owner, c.table_name, cc.position`,
	)) as unknown as PrimaryKeyRow[];

	// Oracle FKs reference a *constraint* (r_constraint_name), not columns directly, so the
	// referenced columns are the parent PK/unique constraint's columns, matched by position.
	const fkRows = (await run(
		`SELECT c.owner AS "table_schema", c.table_name AS "table_name", c.constraint_name AS "constraint_name",
		        cc.column_name AS "column_name", rc.table_name AS "referenced_table", rcc.column_name AS "referenced_column"
		   FROM all_constraints c
		   JOIN all_cons_columns cc  ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
		   JOIN all_constraints rc   ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
		   JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
		  WHERE c.constraint_type = 'R' AND ${ownerFilter('c.owner')}
		  ORDER BY c.owner, c.table_name, c.constraint_name, cc.position`,
	)) as unknown as ForeignKeyRow[];

	// Secondary indexes (skip the index backing a PK constraint; the PK rides separately).
	const indexRows = (await run(
		`SELECT i.table_owner AS "table_schema", i.table_name AS "table_name", i.index_name AS "index_name",
		        i.uniqueness AS "uniqueness", ic.column_name AS "column_name"
		   FROM all_indexes i
		   JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
		  WHERE ${ownerFilter('i.table_owner')}
		    AND i.index_name NOT IN (SELECT index_name FROM all_constraints WHERE constraint_type = 'P' AND index_name IS NOT NULL)
		  ORDER BY i.table_owner, i.table_name, i.index_name, ic.column_position`,
	)) as unknown as IndexRow[];

	const triggerRows = (await run(
		`SELECT table_owner AS "table_schema", table_name AS "table_name", trigger_name AS "trigger_name",
		        trigger_type AS "trigger_type", triggering_event AS "triggering_event", trigger_body AS "trigger_body"
		   FROM all_triggers WHERE ${ownerFilter('table_owner')} AND base_object_type = 'TABLE'
		  ORDER BY table_owner, table_name, trigger_name`,
	)) as unknown as TriggerRow[];

	const viewRows = includeViews
		? (await run(
			`SELECT owner AS "table_schema", view_name AS "table_name", text AS "definition"
			   FROM all_views WHERE ${ownerFilter('owner')}`,
		)) as unknown as ViewRow[]
		: [];

	const routineRows = (await run(
		`SELECT owner AS "routine_schema", object_name AS "routine_name", object_type AS "routine_type"
		   FROM all_procedures
		  WHERE object_type IN ('PROCEDURE', 'FUNCTION') AND ${ownerFilter('owner')}
		  ORDER BY owner, object_name`,
	)) as unknown as RoutineRow[];

	// Routine parameters (position 0 is a function's return value, so it's excluded); packaged
	// subprograms are skipped (package_name IS NULL keeps only standalone routines).
	const parameterRows = (await run(
		`SELECT owner AS "routine_schema", object_name AS "routine_name", argument_name AS "parameter_name",
		        data_type AS "data_type", in_out AS "parameter_mode"
		   FROM all_arguments
		  WHERE ${ownerFilter('owner')} AND package_name IS NULL AND position > 0
		  ORDER BY owner, object_name, position`,
	)) as unknown as ParameterRow[];

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
		parameters: paramsByRoutine.get(tableKey(row.routine_schema, row.routine_name)) ?? [],
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

	const columnsByTable = new Map<string, ColumnInfo[]>();
	for (const row of columnRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = columnsByTable.get(key) ?? [];
		const def = row.data_default === null || row.data_default === undefined ? null : String(row.data_default).trim();
		list.push({
			name: row.column_name,
			dataType: composeType(row),
			nullable: row.nullable === 'Y',
			isPrimaryKey: primaryKeyColumns.get(key)?.has(row.column_name) ?? false,
			default: def === '' ? null : def,
			comment: undefined,
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
		const index = byName.get(row.index_name) ?? { name: row.index_name, columns: [], unique: row.uniqueness === 'UNIQUE' };
		index.columns.push(row.column_name);
		byName.set(row.index_name, index);
		indexesByTable.set(key, byName);
	}

	const triggersByTable = new Map<string, TriggerInfo[]>();
	for (const row of triggerRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = triggersByTable.get(key) ?? [];
		list.push({ name: row.trigger_name, timing: triggerTiming(row.trigger_type), event: row.triggering_event ?? '', statement: row.trigger_body ?? undefined });
		triggersByTable.set(key, list);
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
			stats: undefined,
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineParam, TableInfo, TriggerInfo } from '../../../../shared/schema';

/**
 * A query runner: takes a SQL string and resolves to named-column rows. The driver supplies one
 * backed by a real ibm_db connection; tests inject a stub that returns canned rows, so
 * introspection assembly is exercised without a Db2 server.
 */
export type Db2RowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

interface TableRow {
	table_schema: string;
	table_name: string;
	table_type: string;
}

interface ColumnRow {
	table_schema: string;
	table_name: string;
	column_name: string;
	type_name: string;
	length: number | null;
	scale: number | null;
	nulls: string;
	default: string | null;
	keyseq: number | null;
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
	uniquerule: string;
	column_name: string;
}

interface TriggerRow {
	table_schema: string;
	table_name: string;
	trigger_name: string;
	trigtime: string;
	trigevent: string;
	text: string | null;
}

interface ViewRow {
	table_schema: string;
	table_name: string;
	text: string | null;
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
	type_name: string | null;
	rowtype: string | null;
}

interface DigestRow {
	table_schema: string;
	table_name: string;
	column_name: string;
	type_name: string;
	colno: number;
}

// Db2 system schemas: never user data, so excluded from introspection (mirrors the
// pg_catalog / Oracle SYS exclusion the other drivers do). Beyond these, everything under a
// `SYS*` schema is system-owned, so the filter also excludes the `SYS%` prefix.
const SYSTEM_SCHEMAS = ['NULLID', 'SQLJ', 'SYSCAT', 'SYSFUN', 'SYSIBM', 'SYSIBMADM', 'SYSIBMINTERNAL', 'SYSIBMTS', 'SYSPROC', 'SYSPUBLIC', 'SYSSTAT', 'SYSTOOLS'];

const SYS_LIST = SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ');

/** `<col> NOT LIKE 'SYS%' AND <col> NOT IN ('NULLID', …)` — the user-schema filter for an owner column. */
function ownerFilter(col: string): string {
	return `${col} NOT LIKE 'SYS%' AND ${col} NOT IN (${SYS_LIST})`;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/** Compose a readable column type from the catalog parts, e.g. `DECIMAL(10,2)`, `VARCHAR(255)`.
 *  Db2's LENGTH is the character length for string types and the precision for DECIMAL/NUMERIC;
 *  SCALE applies to the decimal types. Date/time and plain numeric types carry no length suffix. */
function composeType(row: ColumnRow): string {
	const base = row.type_name.trim();
	const t = base.toUpperCase();
	if ((t === 'DECIMAL' || t === 'NUMERIC' || t === 'DECFLOAT') && row.length !== null) {
		return row.scale !== null && row.scale !== 0 ? `${base}(${row.length},${row.scale})` : `${base}(${row.length})`;
	}
	const sized = ['CHARACTER', 'CHAR', 'VARCHAR', 'CLOB', 'BLOB', 'DBCLOB', 'GRAPHIC', 'VARGRAPHIC', 'BINARY', 'VARBINARY'];
	if (sized.includes(t) && row.length) {
		// Db2 reports CHARACTER for fixed-width CHAR; keep the catalog spelling otherwise.
		return `${base}(${row.length})`;
	}
	return base;
}

/** Db2 trigtime ('B' | 'A' | 'I') → our timing. */
function triggerTiming(trigtime: string): string {
	const t = (trigtime ?? '').toUpperCase();
	if (t === 'I') {
		return 'INSTEAD OF';
	}
	return t === 'B' ? 'BEFORE' : 'AFTER';
}

/** Db2 trigevent ('I' | 'U' | 'D') → INSERT / UPDATE / DELETE. */
function triggerEvent(trigevent: string): string {
	const t = (trigevent ?? '').toUpperCase();
	if (t === 'I') {
		return 'INSERT';
	}
	if (t === 'U') {
		return 'UPDATE';
	}
	if (t === 'D') {
		return 'DELETE';
	}
	return t;
}

/** Db2 routine parameter rowtype ('P' in, 'O' out, 'B' inout) → IN / OUT / INOUT. */
function paramMode(rowtype: string | null): string | undefined {
	const t = (rowtype ?? '').toUpperCase();
	if (t === 'P') {
		return 'IN';
	}
	if (t === 'O') {
		return 'OUT';
	}
	if (t === 'B') {
		return 'INOUT';
	}
	return undefined;
}

/** A small deterministic 32-bit string hash (FNV-1a). Db2 has no portable SQL hash across
 *  versions, so the structural fingerprint is folded client-side instead. */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectDb2: a column count plus an
 * order-independent hash over each column's identity. Any added/dropped/renamed/retyped/
 * reordered column changes it, so the live schema index can detect DDL with one query. The
 * `/* digest *​/` marker keeps it distinguishable from the full column introspection query.
 */
export async function db2StructuralDigest(run: Db2RowRunner): Promise<string> {
	const rows = (await run(
		`SELECT /* digest */ TABSCHEMA AS "table_schema", TABNAME AS "table_name", COLNAME AS "column_name", TYPENAME AS "type_name", COLNO AS "colno"
		   FROM SYSCAT.COLUMNS WHERE ${ownerFilter('TABSCHEMA')}`,
	)) as unknown as DigestRow[];
	let sum = 0;
	for (const row of rows) {
		sum = (sum + fnv1a(`${row.table_schema}:${row.table_name}:${row.column_name}:${row.type_name}:${row.colno}`)) >>> 0;
	}
	return `${rows.length}:${sum}`;
}

/**
 * Introspect tables, columns, primary keys, foreign keys, indexes, triggers, views and routines
 * from the SYSCAT.* system-catalog views, covering every user schema the connected user can see.
 * Stats and comments are deferred (best-effort, not populated in this first cut).
 */
export async function introspectDb2(run: Db2RowRunner, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	// Db2 TABLES.TYPE: 'T' base table, 'V' view (+ aliases/nicknames we ignore here).
	const typeFilter = includeViews ? `TYPE IN ('T', 'V')` : `TYPE = 'T'`;
	const tableRows = (await run(
		`SELECT TABSCHEMA AS "table_schema", TABNAME AS "table_name", TYPE AS "table_type"
		   FROM SYSCAT.TABLES WHERE ${typeFilter} AND ${ownerFilter('TABSCHEMA')}
		  ORDER BY "table_schema", "table_name"`,
	)) as unknown as TableRow[];

	const columnRows = (await run(
		`SELECT TABSCHEMA AS "table_schema", TABNAME AS "table_name", COLNAME AS "column_name",
		        TYPENAME AS "type_name", LENGTH AS "length", SCALE AS "scale", NULLS AS "nulls",
		        DEFAULT AS "default", KEYSEQ AS "keyseq", COLNO AS "colno"
		   FROM SYSCAT.COLUMNS WHERE ${ownerFilter('TABSCHEMA')}
		  ORDER BY TABSCHEMA, TABNAME, COLNO`,
	)) as unknown as ColumnRow[];

	// Primary keys: SYSCAT.COLUMNS.KEYSEQ carries the column's 1-based position within the PK,
	// so the PK is read straight off the columns (no extra join needed) ordered by KEYSEQ.
	const pkRows = (await run(
		`SELECT TABSCHEMA AS "table_schema", TABNAME AS "table_name", COLNAME AS "column_name"
		   FROM SYSCAT.COLUMNS WHERE KEYSEQ IS NOT NULL AND KEYSEQ > 0 AND ${ownerFilter('TABSCHEMA')}
		  ORDER BY TABSCHEMA, TABNAME, KEYSEQ`,
	)) as unknown as PrimaryKeyRow[];

	// Foreign keys: SYSCAT.REFERENCES names the FK (CONSTNAME) and the parent constraint (REFKEYNAME).
	// The FK columns come from SYSCAT.KEYCOLUSE for CONSTNAME; the referenced columns from
	// SYSCAT.KEYCOLUSE for REFKEYNAME, matched by COLSEQ position.
	const fkRows = (await run(
		`SELECT r.TABSCHEMA AS "table_schema", r.TABNAME AS "table_name", r.CONSTNAME AS "constraint_name",
		        kc.COLNAME AS "column_name", r.REFTABNAME AS "referenced_table", rkc.COLNAME AS "referenced_column"
		   FROM SYSCAT.REFERENCES r
		   JOIN SYSCAT.KEYCOLUSE kc  ON kc.CONSTNAME = r.CONSTNAME AND kc.TABSCHEMA = r.TABSCHEMA AND kc.TABNAME = r.TABNAME
		   JOIN SYSCAT.KEYCOLUSE rkc ON rkc.CONSTNAME = r.REFKEYNAME AND rkc.TABSCHEMA = r.REFTABSCHEMA AND rkc.TABNAME = r.REFTABNAME AND rkc.COLSEQ = kc.COLSEQ
		  WHERE ${ownerFilter('r.TABSCHEMA')}
		  ORDER BY r.TABSCHEMA, r.TABNAME, r.CONSTNAME, kc.COLSEQ`,
	)) as unknown as ForeignKeyRow[];

	// Secondary indexes (skip the index backing a PK constraint: UNIQUERULE 'P').
	const indexRows = (await run(
		`SELECT i.TABSCHEMA AS "table_schema", i.TABNAME AS "table_name", i.INDNAME AS "index_name",
		        i.UNIQUERULE AS "uniquerule", ic.COLNAME AS "column_name"
		   FROM SYSCAT.INDEXES i
		   JOIN SYSCAT.INDEXCOLUSE ic ON ic.INDSCHEMA = i.INDSCHEMA AND ic.INDNAME = i.INDNAME
		  WHERE i.UNIQUERULE <> 'P' AND ${ownerFilter('i.TABSCHEMA')}
		  ORDER BY i.TABSCHEMA, i.TABNAME, i.INDNAME, ic.COLSEQ`,
	)) as unknown as IndexRow[];

	const triggerRows = (await run(
		`SELECT TABSCHEMA AS "table_schema", TABNAME AS "table_name", TRIGNAME AS "trigger_name",
		        TRIGTIME AS "trigtime", TRIGEVENT AS "trigevent", TEXT AS "text"
		   FROM SYSCAT.TRIGGERS WHERE ${ownerFilter('TABSCHEMA')}
		  ORDER BY TABSCHEMA, TABNAME, TRIGNAME`,
	)) as unknown as TriggerRow[];

	const viewRows = includeViews
		? (await run(
			`SELECT VIEWSCHEMA AS "table_schema", VIEWNAME AS "table_name", TEXT AS "text"
			   FROM SYSCAT.VIEWS WHERE ${ownerFilter('VIEWSCHEMA')}`,
		)) as unknown as ViewRow[]
		: [];

	const routineRows = (await run(
		`SELECT ROUTINESCHEMA AS "routine_schema", ROUTINENAME AS "routine_name", ROUTINETYPE AS "routine_type"
		   FROM SYSCAT.ROUTINES
		  WHERE ROUTINETYPE IN ('P', 'F') AND ${ownerFilter('ROUTINESCHEMA')}
		  ORDER BY ROUTINESCHEMA, ROUTINENAME`,
	)) as unknown as RoutineRow[];

	const parameterRows = (await run(
		`SELECT ROUTINESCHEMA AS "routine_schema", ROUTINENAME AS "routine_name", PARMNAME AS "parameter_name",
		        TYPENAME AS "type_name", ROWTYPE AS "rowtype"
		   FROM SYSCAT.ROUTINEPARMS
		  WHERE ${ownerFilter('ROUTINESCHEMA')} AND ROWTYPE IN ('P', 'O', 'B')
		  ORDER BY ROUTINESCHEMA, ROUTINENAME, ORDINAL`,
	)) as unknown as ParameterRow[];

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.text) {
			viewDefByTable.set(tableKey(row.table_schema, row.table_name), row.text);
		}
	}

	const paramsByRoutine = new Map<string, RoutineParam[]>();
	for (const row of parameterRows) {
		const key = tableKey(row.routine_schema, row.routine_name);
		const list = paramsByRoutine.get(key) ?? [];
		list.push({ name: row.parameter_name ?? '', dataType: (row.type_name ?? '').trim(), mode: paramMode(row.rowtype) });
		paramsByRoutine.set(key, list);
	}

	const routines: RoutineInfo[] = routineRows.map((row) => ({
		name: row.routine_name,
		schema: row.routine_schema,
		kind: row.routine_type === 'P' ? 'procedure' : 'function',
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
		const def = row.default === null || row.default === undefined ? null : String(row.default).trim();
		list.push({
			name: row.column_name,
			dataType: composeType(row),
			nullable: row.nulls === 'Y',
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
		const index = byName.get(row.index_name) ?? { name: row.index_name, columns: [], unique: row.uniquerule === 'U' };
		index.columns.push(row.column_name);
		byName.set(row.index_name, index);
		indexesByTable.set(key, byName);
	}

	const triggersByTable = new Map<string, TriggerInfo[]>();
	for (const row of triggerRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const list = triggersByTable.get(key) ?? [];
		list.push({ name: row.trigger_name, timing: triggerTiming(row.trigtime), event: triggerEvent(row.trigevent), statement: row.text ?? undefined });
		triggersByTable.set(key, list);
	}

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.table_schema, row.table_name);
		const triggers = triggersByTable.get(key);
		return {
			name: row.table_name,
			schema: row.table_schema,
			kind: row.table_type === 'V' ? 'view' : 'table',
			definition: row.table_type === 'V' ? viewDefByTable.get(key) : undefined,
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

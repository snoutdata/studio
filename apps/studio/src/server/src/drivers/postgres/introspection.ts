/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Pool, QueryResult } from 'pg';

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineParam, TableInfo, TriggerInfo } from '../../../../shared/schema';
import { attachSeries, readSeries } from './series';

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
	is_identity: string;
	identity_generation: string | null;
	is_generated: string;
}

interface PrimaryKeyRow {
	table_schema: string;
	table_name: string;
	column_name: string;
	constraint_name: string;
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
	events: string;
	statement: string | null;
}

interface StatsRow {
	table_schema: string;
	table_name: string;
	row_count: string | number | null;
	data_bytes: string | number | null;
	index_bytes: string | number | null;
	total_bytes: string | number | null;
	live_tuples: string | number | null;
	dead_tuples: string | number | null;
	seq_scan: string | number | null;
	idx_scan: string | number | null;
	last_vacuum: Date | string | null;
	last_autovacuum: Date | string | null;
	last_analyze: Date | string | null;
	last_autoanalyze: Date | string | null;
}

interface ViewRow {
	table_schema: string;
	table_name: string;
	definition: string | null;
}

interface CommentRow {
	table_schema: string;
	table_name: string;
	/** 0 for the table's own comment; otherwise the commented column's attribute number. */
	objsubid: number;
	column_name: string | null;
	description: string;
}

interface RoutineRow {
	routine_schema: string;
	routine_name: string;
	/** Catalog-unique routine id (handles overloading); join key for parameters. */
	specific_name: string;
	routine_kind: string;
	return_type: string | null;
	language: string | null;
	definition: string | null;
}

interface ParameterRow {
	specific_schema: string;
	specific_name: string;
	parameter_mode: string | null;
	parameter_name: string | null;
	data_type: string | null;
}

function tableKey(schema: string, table: string): string {
	return `${schema}.${table}`;
}

/**
 * Cheap structural fingerprint, scoped exactly like introspectPostgres: a column
 * count plus an order-independent sum of hashtext over each column's identity. Any
 * added/dropped/renamed/retyped/reordered column changes it, so the live schema index
 * can detect DDL with one aggregate query.
 */
/** Pools whose engine has no `hashtext` (CockroachDB), so the digest goes straight to the
 *  portable form instead of failing first on every 15s poll. */
const withoutHashtext = new WeakSet<Pool>();

/**
 * The same fingerprint without Postgres's internal `hashtext`, for the engines that speak its wire
 * protocol but do not have it. md5 over an ORDERED string_agg is heavier than a hash sum, which is
 * why real Postgres keeps the original. Comments are left out: those engines have no pg_description
 * worth polling.
 */
async function portableStructuralDigest(pool: Pool): Promise<string> {
	const result = await pool.query(
		`SELECT COUNT(*)::text AS n,
		        COALESCE(md5(string_agg(table_schema || ':' || table_name || ':' || column_name || ':' || data_type || ':' || ordinal_position::text, ',' ORDER BY table_schema, table_name, ordinal_position)), '') AS h
		 FROM information_schema.columns
		 WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
	);
	const row = result.rows[0] as { n: string; h: string } | undefined;
	return row ? `${row.n}:${row.h}` : '0:';
}

export async function postgresStructuralDigest(pool: Pool): Promise<string> {
	if (withoutHashtext.has(pool)) {
		return portableStructuralDigest(pool);
	}
	try {
		return await hashtextStructuralDigest(pool);
	} catch (err) {
		if (!/hashtext/i.test(err instanceof Error ? err.message : String(err))) {
			throw err;
		}
		withoutHashtext.add(pool);
		return portableStructuralDigest(pool);
	}
}

async function hashtextStructuralDigest(pool: Pool): Promise<string> {
	// A second aggregate covers COMMENT ON, which lives in pg_description rather than in
	// information_schema.columns. It is folded in as its own component instead of joined per
	// column: pg_description is small, and a comment-only change must still move the digest or
	// the app serves a cached schema with no descriptions until a manual Refresh.
	const result = await pool.query(
		`SELECT COUNT(*)::text AS n,
		        COALESCE(SUM(hashtext(table_schema || ':' || table_name || ':' || column_name || ':' || data_type || ':' || ordinal_position::text))::bigint, 0)::text AS h,
		        (SELECT COALESCE(SUM(hashtext(objoid::text || ':' || objsubid::text || ':' || description))::bigint, 0)::text FROM pg_description) AS d,
		        (SELECT COALESCE(SUM(hashtext(oid::text || ':' || relam::text))::bigint, 0)::text FROM pg_class WHERE relispartition) AS p
		 FROM information_schema.columns
		 WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`,
	);
	// `p`: each partition's access method. Sealing a SnoutTime partition rewrites it into the
	// column store without touching a column, so without this the explorer would call a sealed
	// partition live until a manual Refresh.
	const row = result.rows[0] as { n: string; h: string; d: string; p: string } | undefined;
	return row ? `${row.n}:${row.h}:${row.d}:${row.p}` : '0:0:0:0';
}

/**
 * Introspect tables, columns, primary keys and foreign keys from a Postgres
 * database's information_schema, covering all non-system schemas. Composite
 * foreign-key column ordering is best-effort; single-column FKs (the common case)
 * are exact. Table and column comments come from pg_description (COMMENT ON …).
 */
/**
 * Run a query whose answer ENRICHES the schema (foreign keys, triggers, stats, routines, indexes,
 * comments, view bodies) and read no rows if the engine does not have what it asks for.
 *
 * Postgres always does. The engines that speak its wire protocol on purpose mostly do not have all
 * of it: CockroachDB has no `pg_relation_size`, and a missing size used to fail the whole connect,
 * which is a far worse answer than a table without its size. Tables, columns and primary keys stay
 * strict, because without them there is no schema to enrich.
 */
async function optionalQuery(pool: Pool, sql: string): Promise<Pick<QueryResult, 'rows'>> {
	try {
		return await pool.query(sql);
	} catch {
		return { rows: [] };
	}
}

export async function introspectPostgres(pool: Pool, database: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const tableTypes = includeViews ? ['BASE TABLE', 'VIEW'] : ['BASE TABLE'];

	const tableResult = await pool.query(
		`SELECT table_schema, table_name, table_type
		 FROM information_schema.tables
		 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = ANY($1)
		 ORDER BY table_schema, table_name`,
		[tableTypes],
	);
	const columnResult = await pool.query(
		`SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_identity, identity_generation, is_generated
		 FROM information_schema.columns
		 WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
		 ORDER BY table_schema, table_name, ordinal_position`,
	);
	const pkResult = await pool.query(
		// The join carries table_name as well as schema + constraint name: Postgres only makes a
		// constraint name unique per TABLE, so two tables in one schema with hand-named keys
		// (CONSTRAINT pk PRIMARY KEY …) would otherwise cross-join and hand each other's columns
		// to the wrong table.
		`SELECT tc.table_schema, tc.table_name, tc.constraint_name, kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
		 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
		 ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
	);
	const fkResult = await optionalQuery(pool, 
		`SELECT tc.table_schema, tc.table_name, tc.constraint_name, kcu.column_name,
		        ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		 JOIN information_schema.constraint_column_usage ccu
		   ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
		 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
		 ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`,
	);

	// Triggers from pg_trigger — one row per real trigger object (info_schema.triggers
	// emits one row per fired event, awkward to collapse). pg_get_triggerdef returns the
	// full CREATE TRIGGER … for the properties panel; the tgtype bitmask gives timing +
	// firing events without needing the info_schema view at all.
	const triggerResult = await optionalQuery(pool, 
		`SELECT n.nspname AS table_schema, c.relname AS table_name, t.tgname AS trigger_name,
		        CASE
		            WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF'
		            WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE'
		            ELSE 'AFTER'
		        END AS timing,
		        array_to_string(ARRAY(
		            SELECT e FROM (VALUES
		                (CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END),
		                (CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END),
		                (CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END),
		                (CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END)
		            ) AS v(e) WHERE e IS NOT NULL
		        ), ', ') AS events,
		        pg_get_triggerdef(t.oid, true) AS statement
		 FROM pg_trigger t
		 JOIN pg_class c ON c.oid = t.tgrelid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		 ORDER BY n.nspname, c.relname, t.tgname`,
	);

	// Approximate per-table stats from the catalog (cheap; not an exact COUNT).
	// pg_stat_user_tables is left-joined: it's only populated for relations that have
	// been touched since the last stats reset, so toolbox tables show no scan counts
	// rather than failing the whole introspection.
	const statsResult = await optionalQuery(pool, 
		`SELECT n.nspname AS table_schema, c.relname AS table_name,
		        c.reltuples::bigint AS row_count,
		        pg_relation_size(c.oid)::bigint AS data_bytes,
		        pg_indexes_size(c.oid)::bigint AS index_bytes,
		        pg_total_relation_size(c.oid)::bigint AS total_bytes,
		        s.n_live_tup AS live_tuples,
		        s.n_dead_tup AS dead_tuples,
		        s.seq_scan AS seq_scan,
		        s.idx_scan AS idx_scan,
		        s.last_vacuum AS last_vacuum,
		        s.last_autovacuum AS last_autovacuum,
		        s.last_analyze AS last_analyze,
		        s.last_autoanalyze AS last_autoanalyze
		 FROM pg_class c
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
		 WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		 ORDER BY n.nspname, c.relname`,
	);

	// Stored routines (procedures + functions). `routine_type` is FUNCTION or PROCEDURE in
	// modern Postgres; aggregate/window functions are excluded (pg_proc.prokind IN ('f','p'))
	// because pg_get_functiondef throws on them ("\"avg\" is an aggregate function") and they
	// aren't something the explorer's call list should offer anyway.
	const routineResult = await optionalQuery(pool, 
		`SELECT r.routine_schema, r.routine_name, r.specific_name, r.routine_type AS routine_kind,
		        CASE WHEN r.routine_type = 'FUNCTION' THEN r.data_type ELSE NULL END AS return_type,
		        r.external_language AS language,
		        pg_get_functiondef(p.oid) AS definition
		 FROM information_schema.routines r
		 JOIN pg_proc p ON p.oid = regexp_replace(r.specific_name, '^.*_', '')::oid
		 WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema')
		   AND p.prokind IN ('f', 'p')
		 ORDER BY r.routine_schema, r.routine_name`,
	);

	// Routine parameters, keyed by specific_name (handles overloaded functions). OUT params
	// aren't passed by a caller, so they're excluded from the call signature.
	const parameterResult = await optionalQuery(pool, 
		`SELECT specific_schema, specific_name, parameter_mode, parameter_name, data_type
		 FROM information_schema.parameters
		 WHERE specific_schema NOT IN ('pg_catalog', 'information_schema') AND COALESCE(parameter_mode, 'IN') <> 'OUT'
		 ORDER BY specific_schema, specific_name, ordinal_position`,
	);

	// Secondary indexes from pg_catalog (key columns in order, expression columns skipped);
	// primary-key indexes are excluded since the PK is carried separately.
	const indexResult = await optionalQuery(pool, 
		`SELECT n.nspname AS table_schema, t.relname AS table_name, i.relname AS index_name,
		        ix.indisunique AS is_unique, a.attname AS column_name
		 FROM pg_index ix
		 JOIN pg_class t ON t.oid = ix.indrelid
		 JOIN pg_class i ON i.oid = ix.indexrelid
		 JOIN pg_namespace n ON n.oid = t.relnamespace
		 JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
		 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
		 WHERE NOT ix.indisprimary AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		 ORDER BY n.nspname, t.relname, i.relname, k.ord`,
	);

	// Table + column comments (COMMENT ON …). They live in pg_description keyed by the
	// relation's oid, with objsubid 0 for the table itself and the attribute number for a
	// column, so one query covers both. A hand-written comment is the best description of
	// what a table means, so it feeds the designer, the DDL view, hover and the AI prompt.
	const commentResult = await optionalQuery(pool, 
		`SELECT n.nspname AS table_schema, c.relname AS table_name,
		        d.objsubid, a.attname AS column_name, d.description
		 FROM pg_description d
		 JOIN pg_class c ON c.oid = d.objoid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
		 WHERE c.relkind IN ('r', 'p', 'v', 'm')
		   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		   AND d.description <> ''`,
	);

	// Generated columns: the expression and whether it is STORED ('s') or VIRTUAL ('v', 18+).
	// `attgenerated` is read through row_to_json so a server older than 12, which has no such
	// column, answers with no rows instead of an error.
	const generatedResult = await optionalQuery(pool,
		`SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
		        pg_get_expr(d.adbin, d.adrelid) AS expression, row_to_json(a)->>'attgenerated' AS kind
		 FROM pg_attrdef d
		 JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
		 JOIN pg_class c ON c.oid = a.attrelid
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		   AND row_to_json(a)->>'attgenerated' IN ('s', 'v')`,
	);
	const generatedByColumn = new Map<string, NonNullable<ColumnInfo['generatedAs']>>();
	for (const row of generatedResult.rows as { table_schema: string; table_name: string; column_name: string; expression: string | null; kind: string }[]) {
		if (row.expression) {
			generatedByColumn.set(`${tableKey(row.table_schema, row.table_name)}.${row.column_name}`, { expression: row.expression, kind: row.kind === 'v' ? 'virtual' : 'stored' });
		}
	}
	// The major version, for advice that differs by it (skip scan on 18).
	const versionResult = await optionalQuery(pool, `SELECT current_setting('server_version_num') AS v`);
	const serverVersionNum = Number((versionResult.rows[0] as { v?: string } | undefined)?.v) || undefined;

	// View bodies (the SELECT each view wraps) so schema-sync can recreate them; only
	// queried when views are in scope.
	const viewResult = includeViews
		? await optionalQuery(pool,
			`SELECT n.nspname AS table_schema, c.relname AS table_name, pg_get_viewdef(c.oid, true) AS definition
			 FROM pg_class c
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
		)
		: { rows: [] };

	const tableRows = tableResult.rows as TableRow[];
	const columnRows = columnResult.rows as ColumnRow[];
	const pkRows = pkResult.rows as PrimaryKeyRow[];
	const fkRows = fkResult.rows as ForeignKeyRow[];
	const indexRows = indexResult.rows as IndexRow[];
	const triggerRows = triggerResult.rows as TriggerRow[];
	const statsRows = statsResult.rows as StatsRow[];
	const routineRows = routineResult.rows as RoutineRow[];
	const parameterRows = parameterResult.rows as ParameterRow[];
	const viewRows = viewResult.rows as ViewRow[];
	const commentRows = commentResult.rows as CommentRow[];

	const tableCommentByTable = new Map<string, string>();
	const columnCommentByColumn = new Map<string, string>();
	for (const row of commentRows) {
		const key = tableKey(row.table_schema, row.table_name);
		if (row.objsubid === 0) {
			tableCommentByTable.set(key, row.description);
		} else if (row.column_name) {
			columnCommentByColumn.set(`${key}.${row.column_name}`, row.description);
		}
	}

	const viewDefByTable = new Map<string, string>();
	for (const row of viewRows) {
		if (row.definition) {
			viewDefByTable.set(tableKey(row.table_schema, row.table_name), row.definition);
		}
	}

	const paramsBySpecific = new Map<string, RoutineParam[]>();
	for (const row of parameterRows) {
		const key = `${row.specific_schema}.${row.specific_name}`;
		const list = paramsBySpecific.get(key) ?? [];
		list.push({ name: row.parameter_name ?? '', dataType: row.data_type ?? '', mode: row.parameter_mode ?? undefined });
		paramsBySpecific.set(key, list);
	}

	const routines: RoutineInfo[] = routineRows.map((row) => ({
		name: row.routine_name,
		schema: row.routine_schema,
		kind: row.routine_kind === 'PROCEDURE' ? 'procedure' : 'function',
		returnType: row.return_type ?? undefined,
		language: row.language ?? undefined,
		parameters: paramsBySpecific.get(`${row.routine_schema}.${row.specific_name}`) ?? [],
		definition: row.definition ?? undefined,
	}));

	const primaryKeyColumns = new Map<string, Set<string>>();
	const primaryKeyByTable = new Map<string, string[]>();
	const primaryKeyNameByTable = new Map<string, string>();
	for (const row of pkRows) {
		const key = tableKey(row.table_schema, row.table_name);
		const columns = primaryKeyColumns.get(key) ?? new Set<string>();
		columns.add(row.column_name);
		primaryKeyColumns.set(key, columns);
		const ordered = primaryKeyByTable.get(key) ?? [];
		ordered.push(row.column_name);
		primaryKeyByTable.set(key, ordered);
		// The real constraint name, so dropping or replacing the key doesn't have to guess at
		// `<table>_pkey` — which is only what Postgres picks when nobody named it.
		primaryKeyNameByTable.set(key, row.constraint_name);
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
			comment: columnCommentByColumn.get(`${key}.${row.column_name}`),
			// The two shapes are separate: serial/bigserial carry the sequence in a nextval()
			// DEFAULT, while GENERATED … AS IDENTITY has no default at all and shows up only as
			// is_identity. Reading the default alone missed every identity column.
			autoIncrement: row.is_identity === 'YES' || /^nextval\(/i.test(row.column_default ?? '') || undefined,
			// GENERATED ALWAYS (an identity or a computed column): the database refuses a value.
			generatedAlways: row.identity_generation === 'ALWAYS' || row.is_generated === 'ALWAYS' || undefined,
			generatedAs: generatedByColumn.get(`${key}.${row.column_name}`),
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
		list.push({ name: row.trigger_name, timing: row.timing, event: row.events, statement: row.statement ?? undefined });
		triggersByTable.set(key, list);
	}

	const statsByTable = new Map<string, NonNullable<TableInfo['stats']>>();
	for (const row of statsRows) {
		statsByTable.set(tableKey(row.table_schema, row.table_name), {
			rowCount: row.row_count == null ? undefined : Number(row.row_count),
			dataBytes: row.data_bytes == null ? undefined : Number(row.data_bytes),
			indexBytes: row.index_bytes == null ? undefined : Number(row.index_bytes),
			totalBytes: row.total_bytes == null ? undefined : Number(row.total_bytes),
			liveTuples: row.live_tuples == null ? undefined : Number(row.live_tuples),
			deadTuples: row.dead_tuples == null ? undefined : Number(row.dead_tuples),
			seqScan: row.seq_scan == null ? undefined : Number(row.seq_scan),
			idxScan: row.idx_scan == null ? undefined : Number(row.idx_scan),
			lastVacuum: row.last_vacuum == null ? undefined : new Date(row.last_vacuum).getTime(),
			lastAutovacuum: row.last_autovacuum == null ? undefined : new Date(row.last_autovacuum).getTime(),
			lastAnalyze: row.last_analyze == null ? undefined : new Date(row.last_analyze).getTime(),
			lastAutoanalyze: row.last_autoanalyze == null ? undefined : new Date(row.last_autoanalyze).getTime(),
		});
	}

	// `public` exists on essentially every Postgres and is where an unqualified CREATE TABLE
	// lands, so the explorer shows it whether or not anything is in it yet. Gated on CREATE
	// rather than mere existence: a schema the user cannot put anything into is not the answer
	// to "where do I start", and on a locked-down database it would be a dead node.
	const emptySchemaResult = await pool.query(
		`SELECT n.nspname
		 FROM pg_namespace n
		 WHERE n.nspname = 'public' AND has_schema_privilege(n.oid, 'CREATE')`,
	);
	const emptySchemas: string[] = emptySchemaResult.rows.map((row: { nspname: string }) => row.nspname);

	const tables: TableInfo[] = tableRows.map((row) => {
		const key = tableKey(row.table_schema, row.table_name);
		const triggers = triggersByTable.get(key);
		const stats = statsByTable.get(key);
		return {
			name: row.table_name,
			schema: row.table_schema,
			kind: row.table_type === 'VIEW' ? 'view' : 'table',
			definition: row.table_type === 'VIEW' ? viewDefByTable.get(key) : undefined,
			columns: columnsByTable.get(key) ?? [],
			primaryKey: primaryKeyByTable.get(key) ?? [],
			primaryKeyName: primaryKeyNameByTable.get(key),
			foreignKeys: [...(foreignKeysByTable.get(key)?.values() ?? [])],
			indexes: [...(indexesByTable.get(key)?.values() ?? [])],
			triggers: triggers && triggers.length > 0 ? triggers : undefined,
			stats,
			comment: tableCommentByTable.get(key),
		};
	});

	// Partitions folded under their parents, and SnoutTime series tables (series.ts).
	const seriesRows = await readSeries((sql) => optionalQuery(pool, sql));
	const snouttime = attachSeries(tables, seriesRows);

	return {
		database: database ?? '(all schemas)',
		tables,
		routines: routines.length > 0 ? routines : undefined,
		emptySchemas: emptySchemas.length > 0 ? emptySchemas : undefined,
		snouttime: snouttime ? { version: snouttime } : undefined,
		snouttimeAvailable: !snouttime && seriesRows.available ? true : undefined,
		serverVersionNum,
		fetchedAt: Date.now(),
	};
}

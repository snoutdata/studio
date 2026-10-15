/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The statements a running move asks either database, and how their answers are read.
 *
 * Every one returns ONE JSON value, like `PG_FACTS_SQL`: a hosted endpoint is behind a front door
 * where round trips cost, and a host that can only run "a query and give me the first cell" (the
 * app's connection manager, `psql -At` in the CLI) can run all of them.
 */

import { quoteLiteral } from './pgFacts.js';
import { quoteIdent } from './replace.js';
import type { TableExclusion } from './spec.js';

export interface TableRef {
	readonly schema: string;
	readonly table: string;
}

export interface TableEstimate extends TableRef {
	/** `pg_table_size`: the heap and TOAST, not indexes. Close to what COPY carries (measured 875 MB on disk for 803 MB copied). */
	readonly bytes: number | null;
	readonly rows: number | null;
}

export interface CopyProgress extends TableRef {
	readonly command: string;
	readonly bytes: number;
	readonly rows: number;
}

export interface TableCount extends TableRef {
	/** Null when the table is not there at all. */
	readonly rows: number | null;
}

export interface SequenceValue {
	readonly schema: string;
	readonly name: string;
	/** Text, because a bigint does not survive a JSON number. Null when never called. */
	readonly lastValue: string | null;
}

function parsed(answer: unknown): unknown {
	return typeof answer === 'string' ? JSON.parse(answer) : answer;
}

function objects(answer: unknown): Record<string, unknown>[] {
	const value = parsed(answer);
	return Array.isArray(value)
		? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
		: [];
}

function numberOrNull(value: unknown): number | null {
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function inList(values: readonly string[]): string {
	return values.map(quoteLiteral).join(', ');
}

/** The tables a move copies rows from, with their size and estimated rows, for progress. */
export function pgTableSizesSql(schemas: readonly string[], excludeTables: readonly TableExclusion[]): string {
	if (schemas.length === 0) {
		return `select '[]'::json as tables`;
	}
	const excluded = excludeTables.map((exclusion) => `(n.nspname = ${quoteLiteral(exclusion.schema)} and c.relname = ${quoteLiteral(exclusion.table)})`);
	return `select coalesce(json_agg(json_build_object(
	'schema', n.nspname,
	'table', c.relname,
	'bytes', pg_table_size(c.oid),
	'rows', case when c.reltuples < 0 then null else c.reltuples::bigint end
) order by n.nspname, c.relname), '[]') as tables
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
	and n.nspname in (${inList(schemas)})
	and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')${excluded.length > 0 ? `\n\tand not (${excluded.join(' or ')})` : ''}`;
}

export function tableEstimatesFromPg(answer: unknown): TableEstimate[] {
	return objects(answer).flatMap((row) =>
		typeof row.schema === 'string' && typeof row.table === 'string'
			? [{ schema: row.schema, table: row.table, bytes: numberOrNull(row.bytes), rows: numberOrNull(row.rows) }]
			: []
	);
}

/** Every COPY running in this database right now (Postgres 14+). Visible to the same role (measured, both ends). */
export const PG_COPY_PROGRESS_SQL = `select coalesce(json_agg(json_build_object(
	'schema', n.nspname,
	'table', c.relname,
	'command', p.command,
	'bytes', p.bytes_processed,
	'rows', p.tuples_processed
)), '[]') as copies
from pg_stat_progress_copy p
join pg_class c on c.oid = p.relid
join pg_namespace n on n.oid = c.relnamespace
where p.datname = current_database()`;

export function copyProgressFromPg(answer: unknown): CopyProgress[] {
	return objects(answer).flatMap((row) =>
		typeof row.schema === 'string' && typeof row.table === 'string'
			? [
					{
						schema: row.schema,
						table: row.table,
						command: typeof row.command === 'string' ? row.command : '',
						bytes: numberOrNull(row.bytes) ?? 0,
						rows: numberOrNull(row.rows) ?? 0
					}
				]
			: []
	);
}

/**
 * Exact row counts, in one statement, tolerating tables that are not there: `to_regclass` guards
 * each count and `query_to_xml` runs it, so a table that failed to restore is a null rather than
 * an error that loses every other count.
 */
export function pgRowCountsSql(tables: readonly TableRef[]): string {
	if (tables.length === 0) {
		return `select '[]'::json as counts`;
	}
	const values = tables.map((table) => `(${quoteLiteral(table.schema)}, ${quoteLiteral(table.table)})`).join(',\n\t');
	return `select json_agg(json_build_object(
	'schema', v.s,
	'table', v.t,
	'rows', case when to_regclass(format('%I.%I', v.s, v.t)) is null then null
		else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', v.s, v.t), false, true, '')))[1]::text::bigint end
)) as counts
from (values
	${values}
) as v(s, t)`;
}

export function tableCountsFromPg(answer: unknown): TableCount[] {
	return objects(answer).flatMap((row) =>
		typeof row.schema === 'string' && typeof row.table === 'string'
			? [{ schema: row.schema, table: row.table, rows: numberOrNull(row.rows) }]
			: []
	);
}

export function pgSequencesSql(schemas: readonly string[]): string {
	if (schemas.length === 0) {
		return `select '[]'::json as sequences`;
	}
	return `select coalesce(json_agg(json_build_object(
	'schema', schemaname,
	'name', sequencename,
	'lastValue', last_value::text
) order by schemaname, sequencename), '[]') as sequences
from pg_sequences
where schemaname in (${inList(schemas)})`;
}

export function sequencesFromPg(answer: unknown): SequenceValue[] {
	return objects(answer).flatMap((row) =>
		typeof row.schema === 'string' && typeof row.name === 'string'
			? [{ schema: row.schema, name: row.name, lastValue: typeof row.lastValue === 'string' ? row.lastValue : null }]
			: []
	);
}

/** `CREATE DATABASE` cannot run inside a transaction block, so this is always its own statement. */
export function createDatabaseSql(name: string): string {
	return `create database ${quoteIdent(name)}`;
}

/** Split a list into pieces, so one statement never names ten thousand tables. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		out.push(items.slice(index, index + size));
	}
	return out;
}

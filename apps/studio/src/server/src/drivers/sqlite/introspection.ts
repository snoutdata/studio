/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'node:path';

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, TableInfo, TriggerInfo } from '../../../../shared/schema';

/**
 * Runs one read-only catalog query and yields its rows as plain objects (named columns).
 * Injectable so the unit test can feed canned `sqlite_master` / PRAGMA rows without a live file;
 * the driver supplies a runner backed by node:sqlite's synchronous `prepare(...).all()`.
 */
export type SqliteRowRunner = (sql: string) => Promise<Record<string, unknown>[]>;

interface MasterRow {
	name: string;
	type: string;
	sql: string | null;
	tbl_name?: string;
}

interface TableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

interface ForeignKeyRow {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string | null;
}

interface IndexListRow {
	seq: number;
	name: string;
	unique: number;
	origin: string;
	partial: number;
}

interface IndexInfoRow {
	seqno: number;
	cid: number;
	name: string | null;
}

/** Quote a SQLite identifier for interpolation into a PRAGMA (PRAGMA args can't be bound params). */
function quote(name: string): string {
	return '"' + name.replace(/"/g, '""') + '"';
}

/** 32-bit FNV-1a over a string — used to fold the structural fingerprint client-side (SQLite has
 *  no portable hash function in plain SQL). */
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// hash *= 16777619, kept in 32-bit range via Math.imul.
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Cheap structural fingerprint: a count plus an order-independent sum of FNV-1a over each
 * schema object's `type:name:sql`. SQLite stores every table/view/index/trigger's CREATE text
 * in `sqlite_master.sql`, and ALTER rewrites it, so any DDL change (add/drop/rename/retype)
 * moves the fingerprint — the live schema index detects it with one query.
 */
export async function sqliteStructuralDigest(run: SqliteRowRunner): Promise<string> {
	const rows = await run(
		`SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master
		 WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
	) as unknown as MasterRow[];
	let acc = 0;
	for (const row of rows) {
		acc = (acc + fnv1a(`${row.type}:${row.name}:${row.sql ?? ''}`)) >>> 0;
	}
	return `${rows.length}:${acc}`;
}

/** Parse a trigger's timing + event out of its CREATE TRIGGER text (SQLite has no catalog columns
 *  for these). Best-effort: an unparseable body still carries its full `statement`. */
function parseTrigger(name: string, sql: string | null): TriggerInfo {
	const text = sql ?? '';
	const timing = /\bINSTEAD\s+OF\b/i.test(text) ? 'INSTEAD OF'
		: /\bBEFORE\b/i.test(text) ? 'BEFORE'
		: /\bAFTER\b/i.test(text) ? 'AFTER'
		: '';
	const event = /\bDELETE\b/i.test(text) ? 'DELETE'
		: /\bINSERT\b/i.test(text) ? 'INSERT'
		: /\bUPDATE\b/i.test(text) ? 'UPDATE'
		: '';
	return { name, timing, event, statement: sql ?? undefined };
}

/**
 * Introspect a SQLite database into the shared schema shape. SQLite has no schemas, so every
 * object lives in one flat namespace; `schema` is left unset on each table. Tables/views come
 * from `sqlite_master`; columns, PKs, FKs and indexes come from the `PRAGMA table_info` /
 * `foreign_key_list` / `index_list` / `index_info` introspection pragmas. SQLite has no stored
 * routines, so `routines` is always undefined.
 */
export async function introspectSqlite(run: SqliteRowRunner, filePath: string | undefined, includeViews: boolean): Promise<DatabaseSchema> {
	const types = includeViews ? "('table', 'view')" : "('table')";
	const masterRows = await run(
		`SELECT name, type, sql FROM sqlite_master
		 WHERE type IN ${types} AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
		 ORDER BY name`,
	) as unknown as MasterRow[];

	// Build each table's columns/PK first so a foreign key with an implicit referenced column
	// (PRAGMA reports `to` as null when the FK targets the parent's PK) can be filled in after.
	const primaryKeyByTable = new Map<string, string[]>();
	const partials: { row: MasterRow; columns: ColumnInfo[]; foreignKeys: ForeignKeyInfo[]; indexes: IndexInfo[] }[] = [];

	for (const row of masterRows) {
		const columnRows = await run(`PRAGMA table_info(${quote(row.name)})`) as unknown as TableInfoRow[];
		const columns: ColumnInfo[] = columnRows.map((c) => ({
			name: c.name,
			dataType: c.type ?? '',
			nullable: c.notnull === 0,
			isPrimaryKey: c.pk > 0,
			default: c.dflt_value,
			comment: undefined,
		}));
		const primaryKey = columnRows
			.filter((c) => c.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name);
		primaryKeyByTable.set(row.name, primaryKey);

		// Foreign keys: PRAGMA emits one row per (constraint, column); group by `id`. SQLite FKs
		// are anonymous, so synthesise a stable constraint name from the table + group id.
		const fkRows = row.type === 'table' ? await run(`PRAGMA foreign_key_list(${quote(row.name)})`) as unknown as ForeignKeyRow[] : [];
		const fkById = new Map<number, ForeignKeyInfo>();
		for (const fk of fkRows.slice().sort((a, b) => a.id - b.id || a.seq - b.seq)) {
			const existing = fkById.get(fk.id) ?? { constraintName: `fk_${row.name}_${fk.id}`, columns: [], referencedTable: fk.table, referencedColumns: [] };
			existing.columns.push(fk.from);
			existing.referencedColumns.push(fk.to ?? '');
			fkById.set(fk.id, existing);
		}

		// Secondary indexes: skip the auto-created primary-key index (origin 'pk' — carried in
		// primaryKey already). Each index's columns come from PRAGMA index_info, in key order.
		const indexListRows = row.type === 'table' ? await run(`PRAGMA index_list(${quote(row.name)})`) as unknown as IndexListRow[] : [];
		const indexes: IndexInfo[] = [];
		for (const idx of indexListRows.filter((i) => i.origin !== 'pk').sort((a, b) => a.seq - b.seq)) {
			const infoRows = await run(`PRAGMA index_info(${quote(idx.name)})`) as unknown as IndexInfoRow[];
			const cols = infoRows.slice().sort((a, b) => a.seqno - b.seqno).map((c) => c.name).filter((n): n is string => n !== null);
			indexes.push({ name: idx.name, columns: cols, unique: idx.unique === 1 });
		}

		partials.push({ row, columns, foreignKeys: [...fkById.values()], indexes });
	}

	const triggerRows = await run(
		`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
	) as unknown as MasterRow[];
	const triggersByTable = new Map<string, TriggerInfo[]>();
	for (const trig of triggerRows) {
		const owner = trig.tbl_name ?? '';
		const list = triggersByTable.get(owner) ?? [];
		list.push(parseTrigger(trig.name, trig.sql));
		triggersByTable.set(owner, list);
	}

	const tables: TableInfo[] = partials.map(({ row, columns, foreignKeys, indexes }) => {
		// Fill any implicit FK referenced columns (PRAGMA `to` = null) from the parent table's PK.
		for (const fk of foreignKeys) {
			const parentPk = primaryKeyByTable.get(fk.referencedTable);
			fk.referencedColumns = fk.referencedColumns.map((col, i) => col || parentPk?.[i] || col);
		}
		const triggers = triggersByTable.get(row.name);
		return {
			name: row.name,
			kind: row.type === 'view' ? 'view' : 'table',
			definition: row.type === 'view' ? (row.sql ?? undefined) : undefined,
			columns,
			primaryKey: primaryKeyByTable.get(row.name) ?? [],
			foreignKeys,
			indexes,
			triggers: triggers && triggers.length > 0 ? triggers : undefined,
			comment: undefined,
		};
	});

	return {
		database: filePath ? basename(filePath) : 'SQLite',
		tables,
		fetchedAt: Date.now(),
	};
}

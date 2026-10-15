/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The destination's schema, as the reviewer needs to see it.
 *
 *  Deliberately a SUBSET, and deliberately structural: SnoutData's own `DatabaseSchema`
 *  (apps/studio/src/shared/schema.ts) satisfies these types as-is, so the desktop hands its
 *  introspected schema straight in with no adapter, while any other host (a CI runner, a
 *  service of its own) builds the same shape from its own introspection. Everything the reviewer does not
 *  read is left out rather than duplicated, so the two definitions cannot drift into disagreement
 *  about a field that matters.
 *--------------------------------------------------------------------------------------------*/

export interface ColumnInfo {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	default?: string | null;
	autoIncrement?: boolean;
}

export interface ForeignKeyInfo {
	constraintName: string;
	columns: string[];
	referencedTable: string;
	referencedColumns: string[];
}

export interface IndexInfo {
	name: string;
	/** Indexed columns, in key order — order is what decides whether one index covers another. */
	columns: string[];
	unique: boolean;
}

export interface TriggerInfo {
	name: string;
	timing: string;
	event: string;
	statement?: string;
}

export interface RoutineInfo {
	name: string;
	schema: string;
	kind: 'procedure' | 'function';
	definition?: string;
}

/** Approximate catalog statistics. Approximate is enough: every use is a threshold. */
export interface TableStats {
	rowCount?: number;
	dataBytes?: number;
	indexBytes?: number;
	engine?: string;
}

export interface TableInfo {
	name: string;
	schema?: string;
	kind: 'table' | 'view' | 'collection' | 'index';
	/** A view's SELECT, when introspection captured it — how we know a drop breaks a view. */
	definition?: string;
	columns: ColumnInfo[];
	primaryKey: string[];
	foreignKeys: ForeignKeyInfo[];
	indexes?: IndexInfo[];
	triggers?: TriggerInfo[];
	stats?: TableStats;
}

export interface DatabaseSchema {
	database: string;
	tables: TableInfo[];
	routines?: RoutineInfo[];
	/** Epoch ms of introspection. Reported with every schema-derived finding, because a finding
	 *  from a stale schema is a guess and the reader is entitled to know how old it is. */
	fetchedAt: number;
}

/** Case-insensitive table lookup — vendors disagree about identifier folding, reviewers should
 *  not. Matches on the bare name; a schema-qualified `sales.orders` matches table `orders` in
 *  schema `sales` and, failing that, any table named `orders`. */
export function findTable(schema: DatabaseSchema | undefined, name: string): TableInfo | undefined {
	if (!schema || name === '') {
		return undefined;
	}
	const dot = name.lastIndexOf('.');
	const bare = (dot === -1 ? name : name.slice(dot + 1)).toLowerCase();
	const qualifier = dot === -1 ? '' : name.slice(0, dot).toLowerCase();
	let loose: TableInfo | undefined;
	for (const table of schema.tables) {
		if (table.name.toLowerCase() !== bare) {
			continue;
		}
		if (qualifier !== '' && (table.schema ?? '').toLowerCase() === qualifier) {
			return table;
		}
		loose = loose ?? table;
	}
	return loose;
}

/** Case-insensitive column lookup within a table. */
export function findColumn(table: TableInfo | undefined, name: string): ColumnInfo | undefined {
	if (!table) {
		return undefined;
	}
	const want = name.toLowerCase();
	return table.columns.find((c) => c.name.toLowerCase() === want);
}

/** Every index on the table INCLUDING the primary key, expressed as one. Rules that ask "is
 *  this column indexed" mean the PK too, and `TableInfo.indexes` deliberately excludes it. */
export function allIndexes(table: TableInfo): IndexInfo[] {
	const out: IndexInfo[] = [];
	if (table.primaryKey.length > 0) {
		out.push({ name: 'PRIMARY', columns: [...table.primaryKey], unique: true });
	}
	for (const index of table.indexes ?? []) {
		out.push(index);
	}
	return out;
}

/** True when some index has `columns` as a LEADING prefix — the only position that lets a
 *  b-tree serve a lookup on them. An index on (a, b) serves a; an index on (b, a) does not. */
export function hasLeadingIndex(table: TableInfo, columns: string[]): boolean {
	if (columns.length === 0) {
		return false;
	}
	const want = columns.map((c) => c.toLowerCase());
	return allIndexes(table).some((index) => {
		if (index.columns.length < want.length) {
			return false;
		}
		return want.every((c, i) => index.columns[i].toLowerCase() === c);
	});
}

/** The index whose leading columns are exactly `columns`, if any — used to report the index
 *  that already does the job a new one is asking for. */
export function coveringIndex(table: TableInfo, columns: string[]): IndexInfo | undefined {
	const want = columns.map((c) => c.toLowerCase());
	return allIndexes(table).find(
		(index) => index.columns.length >= want.length && want.every((c, i) => index.columns[i].toLowerCase() === c),
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { markdownCode, markdownText } from '../../../shared/markdownEscape';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../shared/schema';

/** A table together with the database/schema it effectively belongs to. */
export interface IndexedTable {
	table: TableInfo;
	database: string;
}

/** Case-insensitive lookups over the cached schemas, for completion and hover. */
export interface SchemaIndex {
	readonly tables: IndexedTable[];
	readonly databases: string[];
	/** All tables matching a name, across databases. */
	findByName(name: string): IndexedTable[];
	/** A single table by name, preferring one in `database` when given. */
	find(name: string, database?: string): IndexedTable | undefined;
	/** Tables in a database/schema. */
	inDatabase(database: string): IndexedTable[];
}

export function buildSchemaIndex(schemas: DatabaseSchema[]): SchemaIndex {
	const tables: IndexedTable[] = [];
	for (const schema of schemas) {
		for (const table of schema.tables) {
			tables.push({ table, database: table.schema ?? schema.database });
		}
	}

	const byName = new Map<string, IndexedTable[]>();
	for (const entry of tables) {
		const key = entry.table.name.toLowerCase();
		const list = byName.get(key) ?? [];
		list.push(entry);
		byName.set(key, list);
	}
	const databases = [...new Set(tables.map((entry) => entry.database))].sort((a, b) => a.localeCompare(b));

	return {
		tables,
		databases,
		findByName: (name) => byName.get(name.toLowerCase()) ?? [],
		find: (name, database) => {
			const matches = byName.get(name.toLowerCase()) ?? [];
			if (!database) {
				return matches[0];
			}
			return matches.find((entry) => entry.database.toLowerCase() === database.toLowerCase()) ?? matches[0];
		},
		inDatabase: (database) => tables.filter((entry) => entry.database.toLowerCase() === database.toLowerCase()),
	};
}

export function findColumn(table: TableInfo, name: string): ColumnInfo | undefined {
	return table.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
}

/** A foreign-key join from a source table to a related table, with its condition. */
export interface JoinEdge {
	target: IndexedTable;
	/** Column pairs: `source.from = target.to`. */
	on: Array<{ from: string; to: string }>;
	/** True when derived by naming convention rather than a declared FK constraint. */
	inferred?: boolean;
}

/**
 * FK relationships involving `source`, in both directions: outgoing (source's own
 * FKs → referenced tables) and incoming (other tables whose FKs reference source).
 * Drives FK-derived JOIN suggestions (ROADMAP phase d).
 */
export function joinEdges(source: IndexedTable, index: SchemaIndex): JoinEdge[] {
	const edges: JoinEdge[] = [];
	for (const fk of source.table.foreignKeys) {
		const target = index.findByName(fk.referencedTable)[0];
		if (target) {
			edges.push({ target, on: fk.columns.map((col, i) => ({ from: col, to: fk.referencedColumns[i] ?? fk.referencedColumns[0] })) });
		}
	}
	for (const candidate of index.tables) {
		if (candidate === source) {
			continue;
		}
		for (const fk of candidate.table.foreignKeys) {
			if (fk.referencedTable.toLowerCase() === source.table.name.toLowerCase()) {
				edges.push({ target: candidate, on: fk.columns.map((col, i) => ({ from: fk.referencedColumns[i] ?? fk.referencedColumns[0], to: col })) });
			}
		}
	}
	return edges;
}

/**
 * Convention-based JOIN suggestions for schemas that omit FK constraints: a column
 * named `<x>_id` is matched to a table named `<x>` (modulo simple pluralization) whose
 * key it could reference, when the column types agree. Surfaced in both directions like
 * {@link joinEdges} and marked `inferred` so callers can rank them below declared FKs.
 */
export function inferredJoinEdges(source: IndexedTable, index: SchemaIndex): JoinEdge[] {
	const edges: JoinEdge[] = [];

	// Outgoing: the source's own `<x>_id` columns → a table named <x>.
	for (const column of source.table.columns) {
		const base = fkColumnBase(column.name);
		if (!base) {
			continue;
		}
		const target = index.tables.find((entry) => entry !== source && namesMatch(base, entry.table.name));
		if (!target) {
			continue;
		}
		const to = referencedColumn(target);
		if (to && typesJoinable(column, findColumn(target.table, to))) {
			edges.push({ target, on: [{ from: column.name, to }], inferred: true });
		}
	}

	// Incoming: other tables' `<source>_id` columns → the source's key.
	const sourceKey = referencedColumn(source);
	const sourceKeyColumn = sourceKey ? findColumn(source.table, sourceKey) : undefined;
	if (sourceKey && sourceKeyColumn) {
		for (const candidate of index.tables) {
			if (candidate === source) {
				continue;
			}
			for (const column of candidate.table.columns) {
				const base = fkColumnBase(column.name);
				if (base && namesMatch(base, source.table.name) && typesJoinable(column, sourceKeyColumn)) {
					edges.push({ target: candidate, on: [{ from: sourceKey, to: column.name }], inferred: true });
				}
			}
		}
	}

	return edges;
}

/** The base of an `<x>_id` foreign-key-style column name, or undefined if it isn't one. */
function fkColumnBase(name: string): string | undefined {
	const match = /^(.+)_id$/i.exec(name);
	return match ? match[1] : undefined;
}

/** The column an inferred FK would point at: a single-column PK, else a column named `id`. */
function referencedColumn(entry: IndexedTable): string | undefined {
	if (entry.table.primaryKey.length === 1) {
		return entry.table.primaryKey[0];
	}
	return findColumn(entry.table, 'id')?.name;
}

/** `posts` → `post`, `categories` → `category`; good enough for FK-name matching. */
function singularize(name: string): string {
	return name.replace(/ies$/i, 'y').replace(/([^s])s$/i, '$1');
}

/** Two identifiers naming the same entity up to trivial pluralization. */
function namesMatch(a: string, b: string): boolean {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	return la === lb || singularize(la) === singularize(lb);
}

/** A column's type without length/modifier noise, for loose comparison. */
function baseType(dataType: string): string {
	return dataType.toLowerCase().split('(')[0].replace(/unsigned|zerofill/g, '').trim();
}

/** Whether two columns could plausibly be joined (same base type, or both integral). */
function typesJoinable(a: ColumnInfo | undefined, b: ColumnInfo | undefined): boolean {
	if (!a || !b) {
		return false;
	}
	const ta = baseType(a.dataType);
	const tb = baseType(b.dataType);
	return ta === tb || (ta.includes('int') && tb.includes('int'));
}

/** The escapers live in shared, since the engine catalog's docs need them too; re-exported for the
 *  server code that has always imported them from here. */
export { markdownCode, markdownText };

/** Markdown detail for a column: type, nullability, PK, FK target, default, comment. */
export function describeColumn(entry: IndexedTable, column: ColumnInfo): string {
	const lines = [`**${markdownText(entry.table.name)}.${markdownText(column.name)}**`];
	const flags = [markdownCode(column.dataType), column.nullable ? 'NULL' : 'NOT NULL'];
	if (column.isPrimaryKey) {
		flags.push('PK');
	}
	if (column.sortKey === 'primary') {
		flags.push('sort key, in the primary index');
	} else if (column.sortKey === 'sort') {
		flags.push('sort key');
	}
	lines.push(flags.join(' · '));

	const fk = entry.table.foreignKeys.find((key) => key.columns.includes(column.name));
	if (fk) {
		const referenced = fk.referencedColumns[fk.columns.indexOf(column.name)] ?? fk.referencedColumns[0];
		lines.push(`→ ${markdownCode(`${fk.referencedTable}.${referenced}`)}`);
	}
	if (column.default !== undefined && column.default !== null) {
		lines.push(`default: ${markdownCode(String(column.default))}`);
	}
	if (column.codec) {
		lines.push(`codec: ${markdownCode(column.codec)}`);
	}
	if (column.storedBytes) {
		const { compressed, uncompressed } = column.storedBytes;
		const ratio = compressed > 0 ? ` (${(uncompressed / compressed).toFixed(1)}x)` : '';
		lines.push(`on disk: ${formatBytes(compressed)} compressed, ${formatBytes(uncompressed)} raw${ratio}`);
	}
	if (column.comment) {
		lines.push(markdownText(column.comment));
	}
	return lines.join('\n\n');
}

function formatBytes(n: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Markdown detail for a table: kind, column count, PK, comment. */
export function describeTable(entry: IndexedTable): string {
	const lines = [
		`**${markdownText(entry.database)}.${markdownText(entry.table.name)}** _(${entry.table.kind})_`,
		`${entry.table.columns.length} columns`,
	];
	if (entry.table.primaryKey.length) {
		lines.push(`PK: ${markdownText(entry.table.primaryKey.join(', '))}`);
	}
	if (entry.table.stats?.engine) {
		lines.push(`engine: ${markdownCode(entry.table.stats.engine)}`);
	}
	if (entry.table.comment) {
		lines.push(markdownText(entry.table.comment));
	}
	return lines.join('\n\n');
}

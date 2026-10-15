/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ClickHouse DDL emitter.
 *
 *  A ClickHouse table is not columns plus keys: it is an ENGINE with an ORDER BY (and often a
 *  PARTITION BY, a TTL and SETTINGS). So a table the source introspected with its own CREATE
 *  statement is copied from that statement, and only a table described by columns alone (a Data
 *  Flow's destination) is written out, as a MergeTree ordered by its key, or by nothing.
 *
 *  Nullability is part of the TYPE here (`Nullable(String)`), not a clause. Foreign keys, triggers
 *  and routines do not exist, so those changes emit nothing. A primary key cannot be changed on an
 *  existing table (it is the sort order of the data on disk), which throws rather than pretend.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../index';
import type { ColumnInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('clickhouse').quoteIdent;

/** Types that cannot be wrapped in Nullable(): composites, and anything already nullable. */
function canWrapNullable(type: string): boolean {
	return !/^(Nullable|LowCardinality\(Nullable|Array|Map|Tuple|Nested|Object|JSON|Variant|Dynamic)\b/i.test(type.trim());
}

/** The column's type with its nullability folded in: wrapped in `Nullable(...)` when it should be
 *  and is not, unwrapped when it should not be and is (the designer's "nullable" box unticked on a
 *  column introspected as `Nullable(String)`). */
export function clickhouseColumnType(column: ColumnInfo): string {
	const type = column.dataType.trim();
	if (column.nullable) {
		return canWrapNullable(type) ? `Nullable(${type})` : type;
	}
	const low = /^LowCardinality\(Nullable\((.*)\)\)$/i.exec(type);
	if (low) {
		return `LowCardinality(${low[1]})`;
	}
	const plain = /^Nullable\((.*)\)$/i.exec(type);
	return plain ? plain[1] : type;
}

function columnDef(column: ColumnInfo): string {
	let def = `${q(column.name)} ${clickhouseColumnType(column)}`;
	if (column.default !== null && column.default !== undefined && column.default !== '') {
		def += ` DEFAULT ${column.default}`;
	}
	if (column.comment) {
		def += ` COMMENT '${column.comment.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
	}
	return def;
}

/** A skip index. One that came from ClickHouse carries its TYPE; one a flow asks for does not, and
 *  gets a bloom filter, which answers the equality lookups such an index is usually wanted for. */
function indexDef(index: IndexInfo): string {
	const expr = index.columns.length === 1 ? index.columns[0] : `(${index.columns.map(q).join(', ')})`;
	return `INDEX ${q(index.name)} ${expr} TYPE ${index.method ?? 'bloom_filter GRANULARITY 1'}`;
}

/** Drop `<db>.` qualifiers from a statement the source database wrote about itself. */
function stripQualifiers(sql: string, databases: readonly string[]): string {
	let out = sql;
	for (const db of databases) {
		if (!db) {
			continue;
		}
		const escaped = db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp('`' + escaped + '`\\s*\\.\\s*', 'g'), '');
		out = out.replace(new RegExp('\\b' + escaped + '\\s*\\.\\s*', 'g'), '');
	}
	return out;
}

function createTable(table: TableInfo, sourceDatabases: readonly string[]): string {
	if (table.createStatement) {
		return stripQualifiers(table.createStatement, [...sourceDatabases, table.schema ?? '']);
	}
	// A sort-key column cannot be Nullable (ClickHouse refuses a nullable key by default), so a key
	// column is written with its plain type whatever the source said.
	const keys = new Set(table.primaryKey.map((name) => name.toLowerCase()));
	const lines = table.columns.map((column) => columnDef(keys.has(column.name.toLowerCase()) ? { ...column, nullable: false } : column));
	for (const index of table.indexes ?? []) {
		lines.push(indexDef(index));
	}
	const key = table.primaryKey.length > 0 ? `(${table.primaryKey.map(q).join(', ')})` : 'tuple()';
	let sql = `CREATE TABLE ${q(table.name)} (\n\t${lines.join(',\n\t')}\n) ENGINE = MergeTree ORDER BY ${key}`;
	if (table.comment) {
		sql += ` COMMENT '${table.comment.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
	}
	return sql;
}

export class ClickHouseEmitter implements DdlEmitter {
	readonly driverId = 'clickhouse';

	constructor(private readonly sourceDatabases: readonly string[] = []) { }

	emit(change: SchemaChange): string[] {
		switch (change.kind) {
			case 'addTable':
				return [createTable(change.table, this.sourceDatabases)];
			case 'dropTable':
				return [`DROP TABLE ${q(change.table.name)}`];
			case 'addColumn':
				return [`ALTER TABLE ${q(change.table)} ADD COLUMN ${columnDef(change.column)}`];
			case 'alterColumn': {
				// MODIFY COLUMN restates type, nullability and default together, but one WITHOUT a
				// default keeps the old one, so clearing it takes its own statement.
				const stmts = [`ALTER TABLE ${q(change.table)} MODIFY COLUMN ${columnDef(change.after)}`];
				const hadDefault = change.before.default !== null && change.before.default !== undefined && change.before.default !== '';
				const hasDefault = change.after.default !== null && change.after.default !== undefined && change.after.default !== '';
				if (hadDefault && !hasDefault) {
					stmts.push(`ALTER TABLE ${q(change.table)} MODIFY COLUMN ${q(change.after.name)} REMOVE DEFAULT`);
				}
				return stmts;
			}
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column.name)}`];
			case 'setPrimaryKey':
				throw new Error(`ClickHouse cannot change the primary key of "${change.table}": it is the order the data is stored in. Create a new table with the new ORDER BY and copy the rows into it.`);
			case 'addIndex':
				return [`ALTER TABLE ${q(change.table)} ADD ${indexDef(change.index)}`];
			case 'dropIndex':
				return [`ALTER TABLE ${q(change.table)} DROP INDEX ${q(change.index.name)}`];
			case 'replaceIndex':
				return [`ALTER TABLE ${q(change.table)} DROP INDEX ${q(change.before.name)}`, `ALTER TABLE ${q(change.table)} ADD ${indexDef(change.after)}`];
			case 'addForeignKey':
			case 'dropForeignKey':
			case 'replaceForeignKey':
			case 'addTrigger':
			case 'dropTrigger':
			case 'replaceTrigger':
			case 'addRoutine':
			case 'dropRoutine':
			case 'replaceRoutine':
				return [];
			case 'addView':
			case 'replaceView': {
				const view = change.kind === 'addView' ? change.view : change.after;
				if (view.createStatement) {
					const body = stripQualifiers(view.createStatement, [...this.sourceDatabases, view.schema ?? '']);
					return change.kind === 'replaceView' ? [`DROP VIEW IF EXISTS ${q(view.name)}`, body] : [body];
				}
				const select = stripQualifiers(view.definition ?? '', [...this.sourceDatabases, view.schema ?? '']);
				return [`CREATE OR REPLACE VIEW ${q(view.name)} AS ${select}`];
			}
			case 'dropView':
				return [`DROP VIEW IF EXISTS ${q(change.view.name)}`];
		}
	}
}

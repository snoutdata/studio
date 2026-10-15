/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  SQLite DDL emitter.
 *
 *  SQLite's ALTER TABLE is deliberately minimal: it can RENAME, ADD COLUMN and DROP COLUMN, but
 *  it CANNOT change a column's type/nullability/default, change the primary key, or add/drop a
 *  foreign key in place — those require the documented twelve-step table rebuild, which this
 *  emitter does not generate. Such changes throw a clear error (buildSchemaPlan surfaces it) rather
 *  than emit SQL that would fail or silently do the wrong thing.
 *
 *  Because a foreign key cannot be added after the fact, a brand-new table carries its foreign keys
 *  INLINE in CREATE TABLE. The diff still splits them into separate addForeignKey changes, but the
 *  ordering pass guarantees every addTable precedes every addForeignKey, so the emitter tracks the
 *  tables it just created and treats their addForeignKey changes as already-satisfied no-ops.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../index';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('sqlite').quoteIdent;

function unsupported(what: string): never {
	throw new Error(`SQLite can't ${what} in place (it requires a full table rebuild, which schema sync does not yet generate for SQLite).`);
}

function columnDef(column: ColumnInfo): string {
	let def = q(column.name);
	if (column.dataType) {
		def += ` ${column.dataType}`;
	}
	def += column.nullable ? '' : ' NOT NULL';
	if (column.default !== null && column.default !== undefined) {
		def += ` DEFAULT ${column.default}`;
	}
	return def;
}

function foreignKeyClause(fk: ForeignKeyInfo): string {
	return `FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.referencedTable)} (${fk.referencedColumns.map(q).join(', ')})`;
}

function createIndex(table: string, index: IndexInfo): string {
	return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${q(table)} (${index.columns.map(q).join(', ')})`;
}

function createTable(table: TableInfo): string {
	const lines = table.columns.map(columnDef);
	if (table.primaryKey.length > 0) {
		lines.push(`PRIMARY KEY (${table.primaryKey.map(q).join(', ')})`);
	}
	// Foreign keys ride inline: SQLite can't ADD one to an existing table afterwards.
	for (const fk of table.foreignKeys) {
		lines.push(foreignKeyClause(fk));
	}
	return `CREATE TABLE ${q(table.name)} (\n\t${lines.join(',\n\t')}\n)`;
}

export class SqliteEmitter implements DdlEmitter {
	readonly driverId = 'sqlite';

	// Tables created earlier in THIS plan; their foreign keys were emitted inline by createTable,
	// so the later (separately-modelled) addForeignKey change for them is a no-op.
	private readonly newTables = new Set<string>();

	// Views/triggers carry their full CREATE text in `definition` / `statement` (SQLite stores it
	// verbatim in sqlite_master). sourceSchemas is unused — SQLite has no schema qualifiers.
	constructor(_sourceSchemas: readonly string[] = []) { }

	emit(change: SchemaChange): string[] {
		switch (change.kind) {
			case 'addTable':
				this.newTables.add(change.table.name);
				return [createTable(change.table)];
			case 'dropTable':
				return [`DROP TABLE ${q(change.table.name)}`];
			case 'addColumn':
				return [`ALTER TABLE ${q(change.table)} ADD COLUMN ${columnDef(change.column)}`];
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column.name)}`];
			case 'alterColumn':
				return unsupported(`alter column "${change.table}"."${change.after.name}"`);
			case 'setPrimaryKey':
				return unsupported(`change the primary key of "${change.table}"`);
			case 'addForeignKey':
				// Inline on a table this plan just created; otherwise SQLite can't add it in place.
				return this.newTables.has(change.table) ? [] : unsupported(`add a foreign key to "${change.table}"`);
			case 'dropForeignKey':
				return unsupported(`drop a foreign key from "${change.table}"`);
			case 'replaceForeignKey':
				return unsupported(`change a foreign key on "${change.table}"`);
			case 'addIndex':
				return [createIndex(change.table, change.index)];
			case 'dropIndex':
				return [`DROP INDEX ${q(change.index.name)}`];
			case 'replaceIndex':
				return [`DROP INDEX ${q(change.before.name)}`, createIndex(change.table, change.after)];
			case 'addTrigger':
				return change.trigger.statement ? [change.trigger.statement] : [];
			case 'replaceTrigger':
				return change.after.statement
					? [`DROP TRIGGER IF EXISTS ${q(change.after.name)}`, change.after.statement]
					: [];
			case 'dropTrigger':
				return [`DROP TRIGGER IF EXISTS ${q(change.trigger.name)}`];
			case 'addView': {
				// definition is the full CREATE VIEW text from sqlite_master.
				return change.view.definition ? [change.view.definition] : [];
			}
			case 'replaceView':
				return change.after.definition
					? [`DROP VIEW IF EXISTS ${q(change.after.name)}`, change.after.definition]
					: [];
			case 'dropView':
				return [`DROP VIEW IF EXISTS ${q(change.view.name)}`];
			case 'addRoutine':
			case 'dropRoutine':
			case 'replaceRoutine':
				// SQLite has no stored routines, so introspection never produces these changes.
				return [];
		}
	}
}

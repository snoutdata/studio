/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  MySQL / Aurora DDL emitter.
 *
 *  Object names are emitted UNQUALIFIED (no database prefix) so the statements apply against
 *  the target connection's current database. Trigger/view/routine bodies are introspected
 *  fully qualified with the SOURCE database name, so that qualifier is stripped before
 *  emitting; anything the stripping misses surfaces as an apply error the AI-fix path handles.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../index';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('mysql-aurora').quoteIdent;

/** Remove `\`sourcedb\`.` and bare `sourcedb.` prefixes so a body targets the current database. */
function stripQualifiers(sql: string, schemas: readonly string[]): string {
	let out = sql;
	for (const schema of schemas) {
		if (!schema) {
			continue;
		}
		const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp('`' + escaped + '`\\s*\\.\\s*', 'g'), '');
		out = out.replace(new RegExp('\\b' + escaped + '\\s*\\.\\s*', 'g'), '');
	}
	return out;
}

// This emitter used to GUESS whether a default needed quotes (numeric? CURRENT_TIMESTAMP?
// parenthesised? otherwise quote it), because MySQL introspection handed it bare catalog values
// where every other driver handed it a SQL expression. That guess is gone: `ColumnInfo.default`
// is now contractually an expression, normalised by `mysqlDefaultExpression` at the source, so
// this file passes it through exactly like the Postgres/Oracle/Db2 emitters do. Do not re-add
// quoting here — it would double-quote a value that arrives already quoted.

function columnDef(column: ColumnInfo): string {
	let def = `${q(column.name)} ${column.dataType}`;
	def += column.nullable ? ' NULL' : ' NOT NULL';
	if (column.default !== null && column.default !== undefined) {
		def += ` DEFAULT ${column.default}`;
	}
	return def;
}

function createIndex(table: string, index: IndexInfo): string {
	return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${q(table)} (${index.columns.map(q).join(', ')})`;
}

function dropIndex(table: string, name: string): string {
	return `ALTER TABLE ${q(table)} DROP INDEX ${q(name)}`;
}

function addForeignKey(table: string, fk: ForeignKeyInfo): string {
	return `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(fk.constraintName)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.referencedTable)} (${fk.referencedColumns.map(q).join(', ')})`;
}

function dropForeignKey(table: string, name: string): string {
	return `ALTER TABLE ${q(table)} DROP FOREIGN KEY ${q(name)}`;
}

function createTable(table: TableInfo): string {
	const lines = table.columns.map(columnDef);
	if (table.primaryKey.length > 0) {
		lines.push(`PRIMARY KEY (${table.primaryKey.map(q).join(', ')})`);
	}
	return `CREATE TABLE ${q(table.name)} (\n\t${lines.join(',\n\t')}\n)`;
}

export class MysqlEmitter implements DdlEmitter {
	readonly driverId = 'mysql-aurora';

	constructor(private readonly sourceSchemas: readonly string[] = []) { }

	emit(change: SchemaChange): string[] {
		switch (change.kind) {
			case 'addTable':
				return [createTable(change.table)];
			case 'dropTable':
				return [`DROP TABLE ${q(change.table.name)}`];
			case 'addColumn':
				return [`ALTER TABLE ${q(change.table)} ADD COLUMN ${columnDef(change.column)}`];
			case 'alterColumn':
				return [`ALTER TABLE ${q(change.table)} MODIFY COLUMN ${columnDef(change.after)}`];
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column.name)}`];
			case 'setPrimaryKey': {
				const stmts: string[] = [];
				if (change.before.length > 0) {
					stmts.push(`ALTER TABLE ${q(change.table)} DROP PRIMARY KEY`);
				}
				if (change.after.length > 0) {
					stmts.push(`ALTER TABLE ${q(change.table)} ADD PRIMARY KEY (${change.after.map(q).join(', ')})`);
				}
				return stmts;
			}
			case 'addIndex':
				return [createIndex(change.table, change.index)];
			case 'dropIndex':
				return [dropIndex(change.table, change.index.name)];
			case 'replaceIndex':
				return [dropIndex(change.table, change.before.name), createIndex(change.table, change.after)];
			case 'addForeignKey':
				return [addForeignKey(change.table, change.fk)];
			case 'dropForeignKey':
				return [dropForeignKey(change.table, change.fk.constraintName)];
			case 'replaceForeignKey':
				return [dropForeignKey(change.table, change.before.constraintName), addForeignKey(change.table, change.after)];
			case 'addTrigger':
				return change.trigger.statement ? [stripQualifiers(change.trigger.statement, this.sourceSchemas)] : [];
			case 'replaceTrigger':
				return change.after.statement
					? [`DROP TRIGGER IF EXISTS ${q(change.after.name)}`, stripQualifiers(change.after.statement, this.sourceSchemas)]
					: [];
			case 'dropTrigger':
				return [`DROP TRIGGER IF EXISTS ${q(change.trigger.name)}`];
			case 'addView':
			case 'replaceView': {
				const view = change.kind === 'addView' ? change.view : change.after;
				if (!view.definition) {
					return [];
				}
				return [`CREATE OR REPLACE VIEW ${q(view.name)} AS ${stripQualifiers(view.definition, this.sourceSchemas)}`];
			}
			case 'dropView':
				return [`DROP VIEW IF EXISTS ${q(change.view.name)}`];
			case 'addRoutine':
				return change.routine.definition ? [stripQualifiers(change.routine.definition, this.sourceSchemas)] : [];
			case 'replaceRoutine': {
				if (!change.after.definition) {
					return [];
				}
				const keyword = change.after.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				return [`DROP ${keyword} IF EXISTS ${q(change.after.name)}`, stripQualifiers(change.after.definition, this.sourceSchemas)];
			}
			case 'dropRoutine': {
				const keyword = change.routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				return [`DROP ${keyword} IF EXISTS ${q(change.routine.name)}`];
			}
		}
	}
}

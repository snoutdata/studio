/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  SQL Server DDL emitter.
 *
 *  Identifiers are bracket-quoted. View/trigger/routine bodies come from OBJECT_DEFINITION as a
 *  full `CREATE …` statement, so for a replace they are rewritten to `CREATE OR ALTER …` rather
 *  than wrapped. Column defaults from the catalog are already parenthesised expressions, emitted
 *  verbatim. Primary-key changes only emit the ADD (the existing constraint name isn't carried);
 *  a conflict there is left to the AI-fix path.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../index';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('sqlserver').quoteIdent;

function stripQualifiers(sql: string, schemas: readonly string[]): string {
	let out = sql;
	for (const schema of schemas) {
		if (!schema) {
			continue;
		}
		const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp('\\[' + escaped + '\\]\\s*\\.\\s*', 'g'), '');
		out = out.replace(new RegExp('\\b' + escaped + '\\s*\\.\\s*', 'g'), '');
	}
	return out;
}

/** Rewrite a leading `CREATE <kind>` to `CREATE OR ALTER <kind>` for idempotent replaces. */
function toCreateOrAlter(sql: string): string {
	return sql.replace(/^\s*CREATE\s+(TRIGGER|VIEW|PROCEDURE|FUNCTION|PROC)\b/i, 'CREATE OR ALTER $1');
}

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
	return `DROP INDEX ${q(name)} ON ${q(table)}`;
}

function addForeignKey(table: string, fk: ForeignKeyInfo): string {
	return `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(fk.constraintName)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.referencedTable)} (${fk.referencedColumns.map(q).join(', ')})`;
}

function createTable(table: TableInfo): string {
	const lines = table.columns.map(columnDef);
	if (table.primaryKey.length > 0) {
		lines.push(`PRIMARY KEY (${table.primaryKey.map(q).join(', ')})`);
	}
	return `CREATE TABLE ${q(table.name)} (\n\t${lines.join(',\n\t')}\n)`;
}

export class SqlServerEmitter implements DdlEmitter {
	readonly driverId = 'sqlserver';

	constructor(private readonly sourceSchemas: readonly string[] = []) { }

	emit(change: SchemaChange): string[] {
		switch (change.kind) {
			case 'addTable':
				return [createTable(change.table)];
			case 'dropTable':
				return [`DROP TABLE ${q(change.table.name)}`];
			case 'addColumn':
				return [`ALTER TABLE ${q(change.table)} ADD ${columnDef(change.column)}`];
			case 'alterColumn':
				// SQL Server folds type + nullability into one ALTER COLUMN; default changes are
				// separate constraint objects and left to the AI-fix path.
				return [`ALTER TABLE ${q(change.table)} ALTER COLUMN ${q(change.after.name)} ${change.after.dataType} ${change.after.nullable ? 'NULL' : 'NOT NULL'}`];
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column.name)}`];
			case 'setPrimaryKey':
				return change.after.length > 0
					? [`ALTER TABLE ${q(change.table)} ADD PRIMARY KEY (${change.after.map(q).join(', ')})`]
					: [];
			case 'addIndex':
				return [createIndex(change.table, change.index)];
			case 'dropIndex':
				return [dropIndex(change.table, change.index.name)];
			case 'replaceIndex':
				return [dropIndex(change.table, change.before.name), createIndex(change.table, change.after)];
			case 'addForeignKey':
				return [addForeignKey(change.table, change.fk)];
			case 'dropForeignKey':
				return [`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${q(change.fk.constraintName)}`];
			case 'replaceForeignKey':
				return [`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${q(change.before.constraintName)}`, addForeignKey(change.table, change.after)];
			case 'addTrigger':
				return change.trigger.statement ? [stripQualifiers(change.trigger.statement, this.sourceSchemas)] : [];
			case 'replaceTrigger':
				return change.after.statement ? [toCreateOrAlter(stripQualifiers(change.after.statement, this.sourceSchemas))] : [];
			case 'dropTrigger':
				return [`DROP TRIGGER IF EXISTS ${q(change.trigger.name)}`];
			case 'addView':
				return change.view.definition ? [stripQualifiers(change.view.definition, this.sourceSchemas)] : [];
			case 'replaceView':
				return change.after.definition ? [toCreateOrAlter(stripQualifiers(change.after.definition, this.sourceSchemas))] : [];
			case 'dropView':
				return [`DROP VIEW IF EXISTS ${q(change.view.name)}`];
			case 'addRoutine':
				return change.routine.definition ? [stripQualifiers(change.routine.definition, this.sourceSchemas)] : [];
			case 'replaceRoutine':
				return change.after.definition ? [toCreateOrAlter(stripQualifiers(change.after.definition, this.sourceSchemas))] : [];
			case 'dropRoutine': {
				const keyword = change.routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				return [`DROP ${keyword} IF EXISTS ${q(change.routine.name)}`];
			}
		}
	}
}

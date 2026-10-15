/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Oracle DDL emitter.
 *
 *  Identifiers are double-quoted (Oracle folds unquoted names to uppercase, so the introspected
 *  names are emitted verbatim inside quotes). Column changes use a single `MODIFY (col …)`
 *  (Oracle has no per-attribute ALTER COLUMN). Indexes are schema-scoped objects, so `DROP INDEX`
 *  takes no `ON <table>`. View/trigger/routine bodies come from the catalog as full `CREATE …`
 *  statements and are rewritten to `CREATE OR REPLACE …` for idempotent replaces. Oracle has no
 *  `DROP … IF EXISTS` before 23c, so drops are bare; a missing-object error surfaces on apply
 *  (safe, since Oracle auto-commits each statement and the plan is non-transactional anyway).
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../index';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('oracle').quoteIdent;

function stripQualifiers(sql: string, schemas: readonly string[]): string {
	let out = sql;
	for (const schema of schemas) {
		if (!schema) {
			continue;
		}
		const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp('"' + escaped + '"\\s*\\.\\s*', 'g'), '');
		out = out.replace(new RegExp('\\b' + escaped + '\\s*\\.\\s*', 'g'), '');
	}
	return out;
}

/** Rewrite a leading `CREATE <kind>` to `CREATE OR REPLACE <kind>` for idempotent replaces. */
function toCreateOrReplace(sql: string): string {
	return sql.replace(/^\s*CREATE\s+(TRIGGER|VIEW|PROCEDURE|FUNCTION|PACKAGE)\b/i, 'CREATE OR REPLACE $1');
}

/** `name TYPE [DEFAULT x] [NOT NULL]` — Oracle wants DEFAULT before the nullability clause. */
function columnDef(column: ColumnInfo): string {
	let def = `${q(column.name)} ${column.dataType}`;
	if (column.default !== null && column.default !== undefined) {
		def += ` DEFAULT ${column.default}`;
	}
	def += column.nullable ? '' : ' NOT NULL';
	return def;
}

function createIndex(table: string, index: IndexInfo): string {
	return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${q(table)} (${index.columns.map(q).join(', ')})`;
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

export class OracleEmitter implements DdlEmitter {
	readonly driverId = 'oracle';

	constructor(private readonly sourceSchemas: readonly string[] = []) { }

	emit(change: SchemaChange): string[] {
		switch (change.kind) {
			case 'addTable':
				return [createTable(change.table)];
			case 'dropTable':
				return [`DROP TABLE ${q(change.table.name)}`];
			case 'addColumn':
				return [`ALTER TABLE ${q(change.table)} ADD (${columnDef(change.column)})`];
			case 'alterColumn':
				// Oracle folds type + nullability into one MODIFY; default changes are left to the
				// AI-fix path. MODIFY rejects re-stating an unchanged nullability, so the explicit
				// NULL/NOT NULL here is best-effort.
				return [`ALTER TABLE ${q(change.table)} MODIFY (${q(change.after.name)} ${change.after.dataType} ${change.after.nullable ? 'NULL' : 'NOT NULL'})`];
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column.name)}`];
			case 'setPrimaryKey':
				return change.after.length > 0
					? [`ALTER TABLE ${q(change.table)} ADD PRIMARY KEY (${change.after.map(q).join(', ')})`]
					: [];
			case 'addIndex':
				return [createIndex(change.table, change.index)];
			case 'dropIndex':
				return [`DROP INDEX ${q(change.index.name)}`];
			case 'replaceIndex':
				return [`DROP INDEX ${q(change.before.name)}`, createIndex(change.table, change.after)];
			case 'addForeignKey':
				return [addForeignKey(change.table, change.fk)];
			case 'dropForeignKey':
				return [`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${q(change.fk.constraintName)}`];
			case 'replaceForeignKey':
				return [`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${q(change.before.constraintName)}`, addForeignKey(change.table, change.after)];
			case 'addTrigger':
				return change.trigger.statement ? [stripQualifiers(change.trigger.statement, this.sourceSchemas)] : [];
			case 'replaceTrigger':
				return change.after.statement ? [toCreateOrReplace(stripQualifiers(change.after.statement, this.sourceSchemas))] : [];
			case 'dropTrigger':
				return [`DROP TRIGGER ${q(change.trigger.name)}`];
			case 'addView':
				return change.view.definition ? [stripQualifiers(change.view.definition, this.sourceSchemas)] : [];
			case 'replaceView':
				return change.after.definition ? [toCreateOrReplace(stripQualifiers(change.after.definition, this.sourceSchemas))] : [];
			case 'dropView':
				return [`DROP VIEW ${q(change.view.name)}`];
			case 'addRoutine':
				return change.routine.definition ? [stripQualifiers(change.routine.definition, this.sourceSchemas)] : [];
			case 'replaceRoutine':
				return change.after.definition ? [toCreateOrReplace(stripQualifiers(change.after.definition, this.sourceSchemas))] : [];
			case 'dropRoutine': {
				const keyword = change.routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				return [`DROP ${keyword} ${q(change.routine.name)}`];
			}
		}
	}
}

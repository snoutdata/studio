/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  SAP HANA DDL emitter.
 *
 *  Identifiers are double-quoted (HANA folds unquoted names to uppercase, so the introspected
 *  names are emitted verbatim inside quotes). The column-list ALTERs are HANA's own shape: column
 *  changes are PARENTHESISED lists — `ALTER TABLE t ADD (c TYPE)`, `ALTER TABLE t ALTER (c TYPE)`,
 *  `ALTER TABLE t DROP (c)` — not the `ADD COLUMN` / `ALTER COLUMN` of the other vendors. `ALTER`
 *  restates the whole column definition, so type and nullability change in ONE statement (unlike
 *  Db2), and omitting NOT NULL is what makes a column nullable again. Constraints are dropped by
 *  `DROP CONSTRAINT` (there is no `DROP FOREIGN KEY`), and indexes are schema-scoped objects, so
 *  `DROP INDEX` takes no `ON <table>`.
 *
 *  Views are re-created with `CREATE OR REPLACE VIEW … AS <body>` from the SYS.VIEWS body. Triggers
 *  and routines are emitted only when the catalog gave us a full `CREATE …` statement: HANA stores
 *  a trigger's DEFINITION as the body alone on some versions, and emitting that as a statement
 *  would produce SQL the engine rejects, so those changes are skipped rather than guessed at.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../../index';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('hana').quoteIdent;

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

/** True when a catalog body is already a complete statement we can run as-is. */
function isCreateStatement(sql: string | undefined): boolean {
	return sql !== undefined && /^\s*CREATE\b/i.test(sql);
}

/** `name TYPE [DEFAULT x] [NOT NULL]` — HANA wants DEFAULT before the nullability clause. */
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
	// Plain CREATE TABLE follows the instance's default table type, which is COLUMN on HANA 2 and
	// HANA Cloud — the right default for the analytical workloads HANA is deployed for.
	return `CREATE TABLE ${q(table.name)} (\n\t${lines.join(',\n\t')}\n)`;
}

export class HanaEmitter implements DdlEmitter {
	readonly driverId = 'hana';

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
				// ALTER restates the whole definition, so type + default + nullability move together.
				return [`ALTER TABLE ${q(change.table)} ALTER (${columnDef(change.after)})`];
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP (${q(change.column.name)})`];
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
				return isCreateStatement(change.trigger.statement) ? [stripQualifiers(change.trigger.statement!, this.sourceSchemas)] : [];
			case 'replaceTrigger':
				return isCreateStatement(change.after.statement)
					? [`DROP TRIGGER ${q(change.after.name)}`, stripQualifiers(change.after.statement!, this.sourceSchemas)]
					: [];
			case 'dropTrigger':
				return [`DROP TRIGGER ${q(change.trigger.name)}`];
			case 'addView':
			case 'replaceView': {
				const view = change.kind === 'addView' ? change.view : change.after;
				if (!view.definition) {
					return [];
				}
				const body = stripQualifiers(view.definition, this.sourceSchemas);
				return [isCreateStatement(body) ? body : `CREATE OR REPLACE VIEW ${q(view.name)} AS ${body}`];
			}
			case 'dropView':
				return [`DROP VIEW ${q(change.view.name)}`];
			case 'addRoutine':
				return isCreateStatement(change.routine.definition) ? [stripQualifiers(change.routine.definition!, this.sourceSchemas)] : [];
			case 'replaceRoutine': {
				if (!isCreateStatement(change.after.definition)) {
					return [];
				}
				const keyword = change.after.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				// HANA has no CREATE OR REPLACE for routines before HANA Cloud, so replace = drop + create.
				return [`DROP ${keyword} ${q(change.after.name)}`, stripQualifiers(change.after.definition!, this.sourceSchemas)];
			}
			case 'dropRoutine': {
				const keyword = change.routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				return [`DROP ${keyword} ${q(change.routine.name)}`];
			}
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Postgres DDL emitter.
 *
 *  Identifiers are double-quoted. Column alters are decomposed into TYPE / NOT NULL / DEFAULT
 *  sub-statements (Postgres has no single MODIFY COLUMN). Column defaults come from the catalog
 *  already as valid expressions, so they are emitted verbatim. Trigger/view/function bodies are
 *  introspected qualified with the source schema; that qualifier is stripped before emitting.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor, generatedColumnClause } from '../../index';
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../../../../schema';
import type { DdlEmitter } from './index';
import type { SchemaChange } from '../types';

const q = dialectFor('postgres').quoteIdent;

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

function columnDef(column: ColumnInfo): string {
	let def = `${q(column.name)} ${column.dataType}`;
	if (column.generatedAs) {
		def += ` ${generatedColumnClause(column.generatedAs)}`;
	}
	def += column.nullable ? '' : ' NOT NULL';
	if (!column.generatedAs && column.default !== null && column.default !== undefined) {
		def += ` DEFAULT ${column.default}`;
	}
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

function normalizeDefault(value: string | null | undefined): string | null {
	return value === null || value === undefined ? null : value;
}

export class PostgresEmitter implements DdlEmitter {
	readonly driverId = 'postgres';

	constructor(private readonly sourceSchemas: readonly string[] = []) { }

	emit(change: SchemaChange): string[] {
		switch (change.kind) {
			case 'addTable':
				return [createTable(change.table)];
			case 'dropTable':
				return [`DROP TABLE ${q(change.table.name)}`];
			case 'addColumn':
				return [`ALTER TABLE ${q(change.table)} ADD COLUMN ${columnDef(change.column)}`];
			case 'alterColumn': {
				const stmts: string[] = [];
				const col = q(change.after.name);
				if (change.before.dataType !== change.after.dataType) {
					stmts.push(`ALTER TABLE ${q(change.table)} ALTER COLUMN ${col} TYPE ${change.after.dataType}`);
				}
				if (change.before.nullable !== change.after.nullable) {
					stmts.push(`ALTER TABLE ${q(change.table)} ALTER COLUMN ${col} ${change.after.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
				}
				if (normalizeDefault(change.before.default) !== normalizeDefault(change.after.default)) {
					stmts.push(change.after.default === null || change.after.default === undefined
						? `ALTER TABLE ${q(change.table)} ALTER COLUMN ${col} DROP DEFAULT`
						: `ALTER TABLE ${q(change.table)} ALTER COLUMN ${col} SET DEFAULT ${change.after.default}`);
				}
				return stmts;
			}
			case 'dropColumn':
				return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column.name)}`];
			case 'setPrimaryKey': {
				const stmts: string[] = [];
				// PK constraint name isn't carried; fall back to Postgres' conventional `<table>_pkey`.
				if (change.before.length > 0) {
					stmts.push(`ALTER TABLE ${q(change.table)} DROP CONSTRAINT IF EXISTS ${q(`${change.table}_pkey`)}`);
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
				return change.trigger.statement ? [stripQualifiers(change.trigger.statement, this.sourceSchemas)] : [];
			case 'replaceTrigger':
				return change.after.statement
					? [`DROP TRIGGER IF EXISTS ${q(change.after.name)} ON ${q(change.table)}`, stripQualifiers(change.after.statement, this.sourceSchemas)]
					: [];
			case 'dropTrigger':
				return [`DROP TRIGGER IF EXISTS ${q(change.trigger.name)} ON ${q(change.table)}`];
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
			case 'replaceRoutine': {
				// pg_get_functiondef already yields a CREATE OR REPLACE; just strip the source schema.
				const routine = change.kind === 'addRoutine' ? change.routine : change.after;
				return routine.definition ? [stripQualifiers(routine.definition, this.sourceSchemas)] : [];
			}
			case 'dropRoutine': {
				const keyword = change.routine.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
				return [`DROP ${keyword} IF EXISTS ${q(change.routine.name)}`];
			}
		}
	}
}

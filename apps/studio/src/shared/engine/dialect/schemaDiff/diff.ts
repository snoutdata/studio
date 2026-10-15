/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Dialect-agnostic structural diff: two introspected schemas → a list of SchemaChange.
 *
 *  Object identity is matched by NAME within a connection's namespace (tables, columns,
 *  indexes, FKs by constraint name, triggers/routines/views by name). The database/schema
 *  qualifier is intentionally ignored when matching, because a dev→prod pair usually lives
 *  under different database names (MySQL) while holding the same logical objects. Emitters
 *  therefore produce unqualified DDL applied against the target connection's current
 *  database. (Multi-schema Postgres with the same table name in two schemas is a future
 *  refinement.)
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, IndexInfo, RoutineInfo, TableInfo, TriggerInfo } from '../../../schema';
import type { ChangeClass, ObjectType, SchemaChange } from './types';

/** Collapse whitespace + strip a trailing semicolon so trivially-formatted bodies compare equal. */
function normalizeBody(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

/** Treat null/undefined/'' defaults as the same "no default". Otherwise compare verbatim. */
function normalizeDefault(value: string | null | undefined): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	return value;
}

function columnsEqual(a: ColumnInfo, b: ColumnInfo): boolean {
	return a.dataType === b.dataType
		&& a.nullable === b.nullable
		&& normalizeDefault(a.default) === normalizeDefault(b.default);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function indexesEqual(a: IndexInfo, b: IndexInfo): boolean {
	return a.unique === b.unique && arraysEqual(a.columns, b.columns);
}

function foreignKeysEqual(a: ForeignKeyInfo, b: ForeignKeyInfo): boolean {
	return a.referencedTable === b.referencedTable
		&& arraysEqual(a.columns, b.columns)
		&& arraysEqual(a.referencedColumns, b.referencedColumns);
}

function byName<T extends { name: string }>(items: readonly T[] | undefined): Map<string, T> {
	const map = new Map<string, T>();
	for (const item of items ?? []) {
		map.set(item.name, item);
	}
	return map;
}

/** Diff two existing tables (already known to share a name) into column/PK/index/FK/trigger changes. */
function diffTable(source: TableInfo, target: TableInfo, out: SchemaChange[]): void {
	const targetColumns = byName(target.columns);
	const sourceColumns = byName(source.columns);
	for (const column of source.columns) {
		const existing = targetColumns.get(column.name);
		if (!existing) {
			out.push({ kind: 'addColumn', table: source.name, column });
		} else if (!columnsEqual(column, existing)) {
			out.push({ kind: 'alterColumn', table: source.name, before: existing, after: column });
		}
	}
	for (const column of target.columns) {
		if (!sourceColumns.has(column.name)) {
			out.push({ kind: 'dropColumn', table: source.name, column });
		}
	}

	if (!arraysEqual(source.primaryKey, target.primaryKey)) {
		out.push({ kind: 'setPrimaryKey', table: source.name, before: target.primaryKey, after: source.primaryKey });
	}

	const targetIndexes = byName(target.indexes);
	const sourceIndexes = byName(source.indexes);
	for (const index of source.indexes ?? []) {
		const existing = targetIndexes.get(index.name);
		if (!existing) {
			out.push({ kind: 'addIndex', table: source.name, index });
		} else if (!indexesEqual(index, existing)) {
			out.push({ kind: 'replaceIndex', table: source.name, before: existing, after: index });
		}
	}
	for (const index of target.indexes ?? []) {
		if (!sourceIndexes.has(index.name)) {
			out.push({ kind: 'dropIndex', table: source.name, index });
		}
	}

	const targetFks = byName(target.foreignKeys.map((fk) => ({ ...fk, name: fk.constraintName })));
	const sourceFks = byName(source.foreignKeys.map((fk) => ({ ...fk, name: fk.constraintName })));
	for (const fk of source.foreignKeys) {
		const existing = targetFks.get(fk.constraintName);
		if (!existing) {
			out.push({ kind: 'addForeignKey', table: source.name, fk });
		} else if (!foreignKeysEqual(fk, existing)) {
			out.push({ kind: 'replaceForeignKey', table: source.name, before: existing, after: fk });
		}
	}
	for (const fk of target.foreignKeys) {
		if (!sourceFks.has(fk.constraintName)) {
			out.push({ kind: 'dropForeignKey', table: source.name, fk });
		}
	}

	const targetTriggers = byName(target.triggers);
	const sourceTriggers = byName(source.triggers);
	for (const trigger of source.triggers ?? []) {
		const existing = targetTriggers.get(trigger.name);
		if (!existing) {
			out.push({ kind: 'addTrigger', table: source.name, trigger });
		} else if (normalizeBody(trigger.statement) !== normalizeBody(existing.statement)) {
			out.push({ kind: 'replaceTrigger', table: source.name, before: existing, after: trigger });
		}
	}
	for (const trigger of target.triggers ?? []) {
		if (!sourceTriggers.has(trigger.name)) {
			out.push({ kind: 'dropTrigger', table: source.name, trigger });
		}
	}
}

/** Compute the dialect-agnostic change list that would morph `target` into `source`. */
export function computeChanges(source: DatabaseSchema, target: DatabaseSchema): SchemaChange[] {
	const changes: SchemaChange[] = [];

	const sourceTables = source.tables.filter((t) => t.kind !== 'view');
	const targetTables = target.tables.filter((t) => t.kind !== 'view');
	const sourceViews = source.tables.filter((t) => t.kind === 'view');
	const targetViews = target.tables.filter((t) => t.kind === 'view');

	const targetTableByName = byName(targetTables);
	const sourceTableByName = byName(sourceTables);
	for (const table of sourceTables) {
		const existing = targetTableByName.get(table.name);
		if (!existing) {
			changes.push({ kind: 'addTable', table });
			for (const index of table.indexes ?? []) {
				changes.push({ kind: 'addIndex', table: table.name, index });
			}
			for (const fk of table.foreignKeys) {
				changes.push({ kind: 'addForeignKey', table: table.name, fk });
			}
			for (const trigger of table.triggers ?? []) {
				changes.push({ kind: 'addTrigger', table: table.name, trigger });
			}
		} else {
			diffTable(table, existing, changes);
		}
	}
	for (const table of targetTables) {
		if (!sourceTableByName.has(table.name)) {
			changes.push({ kind: 'dropTable', table });
		}
	}

	const targetViewByName = byName(targetViews);
	const sourceViewByName = byName(sourceViews);
	for (const view of sourceViews) {
		const existing = targetViewByName.get(view.name);
		if (!existing) {
			changes.push({ kind: 'addView', view });
		} else if (normalizeBody(view.definition) !== normalizeBody(existing.definition)) {
			changes.push({ kind: 'replaceView', before: existing, after: view });
		}
	}
	for (const view of targetViews) {
		if (!sourceViewByName.has(view.name)) {
			changes.push({ kind: 'dropView', view });
		}
	}

	const targetRoutineByName = byName(target.routines);
	const sourceRoutineByName = byName(source.routines);
	for (const routine of source.routines ?? []) {
		const existing = targetRoutineByName.get(routine.name);
		if (!existing) {
			changes.push({ kind: 'addRoutine', routine });
		} else if (normalizeBody(routine.definition) !== normalizeBody(existing.definition)) {
			changes.push({ kind: 'replaceRoutine', before: existing, after: routine });
		}
	}
	for (const routine of target.routines ?? []) {
		if (!sourceRoutineByName.has(routine.name)) {
			changes.push({ kind: 'dropRoutine', routine });
		}
	}

	return changes;
}

/** Dialect-independent metadata for a change (the SQL itself comes from the per-driver emitter). */
export function describeChange(change: SchemaChange): { description: string; destructive: boolean; changeClass: ChangeClass; objectType: ObjectType; objectName: string } {
	switch (change.kind) {
		case 'addTable':
			return { description: `Create table \`${change.table.name}\``, destructive: false, changeClass: 'add', objectType: 'table', objectName: change.table.name };
		case 'dropTable':
			return { description: `Drop table \`${change.table.name}\``, destructive: true, changeClass: 'drop', objectType: 'table', objectName: change.table.name };
		case 'addColumn':
			return { description: `Add column \`${change.table}\`.\`${change.column.name}\``, destructive: false, changeClass: 'add', objectType: 'column', objectName: `${change.table}.${change.column.name}` };
		case 'alterColumn':
			return { description: `Alter column \`${change.table}\`.\`${change.after.name}\` (${change.before.dataType} → ${change.after.dataType})`, destructive: false, changeClass: 'alter', objectType: 'column', objectName: `${change.table}.${change.after.name}` };
		case 'dropColumn':
			return { description: `Drop column \`${change.table}\`.\`${change.column.name}\``, destructive: true, changeClass: 'drop', objectType: 'column', objectName: `${change.table}.${change.column.name}` };
		case 'setPrimaryKey':
			return { description: `Change primary key of \`${change.table}\``, destructive: false, changeClass: 'alter', objectType: 'primaryKey', objectName: change.table };
		case 'addIndex':
			return { description: `Add index \`${change.index.name}\` on \`${change.table}\``, destructive: false, changeClass: 'add', objectType: 'index', objectName: `${change.table}.${change.index.name}` };
		case 'dropIndex':
			return { description: `Drop index \`${change.index.name}\` on \`${change.table}\``, destructive: false, changeClass: 'drop', objectType: 'index', objectName: `${change.table}.${change.index.name}` };
		case 'replaceIndex':
			return { description: `Rebuild index \`${change.after.name}\` on \`${change.table}\``, destructive: false, changeClass: 'alter', objectType: 'index', objectName: `${change.table}.${change.after.name}` };
		case 'addForeignKey':
			return { description: `Add foreign key \`${change.fk.constraintName}\` on \`${change.table}\``, destructive: false, changeClass: 'add', objectType: 'foreignKey', objectName: `${change.table}.${change.fk.constraintName}` };
		case 'dropForeignKey':
			return { description: `Drop foreign key \`${change.fk.constraintName}\` on \`${change.table}\``, destructive: false, changeClass: 'drop', objectType: 'foreignKey', objectName: `${change.table}.${change.fk.constraintName}` };
		case 'replaceForeignKey':
			return { description: `Rebuild foreign key \`${change.after.constraintName}\` on \`${change.table}\``, destructive: false, changeClass: 'alter', objectType: 'foreignKey', objectName: `${change.table}.${change.after.constraintName}` };
		case 'addTrigger':
			return { description: `Add trigger \`${change.trigger.name}\` on \`${change.table}\``, destructive: false, changeClass: 'add', objectType: 'trigger', objectName: `${change.table}.${change.trigger.name}` };
		case 'dropTrigger':
			return { description: `Drop trigger \`${change.trigger.name}\` on \`${change.table}\``, destructive: false, changeClass: 'drop', objectType: 'trigger', objectName: `${change.table}.${change.trigger.name}` };
		case 'replaceTrigger':
			return { description: `Replace trigger \`${change.after.name}\` on \`${change.table}\``, destructive: false, changeClass: 'alter', objectType: 'trigger', objectName: `${change.table}.${change.after.name}` };
		case 'addView':
			return { description: `Create view \`${change.view.name}\``, destructive: false, changeClass: 'add', objectType: 'view', objectName: change.view.name };
		case 'dropView':
			return { description: `Drop view \`${change.view.name}\``, destructive: true, changeClass: 'drop', objectType: 'view', objectName: change.view.name };
		case 'replaceView':
			return { description: `Replace view \`${change.after.name}\``, destructive: false, changeClass: 'alter', objectType: 'view', objectName: change.after.name };
		case 'addRoutine':
			return { description: `Create ${change.routine.kind} \`${change.routine.name}\``, destructive: false, changeClass: 'add', objectType: 'routine', objectName: change.routine.name };
		case 'dropRoutine':
			return { description: `Drop ${change.routine.kind} \`${change.routine.name}\``, destructive: false, changeClass: 'drop', objectType: 'routine', objectName: change.routine.name };
		case 'replaceRoutine':
			return { description: `Replace ${change.after.kind} \`${change.after.name}\``, destructive: false, changeClass: 'alter', objectType: 'routine', objectName: change.after.name };
	}
}

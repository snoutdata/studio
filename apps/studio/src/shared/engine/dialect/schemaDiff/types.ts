/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Schema sync (migration diff) — shared contracts.
 *
 *  A migration plan is computed deterministically from two introspected schemas: the
 *  SOURCE (the desired state, e.g. dev) and the TARGET (the database that gets changed,
 *  e.g. prod). The diff is dialect-agnostic (a list of {@link SchemaChange}); a per-driver
 *  emitter turns each change into the actual DDL. The AI is only consulted on the error
 *  path — when an emitted statement fails to apply.
 *--------------------------------------------------------------------------------------------*/

import type { ColumnInfo, ForeignKeyInfo, IndexInfo, RoutineInfo, TableInfo, TriggerInfo } from '../../../schema';

/** Coarse object category a change touches — drives grouping + iconography in the UI. */
export type ObjectType = 'table' | 'column' | 'primaryKey' | 'index' | 'foreignKey' | 'trigger' | 'routine' | 'view';

/**
 * Which direction a change moves the target, relative to the source:
 * - `add`: present in source, absent in target (purely additive)
 * - `alter`: present in both but different (a modification — even when carried out as drop+add)
 * - `drop`: absent in source, present only in target (a removal)
 *
 * Lets the UI offer sync modes: include all (mirror), exclude `drop` (additive — never remove
 * anything from the target), or `add`-only.
 */
export type ChangeClass = 'add' | 'alter' | 'drop';

/**
 * One structural difference between target and source, in dialect-agnostic terms. A new
 * table emits {@link AddTable} plus separate add-index/add-foreign-key/add-trigger changes
 * for its dependents, so the ordering pass can create every table before any cross-table
 * constraint. Index/foreign-key edits are modelled as drop+add (no in-place "replace")
 * since that is what every dialect does under the hood.
 */
export type SchemaChange =
	| { kind: 'addTable'; table: TableInfo }
	| { kind: 'dropTable'; table: TableInfo }
	| { kind: 'addColumn'; table: string; column: ColumnInfo }
	| { kind: 'alterColumn'; table: string; before: ColumnInfo; after: ColumnInfo }
	| { kind: 'dropColumn'; table: string; column: ColumnInfo }
	| { kind: 'setPrimaryKey'; table: string; before: string[]; after: string[] }
	| { kind: 'addIndex'; table: string; index: IndexInfo }
	| { kind: 'dropIndex'; table: string; index: IndexInfo }
	| { kind: 'replaceIndex'; table: string; before: IndexInfo; after: IndexInfo }
	| { kind: 'addForeignKey'; table: string; fk: ForeignKeyInfo }
	| { kind: 'dropForeignKey'; table: string; fk: ForeignKeyInfo }
	| { kind: 'replaceForeignKey'; table: string; before: ForeignKeyInfo; after: ForeignKeyInfo }
	| { kind: 'addTrigger'; table: string; trigger: TriggerInfo }
	| { kind: 'dropTrigger'; table: string; trigger: TriggerInfo }
	| { kind: 'replaceTrigger'; table: string; before: TriggerInfo; after: TriggerInfo }
	| { kind: 'addView'; view: TableInfo }
	| { kind: 'dropView'; view: TableInfo }
	| { kind: 'replaceView'; before: TableInfo; after: TableInfo }
	| { kind: 'addRoutine'; routine: RoutineInfo }
	| { kind: 'dropRoutine'; routine: RoutineInfo }
	| { kind: 'replaceRoutine'; before: RoutineInfo; after: RoutineInfo };

/** A single applyable SQL statement plus the metadata the review UI renders. */
export interface MigrationStatement {
	/** Stable id within a plan (used as a React key + to resume from a failure). */
	id: string;
	sql: string;
	/** Human-readable one-liner, e.g. "Add column `users`.`email`". */
	description: string;
	/** True when applying this could lose data (drop table/column/view). Flagged in the UI. */
	destructive: boolean;
	/** Add / Modify / Delete — lets the UI toggle whole classes (e.g. exclude all deletions). */
	changeClass: ChangeClass;
	objectType: ObjectType;
	/** The object the statement acts on, e.g. `users` or `users.email`. */
	objectName: string;
}

/** Result of computing a plan: the plan, or a reason it could not be built (e.g. cross-dialect). */
export type SchemaDiffResult =
	| { ok: true; plan: MigrationPlan }
	| { ok: false; error: string };

/** One statement to apply — the ordered subset the user kept (with any AI-fixed SQL swapped in). */
export interface ApplyStatement {
	id: string;
	sql: string;
}

/**
 * Outcome of applying a migration. On a non-transactional failure, `failedIndex` is the
 * position in the submitted array that errored, so the UI can fix it and resume from there.
 * Postgres rolls the whole thing back on failure, so `applied` is 0 in that case.
 */
export type ApplyMigrationResult =
	| { ok: true; applied: number }
	| { ok: false; error: string; failedIndex: number; failedId: string; applied: number; rolledBack: boolean };

/** The full ordered migration the engine produces for a source→target pair. */
export interface MigrationPlan {
	driverId: string;
	sourceDatabase: string;
	targetDatabase: string;
	statements: MigrationStatement[];
	/**
	 * Whether the whole apply can run inside one transaction (Postgres has transactional
	 * DDL; MySQL/SQL Server auto-commit each statement). When false, the apply runs
	 * statement-by-statement and can resume from a failure after an AI fix.
	 */
	transactional: boolean;
}

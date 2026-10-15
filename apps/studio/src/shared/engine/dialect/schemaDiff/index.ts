/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Schema sync entry point: two introspected schemas → an ordered, emitted MigrationPlan.
 *--------------------------------------------------------------------------------------------*/

import { dialectFor } from '../index';
import type { DatabaseSchema } from '../../../schema';
import { computeChanges, describeChange } from './diff';
import { emitterFor } from './emit/index';
import { orderChanges } from './order';
import type { MigrationPlan, MigrationStatement } from './types';

export type { MigrationPlan, MigrationStatement, SchemaChange, ObjectType, ChangeClass, SchemaDiffResult, ApplyStatement, ApplyMigrationResult } from './types';
export { computeChanges, describeChange } from './diff';
export { orderChanges } from './order';
export { clickhouseColumnType } from './emit/clickhouse';

/** Distinct, non-empty source schema (database) names, used to strip qualifiers from bodies. */
function sourceSchemaNames(source: DatabaseSchema): string[] {
	const names = new Set<string>();
	for (const table of source.tables) {
		if (table.schema) {
			names.add(table.schema);
		}
	}
	for (const routine of source.routines ?? []) {
		if (routine.schema) {
			names.add(routine.schema);
		}
	}
	return [...names];
}

/**
 * Build the migration that morphs `target` into `source` for the given driver. The result is
 * deterministic: same inputs → same statements in the same order.
 */
export function buildPlan(source: DatabaseSchema, target: DatabaseSchema, driverId: string): MigrationPlan {
	const emitter = emitterFor(driverId, sourceSchemaNames(source));
	const ordered = orderChanges(computeChanges(source, target));

	const statements: MigrationStatement[] = [];
	let seq = 0;
	for (const change of ordered) {
		const meta = describeChange(change);
		for (const sql of emitter.emit(change)) {
			statements.push({
				id: `s${seq++}`,
				sql,
				description: meta.description,
				destructive: meta.destructive,
				changeClass: meta.changeClass,
				objectType: meta.objectType,
				objectName: meta.objectName,
			});
		}
	}

	return {
		driverId,
		sourceDatabase: source.database,
		targetDatabase: target.database,
		statements,
		// Postgres has transactional DDL; MySQL, SQL Server and Oracle auto-commit each statement.
		transactional: dialectFor(driverId).isTransactionalDdl,
	};
}

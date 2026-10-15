/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Per-driver DDL emitters. An emitter turns one dialect-agnostic SchemaChange into one or
 *  more concrete SQL statements. The change's description / destructive flag / object name
 *  are derived centrally (see describeChange) — the emitter is only responsible for SQL text.
 *--------------------------------------------------------------------------------------------*/

import type { SchemaChange } from '../types';
import { ClickHouseEmitter } from './clickhouse';
import { Db2Emitter } from './db2';
import { HanaEmitter } from './hana';
import { MysqlEmitter } from './mysql';
import { OracleEmitter } from './oracle';
import { PostgresEmitter } from './postgres';
import { SqliteEmitter } from './sqlite';
import { SqlServerEmitter } from './sqlserver';

export interface DdlEmitter {
	readonly driverId: string;
	/** SQL for one change. Most changes yield a single statement; some (e.g. a PK swap) yield several. */
	emit(change: SchemaChange): string[];
}

/**
 * Resolve the emitter for a driver id, or throw if the dialect is not supported for sync.
 * `sourceSchemas` are the source database/schema names whose qualifiers must be stripped from
 * trigger/view/routine bodies so they apply against the target's current database.
 */
export function emitterFor(driverId: string, sourceSchemas: readonly string[] = []): DdlEmitter {
	switch (driverId) {
		case 'mysql-aurora': return new MysqlEmitter(sourceSchemas);
		case 'mariadb': return new MysqlEmitter(sourceSchemas);
		case 'postgres': return new PostgresEmitter(sourceSchemas);
		case 'sqlserver': return new SqlServerEmitter(sourceSchemas);
		case 'oracle': return new OracleEmitter(sourceSchemas);
		case 'db2': return new Db2Emitter(sourceSchemas);
		case 'sqlite': return new SqliteEmitter(sourceSchemas);
		case 'hana': return new HanaEmitter(sourceSchemas);
		case 'clickhouse': return new ClickHouseEmitter(sourceSchemas);
		default: throw new Error(`Schema sync is not supported for driver "${driverId}".`);
	}
}

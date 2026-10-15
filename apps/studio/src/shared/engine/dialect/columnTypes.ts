/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Inferred type -> a vendor's column type.
 *
 *  The flow layer reasons in seven types (`InferredType`); a CREATE TABLE needs a real one per
 *  vendor. This is a lookup table rather than an addition to the `Dialect` interface on purpose:
 *  `Dialect` models CLAUSE SHAPE, and widening it for a create-table need would touch all
 *  thirteen implementations for something only the sink planner asks about. Same precedent as
 *  `schemaDiff/emit/emitterFor` — one function, keyed by driver id.
 *
 *  Sizing rule: a text column is given room to grow (double the longest value seen, floored at a
 *  sane minimum) and falls back to the vendor's large-text type past its VARCHAR ceiling. Getting
 *  this wrong is the classic import failure — a column sized to the sample, then a longer value
 *  arrives on run 2 and the insert errors.
 *--------------------------------------------------------------------------------------------*/

import type { InferredType } from './rows';

export interface ColumnTypeOptions {
	/** Longest text value observed while sampling; 0 when unknown. */
	maxLength?: number;
}

/** Headroom over the sampled longest value, and the floor no text column goes below. */
const HEADROOM = 2;
const MIN_VARCHAR = 64;

function varcharSize(maxLength: number | undefined, ceiling: number): number | null {
	const needed = Math.max(MIN_VARCHAR, Math.ceil((maxLength ?? 0) * HEADROOM));
	return needed > ceiling ? null : needed;
}

/**
 * The column type to declare for `type` on `driverId`. Unknown drivers fall back to a portable
 * ANSI-ish set, which is what the generic dialect does for everything else.
 */
export function sqlTypeFor(driverId: string, type: InferredType, options: ColumnTypeOptions = {}): string {
	switch (driverId) {
		case 'postgres':
			return { string: 'TEXT', integer: 'BIGINT', number: 'DOUBLE PRECISION', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP', json: 'JSONB' }[type];
		case 'redshift': {
			// Redshift has no TEXT: `TEXT` silently becomes VARCHAR(256), which truncates. Size it.
			const size = varcharSize(options.maxLength, 65535);
			return { string: `VARCHAR(${size ?? 65535})`, integer: 'BIGINT', number: 'DOUBLE PRECISION', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP', json: `VARCHAR(${65535})` }[type];
		}
		case 'mysql-aurora':
		case 'mariadb': {
			const size = varcharSize(options.maxLength, 4096);
			return { string: size === null ? 'LONGTEXT' : `VARCHAR(${size})`, integer: 'BIGINT', number: 'DOUBLE', boolean: 'TINYINT(1)', date: 'DATE', timestamp: 'DATETIME(3)', json: 'JSON' }[type];
		}
		case 'sqlserver': {
			const size = varcharSize(options.maxLength, 4000);
			return { string: size === null ? 'NVARCHAR(MAX)' : `NVARCHAR(${size})`, integer: 'BIGINT', number: 'FLOAT', boolean: 'BIT', date: 'DATE', timestamp: 'DATETIME2(3)', json: 'NVARCHAR(MAX)' }[type];
		}
		case 'oracle': {
			const size = varcharSize(options.maxLength, 4000);
			// No BOOLEAN before 23c — NUMBER(1) is what the dialect's 1/0 literals target.
			return { string: size === null ? 'CLOB' : `VARCHAR2(${size} CHAR)`, integer: 'NUMBER(19)', number: 'BINARY_DOUBLE', boolean: 'NUMBER(1)', date: 'DATE', timestamp: 'TIMESTAMP(3)', json: 'CLOB' }[type];
		}
		case 'db2': {
			const size = varcharSize(options.maxLength, 32672);
			return { string: size === null ? 'CLOB' : `VARCHAR(${size})`, integer: 'BIGINT', number: 'DOUBLE', boolean: 'SMALLINT', date: 'DATE', timestamp: 'TIMESTAMP', json: 'CLOB' }[type];
		}
		case 'hana': {
			const size = varcharSize(options.maxLength, 5000);
			return { string: size === null ? 'NCLOB' : `NVARCHAR(${size})`, integer: 'BIGINT', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP', json: 'NCLOB' }[type];
		}
		case 'sqlite':
			// Storage classes, not lengths: SQLite ignores a size and types by affinity.
			return { string: 'TEXT', integer: 'INTEGER', number: 'REAL', boolean: 'INTEGER', date: 'TEXT', timestamp: 'TEXT', json: 'TEXT' }[type];
		case 'duckdb':
			return { string: 'VARCHAR', integer: 'BIGINT', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP', json: 'JSON' }[type];
		case 'clickhouse':
			return { string: 'String', integer: 'Int64', number: 'Float64', boolean: 'Bool', date: 'Date', timestamp: "DateTime64(3)", json: 'String' }[type];
		case 'snowflake':
			return { string: 'VARCHAR', integer: 'NUMBER(38,0)', number: 'FLOAT', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP_NTZ', json: 'VARIANT' }[type];
		default: {
			const size = varcharSize(options.maxLength, 4000);
			return { string: size === null ? 'TEXT' : `VARCHAR(${size})`, integer: 'BIGINT', number: 'DOUBLE PRECISION', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP', json: 'TEXT' }[type];
		}
	}
}

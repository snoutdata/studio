/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectSnowflake, snowflakeStructuralDigest, type SnowflakeRowRunner } from './introspection';

// Canned INFORMATION_SCHEMA rows for a tiny two-table + one-view schema in schema "PUBLIC".
const TABLES = [
	{ table_schema: 'PUBLIC', table_name: 'DEPARTMENTS', table_type: 'BASE TABLE' },
	{ table_schema: 'PUBLIC', table_name: 'EMPLOYEES', table_type: 'BASE TABLE' },
	{ table_schema: 'PUBLIC', table_name: 'EMP_VIEW', table_type: 'VIEW' },
];
const COLUMNS = [
	{ table_schema: 'PUBLIC', table_name: 'DEPARTMENTS', column_name: 'DEPT_ID', data_type: 'NUMBER', character_maximum_length: null, numeric_precision: 38, numeric_scale: 0, is_nullable: 'NO', column_default: null },
	{ table_schema: 'PUBLIC', table_name: 'DEPARTMENTS', column_name: 'DNAME', data_type: 'TEXT', character_maximum_length: 100, numeric_precision: null, numeric_scale: null, is_nullable: 'YES', column_default: null },
	{ table_schema: 'PUBLIC', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID', data_type: 'NUMBER', character_maximum_length: null, numeric_precision: 38, numeric_scale: 0, is_nullable: 'NO', column_default: null },
	{ table_schema: 'PUBLIC', table_name: 'EMPLOYEES', column_name: 'NAME', data_type: 'TEXT', character_maximum_length: 255, numeric_precision: null, numeric_scale: null, is_nullable: 'NO', column_default: null },
	{ table_schema: 'PUBLIC', table_name: 'EMPLOYEES', column_name: 'SALARY', data_type: 'NUMBER', character_maximum_length: null, numeric_precision: 10, numeric_scale: 2, is_nullable: 'YES', column_default: '0' },
];
const VIEWS = [
	{ table_schema: 'PUBLIC', table_name: 'EMP_VIEW', view_definition: 'SELECT employee_id, name FROM employees' },
];

/** Dispatch a query to canned rows by the INFORMATION_SCHEMA view it reads. Records each SQL seen. */
function makeRunner(seen: string[]): SnowflakeRowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (sql.includes('HASH(')) {
			return [{ n: 5, h: 987654 }];
		}
		if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
			return sql.includes("table_type <> 'VIEW'") ? TABLES.filter((t) => t.table_type !== 'VIEW') : TABLES;
		}
		if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
			return COLUMNS;
		}
		if (sql.includes('INFORMATION_SCHEMA.VIEWS')) {
			return VIEWS;
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectSnowflake assembles tables, columns and views', async () => {
	const schema = await introspectSnowflake(makeRunner([]), 'ANALYTICS', true);

	assert.equal(schema.database, 'ANALYTICS');
	assert.deepEqual(schema.tables.map((t) => t.name), ['DEPARTMENTS', 'EMPLOYEES', 'EMP_VIEW']);

	const employees = schema.tables.find((t) => t.name === 'EMPLOYEES');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	// composeType: NUMBER(p,s) / NUMBER(p) / TEXT(n).
	assert.deepEqual(
		employees.columns.map((c) => `${c.name} ${c.dataType}`),
		['EMPLOYEE_ID NUMBER(38)', 'NAME TEXT(255)', 'SALARY NUMBER(10,2)'],
	);
	assert.equal(employees.columns.find((c) => c.name === 'NAME')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'SALARY')?.default, '0');

	const view = schema.tables.find((t) => t.name === 'EMP_VIEW');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, 'SELECT employee_id, name FROM employees');
});

test('introspectSnowflake qualifies every query with the database INFORMATION_SCHEMA', async () => {
	const seen: string[] = [];
	await introspectSnowflake(makeRunner(seen), 'ANALYTICS', true);
	assert.ok(seen.length > 0);
	for (const sql of seen) {
		assert.ok(sql.includes('"ANALYTICS".INFORMATION_SCHEMA'), `query not scoped to the database: ${sql}`);
		assert.ok(sql.includes("table_schema <> 'INFORMATION_SCHEMA'"), `query missing system-schema filter: ${sql}`);
	}
});

test('introspectSnowflake omits the view query when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectSnowflake(makeRunner(seen), 'ANALYTICS', false);
	assert.ok(!seen.some((s) => s.includes('INFORMATION_SCHEMA.VIEWS')), 'should not query VIEWS');
	assert.ok(seen.some((s) => s.includes('INFORMATION_SCHEMA.TABLES')));
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
});

test('introspectSnowflake returns an empty schema with no database', async () => {
	const schema = await introspectSnowflake(makeRunner([]), undefined, true);
	assert.deepEqual(schema.tables, []);
});

test('snowflakeStructuralDigest returns a count:hash fingerprint', async () => {
	const digest = await snowflakeStructuralDigest(makeRunner([]), 'ANALYTICS');
	assert.equal(digest, '5:987654');
});

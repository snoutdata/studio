/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectRedshift, redshiftStructuralDigest, type RedshiftRowRunner } from './introspection';

// Canned SVV_* rows for a tiny two-table + one-view schema in "public".
const TABLES = [
	{ schema_name: 'public', table_name: 'departments', table_type: 'TABLE' },
	{ schema_name: 'public', table_name: 'employees', table_type: 'TABLE' },
	{ schema_name: 'public', table_name: 'emp_view', table_type: 'VIEW' },
];
const COLUMNS = [
	{ schema_name: 'public', table_name: 'departments', column_name: 'dept_id', data_type: 'integer', is_nullable: 'NO', column_default: null },
	{ schema_name: 'public', table_name: 'departments', column_name: 'dname', data_type: 'character varying(100)', is_nullable: 'YES', column_default: null },
	{ schema_name: 'public', table_name: 'employees', column_name: 'employee_id', data_type: 'integer', is_nullable: false, column_default: null },
	{ schema_name: 'public', table_name: 'employees', column_name: 'dept_id', data_type: 'integer', is_nullable: true, column_default: null },
	{ schema_name: 'public', table_name: 'employees', column_name: 'salary', data_type: 'numeric(10,2)', is_nullable: 'YES', column_default: '0' },
];
const PKS = [
	{ schema_name: 'public', table_name: 'employees', constraint_name: 'employees_pkey', column_name: 'employee_id', referenced_table: null, referenced_column: null },
];
const FKS = [
	{ schema_name: 'public', table_name: 'employees', constraint_name: 'employees_dept_fkey', column_name: 'dept_id', referenced_table: 'departments', referenced_column: 'dept_id' },
];
const VIEWS = [
	{ schema_name: 'public', table_name: 'emp_view', definition: 'SELECT employee_id, salary FROM employees' },
];
const STATS = [
	{ schema_name: 'public', table_name: 'employees', row_count: '4200', size_mb: '3', unsorted: '0', stats_off: '0' },
];

/** Dispatch a query to canned rows by the system view it reads. Records each SQL seen. */
function makeRunner(seen: string[], fail: (sql: string) => boolean = () => false): RedshiftRowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (fail(sql)) {
			throw new Error('ERROR: relation "svv_table_info" does not exist');
		}
		if (sql.includes('MD5(')) {
			return [{ n: 5, h: 123456 }];
		}
		if (sql.includes('svv_all_tables')) {
			return sql.includes("table_type <> 'VIEW'") ? TABLES.filter((t) => t.table_type !== 'VIEW') : TABLES;
		}
		if (sql.includes('svv_all_columns')) {
			return COLUMNS;
		}
		if (sql.includes("'PRIMARY KEY'")) {
			return PKS;
		}
		if (sql.includes("'FOREIGN KEY'")) {
			return FKS;
		}
		if (sql.includes('pg_get_viewdef')) {
			return VIEWS;
		}
		if (sql.includes('svv_table_info')) {
			return STATS;
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectRedshift assembles tables, columns, keys, views and stats', async () => {
	const schema = await introspectRedshift(makeRunner([]), 'analytics', true);

	assert.equal(schema.database, 'analytics');
	assert.deepEqual(schema.tables.map((t) => t.name), ['departments', 'employees', 'emp_view']);

	const employees = schema.tables.find((t) => t.name === 'employees');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	assert.deepEqual(employees.columns.map((c) => c.name), ['employee_id', 'dept_id', 'salary']);
	// is_nullable arrives as 'YES'/'NO' from information_schema-shaped views and as a real boolean
	// from the SVV_* ones; both spellings must land the same way.
	assert.equal(employees.columns.find((c) => c.name === 'employee_id')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'dept_id')?.nullable, true);
	assert.equal(employees.columns.find((c) => c.name === 'salary')?.nullable, true);
	assert.deepEqual(employees.primaryKey, ['employee_id']);
	assert.equal(employees.columns.find((c) => c.name === 'employee_id')?.isPrimaryKey, true);
	assert.deepEqual(employees.foreignKeys, [{
		constraintName: 'employees_dept_fkey',
		columns: ['dept_id'],
		referencedTable: 'departments',
		referencedColumns: ['dept_id'],
	}]);
	// Redshift has neither secondary indexes nor triggers.
	assert.deepEqual(employees.indexes, []);
	assert.equal(employees.triggers, undefined);
	// SVV_TABLE_INFO reports size in 1 MB blocks.
	assert.equal(employees.stats?.rowCount, 4200);
	assert.equal(employees.stats?.totalBytes, 3 * 1024 * 1024);

	const view = schema.tables.find((t) => t.name === 'emp_view');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, 'SELECT employee_id, salary FROM employees');
});

test('introspectRedshift filters out the catalog schemas', async () => {
	const seen: string[] = [];
	await introspectRedshift(makeRunner(seen), 'analytics', true);
	assert.ok(seen.length > 0);
	for (const sql of seen) {
		assert.ok(sql.includes("'pg_catalog'") && sql.includes("'information_schema'"), `query missing system-schema filter: ${sql}`);
	}
});

test('introspectRedshift omits the view query when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectRedshift(makeRunner(seen), 'analytics', false);
	assert.ok(!seen.some((s) => s.includes('pg_get_viewdef')), 'should not query view bodies');
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
});

test('introspectRedshift survives a system view this cluster does not have', async () => {
	// An older cluster generation without SVV_TABLE_INFO must still introspect tables + columns,
	// just without stats — not fail the whole refresh.
	const schema = await introspectRedshift(makeRunner([], (sql) => sql.includes('svv_table_info')), 'analytics', true);
	assert.equal(schema.tables.length, 3);
	assert.equal(schema.tables.find((t) => t.name === 'employees')?.stats, undefined);
});

test('redshiftStructuralDigest returns a count:hash fingerprint', async () => {
	const digest = await redshiftStructuralDigest(makeRunner([]));
	assert.equal(digest, '5:123456');
});

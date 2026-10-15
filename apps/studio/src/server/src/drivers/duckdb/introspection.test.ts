/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectDuckDb, duckdbStructuralDigest, type DuckDbRowRunner } from './introspection';

// Canned information_schema + duckdb_* catalog rows for a tiny two-table + one-view schema.
// (Shapes match @duckdb/node-api's getRowObjectsJson(): LIST columns arrive as real JS arrays.)
const TABLES = [
	{ table_schema: 'main', table_name: 'departments', table_type: 'BASE TABLE' },
	{ table_schema: 'main', table_name: 'emp_view', table_type: 'VIEW' },
	{ table_schema: 'main', table_name: 'employees', table_type: 'BASE TABLE' },
];
const COLUMNS = [
	{ table_schema: 'main', table_name: 'departments', column_name: 'dept_id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
	{ table_schema: 'main', table_name: 'departments', column_name: 'dname', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
	{ table_schema: 'main', table_name: 'emp_view', column_name: 'employee_id', data_type: 'INTEGER', is_nullable: 'YES', column_default: null },
	{ table_schema: 'main', table_name: 'emp_view', column_name: 'name', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
	{ table_schema: 'main', table_name: 'employees', column_name: 'employee_id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
	{ table_schema: 'main', table_name: 'employees', column_name: 'dept_id', data_type: 'INTEGER', is_nullable: 'YES', column_default: null },
	{ table_schema: 'main', table_name: 'employees', column_name: 'name', data_type: 'VARCHAR', is_nullable: 'NO', column_default: null },
	{ table_schema: 'main', table_name: 'employees', column_name: 'salary', data_type: 'DOUBLE', is_nullable: 'YES', column_default: '0' },
];
const CONSTRAINTS = [
	{ schema_name: 'main', table_name: 'departments', constraint_type: 'PRIMARY KEY', constraint_column_names: ['dept_id'], referenced_table: null, referenced_column_names: [] },
	{ schema_name: 'main', table_name: 'employees', constraint_type: 'PRIMARY KEY', constraint_column_names: ['employee_id'], referenced_table: null, referenced_column_names: [] },
	{ schema_name: 'main', table_name: 'employees', constraint_type: 'FOREIGN KEY', constraint_column_names: ['dept_id'], referenced_table: 'departments', referenced_column_names: ['dept_id'] },
];
const INDEXES = [
	{ schema_name: 'main', table_name: 'employees', index_name: 'ix_emp_name', is_unique: false, sql: 'CREATE INDEX ix_emp_name ON employees("name");' },
];
const VIEWS = [
	{ schema_name: 'main', view_name: 'emp_view', sql: 'CREATE VIEW emp_view AS SELECT employee_id, name FROM employees;' },
];

function makeRunner(seen: string[]): DuckDbRowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (sql.includes('duckdb_constraints()')) {
			return CONSTRAINTS as unknown as Record<string, unknown>[];
		}
		if (sql.includes('duckdb_indexes()')) {
			return INDEXES as unknown as Record<string, unknown>[];
		}
		if (sql.includes('duckdb_views()')) {
			return VIEWS as unknown as Record<string, unknown>[];
		}
		if (sql.includes('information_schema.columns')) {
			// The introspection column query carries is_nullable; the digest query does not.
			if (sql.includes('is_nullable')) {
				return COLUMNS as Record<string, unknown>[];
			}
			return COLUMNS.map((c, i) => ({ ...c, ordinal_position: i + 1 })) as Record<string, unknown>[];
		}
		if (sql.includes('information_schema.tables')) {
			const includeViews = sql.includes("'VIEW'");
			return (includeViews ? TABLES : TABLES.filter((t) => t.table_type !== 'VIEW')) as Record<string, unknown>[];
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectDuckDb assembles tables, columns, PK, FK, indexes and views', async () => {
	const schema = await introspectDuckDb(makeRunner([]), '/data/app.duckdb', true);

	assert.equal(schema.database, 'app.duckdb');
	assert.deepEqual(schema.tables.map((t) => t.name), ['departments', 'emp_view', 'employees']);
	assert.equal(schema.routines, undefined);

	const employees = schema.tables.find((t) => t.name === 'employees');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	assert.equal(employees.schema, 'main');
	assert.deepEqual(employees.columns.map((c) => `${c.name} ${c.dataType}`), ['employee_id INTEGER', 'dept_id INTEGER', 'name VARCHAR', 'salary DOUBLE']);
	assert.deepEqual(employees.primaryKey, ['employee_id']);
	assert.equal(employees.columns.find((c) => c.name === 'employee_id')?.isPrimaryKey, true);
	assert.equal(employees.columns.find((c) => c.name === 'name')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'salary')?.default, '0');

	// FK: DuckDB FKs are anonymous, so the constraint name is synthesised; referenced table/columns
	// come straight from duckdb_constraints().
	assert.deepEqual(employees.foreignKeys, [{
		constraintName: 'fk_employees_dept_id',
		columns: ['dept_id'],
		referencedTable: 'departments',
		referencedColumns: ['dept_id'],
	}]);

	// Secondary index columns parsed out of the CREATE INDEX text (quotes stripped).
	assert.deepEqual(employees.indexes, [{ name: 'ix_emp_name', columns: ['name'], unique: false }]);

	const view = schema.tables.find((t) => t.name === 'emp_view');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, VIEWS[0].sql);
});

test('introspectDuckDb omits views and the view query when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectDuckDb(makeRunner(seen), '/data/app.duckdb', false);
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
	assert.ok(!seen.some((s) => s.includes('duckdb_views()')), 'view bodies are not queried when includeViews is false');
	const tablesQuery = seen.find((s) => s.includes('information_schema.tables'));
	assert.ok(tablesQuery && !tablesQuery.includes("'VIEW'"), 'tables query should not request the VIEW type');
});

test('duckdbStructuralDigest returns a count:hash fingerprint and is deterministic', async () => {
	const a = await duckdbStructuralDigest(makeRunner([]));
	const b = await duckdbStructuralDigest(makeRunner([]));
	assert.match(a, /^8:\d+$/);
	assert.equal(a, b);
});

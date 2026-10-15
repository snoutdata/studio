/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectHana, hanaStructuralDigest, type HanaRowRunner } from './introspection';

// Canned SYS.* rows for a tiny two-table + one-view schema in "HR".
const TABLES = [
	{ schema_name: 'HR', table_name: 'DEPARTMENTS', table_kind: 'TABLE' },
	{ schema_name: 'HR', table_name: 'EMPLOYEES', table_kind: 'TABLE' },
];
const VIEWS = [
	{ schema_name: 'HR', table_name: 'EMP_VIEW', definition: 'SELECT EMPLOYEE_ID, SALARY FROM EMPLOYEES' },
];
const COLUMNS = [
	{ schema_name: 'HR', table_name: 'DEPARTMENTS', column_name: 'DEPT_ID', data_type_name: 'INTEGER', length: 10, scale: null, is_nullable: 'FALSE', default_value: null, comments: null },
	{ schema_name: 'HR', table_name: 'DEPARTMENTS', column_name: 'DNAME', data_type_name: 'NVARCHAR', length: 100, scale: null, is_nullable: 'TRUE', default_value: null, comments: 'department name' },
	{ schema_name: 'HR', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID', data_type_name: 'INTEGER', length: 10, scale: null, is_nullable: 'FALSE', default_value: null, comments: null },
	{ schema_name: 'HR', table_name: 'EMPLOYEES', column_name: 'DEPT_ID', data_type_name: 'INTEGER', length: 10, scale: null, is_nullable: 'TRUE', default_value: null, comments: null },
	{ schema_name: 'HR', table_name: 'EMPLOYEES', column_name: 'SALARY', data_type_name: 'DECIMAL', length: 10, scale: 2, is_nullable: 'TRUE', default_value: '0', comments: null },
];
const VIEW_COLUMNS = [
	{ schema_name: 'HR', table_name: 'EMP_VIEW', column_name: 'EMPLOYEE_ID', data_type_name: 'INTEGER', length: 10, scale: null, is_nullable: 'FALSE', default_value: null, comments: null },
	{ schema_name: 'HR', table_name: 'EMP_VIEW', column_name: 'SALARY', data_type_name: 'DECIMAL', length: 10, scale: 2, is_nullable: 'TRUE', default_value: null, comments: null },
];
const PKS = [
	{ schema_name: 'HR', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID' },
];
const FKS = [
	{ schema_name: 'HR', table_name: 'EMPLOYEES', constraint_name: 'FK_EMP_DEPT', column_name: 'DEPT_ID', referenced_table: 'DEPARTMENTS', referenced_column: 'DEPT_ID' },
];
const INDEXES = [
	{ schema_name: 'HR', table_name: 'EMPLOYEES', index_name: 'IX_EMP_DEPT', index_type: 'CPBTREE UNIQUE', column_name: 'DEPT_ID' },
];
const TRIGGERS = [
	{ schema_name: 'HR', table_name: 'EMPLOYEES', trigger_name: 'TRG_EMP_AUDIT', action_time: 'AFTER', trigger_event: 'INSERT', definition: 'BEGIN END' },
];
const ROUTINES = [
	{ routine_schema: 'HR', routine_name: 'RAISE_SALARY', routine_kind: 'procedure', definition: 'CREATE PROCEDURE RAISE_SALARY AS BEGIN END' },
];
const PARAMETERS = [
	{ routine_schema: 'HR', routine_name: 'RAISE_SALARY', routine_kind: 'procedure', parameter_name: 'PCT', data_type_name: 'DECIMAL', parameter_type: 'IN' },
];
const STATS = [
	{ schema_name: 'HR', table_name: 'EMPLOYEES', record_count: '4200', table_size: '1048576' },
];

/** Dispatch a query to canned rows by the SYS view it reads. Records each SQL seen. */
function makeRunner(seen: string[]): HanaRowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (sql.includes('/* digest */')) {
			return COLUMNS.map((c, i) => ({ schema_name: c.schema_name, table_name: c.table_name, column_name: c.column_name, data_type_name: c.data_type_name, position: i + 1 }));
		}
		if (sql.includes('SYS.TABLE_COLUMNS')) {
			return COLUMNS;
		}
		if (sql.includes('SYS.VIEW_COLUMNS')) {
			return VIEW_COLUMNS;
		}
		if (sql.includes('SYS.TABLES')) {
			return TABLES;
		}
		if (sql.includes('SYS.VIEWS')) {
			return VIEWS;
		}
		if (sql.includes('SYS.CONSTRAINTS')) {
			return PKS;
		}
		if (sql.includes('SYS.REFERENTIAL_CONSTRAINTS')) {
			return FKS;
		}
		if (sql.includes('SYS.INDEXES')) {
			return INDEXES;
		}
		if (sql.includes('SYS.TRIGGERS')) {
			return TRIGGERS;
		}
		if (sql.includes('SYS.PROCEDURE_PARAMETERS')) {
			return PARAMETERS;
		}
		if (sql.includes('SYS.PROCEDURES')) {
			return ROUTINES;
		}
		if (sql.includes('SYS.M_TABLES')) {
			return STATS;
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectHana assembles tables, columns, keys, indexes, triggers and stats', async () => {
	const schema = await introspectHana(makeRunner([]), 'HXE', true);

	assert.equal(schema.database, 'HXE');
	assert.deepEqual(schema.tables.map((t) => t.name), ['DEPARTMENTS', 'EMPLOYEES', 'EMP_VIEW']);

	const employees = schema.tables.find((t) => t.name === 'EMPLOYEES');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	// composeType: DECIMAL(p,s) and NVARCHAR(n) carry a suffix; INTEGER does not.
	assert.deepEqual(
		employees.columns.map((c) => `${c.name} ${c.dataType}`),
		['EMPLOYEE_ID INTEGER', 'DEPT_ID INTEGER', 'SALARY DECIMAL(10,2)'],
	);
	assert.equal(employees.columns.find((c) => c.name === 'EMPLOYEE_ID')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'SALARY')?.default, '0');
	assert.deepEqual(employees.primaryKey, ['EMPLOYEE_ID']);
	assert.equal(employees.columns.find((c) => c.name === 'EMPLOYEE_ID')?.isPrimaryKey, true);
	assert.deepEqual(employees.foreignKeys, [{
		constraintName: 'FK_EMP_DEPT',
		columns: ['DEPT_ID'],
		referencedTable: 'DEPARTMENTS',
		referencedColumns: ['DEPT_ID'],
	}]);
	// INDEX_TYPE spells uniqueness out ('CPBTREE UNIQUE'), so it's a substring test.
	assert.deepEqual(employees.indexes, [{ name: 'IX_EMP_DEPT', columns: ['DEPT_ID'], unique: true }]);
	assert.deepEqual(employees.triggers, [{ name: 'TRG_EMP_AUDIT', timing: 'AFTER', event: 'INSERT', statement: 'BEGIN END' }]);
	assert.equal(employees.stats?.rowCount, 4200);
	assert.equal(employees.stats?.totalBytes, 1048576);

	const departments = schema.tables.find((t) => t.name === 'DEPARTMENTS');
	assert.equal(departments?.columns.find((c) => c.name === 'DNAME')?.dataType, 'NVARCHAR(100)');
	assert.equal(departments?.columns.find((c) => c.name === 'DNAME')?.comment, 'department name');

	assert.deepEqual(schema.routines, [{
		name: 'RAISE_SALARY',
		schema: 'HR',
		kind: 'procedure',
		parameters: [{ name: 'PCT', dataType: 'DECIMAL', mode: 'IN' }],
		definition: 'CREATE PROCEDURE RAISE_SALARY AS BEGIN END',
	}]);
});

test('introspectHana merges views in from their own catalog views, with their columns', async () => {
	// SYS.VIEWS / SYS.VIEW_COLUMNS are separate from SYS.TABLES / SYS.TABLE_COLUMNS; a view read from
	// only the table side would show up with no columns.
	const schema = await introspectHana(makeRunner([]), 'HXE', true);
	const view = schema.tables.find((t) => t.name === 'EMP_VIEW');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, 'SELECT EMPLOYEE_ID, SALARY FROM EMPLOYEES');
	assert.deepEqual(view?.columns.map((c) => c.name), ['EMPLOYEE_ID', 'SALARY']);
});

test('introspectHana filters out the SYS and _SYS_* schemas', async () => {
	const seen: string[] = [];
	await introspectHana(makeRunner(seen), 'HXE', true);
	assert.ok(seen.length > 0);
	for (const sql of seen) {
		assert.ok(/<> 'SYS'/.test(sql) && /LEFT\([^)]+, 4\) <> '_SYS'/.test(sql), `query missing system-schema filter: ${sql}`);
	}
});

test('introspectHana omits the view queries when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectHana(makeRunner(seen), 'HXE', false);
	assert.ok(!seen.some((s) => s.includes('SYS.VIEWS')), 'should not query view bodies');
	assert.ok(!seen.some((s) => s.includes('SYS.VIEW_COLUMNS')), 'should not query view columns');
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
});

test('hanaStructuralDigest returns a stable count:hash fingerprint that moves with the schema', async () => {
	const digest = await hanaStructuralDigest(makeRunner([]));
	assert.match(digest, /^5:\d+$/);
	// Same input → same fingerprint (the live schema index compares them across polls).
	assert.equal(digest, await hanaStructuralDigest(makeRunner([])));
	// A renamed column changes it.
	const renamed: HanaRowRunner = async () => COLUMNS.map((c, i) => ({
		schema_name: c.schema_name,
		table_name: c.table_name,
		column_name: c.column_name === 'SALARY' ? 'PAY' : c.column_name,
		data_type_name: c.data_type_name,
		position: i + 1,
	}));
	assert.notEqual(digest, await hanaStructuralDigest(renamed));
});

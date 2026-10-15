/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectOracle, oracleStructuralDigest, type OracleRowRunner } from './introspection';

// Canned ALL_* rows for a tiny two-table + one-view + routines schema in user schema "EMP".
const TABLES = [
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', table_type: 'TABLE' },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', table_type: 'TABLE' },
	{ table_schema: 'EMP', table_name: 'EMP_VIEW', table_type: 'VIEW' },
];
const COLUMNS = [
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', column_name: 'DEPT_ID', data_type: 'NUMBER', data_precision: 10, data_scale: 0, data_length: 22, char_length: null, nullable: 'N', data_default: null },
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', column_name: 'DNAME', data_type: 'VARCHAR2', data_precision: null, data_scale: null, data_length: 100, char_length: 100, nullable: 'Y', data_default: null },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID', data_type: 'NUMBER', data_precision: 10, data_scale: 0, data_length: 22, char_length: null, nullable: 'N', data_default: null },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'DEPT_ID', data_type: 'NUMBER', data_precision: 10, data_scale: 0, data_length: 22, char_length: null, nullable: 'Y', data_default: null },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'NAME', data_type: 'VARCHAR2', data_precision: null, data_scale: null, data_length: 255, char_length: 255, nullable: 'N', data_default: null },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'SALARY', data_type: 'NUMBER', data_precision: 10, data_scale: 2, data_length: 22, char_length: null, nullable: 'Y', data_default: '0' },
];
const PKS = [
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', column_name: 'DEPT_ID' },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID' },
];
const FKS = [
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', constraint_name: 'FK_EMP_DEPT', column_name: 'DEPT_ID', referenced_table: 'DEPARTMENTS', referenced_column: 'DEPT_ID' },
];
const INDEXES = [
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', index_name: 'IX_EMP_NAME', uniqueness: 'NONUNIQUE', column_name: 'NAME' },
];
const VIEWS = [
	{ table_schema: 'EMP', table_name: 'EMP_VIEW', definition: 'SELECT employee_id, name FROM employees' },
];
const ROUTINES = [
	{ routine_schema: 'EMP', routine_name: 'GET_BONUS', routine_type: 'FUNCTION' },
	{ routine_schema: 'EMP', routine_name: 'UPDATE_SAL', routine_type: 'PROCEDURE' },
];
const PARAMETERS = [
	{ routine_schema: 'EMP', routine_name: 'GET_BONUS', parameter_name: 'P_ID', data_type: 'NUMBER', parameter_mode: 'IN' },
];

/** Dispatch a query to canned rows by the dictionary view it reads. Records each SQL it saw. */
function makeRunner(seen: string[]): OracleRowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (sql.includes('ORA_HASH')) {
			return [{ n: 6, h: 123456 }];
		}
		if (sql.includes('all_tables')) {
			// The tables query only UNIONs in all_views when views are in scope; mirror that so
			// the includeViews=false path returns base tables only.
			return sql.includes('all_views') ? TABLES : TABLES.filter((t) => t.table_type !== 'VIEW');
		}
		if (sql.includes('all_tab_columns')) {
			return COLUMNS;
		}
		if (sql.includes("constraint_type = 'R'")) {
			return FKS;
		}
		if (sql.includes('all_indexes')) {
			return INDEXES;
		}
		if (sql.includes('all_triggers')) {
			return [];
		}
		if (sql.includes('all_views')) {
			return VIEWS;
		}
		if (sql.includes('all_procedures')) {
			return ROUTINES;
		}
		if (sql.includes('all_arguments')) {
			return PARAMETERS;
		}
		if (sql.includes("constraint_type = 'P'")) {
			return PKS;
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectOracle assembles tables, columns, PK, FK, indexes and views', async () => {
	const seen: string[] = [];
	const schema = await introspectOracle(makeRunner(seen), 'ORCLPDB1', true);

	assert.equal(schema.database, 'ORCLPDB1');
	assert.deepEqual(schema.tables.map((t) => t.name), ['DEPARTMENTS', 'EMPLOYEES', 'EMP_VIEW']);

	const employees = schema.tables.find((t) => t.name === 'EMPLOYEES');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	// composeType: NUMBER(p,s), NUMBER(p), VARCHAR2(n).
	assert.deepEqual(
		employees.columns.map((c) => `${c.name} ${c.dataType}`),
		['EMPLOYEE_ID NUMBER(10)', 'DEPT_ID NUMBER(10)', 'NAME VARCHAR2(255)', 'SALARY NUMBER(10,2)'],
	);
	assert.deepEqual(employees.primaryKey, ['EMPLOYEE_ID']);
	assert.equal(employees.columns.find((c) => c.name === 'EMPLOYEE_ID')?.isPrimaryKey, true);
	assert.equal(employees.columns.find((c) => c.name === 'NAME')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'SALARY')?.default, '0');

	// FK resolves the referenced table+column via the constraint-reference join.
	assert.equal(employees.foreignKeys.length, 1);
	assert.deepEqual(employees.foreignKeys[0], {
		constraintName: 'FK_EMP_DEPT',
		columns: ['DEPT_ID'],
		referencedTable: 'DEPARTMENTS',
		referencedColumns: ['DEPT_ID'],
	});

	// Secondary index carried; uniqueness mapped to a boolean.
	assert.deepEqual(employees.indexes, [{ name: 'IX_EMP_NAME', columns: ['NAME'], unique: false }]);

	const view = schema.tables.find((t) => t.name === 'EMP_VIEW');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, 'SELECT employee_id, name FROM employees');
});

test('introspectOracle reads routines + their parameters', async () => {
	const schema = await introspectOracle(makeRunner([]), 'ORCLPDB1', true);
	assert.deepEqual(schema.routines?.map((r) => `${r.kind} ${r.name}`), ['function GET_BONUS', 'procedure UPDATE_SAL']);
	const fn = schema.routines?.find((r) => r.name === 'GET_BONUS');
	assert.deepEqual(fn?.parameters, [{ name: 'P_ID', dataType: 'NUMBER', mode: 'IN' }]);
});

test('introspectOracle excludes Oracle system schemas in every query', async () => {
	const seen: string[] = [];
	await introspectOracle(makeRunner(seen), 'ORCLPDB1', true);
	assert.ok(seen.length > 0);
	for (const sql of seen) {
		assert.ok(sql.includes("'SYS'") && sql.includes('NOT IN'), `query missing system-schema filter: ${sql}`);
	}
});

test('introspectOracle omits the view query when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectOracle(makeRunner(seen), 'ORCLPDB1', false);
	assert.ok(!seen.some((s) => s.includes('all_views')), 'should not query all_views');
	assert.ok(seen.some((s) => s.includes('all_tables')));
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
});

test('oracleStructuralDigest returns a count:hash fingerprint', async () => {
	const digest = await oracleStructuralDigest(makeRunner([]));
	assert.equal(digest, '6:123456');
});

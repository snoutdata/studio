/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectDb2, db2StructuralDigest, type Db2RowRunner } from './introspection';

// Canned SYSCAT.* rows for a tiny two-table + one-view + routines schema in user schema "EMP".
const TABLES = [
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', table_type: 'T' },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', table_type: 'T' },
	{ table_schema: 'EMP', table_name: 'EMP_VIEW', table_type: 'V' },
];
const COLUMNS = [
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', column_name: 'DEPT_ID', type_name: 'INTEGER', length: 4, scale: 0, nulls: 'N', default: null, keyseq: 1, colno: 0 },
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', column_name: 'DNAME', type_name: 'VARCHAR', length: 100, scale: 0, nulls: 'Y', default: null, keyseq: null, colno: 1 },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID', type_name: 'INTEGER', length: 4, scale: 0, nulls: 'N', default: null, keyseq: 1, colno: 0 },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'DEPT_ID', type_name: 'INTEGER', length: 4, scale: 0, nulls: 'Y', default: null, keyseq: null, colno: 1 },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'NAME', type_name: 'VARCHAR', length: 255, scale: 0, nulls: 'N', default: null, keyseq: null, colno: 2 },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'SALARY', type_name: 'DECIMAL', length: 10, scale: 2, nulls: 'Y', default: '0', keyseq: null, colno: 3 },
];
const PKS = [
	{ table_schema: 'EMP', table_name: 'DEPARTMENTS', column_name: 'DEPT_ID' },
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID' },
];
const FKS = [
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', constraint_name: 'FK_EMP_DEPT', column_name: 'DEPT_ID', referenced_table: 'DEPARTMENTS', referenced_column: 'DEPT_ID' },
];
const INDEXES = [
	{ table_schema: 'EMP', table_name: 'EMPLOYEES', index_name: 'IX_EMP_NAME', uniquerule: 'D', column_name: 'NAME' },
];
const VIEWS = [
	{ table_schema: 'EMP', table_name: 'EMP_VIEW', text: 'CREATE VIEW EMP.EMP_VIEW AS SELECT employee_id, name FROM employees' },
];
const ROUTINES = [
	{ routine_schema: 'EMP', routine_name: 'GET_BONUS', routine_type: 'F' },
	{ routine_schema: 'EMP', routine_name: 'UPDATE_SAL', routine_type: 'P' },
];
const PARAMETERS = [
	{ routine_schema: 'EMP', routine_name: 'GET_BONUS', parameter_name: 'P_ID', type_name: 'INTEGER', rowtype: 'P' },
];

/** Dispatch a query to canned rows by the catalog view it reads. Records each SQL it saw. */
function makeRunner(seen: string[]): Db2RowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (sql.includes('/* digest */')) {
			return COLUMNS.map((c) => ({ table_schema: c.table_schema, table_name: c.table_name, column_name: c.column_name, type_name: c.type_name, colno: c.colno }));
		}
		if (sql.includes('SYSCAT.TABLES')) {
			// The tables query only includes views when they're in scope; mirror that so the
			// includeViews=false path returns base tables only.
			return sql.includes("'V'") ? TABLES : TABLES.filter((t) => t.table_type !== 'V');
		}
		if (sql.includes('KEYSEQ IS NOT NULL')) {
			return PKS;
		}
		if (sql.includes('SYSCAT.COLUMNS')) {
			return COLUMNS;
		}
		if (sql.includes('SYSCAT.REFERENCES')) {
			return FKS;
		}
		if (sql.includes('SYSCAT.INDEXES')) {
			return INDEXES;
		}
		if (sql.includes('SYSCAT.TRIGGERS')) {
			return [];
		}
		if (sql.includes('SYSCAT.VIEWS')) {
			return VIEWS;
		}
		if (sql.includes('SYSCAT.ROUTINES')) {
			return ROUTINES;
		}
		if (sql.includes('SYSCAT.ROUTINEPARMS')) {
			return PARAMETERS;
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectDb2 assembles tables, columns, PK, FK, indexes and views', async () => {
	const seen: string[] = [];
	const schema = await introspectDb2(makeRunner(seen), 'SAMPLE', true);

	assert.equal(schema.database, 'SAMPLE');
	assert.deepEqual(schema.tables.map((t) => t.name), ['DEPARTMENTS', 'EMPLOYEES', 'EMP_VIEW']);

	const employees = schema.tables.find((t) => t.name === 'EMPLOYEES');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	// composeType: INTEGER (bare), VARCHAR(n), DECIMAL(p,s).
	assert.deepEqual(
		employees.columns.map((c) => `${c.name} ${c.dataType}`),
		['EMPLOYEE_ID INTEGER', 'DEPT_ID INTEGER', 'NAME VARCHAR(255)', 'SALARY DECIMAL(10,2)'],
	);
	assert.deepEqual(employees.primaryKey, ['EMPLOYEE_ID']);
	assert.equal(employees.columns.find((c) => c.name === 'EMPLOYEE_ID')?.isPrimaryKey, true);
	assert.equal(employees.columns.find((c) => c.name === 'NAME')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'SALARY')?.default, '0');

	// FK resolves the referenced table+column via the KEYCOLUSE position join.
	assert.equal(employees.foreignKeys.length, 1);
	assert.deepEqual(employees.foreignKeys[0], {
		constraintName: 'FK_EMP_DEPT',
		columns: ['DEPT_ID'],
		referencedTable: 'DEPARTMENTS',
		referencedColumns: ['DEPT_ID'],
	});

	// Secondary index carried; UNIQUERULE 'D' (duplicates allowed) → unique:false.
	assert.deepEqual(employees.indexes, [{ name: 'IX_EMP_NAME', columns: ['NAME'], unique: false }]);

	const view = schema.tables.find((t) => t.name === 'EMP_VIEW');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, 'CREATE VIEW EMP.EMP_VIEW AS SELECT employee_id, name FROM employees');
});

test('introspectDb2 reads routines + their parameters', async () => {
	const schema = await introspectDb2(makeRunner([]), 'SAMPLE', true);
	assert.deepEqual(schema.routines?.map((r) => `${r.kind} ${r.name}`), ['function GET_BONUS', 'procedure UPDATE_SAL']);
	const fn = schema.routines?.find((r) => r.name === 'GET_BONUS');
	assert.deepEqual(fn?.parameters, [{ name: 'P_ID', dataType: 'INTEGER', mode: 'IN' }]);
});

test('introspectDb2 excludes Db2 system schemas in every query', async () => {
	const seen: string[] = [];
	await introspectDb2(makeRunner(seen), 'SAMPLE', true);
	assert.ok(seen.length > 0);
	for (const sql of seen) {
		assert.ok(sql.includes("NOT LIKE 'SYS%'") && sql.includes("'SYSIBM'"), `query missing system-schema filter: ${sql}`);
	}
});

test('introspectDb2 omits the view query when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectDb2(makeRunner(seen), 'SAMPLE', false);
	assert.ok(!seen.some((s) => s.includes('SYSCAT.VIEWS')), 'should not query SYSCAT.VIEWS');
	assert.ok(seen.some((s) => s.includes('SYSCAT.TABLES')));
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
});

test('db2StructuralDigest returns a count:hash fingerprint that changes with structure', async () => {
	const digest = await db2StructuralDigest(makeRunner([]));
	assert.match(digest, /^6:\d+$/);
	// A renamed column changes the fingerprint.
	const mutated: Db2RowRunner = async (sql) => {
		if (sql.includes('/* digest */')) {
			return [{ table_schema: 'EMP', table_name: 'EMPLOYEES', column_name: 'RENAMED', type_name: 'INTEGER', colno: 0 }];
		}
		throw new Error('unexpected');
	};
	assert.notEqual(await db2StructuralDigest(mutated), digest);
});

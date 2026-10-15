/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introspectSqlite, sqliteStructuralDigest, type SqliteRowRunner } from './introspection';

// Canned sqlite_master + PRAGMA rows for a tiny two-table + one-view + one-trigger schema.
const MASTER = [
	{ name: 'departments', type: 'table', sql: 'CREATE TABLE departments(dept_id INTEGER PRIMARY KEY, dname TEXT)' },
	{ name: 'emp_view', type: 'view', sql: 'CREATE VIEW emp_view AS SELECT employee_id, name FROM employees' },
	{ name: 'employees', type: 'table', sql: 'CREATE TABLE employees(employee_id INTEGER PRIMARY KEY, dept_id INTEGER, name TEXT NOT NULL, salary REAL DEFAULT 0, FOREIGN KEY(dept_id) REFERENCES departments(dept_id))' },
];
const TABLE_INFO: Record<string, unknown[]> = {
	departments: [
		{ cid: 0, name: 'dept_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
		{ cid: 1, name: 'dname', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
	],
	employees: [
		{ cid: 0, name: 'employee_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
		{ cid: 1, name: 'dept_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
		{ cid: 2, name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
		{ cid: 3, name: 'salary', type: 'REAL', notnull: 0, dflt_value: '0', pk: 0 },
	],
	emp_view: [
		{ cid: 0, name: 'employee_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
		{ cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
	],
};
// `to` is null to exercise the implicit-referenced-column fill from the parent table's PK.
const FK_LIST: Record<string, unknown[]> = {
	departments: [],
	employees: [{ id: 0, seq: 0, table: 'departments', from: 'dept_id', to: null }],
};
const INDEX_LIST: Record<string, unknown[]> = {
	departments: [],
	employees: [
		{ seq: 0, name: 'ix_emp_name', unique: 0, origin: 'c', partial: 0 },
		// The PK's auto-index (origin 'pk') must be skipped — the PK is carried separately.
		{ seq: 1, name: 'sqlite_autoindex_employees_1', unique: 1, origin: 'pk', partial: 0 },
	],
};
const INDEX_INFO: Record<string, unknown[]> = {
	ix_emp_name: [{ seqno: 0, cid: 2, name: 'name' }],
};
const TRIGGERS = [
	{ name: 'trg_emp_ai', tbl_name: 'employees', sql: 'CREATE TRIGGER trg_emp_ai AFTER INSERT ON employees BEGIN UPDATE departments SET dname = dname; END' },
];
const DIGEST = [
	{ type: 'table', name: 'departments', sql: MASTER[0].sql },
	{ type: 'table', name: 'employees', sql: MASTER[2].sql },
	{ type: 'view', name: 'emp_view', sql: MASTER[1].sql },
	{ type: 'index', name: 'ix_emp_name', sql: 'CREATE INDEX ix_emp_name ON employees(name)' },
	{ type: 'trigger', name: 'trg_emp_ai', sql: TRIGGERS[0].sql },
];

/** Extract the quoted identifier from a `PRAGMA foo("name")` call. */
function pragmaArg(sql: string): string {
	const m = sql.match(/\("([^"]+)"\)/);
	return m ? m[1] : '';
}

function makeRunner(seen: string[]): SqliteRowRunner {
	return async (sql: string) => {
		seen.push(sql);
		if (sql.includes('PRAGMA table_info')) {
			return TABLE_INFO[pragmaArg(sql)] as Record<string, unknown>[];
		}
		if (sql.includes('PRAGMA foreign_key_list')) {
			return FK_LIST[pragmaArg(sql)] as Record<string, unknown>[];
		}
		if (sql.includes('PRAGMA index_list')) {
			return INDEX_LIST[pragmaArg(sql)] as Record<string, unknown>[];
		}
		if (sql.includes('PRAGMA index_info')) {
			return (INDEX_INFO[pragmaArg(sql)] ?? []) as Record<string, unknown>[];
		}
		if (sql.includes("type = 'trigger'")) {
			return TRIGGERS as Record<string, unknown>[];
		}
		if (sql.includes("'index', 'trigger'")) {
			return DIGEST as Record<string, unknown>[];
		}
		if (sql.includes('sqlite_master')) {
			const includeViews = sql.includes("'view'");
			return (includeViews ? MASTER : MASTER.filter((r) => r.type === 'table')) as Record<string, unknown>[];
		}
		throw new Error(`unexpected query: ${sql}`);
	};
}

test('introspectSqlite assembles tables, columns, PK, FK (implicit ref), indexes and views', async () => {
	const schema = await introspectSqlite(makeRunner([]), '/data/app.db', true);

	assert.equal(schema.database, 'app.db');
	assert.deepEqual(schema.tables.map((t) => t.name), ['departments', 'emp_view', 'employees']);
	assert.equal(schema.routines, undefined);

	const employees = schema.tables.find((t) => t.name === 'employees');
	assert.ok(employees);
	assert.equal(employees.kind, 'table');
	assert.deepEqual(employees.columns.map((c) => `${c.name} ${c.dataType}`), ['employee_id INTEGER', 'dept_id INTEGER', 'name TEXT', 'salary REAL']);
	assert.deepEqual(employees.primaryKey, ['employee_id']);
	assert.equal(employees.columns.find((c) => c.name === 'employee_id')?.isPrimaryKey, true);
	assert.equal(employees.columns.find((c) => c.name === 'name')?.nullable, false);
	assert.equal(employees.columns.find((c) => c.name === 'salary')?.default, '0');

	// FK: anonymous in SQLite, so the constraint name is synthesised; the null `to` is filled
	// from the parent's PK.
	assert.deepEqual(employees.foreignKeys, [{
		constraintName: 'fk_employees_0',
		columns: ['dept_id'],
		referencedTable: 'departments',
		referencedColumns: ['dept_id'],
	}]);

	// Secondary index carried; the PK auto-index (origin 'pk') is skipped.
	assert.deepEqual(employees.indexes, [{ name: 'ix_emp_name', columns: ['name'], unique: false }]);

	// Trigger timing/event parsed out of the CREATE TRIGGER text.
	assert.deepEqual(employees.triggers, [{ name: 'trg_emp_ai', timing: 'AFTER', event: 'INSERT', statement: TRIGGERS[0].sql }]);

	const view = schema.tables.find((t) => t.name === 'emp_view');
	assert.equal(view?.kind, 'view');
	assert.equal(view?.definition, MASTER[1].sql);
});

test('introspectSqlite omits views and the view query when includeViews is false', async () => {
	const seen: string[] = [];
	const schema = await introspectSqlite(makeRunner(seen), '/data/app.db', false);
	assert.ok(!schema.tables.some((t) => t.kind === 'view'), 'no views when includeViews is false');
	// The main sqlite_master query must not request views.
	const tablesQuery = seen.find((s) => s.includes('sqlite_master') && s.includes('ORDER BY name') && !s.includes("type = 'trigger'"));
	assert.ok(tablesQuery && !tablesQuery.includes("'view'"), 'tables query should not include view type');
});

test('sqliteStructuralDigest returns a count:hash fingerprint and is deterministic', async () => {
	const a = await sqliteStructuralDigest(makeRunner([]));
	const b = await sqliteStructuralDigest(makeRunner([]));
	assert.match(a, /^5:\d+$/);
	assert.equal(a, b);
});

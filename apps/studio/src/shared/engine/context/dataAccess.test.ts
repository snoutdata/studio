/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dataAccessPromptNote, dataAccessRefusal, effectiveDataAccess, gateValuesResult, limitAmbient, resolveDataAccess, toolDataAccessNeed, type DataAccessLevel, type ValuesResult } from './dataAccess';
import type { AmbientContext } from '../../ai';

const ON_SCREEN: AmbientContext = {
	editorBuffer: 'SELECT * FROM users',
	resultColumns: [{ name: 'email' }],
	resultRows: [['ada@example.com']],
	selectedCell: { column: 'email', value: 'ada@example.com' },
	selectedRow: [{ column: 'email', value: 'ada@example.com' }],
	lastError: 'boom',
} as AmbientContext;

describe('data access', () => {
	test('never chosen behaves as before the setting existed', () => {
		assert.equal(effectiveDataAccess(undefined), 'queries');
		assert.equal(dataAccessRefusal('run_query', effectiveDataAccess(undefined)), undefined);
		assert.equal(limitAmbient(ON_SCREEN, effectiveDataAccess(undefined)), ON_SCREEN);
	});

	test('schema only takes every database value out of the ambient context, and nothing else', () => {
		const limited = limitAmbient(ON_SCREEN, 'schema');
		assert.equal(JSON.stringify(limited).includes('ada@example.com'), false);
		assert.equal(limited.editorBuffer, ON_SCREEN.editorBuffer);
		assert.deepEqual(limited.resultColumns, ON_SCREEN.resultColumns);
	});

	test('schema only reduces the last error to its class and code: a driver\'s message quotes values', () => {
		const limited = limitAmbient({ ...ON_SCREEN, lastError: "Duplicate entry 'ada@example.com' for key 'users.email' (ER_DUP_ENTRY)" }, 'schema');
		assert.equal(limited.lastError?.includes('ada@example.com'), false);
		assert.match(limited.lastError ?? '', /constraint-violation/);
		assert.match(limited.lastError ?? '', /ER_DUP_ENTRY/);
	});

	test('screen keeps what is on screen', () => {
		assert.equal(limitAmbient(ON_SCREEN, 'screen'), ON_SCREEN);
	});

	test('each tool that carries values is refused below the level it needs', () => {
		assert.match(dataAccessRefusal('get_query_result', 'schema') ?? '', /Settings → AI/);
		assert.equal(dataAccessRefusal('get_query_result', 'screen'), undefined);
		for (const tool of ['run_query', 'explain']) {
			assert.ok(dataAccessRefusal(tool, 'schema'));
			assert.ok(dataAccessRefusal(tool, 'screen'));
			assert.equal(dataAccessRefusal(tool, 'queries'), undefined);
		}
	});

	test('a grid filter is gated like the grid it reads: its match count rebuilds cell values', () => {
		// "Filter email = 'a…'" then "= 'b…'": the count says which guess was right, one letter at a time.
		assert.match(dataAccessRefusal('filter_results', 'schema') ?? '', /Settings → AI/);
		assert.equal(dataAccessRefusal('filter_results', 'screen'), undefined);
		const counted: ValuesResult = { ok: true, summary: 'Filtered to email contains "a" (3 of 40 loaded rows match).', dataConnectionId: 'prod' };
		const refused = gateValuesResult('filter_results', counted, (id) => (id === 'prod' ? 'schema' : 'queries'));
		assert.equal(refused.ok, false);
		assert.equal(refused.summary.includes('3 of 40'), false);
	});

	test('tools that carry no values are never gated', () => {
		for (const tool of ['list_tables', 'describe_table', 'search_columns', 'get_app_state', 'open_in_new_tab', 'sort_results', 'clear_results_filter']) {
			assert.equal(toolDataAccessNeed(tool), undefined);
			assert.equal(dataAccessRefusal(tool, 'schema'), undefined);
		}
	});

	test('the prompt says what the model cannot see, and says nothing at the top level', () => {
		assert.equal(dataAccessPromptNote('queries'), '');
		assert.match(dataAccessPromptNote('schema'), /SCHEMA ONLY/);
		assert.match(dataAccessPromptNote('screen'), /NOT running queries/);
	});

	test('a connection\'s own level wins over the default, in both directions', () => {
		assert.equal(resolveDataAccess('queries', 'schema'), 'schema');
		assert.equal(resolveDataAccess('schema', 'queries'), 'queries');
		assert.equal(resolveDataAccess('screen', undefined), 'screen');
		assert.equal(resolveDataAccess(undefined, undefined), 'queries');
	});

	test('grid rows are checked against the connection they came from, on the way out', () => {
		const rows: ValuesResult & { data?: unknown } = { ok: true, summary: '3 rows', data: { rows: [['ada@example.com']] }, dataConnectionId: 'prod' };
		const levelFor = (id: string | undefined): DataAccessLevel => (id === 'prod' ? 'schema' : 'queries');
		const refused = gateValuesResult('get_query_result', rows, levelFor);
		assert.equal(refused.ok, false);
		assert.equal(refused.refused, true);
		assert.equal(JSON.stringify(refused).includes('ada@example.com'), false);
		assert.equal(gateValuesResult('get_query_result', { ...rows, dataConnectionId: 'dev' }, levelFor).ok, true);
		assert.equal(gateValuesResult('get_app_state', rows, levelFor).ok, true);
	});

	// What a database says when something fails can quote the values it failed on. "Schema only"
	// promises no values, so the last error and the log are reduced to their class and code below
	// the level that shows what is on screen, rather than refused: the class is still what the model
	// needs to help, and refusing would hide that anything went wrong at all.
	const DRIVER_ERRORS = [
		"Duplicate entry 'ada@example.com' for key 'users.email'",
		"Violation of PRIMARY KEY constraint 'PK_users'. Cannot insert duplicate key in object 'dbo.users'. The duplicate key value is (ada@example.com).",
		'invalid input syntax for type integer: "ada@example.com,bob@example.com"',
	];

	test('the last error and the log run at every level: they are reduced, never switched off', () => {
		for (const tool of ['get_last_error', 'get_recent_logs']) {
			assert.equal(toolDataAccessNeed(tool), 'screen');
			assert.equal(dataAccessRefusal(tool, 'schema'), undefined);
		}
	});

	test('below what is on screen, the last error keeps its class and code and loses its text', () => {
		for (const detail of DRIVER_ERRORS) {
			const result: ValuesResult & { data?: unknown } = {
				ok: true,
				summary: `Last error: ${detail}`,
				dataConnectionId: 'prod',
				data: { title: 'Query failed', detail, source: 'query', connectionId: 'prod', connectionLabel: 'Billing prod', sql: 'insert into users values (1)', ts: 1 },
			};
			const gated = gateValuesResult('get_last_error', result, (id) => (id === 'prod' ? 'schema' : 'queries'));
			const text = JSON.stringify(gated);
			assert.equal(gated.ok, true, detail);
			assert.equal(text.includes('ada@example.com'), false, detail);
			assert.match(text, /constraint-violation|type-mismatch/, detail);
			// The user's own SQL and the connection it came from are not database values.
			assert.match(text, /insert into users/);
			assert.equal(gateValuesResult('get_last_error', result, () => 'screen'), result);
		}
	});

	test('below what is on screen, each log line about such a database is reduced on its own', () => {
		const lines = [
			{ ts: 1, level: 'error', message: `Query failed [Billing prod]: ${DRIVER_ERRORS[0]}`, connectionId: 'prod' },
			{ ts: 2, level: 'info', message: 'Exported 12 rows to report.csv', connectionId: 'dev' },
			{ ts: 3, level: 'error', message: `Unhandled: ${DRIVER_ERRORS[2]}` },
		];
		const result = { ok: true, summary: '3 recent log lines', data: lines };
		const gated = gateValuesResult('get_recent_logs', result, (id) => (id === 'dev' ? 'queries' : 'schema'));
		const out = gated.data as { message: string }[];
		assert.equal(JSON.stringify(out).includes('ada@example.com'), false);
		assert.equal(out[1].message, lines[1].message);
		assert.match(out[0].message, /constraint-violation/);
		assert.match(out[2].message, /type-mismatch/);
	});

	test('a failed read whose error is the database\'s own is reduced the same way', () => {
		const failed = { ok: false, summary: '', error: `The last query failed: ${DRIVER_ERRORS[2]}`, errorFromDatabase: true, dataConnectionId: 'prod' };
		const gated = gateValuesResult('get_query_result', failed, () => 'schema');
		assert.equal(gated.ok, false);
		assert.equal(gated.error?.includes('ada@example.com'), false);
		assert.match(gated.error ?? '', /type-mismatch/);
		// An error the app wrote itself is left alone.
		const own = { ok: false, summary: '', error: 'No query result is currently shown.' };
		assert.equal(gateValuesResult('get_query_result', own, () => 'schema'), own);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyError, clickhouseErrorCode, errorCode, valueFreeError, type ErrorClass } from './errorClass';

// Real-ish messages the drivers actually produce, grouped by the class they must map to.
const EXECUTION_CASES: Record<Exclude<ErrorClass, 'unsupported-translation'>, string[]> = {
	deadlock: [
		'deadlock detected',
		'Deadlock found when trying to get lock; try restarting transaction',
		'Transaction (Process ID 58) was deadlocked on lock resources with another process',
	],
	timeout: [
		'canceling statement due to statement timeout',
		'Lock wait timeout exceeded; try restarting transaction',
		'Execution Timeout Expired. The timeout period elapsed prior to completion of the operation.',
		'Query execution was interrupted, maximum statement execution time exceeded',
		'connect ETIMEDOUT',
	],
	'constraint-violation': [
		'duplicate key value violates unique constraint "users_pkey"',
		'null value in column "email" violates not-null constraint',
		'Duplicate entry \'a@b.com\' for key \'users.email\'',
		'Cannot add or update a child row: a foreign key constraint fails',
		'Violation of PRIMARY KEY constraint. Cannot insert duplicate key in object dbo.users',
		'UNIQUE constraint failed: users.email',
		'ORA-00001: unique constraint (APP.USERS_PK) violated',
	],
	'type-mismatch': [
		'invalid input syntax for type integer: "abc"',
		'Conversion failed when converting the varchar value \'abc\' to data type int',
		'Incorrect integer value: \'abc\' for column \'age\' at row 1',
		'operator does not exist: integer = text',
		'ORA-01722: invalid number',
	],
	'resource-limit': [
		'Code: 241. DB::Exception: (total) memory limit exceeded: would use 9.31 GiB. (MEMORY_LIMIT_EXCEEDED)',
		'ERROR: out of memory',
		"There is insufficient system memory in resource pool 'default' to run this query.",
	],
	unclassified: [
		'relation "orders" does not exist',
		'permission denied for table users',
		'syntax error at or near "SLECT"',
		'',
	],
};

for (const [cls, messages] of Object.entries(EXECUTION_CASES)) {
	for (const message of messages) {
		test(`classifies execution error as ${cls}: ${message.slice(0, 48) || '(empty)'}`, () => {
			assert.equal(classifyError(message, 'execution'), cls);
		});
	}
}

test('translation origin is always unsupported-translation, regardless of message', () => {
	assert.equal(classifyError('only a single SELECT statement is supported.', 'translation'), 'unsupported-translation');
	// Even a message that looks like another class stays translation when that's its origin.
	assert.equal(classifyError('deadlock detected', 'translation'), 'unsupported-translation');
});

test('deadlock wins over timeout when a message could read as both', () => {
	// A deadlock message that also mentions a lock/timeout context still classifies as deadlock.
	assert.equal(classifyError('deadlock detected while waiting for lock, timed out', 'execution'), 'deadlock');
});

test('a ClickHouse error is classified by its code, not its wording', () => {
	assert.equal(classifyError('Code: 241. DB::Exception: (total) memory limit exceeded: would use 9.31 GiB. (MEMORY_LIMIT_EXCEEDED)', 'execution'), 'resource-limit');
	assert.equal(classifyError('Code: 159. DB::Exception: Timeout exceeded: elapsed 5.001 seconds, maximum: 5. (TIMEOUT_EXCEEDED)', 'execution'), 'timeout');
	assert.equal(classifyError('Code: 252. DB::Exception: Too many parts (3001). Merges are processing significantly slower than inserts. (TOO_MANY_PARTS)', 'execution'), 'resource-limit');
	assert.equal(classifyError("Code: 53. DB::Exception: Cannot convert string 'x' to type UInt8. (TYPE_MISMATCH)", 'execution'), 'type-mismatch');
	// The code outranks a word that would have matched another class.
	assert.equal(classifyError('Code: 241. DB::Exception: memory limit exceeded while waiting for a deadlock check', 'execution'), 'resource-limit');
	// An unmapped code still falls through to the patterns.
	assert.equal(classifyError('Code: 60. DB::Exception: Unknown table expression identifier. (UNKNOWN_TABLE)', 'execution'), 'unclassified');
	assert.equal(clickhouseErrorCode('Code: 60. DB::Exception: x'), 60);
	assert.equal(clickhouseErrorCode('ERROR: relation "x" does not exist'), undefined);
});

test('out of memory is a resource limit on other engines too', () => {
	assert.equal(classifyError('ERROR: out of memory DETAIL: Failed on request of size 1048576.', 'execution'), 'resource-limit');
	assert.equal(classifyError('There is insufficient system memory in resource pool default to run this query.', 'execution'), 'resource-limit');
});

test('errorCode finds the engine\'s code and nothing quoted', () => {
	assert.equal(errorCode("ER_DUP_ENTRY: Duplicate entry 'ada@example.com' for key 'users.email'"), 'ER_DUP_ENTRY');
	assert.equal(errorCode('ORA-00001: unique constraint (APP.PK_USERS) violated'), 'ORA-00001');
	assert.equal(errorCode('Code: 241. DB::Exception: Memory limit exceeded'), 'Code 241');
	assert.equal(errorCode('SQLSTATE[23000]: Integrity constraint violation'), 'SQLSTATE 23000');
	assert.equal(errorCode("Msg 2627, Level 14: Violation of PRIMARY KEY constraint 'PK_users'"), 'Msg 2627');
	assert.equal(errorCode('DB2 SQL Error: SQLCODE=-803, SQLSTATE=23505'), 'SQLSTATE 23505');
	assert.equal(errorCode('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.email'), 'SQLITE_CONSTRAINT');
	assert.equal(errorCode('connect ECONNREFUSED 127.0.0.1:5432'), 'ECONNREFUSED');
	assert.equal(errorCode('invalid input syntax for type integer: "ada@example.com"'), undefined);
});

test('valueFreeError keeps the class and code and drops every quoted word', () => {
	const out = valueFreeError("ER_DUP_ENTRY: Duplicate entry 'ada@example.com' for key 'users.email'");
	assert.equal(out.includes('ada@example.com'), false);
	assert.equal(out.includes('users.email'), false);
	assert.match(out, /constraint-violation/);
	assert.match(out, /ER_DUP_ENTRY/);
	assert.match(valueFreeError('something odd happened: 42'), /unclassified/);
	assert.equal(valueFreeError('something odd happened: 42').includes('42'), false);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';

// Database-side read-only enforcement against a REAL server. The lexical
// guard cannot see that `SELECT ro_probe_write()` calls a function that writes; a read-only run
// must be refused by the database itself, a plain read must still work, and the pooled connection
// it used must come back clean so an interactive write after it succeeds.
//
// Gated like integration.test.ts, on SNOUTDATA_IT_* (see deploy/db-lab/README.md), for the engines
// the db-lab runs: postgres, mysql-aurora (and mariadb), sqlserver. MySQL needs to create a stored
// function with binary logging on, so run it as root (SNOUTDATA_IT_USER=root, password snout_root)
// or with log_bin_trust_function_creators already set. It creates and drops a `ro_probe` table.

const driver = process.env.SNOUTDATA_IT_DRIVER ?? 'mysql-aurora';
const supported = ['postgres', 'mysql-aurora', 'mariadb', 'sqlserver'].includes(driver);
const enabled = Boolean(process.env.SNOUTDATA_IT_HOST) && supported;
const skip = enabled ? false : 'set SNOUTDATA_IT_* for postgres, mysql-aurora, mariadb or sqlserver to run';

const config = {
	id: 'readonly-it',
	label: 'readonly-it',
	driver,
	host: process.env.SNOUTDATA_IT_HOST,
	port: Number(process.env.SNOUTDATA_IT_PORT ?? 3306),
	database: process.env.SNOUTDATA_IT_NAME,
	username: process.env.SNOUTDATA_IT_USER,
	password: process.env.SNOUTDATA_IT_PASSWORD,
};

interface Outcome { ok: boolean; error?: string; result?: { rows: unknown[][]; rowCount: number } }

let child: ChildProcessWithoutNullStreams | undefined;
let conn: MessageConnection | undefined;

function run(sql: string, readOnly = false): Promise<Outcome> {
	return conn!.sendRequest('snout/executeQuery', { connectionId: config.id, query: readOnly ? { lang: 'sql', sql, readOnly } : { lang: 'sql', sql } }) as Promise<Outcome>;
}

async function must(sql: string): Promise<Outcome> {
	const outcome = await run(sql);
	assert.equal(outcome.ok, true, `${sql}: ${outcome.error}`);
	return outcome;
}

async function probeCount(): Promise<number> {
	return Number((await must('SELECT COUNT(*) FROM ro_probe')).result!.rows[0][0]);
}

/** The session the next statement lands on, and whether it is clean: [id, read-only?, in a transaction?]. */
async function sessionState(readOnly = false): Promise<[string, boolean, boolean]> {
	const sql = driver === 'postgres'
		? "SELECT pg_backend_pid(), current_setting('transaction_read_only') = 'on', now() <> statement_timestamp()"
		: driver === 'sqlserver'
			? 'SELECT @@SPID, 0, @@TRANCOUNT'
			: 'SELECT CONNECTION_ID(), @@SESSION.transaction_read_only, 0';
	const outcome = await run(sql, readOnly);
	assert.equal(outcome.ok, true, outcome.error);
	const [id, ro, tx] = outcome.result!.rows[0];
	return [String(id), ro === true || Number(ro) === 1, tx === true || Number(tx) > 0];
}

before(async () => {
	if (!enabled) {
		return;
	}
	child = spawn(process.execPath, ['out/server/server.js', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
	conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
	conn.listen();
	await conn.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
	conn.sendNotification('initialized', {});
	await conn.sendRequest('snout/connect', { config });
	if (driver === 'sqlserver') {
		await must("IF OBJECT_ID('dbo.ro_probe') IS NOT NULL DROP TABLE dbo.ro_probe");
		await must('CREATE TABLE dbo.ro_probe (id int)');
	} else {
		await must('DROP TABLE IF EXISTS ro_probe');
		await must('CREATE TABLE ro_probe (id int)');
	}
	if (driver === 'postgres') {
		await must('CREATE OR REPLACE FUNCTION ro_probe_write() RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ro_probe VALUES (1); RETURN 1; END $$');
	} else if (driver !== 'sqlserver') {
		// Root may set this; another account needs it set already (see the header).
		await run('SET GLOBAL log_bin_trust_function_creators = 1');
		await must('DROP FUNCTION IF EXISTS ro_probe_write');
		await must('CREATE FUNCTION ro_probe_write() RETURNS INT NOT DETERMINISTIC MODIFIES SQL DATA BEGIN INSERT INTO ro_probe VALUES (1); RETURN 1; END');
	}
});

after(async () => {
	if (conn) {
		if (driver === 'postgres') {
			await run('DROP FUNCTION IF EXISTS ro_probe_write()');
		} else if (driver !== 'sqlserver') {
			await run('DROP FUNCTION IF EXISTS ro_probe_write');
		}
		await run(driver === 'sqlserver' ? "IF OBJECT_ID('dbo.ro_probe') IS NOT NULL DROP TABLE dbo.ro_probe" : 'DROP TABLE IF EXISTS ro_probe');
		await conn.sendRequest('snout/disconnect', config.id).catch(() => undefined);
		conn.dispose();
	}
	child?.kill();
});

describe(`database-side read-only (${driver}, env-gated)`, () => {
	if (driver === 'sqlserver') {
		test('a function cannot write at all: the database refuses to create one, so SELECT writing_fn() cannot exist', { skip }, async () => {
			const created = await run('CREATE FUNCTION dbo.ro_probe_write() RETURNS int AS BEGIN INSERT INTO dbo.ro_probe VALUES (1); RETURN 1; END');
			assert.equal(created.ok, false);
			assert.match(created.error ?? '', /side-effecting operator 'INSERT' within a function/i);
		});

		test('a write the statement check missed is UNDONE by the database (the run is always rolled back)', { skip }, async () => {
			// T-SQL control flow at the head of a batch can hide a write from a first-word check. Sent read-only, the server runs it inside a transaction that is rolled back.
			const outcome = await run('IF 1 = 1 INSERT INTO dbo.ro_probe VALUES (2)', true);
			assert.equal(outcome.ok, true, outcome.error);
			assert.equal(await probeCount(), 0, 'the row was rolled back');
		});
	} else {
		test('SELECT writing_fn() is refused by the DATABASE, and nothing was written', { skip }, async () => {
			const outcome = await run('SELECT ro_probe_write()', true);
			assert.equal(outcome.ok, false, 'the database ran a writing function in a read-only run');
			assert.match(outcome.error ?? '', /read[- ]only/i);
			assert.equal(await probeCount(), 0);
		});

		test('without the read-only run the same function writes (the test is not vacuous)', { skip }, async () => {
			await must('SELECT ro_probe_write()');
			assert.equal(await probeCount(), 1);
			await must('DELETE FROM ro_probe');
		});
	}

	if (driver === 'postgres') {
		// An outside review (2026-10-14) hid these behind a backslash-escaped quote on a database
		// with standard_conforming_strings off, where the statement check read them as a string. Sent
		// straight to the server here, past that check, so what is pinned is the driver's own layer.
		test('a run that ends its read-only transaction fails, and a write in a read-write one it opened is rolled back', { skip }, async () => {
			const outcome = await run('SET default_transaction_read_only = off; COMMIT; BEGIN; INSERT INTO ro_probe VALUES (5); SELECT 1', true);
			assert.equal(outcome.ok, false, 'a run that left the read-only transaction returned rows');
			assert.match(outcome.error ?? '', /left the read-only transaction/);
			assert.equal(await probeCount(), 0, 'the write was still in an open transaction, and was rolled back');
		});

		test('a write after the transaction ended has committed, and the run is still reported as failed', { skip }, async () => {
			const outcome = await run('SET default_transaction_read_only = off; COMMIT; INSERT INTO ro_probe VALUES (6); SELECT 1', true);
			assert.equal(outcome.ok, false, 'a run that left the read-only transaction returned rows');
			assert.match(outcome.error ?? '', /left the read-only transaction/);
			assert.equal(await probeCount(), 1, 'what the statement check alone must stop');
			await must('DELETE FROM ro_probe');
			const [, readOnlyAfter, inTxAfter] = await sessionState();
			assert.deepEqual([readOnlyAfter, inTxAfter], [false, false], 'the session is put back');
		});
	}

	test('a normal SELECT still runs read-only', { skip }, async () => {
		const outcome = await run('SELECT COUNT(*) FROM ro_probe', true);
		assert.equal(outcome.ok, true, outcome.error);
		assert.equal(Number(outcome.result!.rows[0][0]), 0);
	});

	test('the pooled connection a read-only run used comes back clean, and an interactive write on it succeeds', { skip }, async () => {
		// A refused statement first, so the clean-up after a FAILURE is what is checked.
		await run(driver === 'sqlserver' ? 'IF 1 = 1 INSERT INTO dbo.ro_probe VALUES (2)' : 'SELECT ro_probe_write()', true);
		const [readId, readOnlyDuring, inTxDuring] = await sessionState(true);
		if (driver !== 'sqlserver') {
			assert.equal(readOnlyDuring, true, 'the read-only run was read-only');
		}
		if (driver === 'postgres' || driver === 'sqlserver') {
			// MySQL has no session variable for "a transaction is open"; its read-only flag above is the check.
			assert.equal(inTxDuring, true, 'the read-only run was inside a transaction');
		}
		const [afterId, readOnlyAfter, inTxAfter] = await sessionState();
		assert.equal(afterId, readId, 'the next interactive statement lands on the same pooled connection');
		assert.equal(readOnlyAfter, false, 'the session is not left read-only');
		assert.equal(inTxAfter, false, 'no transaction is left open');
		await must(driver === 'sqlserver' ? 'INSERT INTO dbo.ro_probe VALUES (3)' : 'INSERT INTO ro_probe VALUES (3)');
		assert.equal(await probeCount(), 1, 'the interactive write committed');
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a read-only run asks of the DATABASE, per engine.
//
// The guard (`guard/sqlGuard.ts`, `context/tools.ts` `readOnlyError`) reads a statement and
// refuses one that writes. It is the first layer and it stays, but it is a lexer: it cannot see
// that `SELECT my_cleanup_fn()` calls a function that deletes rows, or read every vendor's comment
// and quoting rules the way that vendor does. So a run the app labels
// read-only (the agent broker's reads, the assistant's run_query, every query on a connection
// flagged read-only) also asks the database to refuse writes, where the engine has a way to:
//
//   - `transaction`: the statement runs inside a read-only transaction that is always rolled back.
//   - `session`:     the session (one embedded connection) is put in a read-only mode and put back.
//   - `setting`:     a per-request setting (ClickHouse `readonly`), so there is nothing to undo.
//   - `rollback`:    no read-only mode exists; the statement runs in a transaction that is always
//                    rolled back, so a table write is UNDONE rather than refused.
//   - `none`:        only the guard holds.
//
// `begin` runs on the statement's own session before it and `end` after it, success or failure,
// so a pooled connection goes back to the pool as it came out (a driver that cannot run `end`
// destroys the connection instead). Drivers run these through `drivers/readOnlySession.ts`.
//
// Pure: no I/O, so the renderer can show `summary` and a test can pin every statement.

/** How the database is asked to keep a read-only run from writing. */
export type ReadOnlyMechanism = 'transaction' | 'session' | 'setting' | 'rollback' | 'none';

export interface ReadOnlyEnforcement {
	readonly mechanism: ReadOnlyMechanism;
	/** Statements run, in order, on the statement's own session before it. */
	readonly begin: readonly string[];
	/** Statements run, in order, on the same session after it (success or failure). */
	readonly end: readonly string[];
	/** A query run on the same session after the statement SUCCEEDS and before `end`, whose first
	 *  column must be true: the run is still inside what `begin` opened. When it is not, or the
	 *  query cannot run, the run fails rather than return a result (`end` still runs). */
	readonly verify?: string;
	/** What the DATABASE enforces for this engine, as one sentence a person or an agent can read.
	 *  Never wider than the truth: it names what is not covered. */
	readonly summary: string;
}

/**
 * PostgreSQL (and the flavors on its driver). The session default AND the transaction are
 * read-only, so a `COMMIT` hidden in the statement on its own only starts another read-only
 * transaction. `RESET` puts the session default back to whatever the role, database or server
 * says, rather than forcing read-write.
 *
 * What each layer does, since the statement runs on the same session as `begin` and can change it
 * (an outside review, 2026-10-14, hid `SET default_transaction_read_only = off; COMMIT; DELETE ...`
 * behind a backslash-escaped quote on a database with standard_conforming_strings off, and the rows
 * were deleted):
 *
 * - The statement check (`guard/sqlGuard.ts`) lexes Postgres text by both string rules and judges
 *   what either reading finds, and refuses inside a read any transaction control and any setting
 *   that turns read-only off (`readOnlyEscape`).
 * - The database refuses a write to this database inside the READ ONLY transaction, including one
 *   a function it calls makes in this session. It does not stop an effect that lands outside the
 *   database (an HTTP request, a Lambda invocation, a cloud AI service, an export to S3, SQL run
 *   over dblink, a pg_background worker's own transaction, a NOTIFY), so those calls are refused by
 *   the statement check (`guard/sideEffects.ts`), every function in a cloud-integration schema
 *   (`aws_*`, `azure_*`, `google_ml`, `ai`, `net`, `http`) by rule.
 *   It cannot refuse a statement that switches the session default off and ends that transaction:
 *   what follows runs read-write.
 * - `verify` asks afterwards whether the run is still in a transaction (its start is not this
 *   statement's) that is read-only. A run that ended it, or left a read-write one open, fails
 *   instead of returning rows, and the open one is rolled back. A write that ran after the
 *   transaction ended has committed by then; one that ended it and then opened another read-only
 *   one passes `verify`, and is stopped by the statement check alone.
 */
export const POSTGRES_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'transaction',
	begin: ['SET default_transaction_read_only = on', 'BEGIN TRANSACTION READ ONLY'],
	end: ['ROLLBACK', 'RESET default_transaction_read_only'],
	verify: "SELECT current_setting('transaction_read_only') = 'on' AND now() <> statement_timestamp()",
	summary: 'The query runs in a READ ONLY transaction that is then rolled back, so the database refuses a write to this database made inside it, by the statement or by a function it calls. It does not stop an effect outside the database (an HTTP request, a Lambda invocation, a call to a cloud AI service, an export to S3, SQL sent over dblink, a background worker with its own transaction) or a read of the server\'s own files and directories (pg_read_file, pg_ls_dir, pg_stat_file), so the statement check refuses those calls. A statement that ends that transaction could write after it, so the statement check refuses transaction control and any setting that turns read-only off, reading strings both with and without standard_conforming_strings, and a run found outside a read-only transaction afterwards fails rather than show rows (a write it made after ending the transaction is already committed by then). Calls that act without writing a table here (pg_terminate_backend, pg_notify) are stopped only by the statement check too.',
};

/**
 * Redshift's BEGIN takes READ ONLY; it has no session-level default to set alongside it, so a
 * statement after a COMMIT in the query would autocommit. The statement check is what stops that:
 * it refuses transaction control inside a read, and reads Redshift's strings, which escape with a
 * backslash, by that rule as well as Postgres's.
 */
export const REDSHIFT_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'transaction',
	begin: ['BEGIN TRANSACTION READ ONLY'],
	end: ['ROLLBACK'],
	summary: 'The query runs in a READ ONLY transaction that is then rolled back, so the database refuses a write inside it. A statement that ended that transaction could write after it, so the statement check refuses transaction control in a read.',
};

/**
 * MySQL and MariaDB. The session characteristic covers an autocommit statement after a hidden
 * `COMMIT`; it is put back to READ WRITE, the server default (the server's own `read_only` and
 * `super_read_only` are separate and untouched).
 */
export const MYSQL_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'transaction',
	begin: ['SET SESSION TRANSACTION READ ONLY', 'START TRANSACTION READ ONLY'],
	end: ['ROLLBACK', 'SET SESSION TRANSACTION READ WRITE'],
	summary: 'The database refuses writes to tables: the query runs in a READ ONLY transaction that is then rolled back, which covers writes stored functions it calls make here. Temporary tables are still writable, and GET_LOCK and similar calls still act; a call whose effect lands outside the database (sys_exec, Aurora\'s lambda_sync and lambda_async) is refused by the statement check.',
};

/** Oracle: `SET TRANSACTION READ ONLY` must open the transaction; the query runs without autocommit. */
export const ORACLE_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'transaction',
	begin: ['SET TRANSACTION READ ONLY'],
	end: ['ROLLBACK'],
	summary: 'The database refuses DML in the query\'s transaction (SET TRANSACTION READ ONLY, then rolled back). DDL, which commits on its own, and autonomous transactions inside a function are outside it. EXPLAIN PLAN, which writes the plan into a table, and the packages that reach outside the database (UTL_HTTP, UTL_FILE, DBMS_CLOUD and the like) are refused by the statement check, called directly or written inside a string, and so are the functions that run a query handed to them as a string (DBMS_XMLGEN, DBMS_XMLQUERY, DBMS_SQL).',
};

/** SQLite: `query_only` for the one call, on the driver's single connection. */
export const SQLITE_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'session',
	begin: ['PRAGMA query_only = ON'],
	end: ['PRAGMA query_only = OFF'],
	summary: 'The database refuses any change to the database file while the query runs (PRAGMA query_only).',
};

/**
 * DuckDB runs in this process and can read any file or URL the app can (`read_text('~/.ssh/id_rsa')`,
 * `read_csv('https://...')`, `glob`, a replacement scan of `'x.csv'`). So a read-only run goes to a
 * database handle opened READ_ONLY with `enable_external_access = false` and `lock_configuration`
 * (the driver does that; DuckDB cannot switch external access back on while that handle is open),
 * and inside it a read-only transaction. On a connection flagged read-only that handle is the
 * connection's own; on a writable one it is a second handle opened on the same file for the run and
 * closed after it, so the user's own session keeps its file access.
 */
export const DUCKDB_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'transaction',
	begin: ['BEGIN TRANSACTION READ ONLY'],
	end: ['ROLLBACK'],
	summary: 'The database refuses any change to the database file and any file, URL or extension access (read_csv, read_text, glob, COPY, ATTACH, INSTALL, LOAD): the query runs on a handle opened read-only with external access off, in a READ ONLY transaction that is then rolled back. On a writable connection that handle is opened for the query, so it sees what is committed to the file and not the session\'s temporary tables, attached databases or open transaction; an in-memory database refuses the query.',
};

/**
 * ClickHouse: the `readonly` setting on the request. 2 rather than 1 because 1 also forbids the
 * settings the driver replays for a stateless HTTP session; both refuse every write and DDL.
 */
export const CLICKHOUSE_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'setting',
	begin: [],
	end: [],
	summary: 'The database refuses any write or DDL: the request is sent with readonly = 2 (or the account is already read-only). A table function that reaches outside the server (url, s3, remote, mysql, postgresql, file, executable and the rest) is refused by the statement check: in a read, a table function must be one of the few that only read this server\'s data (numbers, zeros, generateRandom, values, view, merge, cluster).',
};

/**
 * SQL Server has no read-only transaction (ApplicationIntent=ReadOnly only routes to a readable
 * secondary). The statement runs in a transaction that is always rolled back, so a table write is
 * undone; a function cannot write at all in T-SQL, so `SELECT writing_fn()` is refused at CREATE.
 *
 * What each layer does, since a COMMIT in the batch ends that transaction and T-SQL needs no `;`
 * before one (an outside review, 2026-10-14): the statement check (`guard/sqlGuard.ts`) refuses
 * COMMIT, ROLLBACK, SAVE TRAN and a BEGIN TRAN inside a statement wherever they sit, plus what
 * acts outside a transaction (xp_*, KILL) and what acts with no write verb (DISABLE TRIGGER, RECEIVE). The driver nests a second transaction, so one COMMIT
 * the check missed commits nothing, and reports a batch that ended either as a failure. A batch
 * that ends both before it acts is caught by the check alone.
 */
export const SQLSERVER_READ_ONLY: ReadOnlyEnforcement = {
	mechanism: 'rollback',
	begin: ['BEGIN TRANSACTION', 'BEGIN TRANSACTION'],
	end: ['IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'],
	summary: 'SQL Server has no read-only mode, so the query runs in a transaction that is always rolled back: a table write is undone, not refused. A COMMIT or ROLLBACK would end that transaction, so the statement check refuses one anywhere in the query, semicolon or not. It also refuses extended procedures (xp_*) and KILL, which act outside the transaction, the functions that open a file by its path (sys.fn_get_audit_file, fn_trace_gettable, sys.fn_xe_file_target_read_file), any string that names a network path (\\\\host\\share, which the server would sign in to), and statements with no write verb that act (DISABLE or ENABLE TRIGGER, RECEIVE, WRITETEXT). The run also nests a second transaction, so one COMMIT the check missed commits nothing, and a query that ends either is reported as failed rather than shown.',
};

/**
 * The guard alone, for an engine with no database-side read-only mode the app uses. There the guard
 * is an allow-list (`guard/readAllowlist.ts`), and this sentence says what it admits and refuses.
 */
export function lexicalOnly(engine: string): ReadOnlyEnforcement {
	return {
		mechanism: 'none',
		begin: [],
		end: [],
		summary: `${engine} is not asked to refuse writes: only the statement check holds. It runs one statement that leads with SELECT, WITH (into a SELECT), SHOW, DESCRIBE, EXPLAIN (not ANALYZE, and not on Db2 or SAP HANA, where it writes the plan into the explain tables) or VALUES (or LIST on a Snowflake stage), and refuses anything else: a second statement (Snowflake's ->> flow operator starts one), a $$ body, PROCEDURE, CALL, EXECUTE, BEGIN or DECLARE, a write anywhere inside the statement, SELECT INTO, known writing functions and those that reach outside the database (Db2's MQ and HTTP functions among them), every Snowflake SYSTEM$ function except a short list that only reports, a function named by IDENTIFIER(...), and advancing a sequence with NEXT VALUE FOR or .NEXTVAL, quoted names included. A user-defined function that writes is not recognised.`,
	};
}

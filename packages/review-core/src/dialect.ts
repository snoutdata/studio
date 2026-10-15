/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Dialect capabilities — only the ones a REVIEW decision turns on.
 *
 *  Deliberately much smaller than SnoutData's own `Dialect` (which also has to build queries):
 *  a reviewer needs to know how identifiers are quoted, whether DDL is transactional, whether
 *  a lock-free index build exists, and how to ask for a plan. Everything else is not a review
 *  decision and is not modelled here.
 *--------------------------------------------------------------------------------------------*/

import { LEGACY_LEX, MYSQL_LEX, ORACLE_LEX, POSTGRES_LEX, SQLITE_LEX, SQLSERVER_LEX } from './sql/mask.js';
import type { SqlLexRules } from './sql/mask.js';

export interface ReviewDialect {
	driverId: string;
	displayName: string;
	/** The quote characters this vendor accepts around an identifier. Used to spot a statement
	 *  quoted for a different vendor (backticks against Postgres). */
	identifierQuotes: string[];
	/** Whether DDL participates in a transaction. `false` means a failed migration leaves the
	 *  database half-changed, which changes how a multi-statement migration must be reviewed. */
	transactionalDdl: boolean;
	/** Whether an index can be built without holding a write lock, and the syntax for it. */
	concurrentIndex?: string;
	/** How to make a statement report its plan without running it, as ONE statement. Absent when
	 *  the vendor has no single-statement way to ask (SQL Server's SHOWPLAN is a session switch). */
	explain?: (sql: string) => string;
	/** How this vendor reads strings, quoted names and comments, which is what decides where a
	 *  statement ends. */
	lex: SqlLexRules;
	/** Adding a NOT NULL column with a default: does the vendor rewrite the whole table? */
	defaultRewritesTable: boolean;
	/** A note about this vendor a review should carry. */
	notes?: string;
	/** Quote one identifier for this vendor. A probe is generated SQL run against a customer's
	 *  database, so every name in one is quoted: a column called `order` is not hypothetical. */
	quote: (ident: string) => string;
}

function doubleQuote(ident: string): string {
	return '"' + ident.replace(/"/g, '""') + '"';
}

function backtick(ident: string): string {
	return '`' + ident.replace(/`/g, '``') + '`';
}

function bracket(ident: string): string {
	return '[' + ident.replace(/]/g, ']]') + ']';
}

/** Quote a possibly schema-qualified name, part by part. */
export function quoteName(dialect: ReviewDialect, name: string): string {
	return name
		.split('.')
		.filter((part) => part !== '')
		.map((part) => dialect.quote(part))
		.join('.');
}

function strip(sql: string): string {
	return sql.trim().replace(/;\s*$/, '');
}

const POSTGRES: ReviewDialect = {
	driverId: 'postgres',
	displayName: 'PostgreSQL',
	identifierQuotes: ['"'],
	transactionalDdl: true,
	concurrentIndex: 'CREATE INDEX CONCURRENTLY',
	explain: (sql) => `EXPLAIN (FORMAT JSON) ${strip(sql)}`,
	lex: POSTGRES_LEX,
	quote: doubleQuote,
	// Postgres 11+ stores a non-volatile default in the catalog instead of rewriting.
	defaultRewritesTable: false,
};

const MYSQL: ReviewDialect = {
	driverId: 'mysql-aurora',
	displayName: 'MySQL',
	identifierQuotes: ['`', '"'],
	transactionalDdl: false,
	concurrentIndex: 'ALTER TABLE … ALGORITHM=INPLACE, LOCK=NONE',
	explain: (sql) => `EXPLAIN FORMAT=JSON ${strip(sql)}`,
	lex: MYSQL_LEX,
	quote: backtick,
	// MySQL 8.0.12+ has instant ADD COLUMN, but only under conditions (position, row format)
	// a reviewer cannot see from the diff, so the warning is raised and says what decides it.
	defaultRewritesTable: true,
};

const MARIADB: ReviewDialect = { ...MYSQL, driverId: 'mariadb', displayName: 'MariaDB' };

const SQLSERVER: ReviewDialect = {
	driverId: 'sqlserver',
	displayName: 'SQL Server',
	identifierQuotes: ['[', '"'],
	transactionalDdl: true,
	concurrentIndex: 'CREATE INDEX … WITH (ONLINE = ON)',
	// No `explain`. An estimated plan needs `SET SHOWPLAN_XML ON`, which must be a batch of its
	// own and stays on for the session until a matching OFF: sent with the statement it fails, and
	// sent apart it leaves a pooled connection answering every later query with a plan. A probe is
	// one statement, so SQL Server gets no plan probe rather than a session
	// switch a host could fail to turn back off.
	lex: SQLSERVER_LEX,
	quote: bracket,
	defaultRewritesTable: false,
};

const ORACLE: ReviewDialect = {
	driverId: 'oracle',
	displayName: 'Oracle',
	identifierQuotes: ['"'],
	transactionalDdl: false,
	concurrentIndex: 'CREATE INDEX … ONLINE',
	explain: (sql) => `EXPLAIN PLAN FOR ${strip(sql)}`,
	lex: ORACLE_LEX,
	quote: doubleQuote,
	defaultRewritesTable: false,
};

const SQLITE: ReviewDialect = {
	driverId: 'sqlite',
	displayName: 'SQLite',
	identifierQuotes: ['"', '`', '['],
	transactionalDdl: true,
	explain: (sql) => `EXPLAIN QUERY PLAN ${strip(sql)}`,
	lex: SQLITE_LEX,
	quote: doubleQuote,
	defaultRewritesTable: false,
	notes: 'SQLite cannot drop or alter a column in place before 3.35; the migration is a table rebuild.',
};

/** Used when the caller does not know the destination's vendor. Permissive on purpose: a
 *  reviewer that invents dialect errors for a vendor it was never told about is noise. */
const GENERIC: ReviewDialect = {
	driverId: 'generic',
	displayName: 'SQL',
	identifierQuotes: ['"', '`', '['],
	transactionalDdl: true,
	explain: (sql) => `EXPLAIN ${strip(sql)}`,
	lex: LEGACY_LEX,
	quote: doubleQuote,
	defaultRewritesTable: false,
};

const DIALECTS: ReviewDialect[] = [POSTGRES, MYSQL, MARIADB, SQLSERVER, ORACLE, SQLITE];

/** Resolve a SnoutData driver id (or a plain vendor name) to its review dialect. */
export function dialectFor(driverId: string | undefined): ReviewDialect {
	if (!driverId) {
		return GENERIC;
	}
	const id = driverId.toLowerCase();
	const exact = DIALECTS.find((d) => d.driverId === id);
	if (exact) {
		return exact;
	}
	// Redshift is Postgres-shaped; Aurora MySQL and "mysql" both mean MySQL.
	if (id.includes('postgres') || id === 'redshift') {
		return POSTGRES;
	}
	if (id.includes('maria')) {
		return MARIADB;
	}
	if (id.includes('mysql')) {
		return MYSQL;
	}
	if (id.includes('sqlserver') || id.includes('mssql')) {
		return SQLSERVER;
	}
	if (id.includes('oracle')) {
		return ORACLE;
	}
	if (id.includes('sqlite') || id.includes('duckdb')) {
		return SQLITE;
	}
	return GENERIC;
}

export { GENERIC as GENERIC_DIALECT };

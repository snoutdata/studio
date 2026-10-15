/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The arguments `pg_dump` and `pg_restore` are run with, for the `native-pg` strategy.
 *
 * No credential, host, port or user ever appears here: the host puts those in the child's
 * environment (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`), where they do not show up
 * in a process listing, a log line or the spec.
 *
 * `pg_dump` takes the source database from `PGDATABASE` too. `pg_restore` cannot: without
 * `--dbname` it prints SQL instead of connecting, so its database is passed as a conninfo string,
 * which is also what stops a database name containing `=` from being read as one.
 */

import type { MoveSpec } from './spec.js';

export interface PgToolArgs {
	readonly dump: readonly string[];
	readonly restore: readonly string[];
}

/**
 * A name as a literal `pg_dump` pattern. Double quotes keep its case and make `*`, `?` and `.`
 * match themselves rather than act as wildcards and separators.
 */
export function quotePattern(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** A database name as a libpq conninfo value. */
export function conninfoDatabase(name: string): string {
	return `dbname='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function nativePgArgs(spec: MoveSpec, target: { readonly database: string }): PgToolArgs {
	if (spec.targetMode === 'replace' && spec.content === 'data') {
		throw new Error('a data-only move cannot replace the target');
	}

	// Uncompressed: the archive only crosses a pipe between two processes on the same machine, so
	// compressing it is CPU spent for nothing.
	const dump: string[] = ['--format=custom', '--compress=0', '--verbose', '--no-password'];
	if (spec.content === 'schema') {
		dump.push('--schema-only');
	} else if (spec.content === 'data') {
		dump.push('--data-only');
	}
	for (const schema of spec.selection.schemas ?? []) {
		dump.push(`--schema=${quotePattern(schema)}`);
	}
	for (const exclusion of spec.selection.excludeSchemas) {
		dump.push(`--exclude-schema=${quotePattern(exclusion.schema)}`);
	}
	for (const exclusion of spec.selection.excludeTables) {
		dump.push(`--exclude-table=${quotePattern(exclusion.schema)}.${quotePattern(exclusion.table)}`);
	}
	for (const exclusion of spec.selection.excludeExtensions) {
		dump.push(`--exclude-extension=${quotePattern(exclusion.extension)}`);
	}

	// No --exit-on-error and no --single-transaction: a restore carries on past an object that
	// fails, and the runner reports every failure. One refused extension must not cost the user
	// the other ten thousand objects.
	const restore: string[] = ['--verbose', '--no-password', `--dbname=${conninfoDatabase(target.database)}`];
	if (spec.ownership === 'skip') {
		restore.push('--no-owner');
	}
	if (spec.privileges === 'skip') {
		restore.push('--no-privileges');
	}
	// `replace` is NOT `--clean`, which drops only what the archive contains and leaves the target's
	// other tables in place (measured). The target is emptied first by `replacePlan`.

	return { dump, restore };
}

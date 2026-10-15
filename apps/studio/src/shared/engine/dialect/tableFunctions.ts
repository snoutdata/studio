/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Table functions: querying the data that is NOT in the database.
 *
 *  On ClickHouse a file in S3, a page on the web, a Postgres table and another server are all
 *  addressed the same way, as a function you select FROM. It is the engine's best trick and the
 *  reason people reach for it in the first place, and in every SQL client it is a string you type
 *  by hand, with no completion, no schema and no way to find out what went wrong except to run it.
 *
 *  This is the knowledge behind a form: the exact statements, built from what somebody filled in
 *  (the list of functions and their arguments is `tableFunctionSpecs.ts`). Four rules shape all of it.
 *
 *    - **The SERVER fetches, not the app.** So a credential that lives on THIS computer (an AWS
 *      CLI profile, an instance role, a `gcloud` configuration) cannot be used: it means nothing
 *      to the machine doing the reading. Only a key PAIR can be handed over, which is why a saved
 *      cloud account is usable here only in its `key` mode and the others are refused by name.
 *    - **Every argument is a string literal**, through the dialect's own `sqlLiteral`. Nothing is
 *      concatenated, and that is what makes it safe to build a statement out of a form.
 *    - **A secret is an ARGUMENT here**, which is the whole difficulty: a password to another
 *      database sits in the middle of the statement. So every call is emitted twice, once really
 *      and once redacted, and the redacted one is what reaches query history, the editor and the
 *      screen. The redaction is by VALUE, not by pattern: the caller knows exactly which arguments
 *      were secret, so nothing is guessed.
 *    - **Overloads live in the spec, not in the caller.** `s3(url, format)` and
 *      `s3(url, key, secret, format)` are both valid and there is no way to skip a middle
 *      argument, so each function builds its own ordered argument list.
 *--------------------------------------------------------------------------------------------*/

import type { QueryResult } from '../../query';
import { paramValue as v, type TableFunctionSpec, type TableFunctionValues } from './tableFunctionSpecs';
import { sqlLiteral } from './insert';
import { dialectFor } from './index';

/** The table functions this engine offers a FORM for, or none. Absent is what hides the whole
 *  surface on every other driver. */
export function tableFunctionsFor(driverId: string): readonly TableFunctionSpec[] {
	return dialectFor(driverId).tableFunctions ?? [];
}

/** One of this engine's own, by id, or nothing. The id is interpolated unquoted, so this lookup
 *  is what stands between a value from outside and the statement. */
export function tableFunctionById(driverId: string, id: string): TableFunctionSpec | undefined {
	return tableFunctionsFor(driverId).find((spec) => spec.id === id);
}

/** Required fields still empty, by label, in the order the form shows them. */
export function missingArguments(spec: TableFunctionSpec, values: TableFunctionValues): string[] {
	return spec.params.filter((param) => param.required && !v(values, param.name)).map((param) => param.label);
}

export interface CallOptions {
	/** Replace every secret argument with an unrunnable placeholder. What history, the editor and
	 *  the screen are given. */
	redactSecrets?: boolean;
}

/** What a redacted secret reads as. Deliberately not a plausible value: a statement carrying it
 *  must fail if anyone runs it, exactly as `engine/security/redact.ts` does. */
export const REDACTED = '<redacted>';

/** `s3('https://…', 'CSVWithNames')` — the call itself, every argument a quoted literal. */
export function emitTableFunctionCall(driverId: string, spec: TableFunctionSpec, values: TableFunctionValues, options: CallOptions = {}): string {
	const secrets = new Set(spec.params.filter((param) => param.secret).map((param) => v(values, param.name)).filter(Boolean));
	const args = spec.build(values).map((arg) => sqlLiteral(driverId, options.redactSecrets && secrets.has(arg) ? REDACTED : arg));
	return `${spec.id}(${args.join(', ')})`;
}

/**
 * What one of these actions answers with.
 *
 * `sql` is the REDACTED statement, always: it is what the screen shows, and there is no path by
 * which the real one comes back out of main.
 */
export type TableFunctionOutcome =
	| { ok: true; result: QueryResult; sql: string }
	| { ok: false; error: string; sql?: string };

/** What the server says the columns are, without reading a row of data. */
export function describeStatement(call: string): string {
	return `DESCRIBE TABLE ${call}`;
}

/** The first rows, to see that it is really the data that was meant. */
export function previewStatement(call: string, limit: number): string {
	const n = Math.max(1, Math.min(1000, Math.trunc(limit)));
	return `SELECT * FROM ${call} LIMIT ${n}`;
}

/** Where a remote table is being copied to. */
export interface ImportTarget {
	database?: string;
	table: string;
	/** Columns to order the new table by, in order. Empty means `tuple()`, which is a legal
	 *  MergeTree with no sorting and the honest answer when nothing was picked. */
	orderBy: readonly string[];
}

/**
 * `CREATE TABLE … ENGINE = MergeTree ORDER BY (…) AS SELECT * FROM <call>` — the one click that
 * turns somebody else's file into a table of this database's own.
 *
 * The engine is MergeTree and is not offered as a choice: this is the "get it in here" action, and
 * a table you want something else for is one you write yourself (the designer is for that).
 */
export function importStatement(driverId: string, target: ImportTarget, call: string): string {
	const quote = dialectFor(driverId).quoteIdent;
	const name = target.database ? `${quote(target.database)}.${quote(target.table)}` : quote(target.table);
	const order = target.orderBy.length > 0 ? `(${target.orderBy.map(quote).join(', ')})` : 'tuple()';
	return `CREATE TABLE ${name}\nENGINE = MergeTree\nORDER BY ${order}\nAS SELECT * FROM ${call}`;
}

/** The line that goes under a recorded statement when the credentials came from a saved account,
 *  since the statement itself no longer says where they came from. */
export function credentialNote(accountName: string | undefined): string {
	return accountName ? `\n-- credentials from the "${accountName}" cloud account` : '';
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Secret redaction for SQL that is about to be RECORDED.
//
// Query history, failure memory and the AI audit log all keep the statement text. That is fine
// for `SELECT`, and a disclosure for `CREATE USER x IDENTIFIED BY 'hunter2'` — the password
// would sit in cleartext in userData/queries.json forever, next to the connection it opens.
// Every recording site in the connection manager runs its SQL through this first.
//
// The replacement is deliberately NOT a valid literal. History rows can be re-run with one
// click, and a redaction that parses (`IDENTIFIED BY '***'`) would quietly SET the password to
// the redaction text. `<redacted>` is a syntax error on every engine, so a re-run fails loudly
// instead of succeeding wrongly.
//
// Pure and parser-free, like the rest of the guard layer: it must never throw on half-typed SQL.

/** What a redacted secret is replaced with. Not valid SQL anywhere, on purpose (see above). */
export const REDACTED_SECRET = '<redacted>';

/** A quoted secret: a single-quoted (optionally N-prefixed for T-SQL), double-quoted or
 *  backtick-quoted literal, doubled-quote escapes included. */
const QUOTED = "(?:N?'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|`(?:[^`]|``)*`)";

/** A bare secret, which only Oracle allows (`ALTER USER x IDENTIFIED BY hunter2`). Restricted to
 *  the characters an Oracle password may use unquoted, so it cannot swallow punctuation. */
const BARE = String.raw`[A-Za-z0-9_$#]+`;

/**
 * Bare words that follow `IDENTIFIED BY` but are syntax, not a password. Redacting these would
 * lose real information from the history row for no gain (`IDENTIFIED BY RANDOM PASSWORD` asks
 * the server to generate one — there is no secret in the text at all).
 */
const NOT_A_SECRET = new Set(['random', 'values', 'password', 'externally', 'globally', 'default']);

/** `IDENTIFIED [WITH plugin] {BY|AS} [PASSWORD|VALUES] <secret>` — MySQL, MariaDB and Oracle. */
const IDENTIFIED = new RegExp(
	String.raw`(\bIDENTIFIED\b(?:\s+WITH\s+[A-Za-z0-9_$.]+)?\s+(?:BY|AS)(?:\s+(?:PASSWORD|VALUES))?\s+)(` + QUOTED + String.raw`|` + BARE + String.raw`)`,
	'gi',
);

/**
 * `[ENCRYPTED] {PASSWORD|OLD_PASSWORD|SECRET} [=] '<secret>'` — Postgres `CREATE ROLE … PASSWORD
 * 'x'`, T-SQL `WITH PASSWORD = N'x'`, and the `OPTIONS (password 'x')` of a foreign-server
 * mapping. QUOTED only: `ALTER USER x PASSWORD EXPIRE` is MySQL syntax with no secret in it, and
 * accepting a bare word here would redact `EXPIRE`.
 */
const PASSWORD_LITERAL = new RegExp(
	String.raw`(\b(?:ENCRYPTED\s+|UNENCRYPTED\s+|HASHED\s+)?(?:OLD_PASSWORD|PASSWORD|SECRET)\s*=?\s*)(` + QUOTED + String.raw`)`,
	'gi',
);

/** Oracle's `ALTER USER x IDENTIFIED BY new REPLACE old` — the old password is a secret too.
 *  Only applied to statements that carry an IDENTIFIED clause, so MySQL's `REPLACE INTO` and the
 *  `REPLACE(a, b, c)` function are never touched. */
const REPLACE_SECRET = new RegExp(String.raw`(\bREPLACE\s+)(` + QUOTED + String.raw`|` + BARE + String.raw`)`, 'gi');

/** MySQL's `SET PASSWORD [FOR u@h] = '<secret>'`, where a FOR clause sits between the two. */
const SET_PASSWORD = new RegExp(String.raw`(\bSET\s+PASSWORD\b[^;=]*=\s*)(` + QUOTED + String.raw`)`, 'gi');

function replaceSecret(prefix: string, secret: string): string {
	if (!secret.startsWith("'") && !secret.startsWith('"') && !secret.startsWith('`') && !/^N'/i.test(secret) && NOT_A_SECRET.has(secret.toLowerCase())) {
		return prefix + secret;
	}
	return prefix + REDACTED_SECRET;
}

/**
 * `sql` with every password/secret literal replaced by {@link REDACTED_SECRET}. Statements that
 * carry no secret are returned unchanged (same string), so the overwhelmingly common case costs
 * one regex test and nothing else.
 */
export function redactSqlSecrets(sql: string): string {
	if (!/\b(?:identified|password|secret)\b/i.test(sql)) {
		return sql;
	}
	let out = sql.replace(IDENTIFIED, (_m, prefix: string, secret: string) => replaceSecret(prefix, secret));
	out = out.replace(PASSWORD_LITERAL, (_m, prefix: string, secret: string) => replaceSecret(prefix, secret));
	out = out.replace(SET_PASSWORD, (_m, prefix: string, secret: string) => replaceSecret(prefix, secret));
	if (/\bIDENTIFIED\b/i.test(sql)) {
		out = out.replace(REPLACE_SECRET, (_m, prefix: string, secret: string) => replaceSecret(prefix, secret));
	}
	return out;
}

/** True when `sql` carries a secret {@link redactSqlSecrets} would remove. Callers that must
 *  decide whether a statement may be shown or stored at all (an audit payload, a shared link)
 *  ask this rather than diffing the redacted text. */
export function containsSqlSecret(sql: string): boolean {
	return redactSqlSecrets(sql) !== sql;
}

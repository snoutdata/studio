/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Secrets out of the text a failed restore leaves behind.
 *
 * A restore failure keeps the statement that failed, and the server's message can quote it back
 * (`LINE 1: ...`). Some of the statements that fail most often on a hosted target are the ones that
 * carry the source's stored credentials: `CREATE SUBSCRIPTION ... CONNECTION '... password=...'`,
 * `CREATE USER MAPPING ... OPTIONS (password '...')`, `ALTER ROLE ... PASSWORD '...'`. That text
 * goes into the run result and wherever a host keeps it, so it is redacted on the way out.
 *
 * The same rule as the desktop's `shared/engine/security/redact.ts`, kept here because this core
 * imports nothing: the replacement is `<redacted>`, which is not valid SQL anywhere, so a statement
 * somebody copies out of the report and re-runs fails loudly instead of setting a password to the
 * redaction text. Pure and parser-free; it never throws.
 */

export const REDACTED_SECRET = '<redacted>';

/** A single-quoted literal (optionally `E`-prefixed), doubled quotes included. */
const QUOTED = String.raw`[Ee]?'(?:[^']|'')*'`;

/**
 * `[ENCRYPTED] PASSWORD '<secret>'` on a role, and `password '<secret>'` / `sslpassword '<secret>'`
 * in a user mapping's OPTIONS (including `ADD` and `SET`). The verifier pg_dump writes for a role
 * (`SCRAM-SHA-256$...`) is redacted too: it is enough to attack the password offline.
 */
const PASSWORD_LITERAL = new RegExp(String.raw`(\b(?:ENCRYPTED\s+|UNENCRYPTED\s+)?(?:SSL)?PASSWORD\s*=?\s*)(` + QUOTED + ')', 'gi');

/**
 * `password=<secret>` inside a libpq connection string, which is itself inside a SQL literal, so a
 * quoted value has its quotes doubled (`password=''a b''`) and a bare one runs to the next space or
 * to the literal's closing quote (a doubled quote inside it is part of the value).
 */
const CONNINFO_QUOTED = /(\b(?:ssl)?password\s*=\s*)(''(?:[^']|'''')*'')/gi;
const CONNINFO_BARE = /(\b(?:ssl)?password\s*=\s*)((?:[^\s']|'')+)/gi;

/** A Postgres connection URI's password: `<scheme>://user:<secret>@host`. */
const URI_PASSWORD = /(\b(?:postgres|postgresql):\/\/[^:/@\s']*:)([^@\s']*)(@)/gi;

/** `text` with every password it carries replaced by {@link REDACTED_SECRET}. */
export function redactSecrets(text: string): string {
	if (!/password|:\/\//i.test(text)) {
		return text;
	}
	return text
		.replace(URI_PASSWORD, (_m, before: string, _secret: string, at: string) => `${before}${REDACTED_SECRET}${at}`)
		// Quoted conninfo first: read as a SQL literal, `''a b''` is an empty string and the
		// password after it would survive.
		.replace(CONNINFO_QUOTED, (_m, prefix: string) => `${prefix}${REDACTED_SECRET}`)
		.replace(PASSWORD_LITERAL, (_m, prefix: string) => `${prefix}${REDACTED_SECRET}`)
		.replace(CONNINFO_BARE, (_m, prefix: string, value: string) => `${prefix}${value === REDACTED_SECRET ? value : REDACTED_SECRET}`);
}

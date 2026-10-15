/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The write half's seam: one emitter per engine, turning a vendor-neutral SecurityChange into
 *  concrete SQL. The emitter is responsible for SQL TEXT only — the sentence shown to the person
 *  approving it, and whether it is destructive, are derived centrally in plan.ts so they cannot
 *  drift between vendors.
 *
 *  Nothing here runs anything. An emitter's whole output is text for the review surface.
 *--------------------------------------------------------------------------------------------*/

import type { GrantScope, PolicyKind, PrincipalKind, SecurityChange } from './types';

export interface SecurityEmitter {
	readonly driverId: string;
	/** The principal kinds this engine actually has, in the order the UI should offer them.
	 *  SQL Server lists `login` as well as `user` because they are genuinely different objects. */
	readonly principalKinds: readonly PrincipalKind[];
	/** True when a principal's identity includes a host (MySQL and MariaDB, and nothing else). */
	readonly usesHost: boolean;
	/** The scopes a grant can be made at on this engine, narrow to wide. Oracle returns no
	 *  `schema`/`database` because a schema IS a user there — offering the control would be
	 *  offering something that cannot be expressed. */
	readonly grantScopes: readonly GrantScope[];
	/** The privileges offered for a scope, for the review surface's picker. Not exhaustive by
	 *  design — the common set, in a sensible order, with a free-text field for the rest. */
	privilegesFor(scope: GrantScope): readonly string[];
	/** The policy kinds this engine's catalog is read for and whose statements this emitter
	 *  writes. Empty on every engine but ClickHouse today. The UI hides what is not here, and
	 *  `emit` still refuses by name if something asks anyway. */
	readonly policyKinds: readonly PolicyKind[];
	/** SQL for one change. Most yield one statement; some yield several (creating a user with
	 *  roles is a CREATE plus one GRANT per role). */
	emit(change: SecurityChange): string[];
}

/** A single-quoted SQL string literal, doubling any embedded quote. For engines whose literals
 *  give a backslash no meaning (Postgres with standard strings, SQL Server, Oracle). */
export function quoteLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A single-quoted string literal for an engine that reads a backslash as an escape inside one:
 * MySQL and MariaDB (their user, host and role names are literals, not identifiers) and
 * ClickHouse. The backslash is doubled first, then the quote, so no character of the value can
 * end the literal early: `x\` stays one literal instead of escaping the closing quote and
 * running on into the next one.
 *
 * Quotes are doubled rather than backslash-escaped because both server modes read `''` the same
 * way. With MySQL's NO_BACKSLASH_ESCAPES on, a doubled backslash reads as two characters, so the
 * value differs from the one written but the statement still holds exactly one literal there.
 */
export function quoteBackslashLiteral(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** A double-quoted identifier (Postgres, Oracle), doubling any embedded quote. */
export function quoteDouble(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** A backtick-quoted identifier (MySQL, MariaDB). */
export function quoteBacktick(name: string): string {
	return '`' + name.replace(/`/g, '``') + '`';
}

/** A bracket-quoted identifier (SQL Server). */
export function quoteBracket(name: string): string {
	return `[${name.replace(/]/g, ']]')}]`;
}

/** Characters that may not appear in a name we are about to quote into a statement. */
const UNSAFE_IN_NAME = /[\u0000-\u001F\u007F;]/;

/**
 * Reject a name that cannot be safely quoted into an identifier.
 *
 * Every emitter quotes, so an embedded quote is escaped rather than injected — but a name
 * carrying a control character or a statement terminator is not a name anyone meant to type, and
 * letting it through produces a statement whose review surface shows one thing and whose server
 * does another. Refusing is the honest answer.
 */
export function assertSafeName(name: string, what: string): string {
	const trimmed = name.trim();
	if (trimmed === '') {
		throw new Error(`The ${what} cannot be empty.`);
	}
	if (UNSAFE_IN_NAME.test(trimmed)) {
		throw new Error(`The ${what} "${name}" contains a character that is not allowed in a name.`);
	}
	return trimmed;
}

/**
 * Reject a password that cannot be safely quoted into a statement.
 *
 * Same reasoning as {@link assertSafeName}, and it matters more here: the password is the one
 * value the review surface deliberately does NOT display, so a reviewer cannot catch what a
 * control character did to the statement they are approving.
 */
export function assertSafePassword(password: string): string {
	if (password === '') {
		throw new Error('The password cannot be empty.');
	}
	if (UNSAFE_IN_NAME.test(password)) {
		throw new Error('The password contains a character that is not allowed.');
	}
	return password;
}

/**
 * Reject a privilege that is not a plain privilege word.
 *
 * Privileges are the one part of a GRANT that cannot be quoted — `GRANT "SELECT"` is not valid
 * anywhere — so they are interpolated bare and must be validated instead. Letters, spaces and
 * underscores only, which covers every real privilege on all four engines (SELECT,
 * ALL PRIVILEGES, CREATE TEMPORARY TABLES, VIEW DEFINITION) and nothing else.
 */
export function assertSafePrivilege(privilege: string): string {
	const trimmed = privilege.trim().toUpperCase();
	if (!/^[A-Z][A-Z_ ]*$/.test(trimmed)) {
		throw new Error(`"${privilege}" is not a valid privilege name.`);
	}
	return trimmed;
}

/** Validate and join a privilege list for a GRANT/REVOKE. */
export function privilegeList(privileges: readonly string[]): string {
	if (privileges.length === 0) {
		throw new Error('Select at least one privilege.');
	}
	return privileges.map(assertSafePrivilege).join(', ');
}

/** How a policy kind is named in a sentence addressed to a person. */
export function policyKindLabel(kind: PolicyKind): string {
	switch (kind) {
		case 'row-policy': return 'row policy';
		case 'quota': return 'quota';
		case 'settings-profile': return 'settings profile';
	}
}

/**
 * Refuse a policy an engine cannot express, in the user's words.
 *
 * Four of the six engines land here for all three kinds. That is deliberately a REFUSAL rather
 * than a missing case: Postgres really does have row policies, so the honest sentence is "not
 * read or written here yet", not silence and not a statement written by guesswork.
 */
export function refusePolicy(engine: string, kind: PolicyKind): never {
	throw new Error(`${engine} ${policyKindLabel(kind)} objects are not supported by SnoutData yet.`);
}

/** Characters that end a statement or start a comment. */
const STATEMENT_BREAK = /[;\u0000-\u0008\u000B\u000C\u000E-\u001F]|--|\/\*/;

/**
 * Reject an expression that could carry a second statement.
 *
 * A row policy's filter IS an expression, so unlike every other value in this module it cannot be
 * quoted or picked from a list: it goes into the statement as written. This is not a SQL parser
 * and does not pretend to be one. What it does is make sure the statement the reviewer reads is
 * the whole statement that runs, by refusing a terminator or a comment that could hide the rest
 * of the line from them. The review sheet is the real control; this stops it being lied to.
 */
export function assertSafeExpression(expression: string, what: string): string {
	const trimmed = expression.trim();
	if (trimmed === '') {
		throw new Error(`The ${what} cannot be empty.`);
	}
	if (STATEMENT_BREAK.test(trimmed)) {
		throw new Error(`The ${what} cannot contain a semicolon or a comment.`);
	}
	return trimmed;
}

/** A setting or limit name: a bare identifier, interpolated unquoted because no engine accepts a
 *  quoted one. */
export function assertSafeSettingName(name: string): string {
	const trimmed = name.trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
		throw new Error(`"${name}" is not a valid setting name.`);
	}
	return trimmed;
}

/** A setting's value: a number as itself, anything else as a quoted literal. Settings take both
 *  (`max_memory_usage = 1000000`, `log_comment = 'x'`) and quoting a number would be refused. */
export function settingValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed === '') {
		throw new Error('A setting needs a value.');
	}
	return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : quoteBackslashLiteral(trimmed);
}

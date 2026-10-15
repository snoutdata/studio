/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The vendor-neutral model of who can reach a database and what they may do with it.
 *
 *  Principals and grants are the least portable thing in SQL — there is no `information_schema`
 *  worth having, and the four supported engines disagree on the shape of the question, not just
 *  its spelling (MySQL identifies a user by name AND host; SQL Server splits a server login from
 *  the database user it maps to; Oracle makes a role a kind of principal you can log in as).
 *  Rather than flatten those differences away, this model keeps the union and lets each vendor
 *  fill in what it has — the UI renders what is present and says nothing about what is not.
 *--------------------------------------------------------------------------------------------*/

/**
 * What kind of thing a principal is.
 *
 * `login` is a SQL Server server-level login, which is NOT a database user: it authenticates but
 * reaches no data until a `user` in some database maps to it. Keeping them apart is the whole
 * reason the "I created the login and it still can't connect" question exists.
 */
export type PrincipalKind = 'user' | 'role' | 'login' | 'group';

/** One account or role, as the server's own catalog reports it. */
export interface Principal {
	/** The name exactly as the catalog stores it (already case-folded by the engine, if it folds). */
	name: string;
	kind: PrincipalKind;
	/** MySQL/MariaDB only: the host part. Identity there is the PAIR — `app@localhost` and
	 *  `app@%` are two different accounts with different grants, and treating them as one is the
	 *  classic way to grant a privilege that appears to do nothing. */
	host?: string;
	/** Can authenticate and open a session. False for a pure role/group. */
	canLogin: boolean;
	/** Holds the engine's unrestricted role (pg `rolsuper`, MySQL `SUPER`/`ALL`, `sysadmin`, DBA),
	 *  whether directly or through a role it is a member of. See {@link superuserVia}. */
	isSuperuser: boolean;
	/**
	 * The role this principal is a superuser THROUGH, when it does not hold it directly.
	 *
	 * Not a nicety. ClickHouse Cloud's `default` user holds no grant of its own at all: everything
	 * it can do arrives through `default_role`, so a catalog read that only looks at direct grants
	 * reports the administrator of the service as an ordinary account. Naming the role is what
	 * makes the badge actionable, because the thing to take away is the membership, not a grant
	 * the user does not have.
	 */
	superuserVia?: string;
	/** The account exists but is switched off (T-SQL `DISABLE`, Oracle `EXPIRED & LOCKED`). */
	disabled: boolean;
	/** Locked out, usually by failed-login policy rather than by an administrator. */
	locked: boolean;
	/** When the account or its password stops working, as the catalog reports it. */
	expiresAt?: string;
	/** Roles this principal is a member of, by name. */
	memberOf: readonly string[];
	/** Vendor facts with no cross-engine meaning (`rolconnlimit`, `default_tablespace`, the
	 *  authentication plugin), already stringified for display in the detail pane. */
	attributes?: Readonly<Record<string, string>>;
}

/** How wide a grant reaches. Ordered narrow-to-wide by {@link scopeRank}. */
export type GrantScope = 'column' | 'table' | 'schema' | 'database' | 'global';

/** Sort key for a scope, so a principal's grants can be shown widest-first — the wide ones are
 *  what actually decide what someone can do, and burying them under fifty table rows is how a
 *  stray `ALL PRIVILEGES` goes unnoticed. */
export function scopeRank(scope: GrantScope): number {
	switch (scope) {
		case 'global': return 0;
		case 'database': return 1;
		case 'schema': return 2;
		case 'table': return 3;
		case 'column': return 4;
	}
}

/** One privilege held by one principal on one object. */
export interface Grant {
	grantee: string;
	/** MySQL's host part of the grantee (see {@link Principal.host}). */
	granteeHost?: string;
	scope: GrantScope;
	database?: string;
	schema?: string;
	/** Table, view or routine name, for a `table`/`column` scope grant. */
	object?: string;
	column?: string;
	/** Upper-cased privilege as the catalog names it: SELECT, INSERT, EXECUTE, ALL PRIVILEGES, … */
	privilege: string;
	/** The grantee may pass this privilege on to others. */
	withGrantOption: boolean;
	/**
	 * This is a DENY, not a grant (SQL Server only). It has to be in the model rather than
	 * filtered out of the read: a DENY beats every GRANT the principal holds, including one it
	 * inherits from a role, so a list that shows only the grants tells the reader the OPPOSITE of
	 * what is true about that object.
	 */
	deny?: boolean;
	/** Who granted it, when the catalog records that. */
	grantor?: string;
}

/**
 * What kind of thing an {@link AccessPolicy} is.
 *
 * These are the access objects that are NEITHER a principal nor a grant, and that is the whole
 * reason they need a type of their own. A grant answers "may this account read this table"; these
 * three answer the questions that come AFTER the answer is yes: which rows of it (`row-policy`),
 * how much of it per hour (`quota`), and under which settings (`settings-profile`). A DBA looking
 * for why an account sees four rows out of four million will not find it in a grant list.
 */
export type PolicyKind = 'row-policy' | 'quota' | 'settings-profile';

/**
 * One access policy, as the server's own catalog reports it.
 *
 * Deliberately ONE type for all three kinds rather than three. What differs between them is the
 * DETAIL (an expression, a set of limits, a set of settings), and every question the screen asks
 * is common: what is it called, what is it attached to, who does it apply to, and what does it
 * do. Keeping the detail as text the vendor query composed keeps this model out of the business
 * of modelling every engine's limit vocabulary, which is where a shared type would go wrong first.
 */
export interface AccessPolicy {
	kind: PolicyKind;
	/** The name as the catalog reports it. For a ClickHouse row policy this is the SHORT name
	 *  (`hide_others`), not the qualified `hide_others ON db.t` form the catalog also carries. */
	name: string;
	/** Row policies only: the table it filters. */
	database?: string;
	object?: string;
	/** The principals it applies to, by name. */
	appliesTo: readonly string[];
	/** It applies to everyone, minus {@link exceptFor}. Both halves matter: "everyone except the
	 *  admin" is the common shape of a real row policy, and showing only the list would say the
	 *  policy applies to nobody. */
	appliesToAll: boolean;
	exceptFor: readonly string[];
	/** The one fact that says what this policy DOES, composed by the vendor query: the filter
	 *  expression, the limits with their window, or the settings it sets. */
	detail?: string;
	/** Row policies only: this one is ANDed with the others rather than ORed, so it can only ever
	 *  take rows away. The distinction decides what a second policy on the same table does, which
	 *  is the thing people get wrong about them. */
	restrictive?: boolean;
	/** Vendor facts with no cross-engine meaning, already stringified for the detail pane. */
	attributes?: Readonly<Record<string, string>>;
}

/** Enough to name an existing policy in a statement. */
export interface PolicyRef {
	kind: PolicyKind;
	name: string;
	database?: string;
	object?: string;
}

/** One `name = value` a settings profile sets. */
export interface PolicySetting {
	name: string;
	value: string;
}

/** A new policy to create. Only the fields its kind uses are read; the emitter refuses the ones
 *  its engine cannot express rather than quietly dropping them. */
export interface PolicyDraft extends PolicyRef {
	/** Row policy: the expression a row must satisfy to be visible. */
	expression?: string;
	restrictive?: boolean;
	/** Quota: how long the window is (`1 hour`), and what it caps. */
	interval?: { duration: number; unit: string; limits: readonly PolicySetting[] };
	/** Settings profile: what it sets. */
	settings?: readonly PolicySetting[];
	/** Who it applies to on creation. Empty with `appliesToAll` false means it exists and applies
	 *  to nobody, which is legal and is how a policy is staged before it is turned on. */
	appliesTo?: readonly string[];
	appliesToAll?: boolean;
}

/** Everything the security view read back for one connection. */
export interface SecuritySnapshot {
	driverId: string;
	principals: readonly Principal[];
	grants: readonly Grant[];
	/** Row policies, quotas and settings profiles, on the engines that have them. Empty rather
	 *  than absent on the engines that do not, so nothing downstream has to test for it. */
	policies: readonly AccessPolicy[];
	/**
	 * What could not be read, in the user's words rather than the driver's. A read that needs
	 * privileges the connected account does not hold is the NORMAL case, not an error: an app user
	 * inspecting its own database can see itself and nothing else. The view shows what it got and
	 * says plainly what it could not.
	 */
	warnings: readonly string[];
}

/** The object a privilege is granted on, for the write side. */
export interface GrantTarget {
	scope: GrantScope;
	database?: string;
	schema?: string;
	object?: string;
	columns?: readonly string[];
}

/** Who a statement is about. `host` is MySQL's, and is part of the identity there. */
export interface PrincipalRef {
	name: string;
	host?: string;
}

/** A new account or role to create. */
export interface PrincipalDraft extends PrincipalRef {
	kind: PrincipalKind;
	/**
	 * The cleartext password, present ONLY in memory on the way to a single generated statement.
	 * It is never persisted, never sent to a model, and never recorded: everything that keeps SQL
	 * runs it through `redactSqlSecrets` first.
	 */
	password?: string;
	/** Roles to grant the new principal on creation. */
	memberOf?: readonly string[];
}

/** The write operations the security view can ask an engine to perform. A discriminated union so
 *  a vendor emitter must handle every case or fail to compile. */
export type SecurityChange =
	| { kind: 'create-principal'; draft: PrincipalDraft }
	| { kind: 'drop-principal'; principal: PrincipalRef; principalKind: PrincipalKind }
	| { kind: 'set-password'; principal: PrincipalRef; password: string }
	| { kind: 'set-enabled'; principal: PrincipalRef; enabled: boolean }
	| { kind: 'grant'; principal: PrincipalRef; target: GrantTarget; privileges: readonly string[]; withGrantOption?: boolean }
	| { kind: 'revoke'; principal: PrincipalRef; target: GrantTarget; privileges: readonly string[] }
	| { kind: 'grant-role'; principal: PrincipalRef; role: string }
	| { kind: 'revoke-role'; principal: PrincipalRef; role: string }
	| { kind: 'create-policy'; draft: PolicyDraft }
	| { kind: 'drop-policy'; policy: PolicyRef }
	/** Who the policy applies to, as the WHOLE list rather than one addition. The engines write
	 *  this with a statement that replaces the list (`ALTER ROW POLICY p ON t TO a, b`), so
	 *  sending a delta would mean reading the current list inside the emitter, which is pure and
	 *  has no connection. The screen knows the list; it sends the one it wants to end up with. */
	| { kind: 'set-policy-principals'; policy: PolicyRef; appliesTo: readonly string[]; appliesToAll: boolean };

/** One statement in a security plan, with the human sentence that explains it. */
export interface SecurityStatement {
	id: string;
	sql: string;
	/** One line, addressed to the person approving it ("Create the user app@%."). */
	description: string;
	/** True when this statement takes access away or destroys a principal — the review surface
	 *  marks these, because "revoke" and "grant" are one keystroke apart and look identical in a list. */
	destructive: boolean;
	/** True when `sql` carries a password, so no surface may log, copy or export it verbatim. */
	carriesSecret: boolean;
}

/** An ordered set of statements produced from one or more {@link SecurityChange}s, ready for the
 *  review surface. Nothing here has been run. */
export interface SecurityPlan {
	driverId: string;
	statements: readonly SecurityStatement[];
}

/**
 * The outcome of applying a security plan.
 *
 * `applied` counts the statements that succeeded, because this is NOT all-or-nothing: three of
 * the four engines auto-commit each of these statements, so a plan that fails halfway has really
 * done half of it, and the surface has to say which half rather than pretend it rolled back.
 */
export type SecurityApplyResult =
	| { ok: true; applied: number }
	| {
		ok: false;
		error: string;
		/** Position in the plan that failed. */
		failedIndex: number;
		failedId: string;
		/** How many statements before it succeeded, and are now in effect. */
		applied: number;
		/** The failing statement's sentence, so the message can name what did not happen. */
		description: string;
	};

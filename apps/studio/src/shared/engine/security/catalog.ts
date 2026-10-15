/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The read half: how each engine's own catalog is asked who exists and what they may do.
 *
 *  Every vendor query aliases its columns to ONE fixed contract (see PRINCIPAL_COLUMNS /
 *  GRANT_COLUMNS), which is what keeps the vendor knowledge entirely in SQL text and the mapping
 *  entirely generic. A new engine is a file of SELECTs, not a new code path.
 *
 *  Two things the contract is shaped around:
 *
 *  - A read that fails is normal. `dba_users` needs privileges most accounts do not hold, and an
 *    application user inspecting its own database can usually see only itself. So a catalog is a
 *    LIST of queries, each with ordered fallback candidates, and a query that fails all of its
 *    candidates becomes a warning on the snapshot rather than an error that empties the screen.
 *  - Any column a vendor query returns that is NOT in the contract becomes a display attribute,
 *    keyed by its column alias. That is how `Default tablespace` and `Authentication plugin`
 *    reach the detail pane without either being in the shared model or needing vendor code here.
 *--------------------------------------------------------------------------------------------*/

import type { AccessPolicy, Grant, GrantScope, PolicyKind, Principal, PrincipalKind } from './types';

/** One thing to ask the catalog. The first candidate that runs without erroring wins; the rest
 *  exist because the privileged view (`dba_*`, `mysql.user`) is not always readable. */
export interface CatalogQuery {
	/** What this query is for, in the user's words — it names the gap in a warning when every
	 *  candidate fails ("Could not read table privileges: …"). */
	label: string;
	/** SQL candidates, most informative first. */
	candidates: readonly string[];
}

/** The per-vendor read half. */
export interface SecurityCatalog {
	readonly driverId: string;
	/** Queries returning rows in the {@link PRINCIPAL_COLUMNS} contract. Results are concatenated
	 *  (SQL Server asks twice: database principals, then server logins). */
	readonly principals: readonly CatalogQuery[];
	/** Queries returning rows in the {@link GRANT_COLUMNS} contract, concatenated. */
	readonly grants: readonly CatalogQuery[];
	/** Queries returning rows in the {@link POLICY_COLUMNS} contract: row policies, quotas and
	 *  settings profiles. Absent on an engine that has none of them, or whose ones we do not read
	 *  yet, which is not the same thing and is why `policyKinds` on the emitter says which. */
	readonly policies?: readonly CatalogQuery[];
}

/** Contract columns for a principal query. Anything else becomes a display attribute. */
export const PRINCIPAL_COLUMNS = ['name', 'kind', 'host', 'can_login', 'is_superuser', 'disabled', 'locked', 'expires_at', 'member_of'] as const;

/** Contract columns for a grant query. */
export const GRANT_COLUMNS = ['grantee', 'grantee_host', 'scope', 'database_name', 'schema_name', 'object_name', 'column_name', 'privilege', 'is_grantable', 'is_deny', 'grantor'] as const;

/** Contract columns for a policy query. `detail` is a sentence the VENDOR composed, because what
 *  a policy does is the one thing that has no shared vocabulary: an expression on one kind, a set
 *  of limits on another. Anything else the query returns becomes a display attribute. */
export const POLICY_COLUMNS = ['kind', 'name', 'database_name', 'object_name', 'applies_to', 'applies_to_all', 'except_for', 'detail', 'is_restrictive'] as const;

/** A catalog row as the drivers hand it back: column name → cell. */
export type CatalogRow = Record<string, unknown>;

/** Read a cell by column name, case-insensitively.
 *
 *  Oracle upper-cases every unquoted alias and Postgres lower-cases them, so `can_login` comes
 *  back as `CAN_LOGIN` on one and `can_login` on the other. Quoting every alias to force the case
 *  would work but would also force `"Default tablespace"`-style quoting on the attribute columns
 *  where the display case is the point, so the lookup folds instead. */
function cell(row: CatalogRow, column: string): unknown {
	if (column in row) {
		return row[column];
	}
	const want = column.toLowerCase();
	for (const key of Object.keys(row)) {
		if (key.toLowerCase() === want) {
			return row[key];
		}
	}
	return undefined;
}

/** A cell as a trimmed string, or undefined when it is null/empty. */
function str(row: CatalogRow, column: string): string | undefined {
	const value = cell(row, column);
	if (value === null || value === undefined) {
		return undefined;
	}
	const text = value instanceof Date ? value.toISOString() : String(value);
	const trimmed = text.trim();
	return trimmed === '' ? undefined : trimmed;
}

/**
 * A cell as a boolean. The four engines each say yes differently — Postgres returns a real
 * boolean, MySQL's catalog uses `'Y'`/`'N'`, `information_schema` uses `'YES'`/`'NO'`, and the
 * `CASE WHEN … THEN 1 ELSE 0` columns come back as a number or its string. All of them mean yes.
 */
function bool(row: CatalogRow, column: string): boolean {
	const value = cell(row, column);
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	const text = str(row, column);
	if (text === undefined) {
		return false;
	}
	const lower = text.toLowerCase();
	return lower === 'y' || lower === 'yes' || lower === 'true' || lower === 't' || lower === '1';
}

/** A display value for an attribute cell: booleans read as Yes/No rather than `true`/`0`. */
function attributeText(value: unknown): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === 'boolean') {
		return value ? 'Yes' : 'No';
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	const text = String(value).trim();
	return text === '' ? undefined : text;
}

function principalKind(raw: string | undefined): PrincipalKind {
	switch ((raw ?? '').toLowerCase()) {
		case 'role': return 'role';
		case 'login': return 'login';
		case 'group': return 'group';
		default: return 'user';
	}
}

function grantScope(raw: string | undefined): GrantScope {
	switch ((raw ?? '').toLowerCase()) {
		case 'column': return 'column';
		case 'schema': return 'schema';
		case 'database': return 'database';
		case 'global': return 'global';
		default: return 'table';
	}
}

/** Split a comma-separated `member_of` cell into role names. Empty and whitespace-only entries
 *  are dropped, so a vendor that returns `''` for "no roles" needs no special case. */
function memberList(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	return raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
}

/** One catalog row → a {@link Principal}. Unknown columns become display attributes. */
export function rowToPrincipal(row: CatalogRow): Principal | null {
	const name = str(row, 'name');
	if (!name) {
		return null;
	}
	const known = new Set<string>(PRINCIPAL_COLUMNS.map((column) => column.toLowerCase()));
	const attributes: Record<string, string> = {};
	for (const key of Object.keys(row)) {
		if (known.has(key.toLowerCase())) {
			continue;
		}
		const text = attributeText(row[key]);
		if (text !== undefined) {
			attributes[key] = text;
		}
	}
	return {
		name,
		kind: principalKind(str(row, 'kind')),
		host: str(row, 'host'),
		canLogin: bool(row, 'can_login'),
		isSuperuser: bool(row, 'is_superuser'),
		disabled: bool(row, 'disabled'),
		locked: bool(row, 'locked'),
		expiresAt: str(row, 'expires_at'),
		memberOf: memberList(str(row, 'member_of')),
		attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
	};
}

/** One catalog row → a {@link Grant}. */
export function rowToGrant(row: CatalogRow): Grant | null {
	const grantee = str(row, 'grantee');
	const privilege = str(row, 'privilege');
	if (!grantee || !privilege) {
		return null;
	}
	return {
		grantee,
		granteeHost: str(row, 'grantee_host'),
		scope: grantScope(str(row, 'scope')),
		database: str(row, 'database_name'),
		schema: str(row, 'schema_name'),
		object: str(row, 'object_name'),
		column: str(row, 'column_name'),
		privilege: privilege.toUpperCase(),
		withGrantOption: bool(row, 'is_grantable'),
		deny: bool(row, 'is_deny') ? true : undefined,
		grantor: str(row, 'grantor'),
	};
}

function policyKind(raw: string | undefined): PolicyKind | null {
	switch ((raw ?? '').toLowerCase()) {
		case 'row-policy': return 'row-policy';
		case 'quota': return 'quota';
		case 'settings-profile': return 'settings-profile';
		default: return null;
	}
}

/** One catalog row → an {@link AccessPolicy}. A row whose `kind` is not one of the three is
 *  dropped rather than guessed at: there is no sensible default, and a policy rendered as the
 *  wrong kind would be read as saying something it does not say. */
export function rowToPolicy(row: CatalogRow): AccessPolicy | null {
	const name = str(row, 'name');
	const kind = policyKind(str(row, 'kind'));
	if (!name || !kind) {
		return null;
	}
	const known = new Set<string>(POLICY_COLUMNS.map((column) => column.toLowerCase()));
	const attributes: Record<string, string> = {};
	for (const key of Object.keys(row)) {
		if (known.has(key.toLowerCase())) {
			continue;
		}
		const text = attributeText(row[key]);
		if (text !== undefined) {
			attributes[key] = text;
		}
	}
	return {
		kind,
		name,
		database: str(row, 'database_name'),
		object: str(row, 'object_name'),
		appliesTo: memberList(str(row, 'applies_to')),
		appliesToAll: bool(row, 'applies_to_all'),
		exceptFor: memberList(str(row, 'except_for')),
		detail: str(row, 'detail'),
		restrictive: kind === 'row-policy' ? bool(row, 'is_restrictive') : undefined,
		attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
	};
}

/** Map a whole result set, dropping rows the contract cannot make sense of. */
export function rowsToPrincipals(rows: readonly CatalogRow[]): Principal[] {
	return rows.map(rowToPrincipal).filter((p): p is Principal => p !== null);
}

export function rowsToGrants(rows: readonly CatalogRow[]): Grant[] {
	return rows.map(rowToGrant).filter((g): g is Grant => g !== null);
}

export function rowsToPolicies(rows: readonly CatalogRow[]): AccessPolicy[] {
	return rows.map(rowToPolicy).filter((p): p is AccessPolicy => p !== null);
}

/**
 * Does this policy apply to this principal?
 *
 * The question the detail pane asks of every policy, and it is not "is the name in the list":
 * "everyone except the administrator" is the ordinary shape of a real row policy, and a list
 * membership test answers it backwards. A policy that applies to a ROLE is reported for the
 * members of that role too, because what a user sees is decided by the roles they hold.
 */
export function policyAppliesTo(policy: AccessPolicy, principalName: string, memberOf: readonly string[] = []): boolean {
	const names = [principalName, ...memberOf];
	if (policy.exceptFor.some((name) => names.includes(name))) {
		return false;
	}
	if (policy.appliesToAll) {
		return true;
	}
	return policy.appliesTo.some((name) => names.includes(name));
}

/** A policy's identity, unique across the three kinds and across tables: two row policies on two
 *  tables legitimately share a short name. */
export function policyKey(policy: { kind: PolicyKind; name: string; database?: string; object?: string }): string {
	const on = policy.database || policy.object ? `:${policy.database ?? ''}.${policy.object ?? ''}` : '';
	return `${policy.kind}:${policy.name}${on}`;
}

/**
 * Identity key for a principal: the name, plus the host where the engine has one. MySQL's
 * `app@localhost` and `app@%` are two accounts with two sets of grants, so anything that joins
 * grants to principals must key on the pair or it will show one account another's privileges.
 */
export function principalKey(name: string, host?: string): string {
	return host ? `${name}@${host}` : name;
}

/**
 * Mark every principal that is a superuser THROUGH a role, not just the ones that hold it
 * directly.
 *
 * A catalog read can only report what the server records against each principal, and on some
 * engines that is nothing useful: ClickHouse Cloud grants its `default` user no privilege at all
 * and makes it a member of `default_role`, which holds them. Reading only direct grants therefore
 * reports the administrator of the service as an ordinary account, which is the exact failure the
 * flag exists to prevent, arriving from the other direction.
 *
 * Applied to the whole snapshot rather than inside any one vendor, because "a role can carry it"
 * is true of every engine that has roles, and a vendor cannot express it in one SELECT without a
 * recursive CTE it may not have.
 *
 * Membership is followed TRANSITIVELY (Cloud really does chain: a console user is granted
 * `sql_console_admin`, which is granted `default_role`, which holds `CREATE USER`), and a cycle
 * is survived rather than trusted: `seen` stops a role that is somehow a member of itself.
 */
export function propagateSuperuser(principals: readonly Principal[]): Principal[] {
	const byName = new Map<string, Principal>();
	for (const principal of principals) {
		// Keyed by name alone: a role has no host anywhere, and it is roles that carry this.
		if (!byName.has(principal.name)) {
			byName.set(principal.name, principal);
		}
	}
	/** The first superuser role reachable from `names`, or undefined. */
	function reach(names: readonly string[], seen: Set<string>): string | undefined {
		for (const name of names) {
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			const role = byName.get(name);
			if (!role) {
				continue;
			}
			if (role.isSuperuser) {
				return role.name;
			}
			const deeper = reach(role.memberOf, seen);
			if (deeper) {
				return deeper;
			}
		}
		return undefined;
	}
	return principals.map((principal) => {
		if (principal.isSuperuser) {
			return principal;
		}
		const via = reach(principal.memberOf, new Set([principal.name]));
		return via ? { ...principal, isSuperuser: true, superuserVia: via } : principal;
	});
}

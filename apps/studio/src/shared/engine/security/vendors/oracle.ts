/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Oracle users, roles and privileges.
 *
 *  Two Oracle facts shape this file:
 *
 *  1. A schema IS a user. There is no schema-level grant to make, so `grantScopes` offers table,
 *     column and system-wide and nothing else. Offering a "grant on schema" control here would
 *     be offering something the engine cannot express.
 *  2. The `dba_*` views need privileges most accounts do not hold. That is the NORMAL case, not
 *     a misconfiguration, so every query falls back to the `all_*` / `user_*` view that shows the
 *     connected account what it can see. The view then shows less and says so, rather than
 *     showing an error where the users should be.
 *
 *  No statement here carries a trailing semicolon: the driver sends one statement per call, and
 *  a terminator is a syntax error on that path.
 *--------------------------------------------------------------------------------------------*/

import type { CatalogQuery, SecurityCatalog } from '../catalog';
import type { SecurityEmitter } from '../emitter';
import { assertSafeName, assertSafePassword, privilegeList, quoteDouble, refusePolicy } from '../emitter';
import type { GrantScope, GrantTarget, PrincipalRef, SecurityChange } from '../types';

const DBA_USERS = `SELECT u.username AS name,
       'user' AS kind,
       NULL AS host,
       1 AS can_login,
       CASE WHEN EXISTS (SELECT 1 FROM dba_role_privs rp
                         WHERE rp.grantee = u.username AND rp.granted_role = 'DBA') THEN 1 ELSE 0 END AS is_superuser,
       CASE WHEN u.account_status LIKE '%LOCKED%' THEN 1 ELSE 0 END AS disabled,
       CASE WHEN u.account_status LIKE '%LOCKED%' THEN 1 ELSE 0 END AS locked,
       u.expiry_date AS expires_at,
       (SELECT LISTAGG(rp.granted_role, ',') WITHIN GROUP (ORDER BY rp.granted_role)
        FROM dba_role_privs rp WHERE rp.grantee = u.username) AS member_of,
       u.account_status AS "Account status",
       u.default_tablespace AS "Default tablespace",
       u.profile AS "Profile",
       u.created AS "Created"
FROM dba_users u
ORDER BY u.username`;

/** What an account with no DBA views can still see: the list of user names, and nothing else. */
const ALL_USERS = `SELECT u.username AS name,
       'user' AS kind,
       NULL AS host,
       1 AS can_login,
       0 AS is_superuser,
       0 AS disabled,
       0 AS locked,
       NULL AS expires_at,
       NULL AS member_of,
       u.created AS "Created"
FROM all_users u
ORDER BY u.username`;

const DBA_ROLES = `SELECT r.role AS name,
       'role' AS kind,
       NULL AS host,
       0 AS can_login,
       0 AS is_superuser,
       0 AS disabled,
       0 AS locked,
       NULL AS expires_at,
       NULL AS member_of,
       r.authentication_type AS "Authentication"
FROM dba_roles r
ORDER BY r.role`;

/** The roles the connected session actually has, when `dba_roles` is out of reach. */
const SESSION_ROLES = `SELECT sr.role AS name,
       'role' AS kind,
       NULL AS host,
       0 AS can_login,
       0 AS is_superuser,
       0 AS disabled,
       0 AS locked,
       NULL AS expires_at,
       NULL AS member_of
FROM session_roles sr
ORDER BY sr.role`;

function sysPrivs(view: string, grantee: string): string {
	return `SELECT ${grantee} AS grantee,
       NULL AS grantee_host,
       'global' AS scope,
       NULL AS database_name,
       NULL AS schema_name,
       NULL AS object_name,
       NULL AS column_name,
       p.privilege AS privilege,
       CASE WHEN p.admin_option = 'YES' THEN 1 ELSE 0 END AS is_grantable,
       0 AS is_deny,
       NULL AS grantor
FROM ${view} p`;
}

/** Object privileges. `owner` is the column in 12c and later; older releases call the same thing
 *  `table_schema` on the `all_*` view, hence the second candidate. */
function tabPrivs(view: string, ownerColumn: string): string {
	return `SELECT p.grantee AS grantee,
       NULL AS grantee_host,
       'table' AS scope,
       NULL AS database_name,
       p.${ownerColumn} AS schema_name,
       p.table_name AS object_name,
       NULL AS column_name,
       p.privilege AS privilege,
       CASE WHEN p.grantable = 'YES' THEN 1 ELSE 0 END AS is_grantable,
       0 AS is_deny,
       p.grantor AS grantor
FROM ${view} p`;
}

function colPrivs(view: string, ownerColumn: string): string {
	return `SELECT p.grantee AS grantee,
       NULL AS grantee_host,
       'column' AS scope,
       NULL AS database_name,
       p.${ownerColumn} AS schema_name,
       p.table_name AS object_name,
       p.column_name AS column_name,
       p.privilege AS privilege,
       CASE WHEN p.grantable = 'YES' THEN 1 ELSE 0 END AS is_grantable,
       0 AS is_deny,
       p.grantor AS grantor
FROM ${view} p`;
}

const GRANT_QUERIES: CatalogQuery[] = [
	{ label: 'system privileges', candidates: [sysPrivs('dba_sys_privs', 'p.grantee'), sysPrivs('user_sys_privs', 'p.username')] },
	{ label: 'object privileges', candidates: [tabPrivs('dba_tab_privs', 'owner'), tabPrivs('all_tab_privs', 'owner'), tabPrivs('all_tab_privs', 'table_schema')] },
	{ label: 'column privileges', candidates: [colPrivs('dba_col_privs', 'owner'), colPrivs('all_col_privs', 'owner'), colPrivs('all_col_privs', 'table_schema')] },
];

export const oracleCatalog: SecurityCatalog = {
	driverId: 'oracle',
	principals: [
		{ label: 'users', candidates: [DBA_USERS, ALL_USERS] },
		{ label: 'roles', candidates: [DBA_ROLES, SESSION_ROLES] },
	],
	grants: GRANT_QUERIES,
};

/** Oracle folds unquoted names to upper case and the catalogs store them that way, so a name
 *  read back from the catalog quotes cleanly. A name the user typed in lower case would become a
 *  genuinely different, case-sensitive user if quoted as typed — so it is upper-cased first,
 *  which is what typing it unquoted would have done. */
function oracleName(name: string, what: string): string {
	return quoteDouble(assertSafeName(name, what).toUpperCase());
}

function principalName(ref: PrincipalRef): string {
	return oracleName(ref.name, 'user name');
}

/** `ON "OWNER"."TABLE"`, or nothing at all for a system privilege. */
function onClause(target: GrantTarget): string {
	if (target.scope === 'global') {
		return '';
	}
	if (target.scope === 'schema' || target.scope === 'database') {
		throw new Error('Oracle has no schema-wide or database-wide GRANT. Grant the system privilege, or grant on the table.');
	}
	const object = oracleName(target.object ?? '', 'table name');
	const owner = target.schema ?? target.database;
	return ` ON ${owner ? `${oracleName(owner, 'owner name')}.${object}` : object}`;
}

function privilegeClause(target: GrantTarget, privileges: readonly string[]): string {
	if (target.scope !== 'column' || !target.columns || target.columns.length === 0) {
		return privilegeList(privileges);
	}
	const columns = target.columns.map((column) => oracleName(column, 'column name')).join(', ');
	return privileges.map((privilege) => `${privilegeList([privilege])} (${columns})`).join(', ');
}

export const oracleEmitter: SecurityEmitter = {
	driverId: 'oracle',
	principalKinds: ['user', 'role'],
	usesHost: false,
	grantScopes: ['column', 'table', 'global'],
	policyKinds: [],
	privilegesFor(scope: GrantScope): readonly string[] {
		switch (scope) {
			case 'global':
				return ['CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE', 'CREATE PROCEDURE', 'CREATE SYNONYM', 'UNLIMITED TABLESPACE', 'SELECT ANY TABLE', 'CREATE USER', 'ALTER USER'];
			case 'column':
				return ['INSERT', 'UPDATE', 'REFERENCES'];
			default:
				return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX', 'REFERENCES', 'EXECUTE', 'ALL PRIVILEGES'];
		}
	},
	emit(change: SecurityChange): string[] {
		switch (change.kind) {
			case 'create-principal': {
				const name = principalName(change.draft);
				if (change.draft.kind === 'role') {
					const statements = [`CREATE ROLE ${name}`];
					for (const role of change.draft.memberOf ?? []) {
						statements.push(`GRANT ${oracleName(role, 'role name')} TO ${name}`);
					}
					return statements;
				}
				if (!change.draft.password) {
					throw new Error('An Oracle user needs a password.');
				}
				const statements = [`CREATE USER ${name} IDENTIFIED BY ${quoteDouble(assertSafePassword(change.draft.password))}`];
				// Without CREATE SESSION the account exists and cannot log in, which looks
				// identical to a broken password. Granting it is part of creating a usable user.
				statements.push(`GRANT CREATE SESSION TO ${name}`);
				for (const role of change.draft.memberOf ?? []) {
					statements.push(`GRANT ${oracleName(role, 'role name')} TO ${name}`);
				}
				return statements;
			}
			case 'drop-principal':
				// Deliberately no CASCADE: on a user that owns objects this fails loudly instead of
				// dropping their tables as a side effect of removing an account.
				return [`DROP ${change.principalKind === 'role' ? 'ROLE' : 'USER'} ${principalName(change.principal)}`];
			case 'set-password':
				return [`ALTER USER ${principalName(change.principal)} IDENTIFIED BY ${quoteDouble(assertSafePassword(change.password))}`];
			case 'set-enabled':
				return [`ALTER USER ${principalName(change.principal)} ACCOUNT ${change.enabled ? 'UNLOCK' : 'LOCK'}`];
			case 'grant': {
				// A system privilege is passed on with ADMIN OPTION, an object privilege with GRANT
				// OPTION. Using the wrong keyword is a syntax error, not a silent no-op.
				const tail = change.withGrantOption ? (change.target.scope === 'global' ? ' WITH ADMIN OPTION' : ' WITH GRANT OPTION') : '';
				return [`GRANT ${privilegeClause(change.target, change.privileges)}${onClause(change.target)} TO ${principalName(change.principal)}${tail}`];
			}
			case 'revoke':
				return [`REVOKE ${privilegeClause(change.target, change.privileges)}${onClause(change.target)} FROM ${principalName(change.principal)}`];
			case 'grant-role':
				return [`GRANT ${oracleName(change.role, 'role name')} TO ${principalName(change.principal)}`];
			case 'revoke-role':
				return [`REVOKE ${oracleName(change.role, 'role name')} FROM ${principalName(change.principal)}`];
			case 'create-policy':
				refusePolicy('Oracle', change.draft.kind);
			case 'drop-policy':
			case 'set-policy-principals':
				refusePolicy('Oracle', change.policy.kind);
		}
	},
};

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  SQL Server logins, database users, roles and permissions.
 *
 *  Two things here have no counterpart on the other three engines, and both are read and shown
 *  rather than smoothed away:
 *
 *  1. A LOGIN is not a USER. A login authenticates at the server; a user is the database-level
 *     principal a login maps to, and it is the user that holds permissions. "I created the login
 *     and it still cannot see anything" is that distinction, so both are listed, with the login
 *     rows marked as such.
 *  2. DENY beats GRANT, including a GRANT inherited from a role. A permission list that quietly
 *     dropped the DENY rows would tell the reader the opposite of the truth about that object,
 *     so `state = 'D'` is read and carried through the model as `deny`.
 *
 *  The server-login query is separate from the database-principal query because it needs
 *  server-level visibility the connected account may not have. Failing it costs the login list
 *  and a warning, not the screen.
 *--------------------------------------------------------------------------------------------*/

import type { CatalogQuery, SecurityCatalog } from '../catalog';
import type { SecurityEmitter } from '../emitter';
import { assertSafeName, assertSafePassword, privilegeList, quoteBracket, quoteLiteral, refusePolicy } from '../emitter';
import type { GrantScope, GrantTarget, PrincipalRef, SecurityChange } from '../types';

/** Database-level principals: users and database roles. `is_fixed_role = 0` drops the built-in
 *  `db_datareader` family, which is noise on every database in the world. */
const DATABASE_PRINCIPALS = `SELECT p.name AS name,
       CASE WHEN p.type = 'R' THEN 'role' ELSE 'user' END AS kind,
       NULL AS host,
       CASE WHEN p.type IN ('S', 'U', 'G', 'E', 'X') THEN 1 ELSE 0 END AS can_login,
       CASE WHEN IS_ROLEMEMBER('db_owner', p.name) = 1 THEN 1 ELSE 0 END AS is_superuser,
       0 AS disabled,
       0 AS locked,
       NULL AS expires_at,
       ISNULL(STUFF((SELECT ',' + r.name
                     FROM sys.database_role_members m
                     JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
                     WHERE m.member_principal_id = p.principal_id
                     ORDER BY r.name
                     FOR XML PATH('')), 1, 1, ''), '') AS member_of,
       p.type_desc AS [Principal type],
       p.default_schema_name AS [Default schema],
       p.create_date AS [Created]
FROM sys.database_principals p
WHERE p.is_fixed_role = 0
  AND p.name NOT IN ('public', 'guest', 'sys', 'INFORMATION_SCHEMA')
ORDER BY p.type, p.name`;

/** Server-level logins. Needs VIEW ANY DEFINITION; a failure is a warning, not an error. */
const SERVER_LOGINS = `SELECT sp.name AS name,
       'login' AS kind,
       NULL AS host,
       1 AS can_login,
       CASE WHEN IS_SRVROLEMEMBER('sysadmin', sp.name) = 1 THEN 1 ELSE 0 END AS is_superuser,
       sp.is_disabled AS disabled,
       0 AS locked,
       NULL AS expires_at,
       '' AS member_of,
       sp.type_desc AS [Login type],
       sp.default_database_name AS [Default database],
       sp.create_date AS [Created]
FROM sys.server_principals sp
WHERE sp.type IN ('S', 'U', 'G')
  AND sp.name NOT LIKE '##%'
  AND sp.name NOT LIKE 'NT SERVICE\\%' ESCAPE '\\'
ORDER BY sp.name`;

/**
 * Database permissions, with the object/schema/column resolved by name.
 *
 * `class` is what says how wide the permission is: 0 is the database itself, 1 an object (a
 * column when `minor_id` is non-zero), 3 a schema. `state` 'W' is GRANT WITH GRANT OPTION and
 * 'D' is DENY.
 */
const PERMISSIONS = `SELECT dp.name AS grantee,
       NULL AS grantee_host,
       CASE perm.class
            WHEN 0 THEN 'database'
            WHEN 3 THEN 'schema'
            WHEN 1 THEN CASE WHEN perm.minor_id = 0 THEN 'table' ELSE 'column' END
            ELSE 'database' END AS scope,
       DB_NAME() AS database_name,
       CASE perm.class
            WHEN 3 THEN SCHEMA_NAME(perm.major_id)
            WHEN 1 THEN OBJECT_SCHEMA_NAME(perm.major_id)
            ELSE NULL END AS schema_name,
       CASE WHEN perm.class = 1 THEN OBJECT_NAME(perm.major_id) ELSE NULL END AS object_name,
       CASE WHEN perm.class = 1 AND perm.minor_id <> 0 THEN COL_NAME(perm.major_id, perm.minor_id) ELSE NULL END AS column_name,
       perm.permission_name AS privilege,
       CASE WHEN perm.state = 'W' THEN 1 ELSE 0 END AS is_grantable,
       CASE WHEN perm.state = 'D' THEN 1 ELSE 0 END AS is_deny,
       gp.name AS grantor
FROM sys.database_permissions perm
JOIN sys.database_principals dp ON dp.principal_id = perm.grantee_principal_id
LEFT JOIN sys.database_principals gp ON gp.principal_id = perm.grantor_principal_id
WHERE perm.state IN ('G', 'W', 'D')
  AND dp.name NOT IN ('public')`;

export const sqlserverCatalog: SecurityCatalog = {
	driverId: 'sqlserver',
	principals: [
		{ label: 'database users and roles', candidates: [DATABASE_PRINCIPALS] },
		{ label: 'server logins', candidates: [SERVER_LOGINS] },
	],
	grants: [{ label: 'database permissions', candidates: [PERMISSIONS] }],
};

function principalName(ref: PrincipalRef): string {
	return quoteBracket(assertSafeName(ref.name, 'principal name'));
}

/** The `ON …` clause. A database-scope permission has none at all in T-SQL — `GRANT CONNECT TO
 *  [app]` — which is why this returns an empty string rather than a clause for that case. */
function onClause(target: GrantTarget): string {
	switch (target.scope) {
		case 'database':
		case 'global':
			return '';
		case 'schema':
			return ` ON SCHEMA::${quoteBracket(assertSafeName(target.schema ?? '', 'schema name'))}`;
		default: {
			const object = quoteBracket(assertSafeName(target.object ?? '', 'object name'));
			const qualified = target.schema ? `${quoteBracket(assertSafeName(target.schema, 'schema name'))}.${object}` : object;
			if (target.scope === 'column' && target.columns && target.columns.length > 0) {
				const columns = target.columns.map((column) => quoteBracket(assertSafeName(column, 'column name'))).join(', ');
				return ` ON ${qualified} (${columns})`;
			}
			return ` ON ${qualified}`;
		}
	}
}

export const sqlserverEmitter: SecurityEmitter = {
	driverId: 'sqlserver',
	principalKinds: ['user', 'login', 'role'],
	usesHost: false,
	grantScopes: ['column', 'table', 'schema', 'database'],
	policyKinds: [],
	privilegesFor(scope: GrantScope): readonly string[] {
		switch (scope) {
			case 'database':
			case 'global':
				return ['CONNECT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE', 'VIEW DEFINITION', 'ALTER', 'CONTROL'];
			case 'schema':
				return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'VIEW DEFINITION', 'ALTER', 'CONTROL'];
			case 'column':
				return ['SELECT', 'UPDATE', 'REFERENCES'];
			default:
				return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'VIEW DEFINITION', 'ALTER', 'CONTROL'];
		}
	},
	emit(change: SecurityChange): string[] {
		switch (change.kind) {
			case 'create-principal': {
				const name = principalName(change.draft);
				if (change.draft.kind === 'role') {
					const statements = [`CREATE ROLE ${name}`];
					for (const role of change.draft.memberOf ?? []) {
						statements.push(`ALTER ROLE ${quoteBracket(assertSafeName(role, 'role name'))} ADD MEMBER ${name}`);
					}
					return statements;
				}
				if (change.draft.kind === 'login') {
					if (!change.draft.password) {
						throw new Error('A SQL Server login needs a password.');
					}
					return [`CREATE LOGIN ${name} WITH PASSWORD = ${quoteLiteral(assertSafePassword(change.draft.password))}`];
				}
				// A database user. With a password we create the server login first, because a user
				// without one authenticates as nobody and the "why can't it connect" question follows
				// immediately.
				const statements: string[] = [];
				if (change.draft.password) {
					statements.push(`CREATE LOGIN ${name} WITH PASSWORD = ${quoteLiteral(assertSafePassword(change.draft.password))}`);
					statements.push(`CREATE USER ${name} FOR LOGIN ${name}`);
				} else {
					statements.push(`CREATE USER ${name} WITHOUT LOGIN`);
				}
				for (const role of change.draft.memberOf ?? []) {
					statements.push(`ALTER ROLE ${quoteBracket(assertSafeName(role, 'role name'))} ADD MEMBER ${name}`);
				}
				return statements;
			}
			case 'drop-principal': {
				const name = principalName(change.principal);
				switch (change.principalKind) {
					case 'role': return [`DROP ROLE ${name}`];
					case 'login': return [`DROP LOGIN ${name}`];
					default: return [`DROP USER ${name}`];
				}
			}
			case 'set-password':
				// The password lives on the LOGIN, never on the database user.
				return [`ALTER LOGIN ${principalName(change.principal)} WITH PASSWORD = ${quoteLiteral(assertSafePassword(change.password))}`];
			case 'set-enabled':
				return [`ALTER LOGIN ${principalName(change.principal)} ${change.enabled ? 'ENABLE' : 'DISABLE'}`];
			case 'grant': {
				const tail = change.withGrantOption ? ' WITH GRANT OPTION' : '';
				return [`GRANT ${privilegeList(change.privileges)}${onClause(change.target)} TO ${principalName(change.principal)}${tail}`];
			}
			case 'revoke':
				return [`REVOKE ${privilegeList(change.privileges)}${onClause(change.target)} FROM ${principalName(change.principal)}`];
			case 'grant-role':
				return [`ALTER ROLE ${quoteBracket(assertSafeName(change.role, 'role name'))} ADD MEMBER ${principalName(change.principal)}`];
			case 'revoke-role':
				return [`ALTER ROLE ${quoteBracket(assertSafeName(change.role, 'role name'))} DROP MEMBER ${principalName(change.principal)}`];
			case 'create-policy':
				refusePolicy('SQL Server', change.draft.kind);
			case 'drop-policy':
			case 'set-policy-principals':
				refusePolicy('SQL Server', change.policy.kind);
		}
	},
};

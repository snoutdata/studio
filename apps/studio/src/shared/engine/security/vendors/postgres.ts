/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Postgres (and Redshift-family) roles and privileges.
 *
 *  Postgres has ONE kind of principal: a role. A "user" is just a role with LOGIN, which is why
 *  `CREATE USER` is documented as an alias for `CREATE ROLE … LOGIN`. The read reflects that —
 *  `kind` is derived from `rolcanlogin` rather than from two different catalogs.
 *
 *  The grant queries read `aclexplode(…acl)` off the system catalogs rather than
 *  `information_schema.table_privileges`. The information_schema views are filtered to
 *  privileges the CURRENT user granted or holds, so an administrator looking at someone else's
 *  grants sees an empty list and concludes there are none — which is the failure mode this
 *  feature exists to prevent.
 *--------------------------------------------------------------------------------------------*/

import type { CatalogQuery, SecurityCatalog } from '../catalog';
import type { SecurityEmitter } from '../emitter';
import { assertSafeName, assertSafePassword, privilegeList, quoteDouble, quoteLiteral, refusePolicy } from '../emitter';
import type { GrantScope, GrantTarget, PrincipalRef, SecurityChange } from '../types';

const PRINCIPALS = `SELECT r.rolname AS name,
       CASE WHEN r.rolcanlogin THEN 'user' ELSE 'role' END AS kind,
       NULL::text AS host,
       r.rolcanlogin AS can_login,
       r.rolsuper AS is_superuser,
       false AS disabled,
       false AS locked,
       r.rolvaliduntil AS expires_at,
       COALESCE((SELECT string_agg(m.rolname, ',' ORDER BY m.rolname)
                 FROM pg_auth_members am
                 JOIN pg_roles m ON m.oid = am.roleid
                 WHERE am.member = r.oid), '') AS member_of,
       r.rolcreatedb AS "Can create databases",
       r.rolcreaterole AS "Can create roles",
       r.rolinherit AS "Inherits role privileges",
       r.rolreplication AS "Replication",
       CASE WHEN r.rolconnlimit < 0 THEN 'unlimited' ELSE r.rolconnlimit::text END AS "Connection limit"
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\\_%'
ORDER BY r.rolcanlogin DESC, r.rolname`;

/** The shared tail of every aclexplode query: PUBLIC comes back as grantee oid 0, which joins to
 *  no role, so the LEFT JOIN plus COALESCE is what stops a world-readable object looking unowned. */
const ACL_JOINS = `LEFT JOIN pg_roles g ON g.oid = a.grantee
LEFT JOIN pg_roles o ON o.oid = a.grantor`;

const TABLE_GRANTS = `SELECT COALESCE(g.rolname, 'PUBLIC') AS grantee,
       NULL::text AS grantee_host,
       'table' AS scope,
       current_database() AS database_name,
       n.nspname AS schema_name,
       c.relname AS object_name,
       NULL::text AS column_name,
       a.privilege_type AS privilege,
       a.is_grantable AS is_grantable,
       false AS is_deny,
       o.rolname AS grantor
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
${ACL_JOINS}
WHERE c.relacl IS NOT NULL
  AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;

const COLUMN_GRANTS = `SELECT COALESCE(g.rolname, 'PUBLIC') AS grantee,
       NULL::text AS grantee_host,
       'column' AS scope,
       current_database() AS database_name,
       n.nspname AS schema_name,
       c.relname AS object_name,
       att.attname AS column_name,
       a.privilege_type AS privilege,
       a.is_grantable AS is_grantable,
       false AS is_deny,
       o.rolname AS grantor
FROM pg_attribute att
JOIN pg_class c ON c.oid = att.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(att.attacl) a
${ACL_JOINS}
WHERE att.attacl IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;

const SCHEMA_GRANTS = `SELECT COALESCE(g.rolname, 'PUBLIC') AS grantee,
       NULL::text AS grantee_host,
       'schema' AS scope,
       current_database() AS database_name,
       n.nspname AS schema_name,
       NULL::text AS object_name,
       NULL::text AS column_name,
       a.privilege_type AS privilege,
       a.is_grantable AS is_grantable,
       false AS is_deny,
       o.rolname AS grantor
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(n.nspacl) a
${ACL_JOINS}
WHERE n.nspacl IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;

const DATABASE_GRANTS = `SELECT COALESCE(g.rolname, 'PUBLIC') AS grantee,
       NULL::text AS grantee_host,
       'database' AS scope,
       d.datname AS database_name,
       NULL::text AS schema_name,
       NULL::text AS object_name,
       NULL::text AS column_name,
       a.privilege_type AS privilege,
       a.is_grantable AS is_grantable,
       false AS is_deny,
       o.rolname AS grantor
FROM pg_database d
CROSS JOIN LATERAL aclexplode(d.datacl) a
${ACL_JOINS}
WHERE d.datacl IS NOT NULL
  AND NOT d.datistemplate`;

const GRANT_QUERIES: CatalogQuery[] = [
	{ label: 'database privileges', candidates: [DATABASE_GRANTS] },
	{ label: 'schema privileges', candidates: [SCHEMA_GRANTS] },
	{ label: 'table and view privileges', candidates: [TABLE_GRANTS] },
	{ label: 'column privileges', candidates: [COLUMN_GRANTS] },
];

export const postgresCatalog: SecurityCatalog = {
	driverId: 'postgres',
	principals: [{ label: 'roles and users', candidates: [PRINCIPALS] }],
	grants: GRANT_QUERIES,
};

/** `"schema"."table"`, falling back to the bare object when no schema is given (the search_path
 *  then decides, exactly as it would for a hand-typed statement). */
function qualified(target: GrantTarget): string {
	const object = quoteDouble(assertSafeName(target.object ?? '', 'table name'));
	return target.schema ? `${quoteDouble(assertSafeName(target.schema, 'schema name'))}.${object}` : object;
}

/** The `ON …` clause for a grant target. Column grants put the column list on the privilege
 *  rather than the object, which is why the privilege text is built alongside it. */
function onClause(target: GrantTarget): string {
	switch (target.scope) {
		case 'database': return `DATABASE ${quoteDouble(assertSafeName(target.database ?? '', 'database name'))}`;
		case 'schema': return `SCHEMA ${quoteDouble(assertSafeName(target.schema ?? '', 'schema name'))}`;
		case 'global': throw new Error('PostgreSQL has no server-wide GRANT. Grant on a database, schema or table instead.');
		default: return qualified(target);
	}
}

/** Privileges, with a column list appended when the target names columns. */
function privilegeClause(target: GrantTarget, privileges: readonly string[]): string {
	if (target.scope !== 'column' || !target.columns || target.columns.length === 0) {
		return privilegeList(privileges);
	}
	const columns = target.columns.map((column) => quoteDouble(assertSafeName(column, 'column name'))).join(', ');
	// `GRANT SELECT (a, b), UPDATE (a, b) ON …` — the column list attaches to each privilege
	// separately, not once to the whole list.
	return privileges.map((privilege) => `${privilegeList([privilege])} (${columns})`).join(', ');
}

function principalName(ref: PrincipalRef): string {
	return quoteDouble(assertSafeName(ref.name, 'role name'));
}

export const postgresEmitter: SecurityEmitter = {
	driverId: 'postgres',
	principalKinds: ['user', 'role'],
	usesHost: false,
	grantScopes: ['column', 'table', 'schema', 'database'],
	policyKinds: [],
	privilegesFor(scope: GrantScope): readonly string[] {
		switch (scope) {
			case 'database': return ['CONNECT', 'CREATE', 'TEMPORARY', 'ALL PRIVILEGES'];
			case 'schema': return ['USAGE', 'CREATE', 'ALL PRIVILEGES'];
			case 'column': return ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
			case 'global': return [];
			default: return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL PRIVILEGES'];
		}
	},
	emit(change: SecurityChange): string[] {
		switch (change.kind) {
			case 'create-principal': {
				const name = principalName(change.draft);
				const options: string[] = [change.draft.kind === 'role' ? 'NOLOGIN' : 'LOGIN'];
				if (change.draft.password) {
					options.push(`PASSWORD ${quoteLiteral(assertSafePassword(change.draft.password))}`);
				}
				const statements = [`CREATE ROLE ${name} WITH ${options.join(' ')}`];
				for (const role of change.draft.memberOf ?? []) {
					statements.push(`GRANT ${quoteDouble(assertSafeName(role, 'role name'))} TO ${name}`);
				}
				return statements;
			}
			case 'drop-principal':
				return [`DROP ROLE ${principalName(change.principal)}`];
			case 'set-password':
				return [`ALTER ROLE ${principalName(change.principal)} WITH PASSWORD ${quoteLiteral(assertSafePassword(change.password))}`];
			case 'set-enabled':
				// Postgres cannot disable a role. Removing LOGIN is the closest true equivalent:
				// the role and everything granted to it survive, it just cannot open a session.
				return [`ALTER ROLE ${principalName(change.principal)} WITH ${change.enabled ? 'LOGIN' : 'NOLOGIN'}`];
			case 'grant': {
				const tail = change.withGrantOption ? ' WITH GRANT OPTION' : '';
				return [`GRANT ${privilegeClause(change.target, change.privileges)} ON ${onClause(change.target)} TO ${principalName(change.principal)}${tail}`];
			}
			case 'revoke':
				return [`REVOKE ${privilegeClause(change.target, change.privileges)} ON ${onClause(change.target)} FROM ${principalName(change.principal)}`];
			case 'grant-role':
				return [`GRANT ${quoteDouble(assertSafeName(change.role, 'role name'))} TO ${principalName(change.principal)}`];
			case 'revoke-role':
				return [`REVOKE ${quoteDouble(assertSafeName(change.role, 'role name'))} FROM ${principalName(change.principal)}`];
			case 'create-policy':
				refusePolicy('Postgres', change.draft.kind);
			case 'drop-policy':
			case 'set-policy-principals':
				refusePolicy('Postgres', change.policy.kind);
		}
	},
};

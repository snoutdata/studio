/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  MySQL / Aurora MySQL and MariaDB accounts and privileges.
 *
 *  The thing that makes MySQL different from every other engine here: an account's identity is
 *  the PAIR `user@host`. `app@localhost` and `app@%` are two separate accounts with two separate
 *  sets of grants, and the single most common "why does my grant do nothing" is granting to one
 *  and connecting as the other. So the host is read, displayed and required throughout, and the
 *  GRANTEE column of every information_schema view (which stores the pair pre-joined as
 *  `'app'@'%'`) is split back apart in SQL so the mapper stays generic.
 *
 *  MariaDB gets its own catalog because roles are a different mechanism there: `mysql.user` has
 *  an `is_role` column and membership lives in `mysql.roles_mapping`, where MySQL 8 has no such
 *  column and uses `mysql.role_edges`. Asking the wrong one is an error, not an empty result.
 *--------------------------------------------------------------------------------------------*/

import type { CatalogQuery, SecurityCatalog } from '../catalog';
import type { SecurityEmitter } from '../emitter';
import { assertSafeName, assertSafePassword, privilegeList, quoteBacktick, quoteBackslashLiteral, refusePolicy } from '../emitter';
import type { GrantScope, GrantTarget, PrincipalRef, SecurityChange } from '../types';

/** Split `'app'@'%'` into its two halves. information_schema stores the pair as one string and
 *  there is no column for either part, so the split happens here rather than in the mapper. */
const GRANTEE_USER = `TRIM(BOTH '''' FROM SUBSTRING_INDEX(GRANTEE, '@', 1))`;
const GRANTEE_HOST = `TRIM(BOTH '''' FROM SUBSTRING_INDEX(GRANTEE, '@', -1))`;

/** MySQL 8: accounts from `mysql.user`, role membership from `mysql.role_edges`. */
const MYSQL_PRINCIPALS = `SELECT u.user AS name,
       'user' AS kind,
       u.host AS host,
       1 AS can_login,
       CASE WHEN u.Super_priv = 'Y' THEN 1 ELSE 0 END AS is_superuser,
       CASE WHEN u.account_locked = 'Y' THEN 1 ELSE 0 END AS disabled,
       CASE WHEN u.account_locked = 'Y' THEN 1 ELSE 0 END AS locked,
       NULL AS expires_at,
       COALESCE((SELECT GROUP_CONCAT(re.from_user ORDER BY re.from_user SEPARATOR ',')
                 FROM mysql.role_edges re
                 WHERE re.to_user = u.user AND re.to_host = u.host), '') AS member_of,
       u.plugin AS \`Authentication plugin\`,
       u.password_expired AS \`Password expired\`,
       u.password_last_changed AS \`Password last changed\`,
       u.max_user_connections AS \`Max connections\`
FROM mysql.user u
ORDER BY u.user, u.host`;

/** MariaDB: `is_role` separates a role from an account, membership is in `mysql.roles_mapping`. */
const MARIADB_PRINCIPALS = `SELECT u.user AS name,
       CASE WHEN u.is_role = 'Y' THEN 'role' ELSE 'user' END AS kind,
       u.host AS host,
       CASE WHEN u.is_role = 'Y' THEN 0 ELSE 1 END AS can_login,
       CASE WHEN u.Super_priv = 'Y' THEN 1 ELSE 0 END AS is_superuser,
       CASE WHEN u.account_locked = 'Y' THEN 1 ELSE 0 END AS disabled,
       CASE WHEN u.account_locked = 'Y' THEN 1 ELSE 0 END AS locked,
       NULL AS expires_at,
       COALESCE((SELECT GROUP_CONCAT(rm.role ORDER BY rm.role SEPARATOR ',')
                 FROM mysql.roles_mapping rm
                 WHERE rm.user = u.user AND rm.host = u.host), '') AS member_of,
       u.plugin AS \`Authentication plugin\`,
       u.password_expired AS \`Password expired\`,
       u.max_user_connections AS \`Max connections\`
FROM mysql.user u
ORDER BY u.is_role, u.user, u.host`;

/**
 * The fallback when `mysql.user` is not readable, which is the normal case for an application
 * account. `information_schema.USER_PRIVILEGES` shows the connected account its own row, so the
 * view degrades to "here is you" rather than to an error.
 */
const PRINCIPALS_FALLBACK = `SELECT DISTINCT ${GRANTEE_USER} AS name,
       'user' AS kind,
       ${GRANTEE_HOST} AS host,
       1 AS can_login,
       0 AS is_superuser,
       0 AS disabled,
       0 AS locked,
       NULL AS expires_at,
       '' AS member_of
FROM information_schema.USER_PRIVILEGES
ORDER BY name, host`;

function grantQuery(view: string, scope: string, extra: { database?: string; object?: string; column?: string }): string {
	return `SELECT ${GRANTEE_USER} AS grantee,
       ${GRANTEE_HOST} AS grantee_host,
       '${scope}' AS scope,
       ${extra.database ?? 'NULL'} AS database_name,
       NULL AS schema_name,
       ${extra.object ?? 'NULL'} AS object_name,
       ${extra.column ?? 'NULL'} AS column_name,
       PRIVILEGE_TYPE AS privilege,
       IS_GRANTABLE AS is_grantable,
       0 AS is_deny,
       NULL AS grantor
FROM information_schema.${view}`;
}

const GRANT_QUERIES: CatalogQuery[] = [
	// MySQL has no schema-vs-database distinction, so a schema privilege IS a database privilege.
	{ label: 'server-wide privileges', candidates: [grantQuery('USER_PRIVILEGES', 'global', {})] },
	{ label: 'database privileges', candidates: [grantQuery('SCHEMA_PRIVILEGES', 'database', { database: 'TABLE_SCHEMA' })] },
	{ label: 'table privileges', candidates: [grantQuery('TABLE_PRIVILEGES', 'table', { database: 'TABLE_SCHEMA', object: 'TABLE_NAME' })] },
	{ label: 'column privileges', candidates: [grantQuery('COLUMN_PRIVILEGES', 'column', { database: 'TABLE_SCHEMA', object: 'TABLE_NAME', column: 'COLUMN_NAME' })] },
];

export const mysqlCatalog: SecurityCatalog = {
	driverId: 'mysql-aurora',
	principals: [{ label: 'accounts', candidates: [MYSQL_PRINCIPALS, PRINCIPALS_FALLBACK] }],
	grants: GRANT_QUERIES,
};

export const mariadbCatalog: SecurityCatalog = {
	driverId: 'mariadb',
	principals: [{ label: 'accounts and roles', candidates: [MARIADB_PRINCIPALS, PRINCIPALS_FALLBACK] }],
	grants: GRANT_QUERIES,
};

/** `'user'@'host'` — string literals, not identifiers. A missing host defaults to `%`, which is
 *  what the server itself does, so the statement means what it looks like it means. */
function account(ref: PrincipalRef): string {
	const user = quoteBackslashLiteral(assertSafeName(ref.name, 'user name'));
	const host = quoteBackslashLiteral(assertSafeName(ref.host ?? '%', 'host'));
	return `${user}@${host}`;
}

/** MySQL's grant target: `*.*`, `` `db`.* `` or `` `db`.`table` ``. */
function onClause(target: GrantTarget): string {
	if (target.scope === 'global') {
		return '*.*';
	}
	const database = quoteBacktick(assertSafeName(target.database ?? target.schema ?? '', 'database name'));
	if (target.scope === 'database' || target.scope === 'schema') {
		return `${database}.*`;
	}
	return `${database}.${quoteBacktick(assertSafeName(target.object ?? '', 'table name'))}`;
}

function privilegeClause(target: GrantTarget, privileges: readonly string[]): string {
	if (target.scope !== 'column' || !target.columns || target.columns.length === 0) {
		return privilegeList(privileges);
	}
	const columns = target.columns.map((column) => quoteBacktick(assertSafeName(column, 'column name'))).join(', ');
	return privileges.map((privilege) => `${privilegeList([privilege])} (${columns})`).join(', ');
}

const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'ALL PRIVILEGES'];

export const mysqlEmitter: SecurityEmitter = {
	driverId: 'mysql-aurora',
	principalKinds: ['user', 'role'],
	usesHost: true,
	grantScopes: ['column', 'table', 'database', 'global'],
	policyKinds: [],
	privilegesFor(scope: GrantScope): readonly string[] {
		switch (scope) {
			case 'global':
				return ['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'CREATE USER', 'RELOAD', 'PROCESS', 'SHOW DATABASES', 'SUPER', 'REPLICATION CLIENT', 'REPLICATION SLAVE', 'EXECUTE'];
			case 'column':
				return ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
			case 'database':
			case 'schema':
				return [...TABLE_PRIVILEGES, 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT'];
			default:
				return TABLE_PRIVILEGES;
		}
	},
	emit(change: SecurityChange): string[] {
		switch (change.kind) {
			case 'create-principal': {
				const who = account(change.draft);
				if (change.draft.kind === 'role') {
					const statements = [`CREATE ROLE ${quoteBackslashLiteral(assertSafeName(change.draft.name, 'role name'))}`];
					for (const role of change.draft.memberOf ?? []) {
						statements.push(`GRANT ${quoteBackslashLiteral(assertSafeName(role, 'role name'))} TO ${who}`);
					}
					return statements;
				}
				const identified = change.draft.password ? ` IDENTIFIED BY ${quoteBackslashLiteral(assertSafePassword(change.draft.password))}` : '';
				const statements = [`CREATE USER ${who}${identified}`];
				for (const role of change.draft.memberOf ?? []) {
					statements.push(`GRANT ${quoteBackslashLiteral(assertSafeName(role, 'role name'))} TO ${who}`);
				}
				return statements;
			}
			case 'drop-principal':
				return [`DROP ${change.principalKind === 'role' ? 'ROLE' : 'USER'} ${change.principalKind === 'role' ? quoteBackslashLiteral(assertSafeName(change.principal.name, 'role name')) : account(change.principal)}`];
			case 'set-password':
				return [`ALTER USER ${account(change.principal)} IDENTIFIED BY ${quoteBackslashLiteral(assertSafePassword(change.password))}`];
			case 'set-enabled':
				return [`ALTER USER ${account(change.principal)} ACCOUNT ${change.enabled ? 'UNLOCK' : 'LOCK'}`];
			case 'grant': {
				const tail = change.withGrantOption ? ' WITH GRANT OPTION' : '';
				return [`GRANT ${privilegeClause(change.target, change.privileges)} ON ${onClause(change.target)} TO ${account(change.principal)}${tail}`];
			}
			case 'revoke':
				return [`REVOKE ${privilegeClause(change.target, change.privileges)} ON ${onClause(change.target)} FROM ${account(change.principal)}`];
			case 'grant-role':
				return [`GRANT ${quoteBackslashLiteral(assertSafeName(change.role, 'role name'))} TO ${account(change.principal)}`];
			case 'revoke-role':
				return [`REVOKE ${quoteBackslashLiteral(assertSafeName(change.role, 'role name'))} FROM ${account(change.principal)}`];
			case 'create-policy':
				refusePolicy('MySQL', change.draft.kind);
			case 'drop-policy':
			case 'set-policy-principals':
				refusePolicy('MySQL', change.policy.kind);
		}
	},
};

/** MariaDB takes the same statements; only the catalog it is read from differs. */
export const mariadbEmitter: SecurityEmitter = { ...mysqlEmitter, driverId: 'mariadb' };

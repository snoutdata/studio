/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ClickHouse users, roles and grants.
 *
 *  Four things here are ClickHouse's own and shape the whole file.
 *
 *  - **A partial revoke is a DENY.** `REVOKE SELECT(secret) ON db.t FROM app` after a wider
 *    `GRANT SELECT ON db.t` does not delete the grant: it adds a row with
 *    `is_partial_revoke = 1` that beats it. A list showing only the grants would therefore tell
 *    the reader the OPPOSITE of what is true about that column, which is exactly why the shared
 *    model already carries `deny` for SQL Server, and why it is reused rather than filtered out.
 *  - **There is no schema.** A ClickHouse database IS the namespace, so `grantScopes` has no
 *    `schema` and the `ON` clause is `*.*`, `db.*` or `db.table`.
 *  - **An account can be read-only to SQL.** `system.users.storage` says where the account is
 *    defined: `local_directory` is SQL-managed, `users_xml` is the server's config file, and
 *    `ALTER USER default ...` on one of those fails with ACCESS_STORAGE_READONLY however much
 *    privilege you hold. It is shown as an attribute so the answer is on screen before the
 *    statement is written.
 *  - **There is no DISABLE.** The documented way to stop an account signing in without dropping
 *    it is to put its `VALID UNTIL` in the past, so that is what `set-enabled` emits, and what
 *    the read reads back as `disabled`.
 *--------------------------------------------------------------------------------------------*/

import type { CatalogQuery, SecurityCatalog } from '../catalog';
import type { SecurityEmitter } from '../emitter';
import { assertSafeExpression, assertSafeName, assertSafePassword, assertSafeSettingName, privilegeList, quoteBackslashLiteral, settingValue } from '../emitter';
import type { GrantScope, GrantTarget, PolicyDraft, PolicyRef, PolicySetting, PrincipalRef, SecurityChange } from '../types';
import { quoteClickHouseIdent } from '../../dialect/index';

/** A backtick-quoted identifier, through the one ClickHouse quoter: a name ending in a backslash
 *  must not escape its own closing quote. */
const quoteIdent = quoteClickHouseIdent;

/**
 * Who counts as an administrator.
 *
 * NOT a single `ALL` row: ClickHouse's own `default` user holds about sixty separate global
 * grants and no `ALL` at all, so looking for one reports the server's administrator as an
 * ordinary account. Holding `CREATE USER` globally is the honest test of the thing the flag is
 * there to warn about, and it catches `default` on a self-managed server.
 *
 * Asked of ROLES as well as users, because on ClickHouse Cloud the `default` user holds no grant
 * whatsoever: `default_role` holds them and `default` is a member of it. The user is then marked
 * by `propagateSuperuser`, which walks membership across every engine.
 */
const ADMIN_ACCESS_TYPES = `'ALL', 'ACCESS MANAGEMENT', 'CREATE USER'`;

/** `valid_until` is an Array(DateTime) whose epoch value means "no expiry", which is what every
 *  account has until someone sets one. So an account is expired only when the value is BOTH past
 *  the epoch and in the past. */
const HAS_EXPIRY = `length(u.valid_until) > 0 AND u.valid_until[1] > toDateTime(0)`;

/**
 * Roles per user and per role, as one grouped read joined in.
 *
 * A correlated subquery in the SELECT list does not work in ClickHouse, so membership arrives by
 * LEFT JOIN onto an aggregate. Inlined as a derived table rather than written as a `WITH` clause
 * so every catalog query still literally begins with SELECT, which is what
 * `plan.test.ts` asserts to keep a write out of the read half.
 */
const MEMBERSHIPS = `(
    SELECT ifNull(user_name, role_name) AS who, arrayStringConcat(groupArray(granted_role_name), ',') AS member_of
    FROM system.role_grants
    GROUP BY who
)`;

const USERS = `SELECT u.name AS name,
       'user' AS kind,
       NULL AS host,
       1 AS can_login,
       u.name IN (SELECT ifNull(user_name, '') FROM system.grants WHERE database IS NULL AND toString(access_type) IN (${ADMIN_ACCESS_TYPES})) AS is_superuser,
       (${HAS_EXPIRY}) AND u.valid_until[1] < now() AS disabled,
       0 AS locked,
       if(${HAS_EXPIRY}, toString(u.valid_until[1]), NULL) AS expires_at,
       ifNull(m.member_of, '') AS member_of,
       arrayStringConcat(arrayMap(x -> toString(x), u.auth_type), ', ') AS "Authentication",
       if(u.storage = 'users_xml', 'users.xml (cannot be changed with SQL)', u.storage) AS "Defined in",
       if(u.default_database = '', 'not set', u.default_database) AS "Default database",
       if(has(u.host_ip, '::/0'), 'anywhere', arrayStringConcat(arrayConcat(u.host_ip, u.host_names, u.host_names_like), ', ')) AS "Can connect from",
       if(u.default_roles_all, 'all granted roles', arrayStringConcat(u.default_roles_list, ', ')) AS "Roles applied on login"
FROM system.users u
LEFT JOIN ${MEMBERSHIPS} m ON m.who = u.name
ORDER BY u.name`;

const ROLES = `SELECT r.name AS name,
       'role' AS kind,
       NULL AS host,
       0 AS can_login,
       r.name IN (SELECT ifNull(role_name, '') FROM system.grants WHERE database IS NULL AND toString(access_type) IN (${ADMIN_ACCESS_TYPES})) AS is_superuser,
       0 AS disabled,
       0 AS locked,
       NULL AS expires_at,
       ifNull(m.member_of, '') AS member_of,
       if(r.storage = 'users_xml', 'users.xml (cannot be changed with SQL)', r.storage) AS "Defined in"
FROM system.roles r
LEFT JOIN ${MEMBERSHIPS} m ON m.who = r.name
ORDER BY r.name`;

/**
 * Every grant, for users and roles alike.
 *
 * `access_type` is an Enum16 and must be `toString()`d: comparing or concatenating an Enum
 * directly is a type error on every server, which is a mistake this codebase has already made
 * once (the Dictionaries health card).
 *
 * The scope is read off which of database/table/column is filled in, because that is what
 * ClickHouse records instead of naming a level.
 */
const GRANTS = `SELECT ifNull(user_name, role_name) AS grantee,
       NULL AS grantee_host,
       multiIf(column IS NOT NULL, 'column', table IS NOT NULL, 'table', database IS NOT NULL, 'database', 'global') AS scope,
       database AS database_name,
       NULL AS schema_name,
       table AS object_name,
       column AS column_name,
       toString(access_type) AS privilege,
       grant_option AS is_grantable,
       is_partial_revoke AS is_deny,
       NULL AS grantor
FROM system.grants
ORDER BY grantee, database, table, column`;

/**
 * Row policies, quotas and settings profiles: the three access objects that are neither a
 * principal nor a grant.
 *
 * Each one composes its own `detail` sentence in SQL, because what a policy DOES has no shared
 * vocabulary across engines: one is an expression, one is a set of limits over a window, one is a
 * set of settings. Composing it here rather than in TypeScript is what keeps the shared model out
 * of the business of knowing that ClickHouse measures a quota in `read_rows`.
 *
 * `apply_to_all` with `apply_to_except` is the shape a real row policy has ("everyone except the
 * admin"), so both halves are read; a list-membership test alone answers the question backwards.
 */
const ROW_POLICIES = `SELECT 'row-policy' AS kind,
       p.short_name AS name,
       p.database AS database_name,
       p.table AS object_name,
       arrayStringConcat(p.apply_to_list, ',') AS applies_to,
       p.apply_to_all AS applies_to_all,
       arrayStringConcat(p.apply_to_except, ',') AS except_for,
       ifNull(p.select_filter, '') AS detail,
       p.is_restrictive AS is_restrictive,
       if(p.storage = 'users_xml', 'users.xml (cannot be changed with SQL)', p.storage) AS "Defined in"
FROM system.row_policies p
ORDER BY p.database, p.table, p.short_name`;

/**
 * A quota's windows and their caps, as one sentence per quota.
 *
 * `system.quotas` holds the durations and `system.quota_limits` holds what each one caps: one row
 * per window, one nullable column per metric. The array of pieces with the empties filtered out is
 * how a row of fifteen mostly-null columns becomes "queries 100, read_rows 1000000"; a null metric
 * is not a limit of zero and must not read as one.
 */
const QUOTA_LIMITS = `(
    SELECT quota_name, arrayStringConcat(groupArray(window), ' and ') AS detail
    FROM (
        SELECT quota_name,
               concat('every ', formatReadableTimeDelta(duration), ': ', if(caps = '', 'tracking only', caps)) AS window
        FROM (
            SELECT quota_name, duration, arrayStringConcat(arrayFilter(x -> x != '', [
                       if(max_queries IS NULL, '', concat('queries ', toString(max_queries))),
                       if(max_query_selects IS NULL, '', concat('selects ', toString(max_query_selects))),
                       if(max_query_inserts IS NULL, '', concat('inserts ', toString(max_query_inserts))),
                       if(max_errors IS NULL, '', concat('errors ', toString(max_errors))),
                       if(max_result_rows IS NULL, '', concat('result_rows ', toString(max_result_rows))),
                       if(max_result_bytes IS NULL, '', concat('result_bytes ', toString(max_result_bytes))),
                       if(max_read_rows IS NULL, '', concat('read_rows ', toString(max_read_rows))),
                       if(max_read_bytes IS NULL, '', concat('read_bytes ', toString(max_read_bytes))),
                       if(max_execution_time IS NULL, '', concat('execution_time ', toString(max_execution_time)))
                   ]), ', ') AS caps
            FROM system.quota_limits
            ORDER BY quota_name, duration
        )
    )
    GROUP BY quota_name
)`;

/** What each quota has actually consumed in the window that is open now, for the accounts this
 *  connection may see. A quota with limits and no usage row has simply not been used yet. */
const QUOTA_USAGE = `(
    SELECT quota_name, arrayStringConcat(groupArray(concat(quota_key, ': ', toString(ifNull(queries, 0)), ' queries, ', toString(ifNull(read_rows, 0)), ' rows read')), ' and ') AS used
    FROM system.quotas_usage
    WHERE duration IS NOT NULL
    GROUP BY quota_name
)`;

function quotas(withUsage: boolean): string {
	return `SELECT 'quota' AS kind,
       q.name AS name,
       NULL AS database_name,
       NULL AS object_name,
       arrayStringConcat(q.apply_to_list, ',') AS applies_to,
       q.apply_to_all AS applies_to_all,
       arrayStringConcat(q.apply_to_except, ',') AS except_for,
       if(ifNull(l.detail, '') = '', 'no limits set', l.detail) AS detail,
       0 AS is_restrictive,
       arrayStringConcat(arrayMap(x -> toString(x), q.keys), ', ') AS "Counted per",${withUsage ? `
       if(ifNull(u.used, '') = '', 'nothing used in the window that is open', u.used) AS "Used so far",` : ''}
       if(q.storage = 'users_xml', 'users.xml (cannot be changed with SQL)', q.storage) AS "Defined in"
FROM system.quotas q
LEFT JOIN ${QUOTA_LIMITS} l ON l.quota_name = q.name${withUsage ? `
LEFT JOIN ${QUOTA_USAGE} u ON u.quota_name = q.name` : ''}
ORDER BY q.name`;
}

/**
 * What a settings profile sets, and who it applies to.
 *
 * An element row with no `setting_name` is an INHERITED profile rather than a setting, and saying
 * so is the difference between "this profile sets nothing" and "this profile is another profile
 * plus two changes".
 */
const SETTINGS_PROFILES = `SELECT 'settings-profile' AS kind,
       s.name AS name,
       NULL AS database_name,
       NULL AS object_name,
       arrayStringConcat(s.apply_to_list, ',') AS applies_to,
       s.apply_to_all AS applies_to_all,
       arrayStringConcat(s.apply_to_except, ',') AS except_for,
       if(ifNull(e.detail, '') = '', 'sets nothing', e.detail) AS detail,
       0 AS is_restrictive,
       if(s.storage = 'users_xml', 'users.xml (cannot be changed with SQL)', s.storage) AS "Defined in"
FROM system.settings_profiles s
LEFT JOIN (
    SELECT profile_name, arrayStringConcat(groupArray(piece), ', ') AS detail
    FROM (
        SELECT profile_name,
               if(setting_name IS NULL, concat('inherits ', ifNull(inherit_profile, '?')), concat(ifNull(setting_name, ''), ' = ', ifNull(value, ''))) AS piece
        FROM system.settings_profile_elements
        WHERE profile_name IS NOT NULL
        ORDER BY profile_name, index
    )
    GROUP BY profile_name
) e ON e.profile_name = s.name
ORDER BY s.name`;

const POLICY_QUERIES: CatalogQuery[] = [
	{ label: 'row policies', candidates: [ROW_POLICIES] },
	// The usage join needs `system.quotas_usage`, which an account without SHOW QUOTAS cannot
	// read. The limits alone are still worth having, so the second candidate drops the join
	// rather than the whole list.
	{ label: 'quotas', candidates: [quotas(true), quotas(false)] },
	{ label: 'settings profiles', candidates: [SETTINGS_PROFILES] },
];

const GRANT_QUERIES: CatalogQuery[] = [
	{ label: 'privileges', candidates: [GRANTS] },
];

export const clickhouseCatalog: SecurityCatalog = {
	driverId: 'clickhouse',
	principals: [
		{ label: 'users', candidates: [USERS] },
		{ label: 'roles', candidates: [ROLES] },
	],
	grants: GRANT_QUERIES,
	policies: POLICY_QUERIES,
};

function principalName(ref: PrincipalRef): string {
	return quoteIdent(assertSafeName(ref.name, 'user or role name'));
}

/** The `ON ...` clause. ClickHouse addresses a grant as `*.*`, `db.*` or `db.table`; there is no
 *  level between a database and a table, because a database is the namespace. */
function onClause(target: GrantTarget): string {
	const database = target.database ?? '';
	switch (target.scope) {
		case 'global':
			return '*.*';
		case 'schema':
			throw new Error('ClickHouse has no schemas. Grant on a database or on a table instead.');
		case 'database':
			return `${quoteIdent(assertSafeName(database, 'database name'))}.*`;
		default: {
			const object = quoteIdent(assertSafeName(target.object ?? '', 'table name'));
			return database ? `${quoteIdent(assertSafeName(database, 'database name'))}.${object}` : object;
		}
	}
}

/** Privileges, with a column list attached to each one when the target names columns:
 *  `GRANT SELECT(a, b), ALTER UPDATE(a, b) ON db.t`, the same shape Postgres uses. */
function privilegeClause(target: GrantTarget, privileges: readonly string[]): string {
	if (target.scope !== 'column' || !target.columns || target.columns.length === 0) {
		return privilegeList(privileges);
	}
	const columns = target.columns.map((column) => quoteIdent(assertSafeName(column, 'column name'))).join(', ');
	return privileges.map((privilege) => `${privilegeList([privilege])}(${columns})`).join(', ');
}

/**
 * A timestamp in the past, for the account that is being switched off.
 *
 * Fixed rather than "now", so the statement a reviewer approves is the statement that runs
 * however long they think about it, and so the read side can tell a deliberate switch-off from
 * an expiry date somebody chose. `'infinity'` is ClickHouse's own word for taking it off again.
 */
const DISABLED_UNTIL = '1970-01-02 00:00:00';

/**
 * What a quota may cap, and nothing else.
 *
 * A limit name goes into the statement UNQUOTED (ClickHouse accepts no quoted form), so unlike a
 * policy name it cannot be made safe by quoting. An allow-list is the only honest control, and it
 * doubles as the list the form offers, so the two can never disagree.
 */
const QUOTA_METRICS = ['queries', 'query_selects', 'query_inserts', 'errors', 'result_rows', 'result_bytes', 'read_rows', 'read_bytes', 'execution_time', 'written_bytes', 'failed_sequential_authentications'] as const;

/** The windows a quota can be measured over, for the same reason. */
const QUOTA_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;

export const clickhouseQuotaMetrics: readonly string[] = QUOTA_METRICS;
export const clickhouseQuotaUnits: readonly string[] = QUOTA_UNITS;

function policyName(ref: PolicyRef): string {
	return quoteIdent(assertSafeName(ref.name, `${ref.kind === 'row-policy' ? 'row policy' : ref.kind === 'quota' ? 'quota' : 'settings profile'} name`));
}

/** `db.table`, which a row policy always has and the other two never do. */
function policyTable(ref: PolicyRef): string {
	const database = assertSafeName(ref.database ?? '', 'database name');
	const table = assertSafeName(ref.object ?? '', 'table name');
	return `${quoteIdent(database)}.${quoteIdent(table)}`;
}

/**
 * The `TO ...` clause.
 *
 * `TO NONE` rather than an omitted clause when nothing is listed: on an ALTER, leaving the clause
 * out means "change nobody it applies to", so a screen that had emptied the list would silently
 * do nothing. NONE says what the person asked for.
 */
function toClause(appliesTo: readonly string[], appliesToAll: boolean): string {
	const names = appliesTo.map((name) => quoteIdent(assertSafeName(name, 'user or role name')));
	if (appliesToAll) {
		return names.length > 0 ? `ALL EXCEPT ${names.join(', ')}` : 'ALL';
	}
	return names.length > 0 ? names.join(', ') : 'NONE';
}

/** `name = value, name = value`, for a settings profile. */
function settingsClause(settings: readonly PolicySetting[]): string {
	if (settings.length === 0) {
		throw new Error('A settings profile needs at least one setting.');
	}
	return settings.map((setting) => `${assertSafeSettingName(setting.name)} = ${settingValue(setting.value)}`).join(', ');
}

/** `FOR INTERVAL 1 hour MAX queries = 100, errors = 10`. */
function intervalClause(interval: NonNullable<PolicyDraft['interval']>): string {
	if (!Number.isInteger(interval.duration) || interval.duration <= 0) {
		throw new Error('A quota window has to be a whole number of units.');
	}
	const unit = interval.unit.trim().toLowerCase();
	if (!(QUOTA_UNITS as readonly string[]).includes(unit)) {
		throw new Error(`"${interval.unit}" is not a window a ClickHouse quota can be measured over.`);
	}
	if (interval.limits.length === 0) {
		return `FOR INTERVAL ${interval.duration} ${unit} TRACKING ONLY`;
	}
	const limits = interval.limits.map((limit) => {
		const metric = limit.name.trim().toLowerCase();
		if (!(QUOTA_METRICS as readonly string[]).includes(metric)) {
			throw new Error(`"${limit.name}" is not something a ClickHouse quota can limit.`);
		}
		const value = limit.value.trim();
		if (!/^\d+(\.\d+)?$/.test(value)) {
			throw new Error(`The limit for ${metric} has to be a number.`);
		}
		return `${metric} = ${value}`;
	});
	return `FOR INTERVAL ${interval.duration} ${unit} MAX ${limits.join(', ')}`;
}

/**
 * `CREATE ...` for one of the three.
 *
 * The row policy's USING expression is the one value in this whole module that reaches the
 * statement as the person wrote it: a filter IS an expression, so it can be neither quoted nor
 * picked from a list. `assertSafeExpression` makes sure it cannot carry a second statement, and
 * the review sheet is what actually decides whether it says what they meant.
 */
function createPolicy(draft: PolicyDraft): string[] {
	const to = draft.appliesTo || draft.appliesToAll ? ` TO ${toClause(draft.appliesTo ?? [], draft.appliesToAll ?? false)}` : '';
	switch (draft.kind) {
		case 'row-policy': {
			const restrictive = draft.restrictive ? ' AS RESTRICTIVE' : '';
			const using = assertSafeExpression(draft.expression ?? '', 'row policy filter');
			return [`CREATE ROW POLICY ${policyName(draft)} ON ${policyTable(draft)}${restrictive} USING ${using}${to}`];
		}
		case 'quota': {
			if (!draft.interval) {
				throw new Error('A quota needs a window to measure over.');
			}
			// KEYED BY user_name: a quota with no key is one bucket for the whole server, which is
			// almost never what someone setting a per-account limit means.
			return [`CREATE QUOTA ${policyName(draft)} KEYED BY user_name ${intervalClause(draft.interval)}${to}`];
		}
		case 'settings-profile':
			return [`CREATE SETTINGS PROFILE ${policyName(draft)} SETTINGS ${settingsClause(draft.settings ?? [])}${to}`];
	}
}

/** The object word a DROP/ALTER uses, which is the kind spelled ClickHouse's way. */
function policyObject(kind: PolicyRef['kind']): string {
	switch (kind) {
		case 'row-policy': return 'ROW POLICY';
		case 'quota': return 'QUOTA';
		case 'settings-profile': return 'SETTINGS PROFILE';
	}
}

export const clickhouseEmitter: SecurityEmitter = {
	driverId: 'clickhouse',
	principalKinds: ['user', 'role'],
	usesHost: false,
	grantScopes: ['column', 'table', 'database', 'global'],
	policyKinds: ['row-policy', 'quota', 'settings-profile'],
	privilegesFor(scope: GrantScope): readonly string[] {
		switch (scope) {
			case 'global':
				return ['SELECT', 'INSERT', 'ALTER', 'CREATE', 'DROP', 'SHOW', 'OPTIMIZE', 'REMOTE', 'S3', 'URL', 'SYSTEM', 'ACCESS MANAGEMENT', 'ALL'];
			case 'database':
				return ['SELECT', 'INSERT', 'ALTER', 'CREATE TABLE', 'CREATE VIEW', 'CREATE DICTIONARY', 'DROP TABLE', 'TRUNCATE', 'OPTIMIZE', 'SHOW TABLES', 'ALL'];
			case 'column':
				return ['SELECT', 'INSERT', 'ALTER UPDATE'];
			case 'schema':
				return [];
			default:
				return ['SELECT', 'INSERT', 'ALTER', 'ALTER UPDATE', 'ALTER DELETE', 'ALTER ADD COLUMN', 'ALTER DROP COLUMN', 'DROP TABLE', 'TRUNCATE', 'OPTIMIZE', 'SHOW COLUMNS', 'ALL'];
		}
	},
	emit(change: SecurityChange): string[] {
		switch (change.kind) {
			case 'create-principal': {
				const name = principalName(change.draft);
				const statements: string[] = [];
				if (change.draft.kind === 'role') {
					if (change.draft.password) {
						throw new Error('A ClickHouse role has no password. Create a user instead, or leave the password blank.');
					}
					statements.push(`CREATE ROLE ${name}`);
				} else if (change.draft.password) {
					// sha256_password is named rather than left to the server's default, so the
					// statement says what it stores and a server configured for plaintext does not
					// quietly store one.
					statements.push(`CREATE USER ${name} IDENTIFIED WITH sha256_password BY ${quoteBackslashLiteral(assertSafePassword(change.draft.password))}`);
				} else {
					statements.push(`CREATE USER ${name}`);
				}
				for (const role of change.draft.memberOf ?? []) {
					statements.push(`GRANT ${quoteIdent(assertSafeName(role, 'role name'))} TO ${name}`);
				}
				return statements;
			}
			case 'drop-principal':
				return [`DROP ${change.principalKind === 'role' ? 'ROLE' : 'USER'} ${principalName(change.principal)}`];
			case 'set-password':
				return [`ALTER USER ${principalName(change.principal)} IDENTIFIED WITH sha256_password BY ${quoteBackslashLiteral(assertSafePassword(change.password))}`];
			case 'set-enabled':
				return [`ALTER USER ${principalName(change.principal)} VALID UNTIL ${change.enabled ? quoteBackslashLiteral('infinity') : quoteBackslashLiteral(DISABLED_UNTIL)}`];
			case 'grant': {
				const tail = change.withGrantOption ? ' WITH GRANT OPTION' : '';
				return [`GRANT ${privilegeClause(change.target, change.privileges)} ON ${onClause(change.target)} TO ${principalName(change.principal)}${tail}`];
			}
			case 'revoke':
				return [`REVOKE ${privilegeClause(change.target, change.privileges)} ON ${onClause(change.target)} FROM ${principalName(change.principal)}`];
			case 'grant-role':
				return [`GRANT ${quoteIdent(assertSafeName(change.role, 'role name'))} TO ${principalName(change.principal)}`];
			case 'revoke-role':
				return [`REVOKE ${quoteIdent(assertSafeName(change.role, 'role name'))} FROM ${principalName(change.principal)}`];
			case 'create-policy':
				return createPolicy(change.draft);
			case 'drop-policy': {
				const on = change.policy.kind === 'row-policy' ? ` ON ${policyTable(change.policy)}` : '';
				return [`DROP ${policyObject(change.policy.kind)} ${policyName(change.policy)}${on}`];
			}
			case 'set-policy-principals': {
				const on = change.policy.kind === 'row-policy' ? ` ON ${policyTable(change.policy)}` : '';
				return [`ALTER ${policyObject(change.policy.kind)} ${policyName(change.policy)}${on} TO ${toClause(change.appliesTo, change.appliesToAll)}`];
			}
		}
	},
};

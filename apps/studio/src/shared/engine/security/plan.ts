/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The registry, and the plan a review surface shows.
 *
 *  Nothing in this module runs SQL. `planFor` turns changes into statements plus the sentence
 *  that explains each one, and that plan is what a person (or an agent's user) approves. The
 *  sentence and the destructive flag are derived HERE rather than in each emitter, so a new
 *  vendor cannot ship a REVOKE that forgets to mark itself as taking access away.
 *--------------------------------------------------------------------------------------------*/

import { backendKindForDriver } from '../compile/native';
import type { SecurityCatalog } from './catalog';
import type { SecurityEmitter } from './emitter';
import { policyKindLabel } from './emitter';
import { containsSqlSecret } from './redact';
import type { AccessPolicy, GrantScope, GrantTarget, PolicyKind, PolicyRef, PrincipalKind, PrincipalRef, SecurityChange, SecurityPlan, SecurityStatement } from './types';
import { clickhouseCatalog, clickhouseEmitter } from './vendors/clickhouse';
import { mariadbCatalog, mariadbEmitter, mysqlCatalog, mysqlEmitter } from './vendors/mysql';
import { oracleCatalog, oracleEmitter } from './vendors/oracle';
import { postgresCatalog, postgresEmitter } from './vendors/postgres';
import { sqlserverCatalog, sqlserverEmitter } from './vendors/sqlserver';

interface VendorSupport {
	catalog: SecurityCatalog;
	emitter: SecurityEmitter;
}

const VENDORS: Record<string, VendorSupport> = {
	'postgres': { catalog: postgresCatalog, emitter: postgresEmitter },
	'mysql-aurora': { catalog: mysqlCatalog, emitter: mysqlEmitter },
	'mariadb': { catalog: mariadbCatalog, emitter: mariadbEmitter },
	'sqlserver': { catalog: sqlserverCatalog, emitter: sqlserverEmitter },
	'oracle': { catalog: oracleCatalog, emitter: oracleEmitter },
	'clickhouse': { catalog: clickhouseCatalog, emitter: clickhouseEmitter },
};

/**
 * Why an engine has no security view, in the user's words.
 *
 * These are not "not implemented yet" — SQLite and DuckDB genuinely have no concept of a user,
 * and a screen that said "coming soon" for them would be promising something that will never
 * arrive. The engines that DO have accounts and are not yet covered say exactly that instead.
 */
const UNSUPPORTED: Record<string, { reason: string; hasAccounts: boolean }> = {
	'sqlite': { reason: 'SQLite has no users or privileges. Access to the database is access to the file.', hasAccounts: false },
	'duckdb': { reason: 'DuckDB has no users or privileges. Access to the database is access to the file.', hasAccounts: false },
	'pinecone': { reason: 'Pinecone has no database users. Access is controlled by the API key on the connection.', hasAccounts: false },
	'mongodb': { reason: 'MongoDB manages users through its own commands rather than SQL. Not supported yet.', hasAccounts: true },
	'snowflake': { reason: 'Snowflake users and roles are not supported yet.', hasAccounts: true },
	'redshift': { reason: 'Redshift users and groups are not supported yet.', hasAccounts: true },
	'db2': { reason: 'Db2 authorities and privileges are not supported yet.', hasAccounts: true },
	'hana': { reason: 'SAP HANA users and roles are not supported yet.', hasAccounts: true },
};

/** What the app can do about security on a connection, for the UI to render honestly. */
export interface SecuritySupport {
	supported: boolean;
	/**
	 * Whether this engine HAS accounts at all, which is a different question from whether we read
	 * them. Surfaces that offer the feature (the connection tree's node) hide it when this is
	 * false, because a permanent row that only ever says "SQLite has no users" is clutter; they
	 * keep it when it is true, because "this engine has users and we do not read them yet" is
	 * something the user should be able to find out.
	 */
	hasAccounts: boolean;
	/** Present when `supported` is false: one sentence saying why, for the empty state. */
	reason?: string;
	principalKinds: readonly PrincipalKind[];
	usesHost: boolean;
	grantScopes: readonly GrantScope[];
	/** The policy kinds this engine's row policies / quotas / settings profiles are read and
	 *  written for. Empty is the normal answer today: the screen then shows no policy section at
	 *  all rather than an empty one. */
	policyKinds: readonly PolicyKind[];
}

export function securitySupport(driverId: string): SecuritySupport {
	const vendor = VENDORS[driverId];
	if (!vendor) {
		// A log service has no accounts of its own to have: the credential is the cloud account the
		// connection references, and who may read what is decided by the provider's own IAM, in the
		// provider's console. Asked by BACKEND KIND rather than by driver id so a service added later
		// is right without being remembered here.
		if (backendKindForDriver(driverId) === 'telemetry') {
			return {
				supported: false,
				hasAccounts: false,
				reason: 'A log service has no database users. Who can read these logs is set by the cloud account this connection uses, in your cloud provider.',
				principalKinds: [],
				usesHost: false,
				grantScopes: [],
				policyKinds: [],
			};
		}
		const known = UNSUPPORTED[driverId];
		return {
			supported: false,
			// An unknown driver is assumed to have accounts: a new SQL engine almost certainly does,
			// and offering the screen that then explains itself is better than silently hiding it.
			hasAccounts: known?.hasAccounts ?? true,
			reason: known?.reason ?? 'Users and privileges are not supported for this connection yet.',
			principalKinds: [],
			usesHost: false,
			grantScopes: [],
			policyKinds: [],
		};
	}
	return {
		supported: true,
		hasAccounts: true,
		principalKinds: vendor.emitter.principalKinds,
		usesHost: vendor.emitter.usesHost,
		grantScopes: vendor.emitter.grantScopes,
		policyKinds: vendor.emitter.policyKinds,
	};
}

/** The catalog for a driver, or null when the engine has no security model we read. */
export function securityCatalogFor(driverId: string): SecurityCatalog | null {
	return VENDORS[driverId]?.catalog ?? null;
}

/** The emitter for a driver, or null. */
export function securityEmitterFor(driverId: string): SecurityEmitter | null {
	return VENDORS[driverId]?.emitter ?? null;
}

/** The privileges offered for a scope on a driver, for the grant editor's picker. */
export function privilegesFor(driverId: string, scope: GrantScope): readonly string[] {
	return VENDORS[driverId]?.emitter.privilegesFor(scope) ?? [];
}

/** `app@%` on MySQL, `app` everywhere else. */
export function principalLabel(ref: PrincipalRef): string {
	return ref.host ? `${ref.name}@${ref.host}` : ref.name;
}

/** The object a grant is about, as a person would say it. */
export function targetLabel(target: GrantTarget): string {
	const parts = [target.database, target.schema, target.object].filter((part): part is string => !!part);
	const path = parts.join('.');
	switch (target.scope) {
		case 'global': return 'the whole server';
		case 'database': return `database ${path}`;
		case 'schema': return `schema ${path}`;
		case 'column': return target.columns && target.columns.length > 0 ? `${path} (${target.columns.join(', ')})` : path;
		default: return path;
	}
}

/** A policy as a person would name it: the kind, the name, and the table when it has one. */
export function policyLabel(policy: PolicyRef | AccessPolicy): string {
	const on = policy.database && policy.object ? ` on ${policy.database}.${policy.object}` : '';
	return `${policyKindLabel(policy.kind)} ${policy.name}${on}`;
}

/** Who a policy applies to, as a sentence. "Everyone except the admin" is a real shape and reads
 *  nothing like the list it is built from, which is the whole reason this is not `join(', ')`. */
export function appliesToLabel(appliesTo: readonly string[], appliesToAll: boolean): string {
	if (appliesToAll) {
		return appliesTo.length > 0 ? `everyone except ${appliesTo.join(', ')}` : 'everyone';
	}
	return appliesTo.length > 0 ? appliesTo.join(', ') : 'nobody';
}

/** One sentence describing a change, addressed to the person approving it. */
export function describeSecurityChange(change: SecurityChange): string {
	switch (change.kind) {
		case 'create-policy':
			return `Create the ${policyLabel(change.draft)}, applying to ${appliesToLabel(change.draft.appliesTo ?? [], change.draft.appliesToAll ?? false)}.`;
		case 'drop-policy':
			return `Drop the ${policyLabel(change.policy)}.`;
		case 'set-policy-principals':
			return `Make the ${policyLabel(change.policy)} apply to ${appliesToLabel(change.appliesTo, change.appliesToAll)}.`;
	}
	const who = change.kind === 'create-principal' ? principalLabel(change.draft) : principalLabel(change.principal);
	switch (change.kind) {
		case 'create-principal':
			return `Create the ${change.draft.kind} ${who}.`;
		case 'drop-principal':
			return `Drop the ${change.principalKind} ${who}, and everything granted to it.`;
		case 'set-password':
			return `Set a new password for ${who}.`;
		case 'set-enabled':
			return change.enabled ? `Let ${who} sign in again.` : `Stop ${who} from signing in.`;
		case 'grant':
			return `Grant ${change.privileges.join(', ')} on ${targetLabel(change.target)} to ${who}.`;
		case 'revoke':
			return `Take ${change.privileges.join(', ')} on ${targetLabel(change.target)} away from ${who}.`;
		case 'grant-role':
			return `Add ${who} to the role ${change.role}.`;
		case 'revoke-role':
			return `Remove ${who} from the role ${change.role}.`;
	}
}

/** True when a change takes access away or destroys a principal. */
export function isDestructive(change: SecurityChange): boolean {
	switch (change.kind) {
		case 'drop-principal':
		case 'revoke':
		case 'revoke-role':
			return true;
		case 'set-enabled':
			return !change.enabled;
		case 'drop-policy':
			return true;
		// A row policy is the one object here whose CREATE takes access away: the moment a
		// permissive policy exists on a table, every account it applies to sees only the rows it
		// allows. So it is marked like a revoke, and the other two are not.
		case 'create-policy':
			return change.draft.kind === 'row-policy';
		// Changing who a policy applies to can only be judged against who it applied to before,
		// which this function does not have. Marked, because the case that matters is the one that
		// puts a row policy on somebody.
		case 'set-policy-principals':
			return change.policy.kind === 'row-policy';
		default:
			return false;
	}
}

/**
 * Turn changes into the ordered, reviewable plan.
 *
 * Throws with a plain-English message when a change cannot be expressed on this engine (a schema
 * grant on Oracle, a login on Postgres) or when a name or privilege would not be safe to
 * interpolate. Callers surface the message as-is: it is written for the user, not the log.
 */
export function planFor(driverId: string, changes: readonly SecurityChange[]): SecurityPlan {
	const emitter = securityEmitterFor(driverId);
	if (!emitter) {
		throw new Error(securitySupport(driverId).reason ?? `Users and privileges are not supported for driver "${driverId}".`);
	}
	const statements: SecurityStatement[] = [];
	changes.forEach((change, changeIndex) => {
		const description = describeSecurityChange(change);
		const destructive = isDestructive(change);
		emitter.emit(change).forEach((sql, statementIndex) => {
			statements.push({
				id: `${change.kind}-${changeIndex}-${statementIndex}`,
				sql,
				description,
				destructive,
				carriesSecret: containsSqlSecret(sql),
			});
		});
	});
	return { driverId, statements };
}

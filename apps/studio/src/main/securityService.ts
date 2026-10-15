/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { principalKey, planFor, propagateSuperuser, redactSqlSecrets, rowsToGrants, rowsToPolicies, rowsToPrincipals, securityCatalogFor, securitySupport, type AccessPolicy, type CatalogQuery, type CatalogRow, type Grant, type Principal, type SecurityChange, type SecurityPlan, type SecurityApplyResult, type SecuritySnapshot, type SecuritySupport } from '../shared/engine';
import { readConnections } from './configStore';
import type { ConnectionManager } from './connectionManager';
import type { QueryResult } from '../shared/query';

/**
 * Database users and privileges, run against a live connection.
 *
 * The engine decides WHAT to ask and what the answer means; this file is the part that talks to a
 * connection. Three things it is responsible for:
 *
 *  - Reading. `snapshot` runs each catalog query, falling back through its candidates, and turns
 *    a query that fails every candidate into a WARNING rather than an error. That is not
 *    defensive padding: `dba_users` and `mysql.user` need privileges an application account does
 *    not have, and the useful answer then is "here is what you can see, and here is what you
 *    cannot", not an empty screen.
 *  - Planning. The driver id is resolved HERE from the saved connection, never taken from the
 *    caller, so a connection cannot be asked to emit another vendor's SQL.
 *  - Applying. `apply` takes CHANGES, not SQL. It re-plans them in main and runs what the
 *    emitters produced, so the only statements that can reach a database through this path are
 *    ones the engine generated — an agent cannot hand main a string and have it run as a
 *    "security plan".
 *
 * Nothing here logs a statement, and the connection manager is called with history recording off:
 * half of these carry a password, and the whole point of the feature is that it does not end up
 * on disk.
 */

export class SecurityService {
	constructor(private readonly connections: ConnectionManager) { }

	/** The driver behind a saved connection. */
	private driverFor(connectionId: string): string {
		const config = readConnections().find((entry) => entry.id === connectionId);
		if (!config) {
			throw new Error('That connection no longer exists.');
		}
		return config.driver;
	}

	/** What this connection's engine can do about users and privileges, for the view's empty
	 *  state and the agent's read tools. */
	support(connectionId: string): SecuritySupport {
		return securitySupport(this.driverFor(connectionId));
	}

	/** Read every principal and grant the connection is allowed to see. */
	async snapshot(connectionId: string): Promise<SecuritySnapshot> {
		const driverId = this.driverFor(connectionId);
		const catalog = securityCatalogFor(driverId);
		if (!catalog) {
			throw new Error(securitySupport(driverId).reason ?? 'Users and privileges are not supported for this connection.');
		}
		const warnings: string[] = [];
		const principals: Principal[] = [];
		const grants: Grant[] = [];
		const policies: AccessPolicy[] = [];

		for (const query of catalog.principals) {
			const rows = await this.tryQuery(connectionId, query, warnings);
			if (rows) {
				principals.push(...rowsToPrincipals(rows));
			}
		}
		for (const query of catalog.grants) {
			const rows = await this.tryQuery(connectionId, query, warnings);
			if (rows) {
				grants.push(...rowsToGrants(rows));
			}
		}
		// Row policies, quotas and settings profiles, on the engines that have them. Read with the
		// same fallback-and-warn rule as the rest: an account that may not read `system.quotas`
		// still gets the users, which is most of the screen.
		for (const query of catalog.policies ?? []) {
			const rows = await this.tryQuery(connectionId, query, warnings);
			if (rows) {
				policies.push(...rowsToPolicies(rows));
			}
		}

		return { driverId, principals: propagateSuperuser(dedupePrincipals(principals)), grants, policies, warnings };
	}

	/**
	 * Run each candidate in turn until one succeeds. A candidate that errors is not reported on
	 * its own — only the last error is, and only when every candidate failed, because "dba_users
	 * does not exist" is noise once `all_users` has answered the question.
	 */
	private async tryQuery(connectionId: string, query: CatalogQuery, warnings: string[]): Promise<CatalogRow[] | null> {
		let lastError = 'no candidate query ran';
		for (const sql of query.candidates) {
			// recordHistory: false — a catalog read the user did not type does not belong in their
			// query history, and there is one of these per query on every refresh.
			const result = await this.connections.execute(connectionId, sql, false);
			if (result.ok) {
				return toRows(result.result);
			}
			lastError = result.error;
		}
		warnings.push(`Could not read ${query.label}: ${lastError}`);
		return null;
	}

	/** The reviewable plan for a set of changes. Throws with a user-facing message when a change
	 *  cannot be expressed on this engine. */
	plan(connectionId: string, changes: readonly SecurityChange[]): SecurityPlan {
		return planFor(this.driverFor(connectionId), changes);
	}

	/**
	 * Apply changes the user has reviewed.
	 *
	 * Deliberately NOT `connectionManager.applyMigration`: that path records every statement in
	 * query history. It is also not wrapped in a transaction even on Postgres — `CREATE ROLE` is
	 * transactional there, but `CREATE LOGIN` and `ALTER USER` are not on the other three, so a
	 * transaction would give one engine a guarantee the UI could not honestly claim for the rest.
	 * The plan stops at the first failure and reports exactly how far it got.
	 */
	async apply(connectionId: string, changes: readonly SecurityChange[]): Promise<SecurityApplyResult> {
		const plan = this.plan(connectionId, changes);
		for (let i = 0; i < plan.statements.length; i++) {
			const statement = plan.statements[i];
			const result = await this.connections.execute(connectionId, statement.sql, false);
			if (!result.ok) {
				return {
					ok: false,
					// Some drivers echo the failing statement back inside the error message, so the
					// error is redacted before it leaves this method.
					error: redactSqlSecrets(result.error),
					failedIndex: i,
					failedId: statement.id,
					applied: i,
					description: statement.description,
				};
			}
		}
		return { ok: true, applied: plan.statements.length };
	}
}

/** A driver result set as plain `column -> value` rows. Drivers return row-major arrays aligned
 *  to `fields`, so the column names are re-attached here for the engine's mappers. */
function toRows(result: QueryResult): CatalogRow[] {
	const columns = result.fields.map((field) => field.name);
	return result.rows.map((row) => {
		const out: CatalogRow = {};
		columns.forEach((column, index) => {
			out[column] = row[index];
		});
		return out;
	});
}

/**
 * Collapse principals that two queries both returned.
 *
 * SQL Server asks twice (database users, then server logins) and the same name legitimately
 * appears in both — the database user `app` and the login `app` are different objects that share
 * a name. They are keyed apart rather than merged, so "there is a login with no database user"
 * stays visible; the dedupe only drops a genuine repeat of the same row.
 */
function dedupePrincipals(principals: readonly Principal[]): Principal[] {
	const byKey = new Map<string, Principal>();
	for (const principal of principals) {
		const key = `${principal.kind === 'login' ? 'login:' : 'db:'}${principalKey(principal.name, principal.host)}`;
		if (!byKey.has(key)) {
			byKey.set(key, principal);
		}
	}
	return [...byKey.values()];
}

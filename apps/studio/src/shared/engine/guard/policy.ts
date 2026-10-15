/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseEnvironment } from '../../connection';
import { destructiveStatement, type DestructiveStatement } from './sqlGuard';

/*
 * The production policy — the ONE place the prod flag is interpreted as a decision.
 *
 * Before this module the flag was read independently by four surfaces (the run path, the
 * native-write path, the grid's edit lock, the launch reconnect), each re-deciding what
 * "prod" means. That is exactly the shape of bug where one surface is hardened and another
 * quietly is not, so the readings live here instead and the surfaces ask.
 *
 * Cosmetics are deliberately NOT in scope. The prod dot, the `env` badge, the "this is a
 * production connection" banner and the PROD suffixes stay where they are: they colour a
 * label, they do not gate anything, and pulling them in would bloat this surface without
 * making a single decision safer.
 */

/** The user preferences that soften the policy. Both default to the safe reading when absent. */
export interface ProdPolicyPrefs {
	/** Settings → "Confirm destructive statements on prod connections". */
	confirmDestructive?: boolean;
	/** Settings → allow grid edit/copy actions on a prod result. */
	allowGridActions?: boolean;
}

/** What a connection is allowed to do, decided once. */
export interface ConnectionPolicy {
	readonly isProduction: boolean;
	/**
	 * Whether this connection may be reopened automatically at launch (and remembered for the
	 * next one). Prod is never reconnected without the user asking: a background reconnect is
	 * an unsupervised session against production.
	 */
	readonly allowsAutoConnect: boolean;
	/** Whether the result grid offers edit/copy actions. `live` is false on a dropped connection. */
	allowsGridActions(live: boolean): boolean;
	/**
	 * The destructive statement in `sql` that must be confirmed before it runs, or undefined
	 * if this connection lets it through. Non-prod never confirms; prod confirms unless the
	 * user has turned the preference off.
	 */
	confirmationFor(sql: string): DestructiveStatement | undefined;
	/** Whether an already-known-to-write native query (a Mongo pipeline) needs a confirm. */
	confirmsWrites(): boolean;
}

/**
 * The policy for one connection. Takes the environment rather than a whole `ConnectionConfig`
 * so the renderer can call it with `activeConfig?.environment` and main with a resolved
 * config, without either shape leaking in here. `driver` is the connection's driver id, so the
 * guard reads the SQL the way that engine does.
 */
export function policyFor(environment: DatabaseEnvironment | undefined, prefs: ProdPolicyPrefs = {}, driver?: string): ConnectionPolicy {
	const isProduction = environment === 'prod';
	const confirmDestructive = prefs.confirmDestructive ?? true;
	const allowGridActions = prefs.allowGridActions ?? false;
	return {
		isProduction,
		allowsAutoConnect: !isProduction,
		allowsGridActions(live: boolean): boolean {
			return (!isProduction || allowGridActions) && live;
		},
		confirmationFor(sql: string): DestructiveStatement | undefined {
			if (!isProduction || !confirmDestructive) {
				return undefined;
			}
			return destructiveStatement(sql, driver);
		},
		confirmsWrites(): boolean {
			return isProduction && confirmDestructive;
		},
	};
}

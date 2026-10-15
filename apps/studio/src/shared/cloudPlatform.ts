/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseSchema } from './schema';

/*
 * What SnoutData Cloud puts in a customer's database that is not the customer's: the schemas
 * the API stack's servers own (auth, storage, Realtime, pg_graphql, ...) and the roles
 * those servers and the pod log in as. On a connection with a `cloudProjectRef` the explorer and
 * Users & Privileges leave them out, so nobody browses the auth server's tables or drops
 * `snout_realtime_admin` from a tree row. (Only the current role names are listed. Projects made
 * before 2026-09-30 had their roles under an older prefix until the host agent renamed them, and
 * a role still under that prefix is shown like any other.)
 *
 * Presentation only: the schema index keeps them, so `auth.users` still completes and hovers in
 * the editor, where a customer's own SQL does reference it.
 */

const PLATFORM_SCHEMAS = new Set([
	'auth',
	'storage',
	'realtime',
	'_realtime',
	'graphql',
	'graphql_public',
	'extensions',
	'net',
	// The same schemas in our own layout, which a project made since it has.
	'snout_identity',
	'snout_files',
	'snout_live',
	'snout_graph',
	'snout_ext',
	// SnoutTime's catalog and its per-partition late-row stores. A customer's series tables live
	// in their own schemas and show there, with their Partitions and Rollups folders; these are
	// the extension's bookkeeping (jobs, job_runs, invalidations, seal_sizes and ~140 functions).
	// `cron` stays: a customer schedules their own jobs in it.
	'snouttime',
	'snouttime_internal',
]);

/** Login roles the platform uses (`snout_gate` is `authenticator` in our own layout). The app,
 *  member and server roles (`snout_app`, `snout_member`, `snout_server`, earlier `anon`,
 *  `authenticated`, `service_role`) are NOT here: a customer grants to them and names them in
 *  row-level-security policies. */
const PLATFORM_ROLES = new Set(['authenticator', 'snout_gate', 'snoutpod_admin', 'snout_auth_admin', 'snout_realtime_admin', 'snout_storage_admin', 'snout_push_admin', 'pgbouncer', 'postgres']);

export function isPlatformSchema(name: string | undefined): boolean {
	return name !== undefined && PLATFORM_SCHEMAS.has(name);
}

export function isPlatformRole(name: string): boolean {
	return PLATFORM_ROLES.has(name);
}

/** The schema with every platform-owned schema's tables, routines and empty rows removed. */
export function withoutPlatformSchemas(schema: DatabaseSchema): DatabaseSchema {
	return {
		...schema,
		tables: schema.tables.filter((t) => !isPlatformSchema(t.schema)),
		routines: schema.routines?.filter((r) => !isPlatformSchema(r.schema)),
		emptySchemas: schema.emptySchemas?.filter((s) => !isPlatformSchema(s)),
	};
}

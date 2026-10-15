/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What SnoutData Cloud puts in a hosted project for itself, as MEASURED (2026-09-13, on a fresh
 * project). Not guessed: every name here was read off a real project, and a change
 * to the pod image or the stack is a change here.
 */

export interface PlatformProfile {
	readonly schemas: readonly string[];
	readonly extensions: readonly string[];
	readonly objects: readonly { readonly schema: string; readonly name: string }[];
}

/** The Postgres major a NEW SnoutData Cloud project runs (it was 17 before). An existing project is asked, never assumed. */
export const HOSTED_POSTGRES_MAJOR = 18;

export const HOSTED_POSTGRES_PLATFORM: PlatformProfile = {
	// Owned by the platform's own admin roles (auth, storage, realtime and the pod's). A project
	// made in the own layout has the `snout_*` names instead; one made
	// before it has the earlier ones until it is renamed, so both sets are listed.
	schemas: [
		'auth', 'extensions', 'graphql', 'graphql_public', 'realtime', 'storage',
		'snout_ext', 'snout_files', 'snout_graph', 'snout_identity', 'snout_live'
	],
	// Installed before the customer has done anything. `vector` is too, and is deliberately NOT
	// listed: it is there for the customer to use, and a table of theirs may depend on it.
	extensions: ['pg_graphql', 'pg_prewarm', 'pg_stat_statements'],
	// PostgREST's schema-cache watchers live in `public` and are owned by `<ref>_owner`, so only
	// their names tell them apart from the customer's own functions. Dropping them breaks the data
	// API's schema reload.
	objects: [
		{ schema: 'public', name: 'pgrst_ddl_watch' },
		{ schema: 'public', name: 'pgrst_drop_watch' }
	]
};

/**
 * The event triggers a SnoutData database (a Cloud project, or the self-hosted stack) installs for
 * itself, each calling a function of the same name in the platform's own schema (`extensions`
 * before the own layout, `snout_ext` in it). An event trigger is database-wide, so `pg_dump`
 * carries it even with that schema excluded, and its restore cannot succeed anywhere: the schema
 * is missing on a plain Postgres, the trigger already exists on another SnoutData database, and only
 * a superuser may create one. Measured 2026-10-15, moving a project out of Cloud.
 */
export const PLATFORM_EVENT_TRIGGERS: readonly string[] = ['snoutpod_grant_new_schema', 'snoutpod_oauth_read_new_schema'];

/** The schemas those triggers' functions live in. */
export const PLATFORM_FUNCTION_SCHEMAS: readonly string[] = ['extensions', 'snout_ext'];

/** A plain Postgres the user runs: nothing on it belongs to anybody but them. */
export const NO_PLATFORM: PlatformProfile = { schemas: [], extensions: [], objects: [] };

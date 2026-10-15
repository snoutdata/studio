/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Pool } from 'pg';

import type { DatabaseDriver } from '../databaseDriver';
import { createPostgresFamilyDriver, type PostgresFamilyIntrospection } from '../postgres/postgresDriver';
import { introspectRedshift, redshiftStructuralDigest, type RedshiftRowRunner } from './introspection';

/** Adapt the pg pool to the named-column row runner the Redshift catalog queries take (the same
 *  seam the unit test injects canned rows through). */
function runnerFor(pool: Pool): RedshiftRowRunner {
	return async (sql: string) => {
		const result = await pool.query(sql);
		return (result.rows ?? []) as Record<string, unknown>[];
	};
}

const REDSHIFT_INTROSPECTION: PostgresFamilyIntrospection = {
	schema: (pool, database, includeViews) => introspectRedshift(runnerFor(pool), database, includeViews),
	digest: (pool) => redshiftStructuralDigest(runnerFor(pool)),
};

/**
 * Amazon Redshift driver. Redshift speaks the PostgreSQL wire protocol, so the `pg` client connects
 * unchanged and the whole connect / pool / SSH-tunnel / execute / cancel path is the Postgres
 * family's (`pg_cancel_backend` is present on Redshift too). What differs is the CATALOG: Redshift
 * dropped most of Postgres's system views and exposes its own `SVV_*` set instead, so it plugs in
 * its own introspection pair (see introspection.ts).
 *
 * It is a warehouse, so pair connections with the `readOnly` flag: Redshift has no indexes and no
 * triggers, its PK/FK constraints are declared-but-not-enforced, and schema sync is not supported
 * for it (`emitterFor` refuses — the ALTER surface is too restricted to emit safely).
 */
export function createRedshiftDriver(): DatabaseDriver {
	return createPostgresFamilyDriver('redshift', 'Amazon Redshift', REDSHIFT_INTROSPECTION);
}

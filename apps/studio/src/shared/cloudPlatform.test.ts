/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isPlatformRole, isPlatformSchema, withoutPlatformSchemas } from './cloudPlatform';
import type { DatabaseSchema } from './schema';

describe('cloudPlatform', () => {
	test('platform roles are hidden, the roles a customer grants to are not', () => {
		for (const role of ['snout_auth_admin', 'snout_realtime_admin', 'snout_storage_admin', 'authenticator', 'snout_gate', 'snoutpod_admin', 'postgres']) {
			assert.equal(isPlatformRole(role), true, role);
		}
		for (const role of ['anon', 'authenticated', 'service_role', 'snout_app', 'snout_member', 'snout_server', 'exampleref002_owner', 'app_user']) {
			assert.equal(isPlatformRole(role), false, role);
		}
	});

	test('platform schemas leave the tree, the customer\'s stay', () => {
		assert.equal(isPlatformSchema('auth'), true);
		assert.equal(isPlatformSchema('snouttime'), true);
		assert.equal(isPlatformSchema('snouttime_internal'), true);
		// The pod's bootstrap makes `graphql_public` (the data API's GraphQL wrapper). It makes no
		// `vault` and no `pgbouncer` schema, so one there is the customer's own and stays in view.
		assert.equal(isPlatformSchema('graphql_public'), true);
		// The same schemas in our own layout.
		for (const name of ['snout_identity', 'snout_files', 'snout_live', 'snout_graph', 'snout_ext']) {
			assert.equal(isPlatformSchema(name), true, name);
		}
		assert.equal(isPlatformSchema('vault'), false);
		assert.equal(isPlatformSchema('pgbouncer'), false);
		assert.equal(isPlatformSchema('cron'), false);
		assert.equal(isPlatformSchema('public'), false);
		assert.equal(isPlatformSchema(undefined), false);
		const schema = {
			database: 'exampleref002',
			tables: [{ name: 'users', schema: 'auth' }, { name: 'orders', schema: 'public' }],
			routines: [{ name: 'uid', schema: 'auth' }, { name: 'job', schema: 'cron' }],
			emptySchemas: ['storage', 'app'],
		} as unknown as DatabaseSchema;
		const out = withoutPlatformSchemas(schema);
		assert.deepEqual(out.tables.map((t) => t.name), ['orders']);
		assert.deepEqual(out.routines?.map((r) => r.name), ['job']);
		assert.deepEqual(out.emptySchemas, ['app']);
	});
});

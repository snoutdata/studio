/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { capabilityConnectionArg, type CapabilitySpec } from '../../../shared/capabilities';

/*
 * An external agent may only touch a connection the user exposed to it, and main can hold a
 * capability to that only if it knows which argument names the connection. So every argument that
 * reads as a connection must be the one the spec declares (or one main recognises by name).
 */

/** Every always-registered capability's spec. Loaded after a bare `window`, which a module reads at load. */
async function staticSpecs(): Promise<CapabilitySpec[]> {
	const host = globalThis as unknown as { window?: unknown };
	host.window ??= { sqlApi: {} };
	const { staticCapabilities } = await import('./index');
	return staticCapabilities.map((handler) => handler.spec);
}

function properties(parameters: Record<string, unknown>): Record<string, { description?: unknown }> {
	return ((parameters as { properties?: Record<string, { description?: unknown }> }).properties) ?? {};
}

describe('capabilities that name a connection', () => {
	test('every argument that names a saved connection is the one main checks', async () => {
		const missed: string[] = [];
		for (const spec of await staticSpecs()) {
			const declared = capabilityConnectionArg(spec);
			for (const [name, schema] of Object.entries(properties(spec.parameters))) {
				const description = typeof schema.description === 'string' ? schema.description : '';
				const looksLikeOne = /connection/i.test(name) || /\b(saved )?connection\b.*\b(id|label)\b|\b(id|label)\b.*\bconnection\b/i.test(description);
				if (looksLikeOne && declared !== name) {
					missed.push(`${spec.name}.${name}`);
				}
			}
		}
		assert.deepEqual(missed, []);
	});

	test('the ones that read a database\'s users, schema or connection are covered', async () => {
		const byName = new Map((await staticSpecs()).map((spec) => [spec.name, spec]));
		for (const name of ['list_db_users', 'list_db_grants', 'list_db_policies', 'orbit_neighbourhood', 'orbit_focus', 'open_orbit', 'test_connection', 'get_connection', 'connect', 'open_table_designer']) {
			const spec = byName.get(name);
			assert.ok(spec, name);
			assert.ok(capabilityConnectionArg(spec), `${name} declares its connection argument`);
		}
	});
});

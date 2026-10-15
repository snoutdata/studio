/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { engineAiDisplayName, engineDisplayName, flavorFor, listFlavors } from './flavors';
import { dialectFor } from './index';

describe('flavors', () => {
	test('every flavor rides a driver that exists, and ids are unique', () => {
		const ids = new Set<string>();
		for (const flavor of listFlavors()) {
			assert.equal(dialectFor(flavor.baseDriver).driverId, flavor.baseDriver, flavor.id);
			assert.ok(!ids.has(flavor.id), flavor.id);
			ids.add(flavor.id);
		}
	});

	test('the flavor names the engine; without one the driver does', () => {
		assert.equal(engineDisplayName('postgres', 'cockroachdb'), 'CockroachDB');
		assert.match(engineAiDisplayName('postgres', 'cockroachdb'), /CockroachDB/);
		assert.equal(engineDisplayName('postgres'), dialectFor('postgres').displayName);
		assert.equal(engineAiDisplayName('mysql-aurora', undefined), dialectFor('mysql-aurora').aiDisplayName);
	});

	test('a flavor on the wrong driver, or an unknown one, is ignored', () => {
		assert.equal(flavorFor('mysql-aurora', 'cockroachdb'), undefined);
		assert.equal(flavorFor('postgres', 'nope'), undefined);
		assert.equal(engineDisplayName('mysql-aurora', 'cockroachdb'), dialectFor('mysql-aurora').displayName);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { newMoveSpec, validateMove, type MoveSpec } from './spec.js';
import { strategyFor } from './strategy.js';

function spec(overrides: Partial<MoveSpec> = {}): MoveSpec {
	return {
		...newMoveSpec({
			id: 'm1',
			name: 'move',
			source: { kind: 'connection', id: 'a', driver: 'postgres' },
			target: { kind: 'connection', id: 'b', driver: 'postgres' }
		}),
		...overrides
	};
}

test('a new move is a draft that replaces nothing and skips owners', () => {
	const fresh = spec();
	assert.equal(fresh.status, 'draft');
	assert.equal(fresh.targetMode, 'requireEmpty');
	assert.equal(fresh.ownership, 'skip');
	assert.equal(fresh.privileges, 'skip');
	assert.deepEqual(validateMove(fresh), []);
});

test('the same endpoint on both sides is invalid', () => {
	assert.match(validateMove(spec({ target: { kind: 'connection', id: 'a', driver: 'postgres' } })).join(), /same database/);
});

test('a cloud endpoint must be a project reference', () => {
	assert.match(
		validateMove(spec({ target: { kind: 'cloud', ref: 'not a ref', driver: 'postgres' } })).join(),
		/not a SnoutData Cloud project reference/
	);
});

test('replacing the target on a data-only move is invalid', () => {
	assert.match(validateMove(spec({ targetMode: 'replace', content: 'data' })).join(), /data-only move cannot/);
});

test('an empty schema list is not "every schema"', () => {
	assert.match(
		validateMove(spec({ selection: { schemas: [], excludeSchemas: [], excludeTables: [], excludeExtensions: [] } })).join(),
		/No schema/
	);
});

test('a new database name is held to Postgres\'s 63 bytes, and a new project to 1-60 characters', () => {
	const tooLong = 'n'.repeat(64);
	assert.match(
		validateMove(spec({ target: { kind: 'newDatabase', serverConnectionId: 'b', database: tooLong, driver: 'postgres' } })).join(),
		/longer than Postgres allows/
	);
	assert.deepEqual(validateMove(spec({ target: { kind: 'newDatabase', serverConnectionId: 'b', database: 'shop', driver: 'postgres' } })), []);
	assert.match(
		validateMove(spec({ target: { kind: 'newCloudProject', name: '', region: 'us-west-2', driver: 'postgres' } })).join(),
		/1 to 60 characters/
	);
});

test('Postgres to Postgres is native; everything else is refused in a sentence', () => {
	assert.deepEqual(strategyFor('postgres', 'postgres'), { kind: 'native-pg' });
	const redshift = strategyFor('redshift', 'redshift');
	assert.equal(redshift.kind, 'refused');
	assert.equal(strategyFor('mysql', 'postgres').kind, 'refused');
});

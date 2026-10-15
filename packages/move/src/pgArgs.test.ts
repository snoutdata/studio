/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { conninfoDatabase, nativePgArgs, quotePattern } from './pgArgs.js';
import { newMoveSpec, type MoveSpec } from './spec.js';

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

test('no credential, host, port or user is ever an argument', () => {
	const { dump, restore } = nativePgArgs(spec({ ownership: 'keep', targetMode: 'replace' }), { database: 'app' });
	for (const arg of [...dump, ...restore]) {
		assert.doesNotMatch(arg, /^(-h|-p|-U|-W|--host|--port|--username|--password)/, arg);
		assert.doesNotMatch(arg, /password=|host=|user=/, arg);
	}
	assert.ok(dump.includes('--no-password') && restore.includes('--no-password'));
});

test('the dump is a custom-format archive and the restore connects to the named database', () => {
	const { dump, restore } = nativePgArgs(spec(), { database: 'app' });
	assert.ok(dump.includes('--format=custom'));
	assert.ok(restore.includes("--dbname=dbname='app'"));
	assert.ok(restore.includes('--no-owner') && restore.includes('--no-privileges'));
	assert.ok(!restore.includes('--clean'));
	// A restore carries on past a failed object; the runner reports it.
	assert.ok(!restore.includes('--exit-on-error') && !restore.includes('--single-transaction'));
});

test('content narrows the dump', () => {
	assert.ok(nativePgArgs(spec({ content: 'schema' }), { database: 'app' }).dump.includes('--schema-only'));
	assert.ok(nativePgArgs(spec({ content: 'data' }), { database: 'app' }).dump.includes('--data-only'));
	assert.throws(() => nativePgArgs(spec({ content: 'data', targetMode: 'replace' }), { database: 'app' }));
});

test('names are quoted so case survives and wildcards match themselves', () => {
	assert.equal(quotePattern('Sales'), '"Sales"');
	assert.equal(quotePattern('we"ird'), '"we""ird"');
	const { dump } = nativePgArgs(
		spec({
			selection: {
				schemas: ['Sales'],
				excludeSchemas: [{ schema: 'auth', reason: 'x' }],
				excludeTables: [{ schema: 'Sales', table: 'big*log', reason: 'x' }],
				excludeExtensions: [{ extension: 'pg_graphql', reason: 'x' }]
			}
		}),
		{ database: 'app' }
	);
	assert.ok(dump.includes('--schema="Sales"'));
	assert.ok(dump.includes('--exclude-schema="auth"'));
	assert.ok(dump.includes('--exclude-table="Sales"."big*log"'));
	assert.ok(dump.includes('--exclude-extension="pg_graphql"'));
});

test('a database name is a conninfo value, so = and quotes cannot change what it connects to', () => {
	assert.equal(conninfoDatabase("it's"), "dbname='it\\'s'");
	assert.equal(conninfoDatabase('a=b host=evil'), "dbname='a=b host=evil'");
	assert.equal(conninfoDatabase('back\\slash'), "dbname='back\\\\slash'");
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { endpointFactsFromPg, newDatabaseFactsFromPg, newHostedProjectFacts, PG_FACTS_SQL, pgServerFactsSql, quoteLiteral } from './pgFacts.js';
import { HOSTED_POSTGRES_PLATFORM } from './platform.js';

const host = { identity: 'db.example:5432/app', readOnly: false, production: false, storage: null };

// The shape a fresh hosted project answered with, trimmed (measured 2026-09-13).
const freshHosted = {
	serverMajor: 17,
	superuser: false,
	sizeBytes: '8451763',
	schemas: [
		{ name: 'auth', bytes: 0 },
		{ name: 'public', bytes: 0 }
	],
	extensions: ['pg_graphql', 'pg_stat_statements', 'plpgsql', 'vector'],
	availableExtensions: ['lo', 'pg_graphql', 'vector'],
	extensionTables: [],
	objects: [
		{ schema: 'public', name: 'pgrst_ddl_watch', kind: 'function', arguments: '' },
		{ schema: 'auth', name: 'uid', kind: 'function', arguments: '' }
	]
};

test('a fresh hosted project is empty: the platform\'s own objects do not count', () => {
	const facts = endpointFactsFromPg(freshHosted, { ...host, platform: HOSTED_POSTGRES_PLATFORM });
	assert.equal(facts.empty, true);
	assert.equal(facts.serverMajor, 17);
	assert.equal(facts.sizeBytes, 8451763);
	assert.equal(facts.superuser, false);
	assert.deepEqual(facts.platformExtensions, ['pg_graphql', 'pg_prewarm', 'pg_stat_statements']);
	assert.ok(facts.platformObjects.some((object) => object.name === 'pgrst_ddl_watch'));
});

test('one user table makes it not empty, and the answer may arrive as text', () => {
	const answer = JSON.stringify({
		...freshHosted,
		objects: [...freshHosted.objects, { schema: 'public', name: 'orders', kind: 'table', arguments: null }]
	});
	assert.equal(endpointFactsFromPg(answer, { ...host, platform: HOSTED_POSTGRES_PLATFORM }).empty, false);
});

test('tables that use an extension\'s type come back with rows, and never-analyzed rows are unknown', () => {
	const facts = endpointFactsFromPg(
		{
			...freshHosted,
			extensionTables: [
				{ extension: 'vector', schema: 'public', table: 'orders', rows: 300000 },
				{ extension: 'vector', schema: 'public', table: 'fresh', rows: null }
			]
		},
		host
	);
	assert.deepEqual(
		facts.extensionTables.map((table) => [table.table, table.rows]),
		[
			['fresh', null],
			['orders', 300000]
		]
	);
});

test('a field that did not come back is unknown, not guessed', () => {
	const facts = endpointFactsFromPg({}, host);
	assert.equal(facts.serverMajor, null);
	assert.equal(facts.superuser, null);
	assert.equal(facts.availableExtensions, null);
	assert.deepEqual(facts.schemas, []);
	assert.deepEqual(facts.platformSchemas, []);
});

test('a new database is asked of its server, with the name as a literal that cannot break out', () => {
	assert.match(pgServerFactsSql("it's"), /datname = E'it''s'/);
	const facts = endpointFactsFromPg({}, host);
	assert.equal(facts.creation, null);

	const created = newDatabaseFactsFromPg({ serverMajor: 16, superuser: false, canCreate: true, nameTaken: false, availableExtensions: ['vector'] }, host);
	assert.deepEqual(created.creation, { canCreate: true, nameTaken: false });
	assert.equal(created.empty, true);
	assert.equal(created.serverMajor, 16);
	assert.deepEqual(created.availableExtensions, ['vector']);
});

test('a new hosted project is what every new project is: 18, empty, the measured platform', () => {
	const facts = newHostedProjectFacts();
	assert.equal(facts.serverMajor, 18);
	assert.equal(facts.empty, true);
	assert.equal(facts.superuser, false);
	assert.ok(facts.platformSchemas.includes('auth'));
	assert.deepEqual(facts.creation, { canCreate: null, nameTaken: false });
});

test('the query is one statement that answers one value', () => {
	assert.equal(PG_FACTS_SQL.trim().split(';').filter((part) => part.trim()).length, 1);
	assert.match(PG_FACTS_SQL, /as facts$/);
});

/**
 * Where a literal that starts at `text[0]` ends, read the way psql's lexer (and the server) reads
 * it: an `E'…'` string always takes `\` as an escape; a plain `'…'` does only when
 * standard_conforming_strings is off. Returns the offset one past the closing quote, or -1.
 */
function literalEnd(text: string, standardConformingStrings: boolean): number {
	let i = 0;
	let escapes = !standardConformingStrings;
	if (text[0] === 'E' || text[0] === 'e') {
		escapes = true;
		i = 1;
	}
	if (text[i] !== "'") {
		return -1;
	}
	for (i++; i < text.length; i++) {
		if (escapes && text[i] === '\\') {
			i++;
			continue;
		}
		if (text[i] === "'") {
			if (text[i + 1] === "'") {
				i++;
				continue;
			}
			return i + 1;
		}
	}
	return -1;
}

test('a literal holds the whole name whatever standard_conforming_strings is', () => {
	const hostile = ["\\' \\! touch /tmp/pwned\n", 'a\\', "\\\\'';", "it's", 'plain', '\\x27'];
	for (const name of hostile) {
		const literal = quoteLiteral(name);
		for (const scs of [true, false]) {
			assert.equal(literalEnd(`${literal} \\! after`, scs), literal.length, `${JSON.stringify(name)} with standard_conforming_strings ${scs ? 'on' : 'off'}`);
		}
	}
	assert.equal(quoteLiteral("\\'"), "E'\\\\'''");
	// The old plain form, for contrast: under `off` the name's `\'` closes nothing and `\!` escapes.
	const plain = `'${"\\' \\! x".replace(/'/g, "''")}'`;
	assert.notEqual(literalEnd(`${plain} tail`, false), plain.length);
});

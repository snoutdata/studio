/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { REDACTED_SECRET, redactSecrets } from './redact.js';

const R = REDACTED_SECRET;

test('a subscription connection string loses its password, quoted or bare', () => {
	assert.equal(
		redactSecrets("CREATE SUBSCRIPTION s CONNECTION 'host=db.example port=5432 password=hunter2 dbname=app' PUBLICATION p WITH (connect = false, slot_name = 's');"),
		`CREATE SUBSCRIPTION s CONNECTION 'host=db.example port=5432 password=${R} dbname=app' PUBLICATION p WITH (connect = false, slot_name = 's');`
	);
	assert.equal(
		redactSecrets("CONNECTION 'host=a password=''two words'' dbname=b'"),
		`CONNECTION 'host=a password=${R} dbname=b'`
	);
	assert.equal(redactSecrets("CONNECTION 'host=a password=ends'"), `CONNECTION 'host=a password=${R}'`);
	assert.equal(redactSecrets("CONNECTION 'password=it''s dbname=b'"), `CONNECTION 'password=${R} dbname=b'`);
});

test('a user mapping loses its password option, and only that', () => {
	assert.equal(
		redactSecrets("CREATE USER MAPPING FOR app SERVER remote OPTIONS (\n    \"user\" 'app',\n    password 'it''s secret'\n);"),
		`CREATE USER MAPPING FOR app SERVER remote OPTIONS (\n    "user" 'app',\n    password ${R}\n);`
	);
	assert.equal(redactSecrets("ALTER USER MAPPING FOR app SERVER s OPTIONS (SET password 'x', ADD sslpassword 'y')"), `ALTER USER MAPPING FOR app SERVER s OPTIONS (SET password ${R}, ADD sslpassword ${R})`);
	assert.equal(redactSecrets("OPTIONS (password_required 'false')"), "OPTIONS (password_required 'false')");
});

test('a role password and its stored verifier are redacted', () => {
	assert.equal(redactSecrets("ALTER ROLE app WITH LOGIN PASSWORD 'hunter2';"), `ALTER ROLE app WITH LOGIN PASSWORD ${R};`);
	assert.equal(redactSecrets("ALTER ROLE app ENCRYPTED PASSWORD 'SCRAM-SHA-256$4096:abc$def:ghi';"), `ALTER ROLE app ENCRYPTED PASSWORD ${R};`);
});

test('a URI keeps its user and host, not its password', () => {
	assert.equal(redactSecrets("dblink_connect('postgresql://app:hunter2@db.example/app')"), `dblink_connect('postgresql://app:${R}@db.example/app')`);
});

test('text with no secret is returned unchanged', () => {
	const sql = 'CREATE TABLE public.orders (id integer NOT NULL, password_hash text);';
	assert.equal(redactSecrets(sql), sql);
	const message = 'could not execute query: ERROR:  password authentication failed for user "app"';
	assert.equal(redactSecrets(message), message);
});

test('redacting twice changes nothing more', () => {
	const once = redactSecrets("CONNECTION 'host=a password=x' PASSWORD = 'y'");
	assert.equal(redactSecrets(once), once);
});

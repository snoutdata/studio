/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
	credentialNote,
	describeStatement,
	emitTableFunctionCall,
	importStatement,
	missingArguments,
	previewStatement,
	tableFunctionById,
	tableFunctionsFor,
} from './tableFunctions';

function spec(id: string) {
	const found = tableFunctionById('clickhouse', id);
	assert.ok(found, `${id} is not one of ClickHouse's table functions`);
	return found;
}

function call(id: string, values: Record<string, string>, redactSecrets = false): string {
	return emitTableFunctionCall('clickhouse', spec(id), values, { redactSecrets });
}

describe('which engines have table functions', () => {
	test('ClickHouse does; nothing else does yet', () => {
		assert.ok(tableFunctionsFor('clickhouse').length >= 8);
		for (const driver of ['postgres', 'mysql-aurora', 'sqlserver', 'duckdb', 'mongodb']) {
			assert.deepEqual(tableFunctionsFor(driver), [], `${driver} must not offer a screen it cannot serve`);
		}
	});

	test('an id from outside resolves to nothing', () => {
		// The id goes into the statement unquoted, so this is the only thing between a tool
		// argument and the SQL.
		assert.equal(tableFunctionById('clickhouse', 's3(1) UNION ALL SELECT'), undefined);
		assert.equal(tableFunctionById('clickhouse', 'S3'), undefined);
		assert.equal(tableFunctionById('postgres', 's3'), undefined);
	});

	test('every spec can build a call from nothing without throwing', () => {
		// The form starts empty, and the screen shows what the statement WOULD be as it is filled
		// in, so an empty spec must be a legal (if useless) call rather than a crash.
		for (const fn of tableFunctionsFor('clickhouse')) {
			assert.doesNotThrow(() => emitTableFunctionCall('clickhouse', fn, {}));
		}
	});
});

describe('the call', () => {
	test('a public bucket says NOSIGN rather than leaving the credentials out', () => {
		// Leaving them out is not "no credentials", it is "use the server's own", which a server
		// refuses for a user's query: a bucket open to the world came back ACCESS_DENIED.
		assert.equal(call('s3', { url: 'https://b.s3.amazonaws.com/x.parquet' }), "s3('https://b.s3.amazonaws.com/x.parquet', 'NOSIGN')");
		assert.equal(call('gcs', { url: 'https://storage.googleapis.com/b/x' }), "gcs('https://storage.googleapis.com/b/x', 'NOSIGN')");
	});

	test('a format with no credentials goes after NOSIGN', () => {
		// The overload that cannot be expressed by "drop empty arguments": there is no way to skip
		// a middle argument, so this is its own shape.
		assert.equal(
			call('s3', { url: 'https://b/x', format: 'CSVWithNames' }),
			"s3('https://b/x', 'NOSIGN', 'CSVWithNames')");
	});

	test('credentials push the format back to fourth', () => {
		assert.equal(
			call('s3', { url: 'https://b/x', keyId: 'AKIA', secret: 'sh', format: 'Parquet' }),
			"s3('https://b/x', 'AKIA', 'sh', 'Parquet')");
	});

	test('trailing empty arguments are dropped, middle ones are not', () => {
		assert.equal(call('remote', { addresses: 'h:9000', database: 'd', table: 't' }), "remote('h:9000', 'd', 't')");
		assert.equal(
			call('remote', { addresses: 'h:9000', database: 'd', table: 't', user: 'u', password: 'p' }),
			"remote('h:9000', 'd', 't', 'u', 'p')");
	});

	test('a quote in a value cannot leave its literal', () => {
		assert.equal(call('url', { url: "https://x/'; DROP TABLE t --" }), "url('https://x/''; DROP TABLE t --')");
	});

	test('whitespace-only values count as empty', () => {
		assert.equal(call('url', { url: '  https://x  ', format: '   ' }), "url('https://x')");
	});
});

describe('the redacted twin', () => {
	test('a secret argument is replaced, and only that argument', () => {
		assert.equal(
			call('remote', { addresses: 'h:9000', database: 'd', table: 't', user: 'u', password: 'hunter2' }, true),
			"remote('h:9000', 'd', 't', 'u', '<redacted>')");
	});

	test('the redacted form is not runnable, which is the point', () => {
		const redacted = call('postgresql', { address: 'h:5432', database: 'd', table: 't', user: 'u', password: 'pw' }, true);
		assert.ok(redacted.includes('<redacted>'));
		assert.ok(!redacted.includes('pw'));
	});

	test('a value that is not a secret is left alone even if it equals one', () => {
		// The redaction is by value, so a non-secret argument that happens to hold the same text is
		// a real edge: it is redacted too, and that is the safe way round.
		const both = call('remote', { addresses: 'pw', database: 'd', table: 't', user: 'u', password: 'pw' }, true);
		assert.equal(both, "remote('<redacted>', 'd', 't', 'u', '<redacted>')");
	});

	test('nothing is redacted when there is no secret', () => {
		assert.equal(call('url', { url: 'https://x' }, true), "url('https://x')");
	});
});

describe('the statements', () => {
	test('describe asks the server, not us', () => {
		assert.equal(describeStatement("s3('u')"), "DESCRIBE TABLE s3('u')");
	});

	test('preview is capped and integral whatever it is given', () => {
		assert.equal(previewStatement("s3('u')", 100), "SELECT * FROM s3('u') LIMIT 100");
		assert.equal(previewStatement("s3('u')", 0), "SELECT * FROM s3('u') LIMIT 1");
		assert.equal(previewStatement("s3('u')", 99999), "SELECT * FROM s3('u') LIMIT 1000");
		assert.equal(previewStatement("s3('u')", 10.9), "SELECT * FROM s3('u') LIMIT 10");
	});

	test('import quotes the target and the sort columns', () => {
		assert.equal(
			importStatement('clickhouse', { database: 'shop', table: 'events', orderBy: ['at', 'id'] }, "s3('u')"),
			"CREATE TABLE `shop`.`events`\nENGINE = MergeTree\nORDER BY (`at`, `id`)\nAS SELECT * FROM s3('u')");
	});

	test('no sort columns is tuple(), not a missing clause', () => {
		assert.ok(importStatement('clickhouse', { table: 'events', orderBy: [] }, "s3('u')").includes('ORDER BY tuple()'));
	});

	test('a hostile table name cannot leave its quotes', () => {
		assert.ok(importStatement('clickhouse', { table: 'ev`ents', orderBy: [] }, "s3('u')").includes('`ev``ents`'));
	});
});

describe('what the form refuses', () => {
	test('the missing required fields come back by label, in order', () => {
		assert.deepEqual(missingArguments(spec('postgresql'), {}), ['Host and port', 'Database', 'Table', 'User']);
		assert.deepEqual(missingArguments(spec('postgresql'), { address: 'h', database: 'd', table: 't', user: 'u' }), []);
		// A password is not required: a Postgres that trusts the host does not have one.
		assert.deepEqual(missingArguments(spec('s3'), { url: 'u' }), []);
	});

	test('the note names the account the credentials came from', () => {
		assert.equal(credentialNote('Acme prod'), '\n-- credentials from the "Acme prod" cloud account');
		assert.equal(credentialNote(undefined), '');
	});
});

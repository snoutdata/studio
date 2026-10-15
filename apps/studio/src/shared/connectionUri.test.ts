/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { injectUriPassword, liftUriPassword, maskUriPasswords, splitUriPassword, uriHasUserinfo } from './connectionUri';

describe('a connection string never keeps its password', () => {
	test('a Mongo URI gives up its password and keeps its user name, hosts, database and options', () => {
		assert.deepEqual(splitUriPassword('mongodb://app:s3cret@db1:27017,db2:27017/shop?replicaSet=rs0&authSource=admin'), {
			host: 'mongodb://app@db1:27017,db2:27017/shop?replicaSet=rs0&authSource=admin',
			password: 's3cret',
		});
		assert.deepEqual(splitUriPassword('mongodb+srv://app:p%40ss%3Aw%2Frd@cluster0.example.net/shop'), {
			host: 'mongodb+srv://app@cluster0.example.net/shop',
			password: 'p@ss:w/rd',
		});
	});

	test('a URI with no password, or not a URI at all, is left as it is', () => {
		for (const host of ['mongodb://app@db:27017/shop', 'mongodb://db:27017/shop', 'db.example', '/var/data/app.sqlite', 'C:\\data\\app.duckdb']) {
			assert.deepEqual(splitUriPassword(host), { host });
		}
		assert.deepEqual(splitUriPassword('mongodb://app:@db/shop'), { host: 'mongodb://app@db/shop' });
	});

	test('a URL with a password pasted into another driver\'s Host field gives it up too', () => {
		assert.deepEqual(splitUriPassword('clickhouse://alex:hunter2@db.example:9000/app'), { host: 'clickhouse://alex@db.example:9000/app', password: 'hunter2' });
		assert.deepEqual(splitUriPassword('https://default:pw@ch.example:8443'), { host: 'https://default@ch.example:8443', password: 'pw' });
		assert.deepEqual(splitUriPassword('https://ch.example/path?u=a@b'), { host: 'https://ch.example/path?u=a@b' });
	});

	test('the password is put back where the driver connects, encoded', () => {
		assert.equal(injectUriPassword('mongodb://app@db:27017/shop?authSource=admin', 'p@ss:w/rd'), 'mongodb://app:p%40ss%3Aw%2Frd@db:27017/shop?authSource=admin');
		assert.equal(injectUriPassword('mongodb+srv://app@cluster0.example.net/', 'x'), 'mongodb+srv://app:x@cluster0.example.net/');
		// Round trip.
		const split = splitUriPassword('mongodb://app:p%40ss@db/shop');
		assert.equal(injectUriPassword(split.host, split.password), 'mongodb://app:p%40ss@db/shop');
	});

	test('nothing is put back without a user name, a password, or when the URI has one', () => {
		assert.equal(injectUriPassword('mongodb://db/shop', 'x'), 'mongodb://db/shop');
		assert.equal(injectUriPassword('mongodb://app@db/shop', undefined), 'mongodb://app@db/shop');
		assert.equal(injectUriPassword('mongodb://app:old@db/shop', 'x'), 'mongodb://app:old@db/shop');
		assert.equal(injectUriPassword('mongodb://CN=me@db/?authMechanism=MONGODB-X509', 'x'), 'mongodb://CN=me@db/?authMechanism=MONGODB-X509');
		assert.equal(injectUriPassword('clickhouse://alex@db/app', 'x'), 'clickhouse://alex@db/app');
	});

	test('user info is seen with or without a password', () => {
		assert.equal(uriHasUserinfo('mongodb://app@db'), true);
		assert.equal(uriHasUserinfo('mongodb://app:x@db'), true);
		assert.equal(uriHasUserinfo('mongodb://db:27017'), false);
		assert.equal(uriHasUserinfo('db.example'), false);
	});

	test('what a model or the audit log reads has every URI password masked', () => {
		assert.equal(maskUriPasswords('connect mongodb://app:s3cret@db/shop now'), 'connect mongodb://app:****@db/shop now');
		assert.equal(maskUriPasswords('{"host":"sqlserver://a:b@h/d","x":"https://u:p%40q@h"}'), '{"host":"sqlserver://a:****@h/d","x":"https://u:****@h"}');
		assert.equal(maskUriPasswords('mongodb://app@db/shop and db:5432'), 'mongodb://app@db/shop and db:5432');
	});

	test('a save or test takes the URI\'s password as the one typed, over the Password field', () => {
		assert.deepEqual(liftUriPassword({ driver: 'mongodb', host: 'mongodb://app:fromuri@db/shop', password: 'typed' }), { driver: 'mongodb', host: 'mongodb://app@db/shop', password: 'fromuri' });
		const plain = { driver: 'mongodb', host: 'mongodb://app@db/shop', password: 'typed' };
		assert.equal(liftUriPassword(plain), plain);
		const postgres = { driver: 'postgres', host: 'db.example' };
		assert.equal(liftUriPassword(postgres), postgres);
	});
});

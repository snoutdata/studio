/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId, UUID } from 'mongodb';

import type { PeerCertificate } from 'node:tls';

import { buildConnection, referencedCollections, reviveObjectIds, reviveWriteValue, tunnelTlsOptions } from './mongoDriver';

const HEX = '650a1b2c3d4e5f6071829304';
const UUID_STR = '2b1c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b';

test('revives a direct _id equality string to ObjectId', () => {
	const out = reviveObjectIds([{ $match: { _id: HEX } }]) as { $match: { _id: unknown } }[];
	const id = out[0].$match._id;
	assert.ok(id instanceof ObjectId);
	assert.equal((id as ObjectId).toHexString(), HEX);
});

test('revives _id inside $in and $ne operators', () => {
	const out = reviveObjectIds([{ $match: { _id: { $in: [HEX, HEX] } } }]) as { $match: { _id: { $in: unknown[] } } }[];
	assert.ok(out[0].$match._id.$in.every((v) => v instanceof ObjectId));

	const ne = reviveObjectIds({ _id: { $ne: HEX } }) as { _id: { $ne: unknown } };
	assert.ok(ne._id.$ne instanceof ObjectId);
});

test('revives _id nested under $and/$or', () => {
	const out = reviveObjectIds({ $and: [{ _id: HEX }, { name: 'x' }] }) as { $and: { _id?: unknown; name?: unknown }[] };
	assert.ok(out.$and[0]._id instanceof ObjectId);
	assert.equal(out.$and[1].name, 'x');
});

test('leaves non-_id fields and non-hex _id strings alone', () => {
	const out = reviveObjectIds({ _id: 'not-an-objectid', userId: HEX, name: HEX }) as Record<string, unknown>;
	assert.equal(out._id, 'not-an-objectid');
	// `userId`/`name` are not `_id`, so a hex-looking value stays a plain string.
	assert.equal(out.userId, HEX);
	assert.equal(out.name, HEX);
});

test('revives a direct _id equality UUID string to match string OR BSON UUID', () => {
	const out = reviveObjectIds([{ $match: { _id: UUID_STR } }]) as { $match: { _id: { $in: unknown[] } } }[];
	const inList = out[0].$match._id.$in;
	// Storage form is unknowable from SQL, so match both the plain string and the BSON UUID binary.
	assert.equal(inList[0], UUID_STR);
	assert.ok(inList[1] instanceof UUID);
	assert.equal((inList[1] as UUID).toString(), UUID_STR);
});

test('revives _id UUID strings inside $in and $ne operators to BSON UUID', () => {
	const out = reviveObjectIds({ _id: { $in: [UUID_STR] } }) as { _id: { $in: unknown[] } };
	assert.ok(out._id.$in[0] instanceof UUID);

	const ne = reviveObjectIds({ _id: { $ne: UUID_STR } }) as { _id: { $ne: unknown } };
	assert.ok(ne._id.$ne instanceof UUID);
});

test('read path also honors an explicit { $oid } wrapper', () => {
	const out = reviveObjectIds({ _id: { $oid: HEX } }) as { _id: unknown };
	assert.ok(out._id instanceof ObjectId);
	assert.equal((out._id as ObjectId).toHexString(), HEX);
});

// Write path (reviveWriteValue): no schema-free guessing — a bare 24-hex string `_id` is a STRING
// (the grid sends an explicit { $oid } when it knows the column is an ObjectId). This is the fix
// for the silent no-op write against string-_id collections.
test('write path: a bare 24-hex _id stays a string (no heuristic ObjectId coercion)', () => {
	const out = reviveWriteValue({ _id: HEX }) as { _id: unknown };
	// Stays the exact string (an ObjectId would not be === the hex string).
	assert.equal(out._id, HEX);
});

test('write path: an explicit { $oid } _id revives to ObjectId', () => {
	const out = reviveWriteValue({ _id: { $oid: HEX } }) as { _id: unknown };
	assert.ok(out._id instanceof ObjectId);
	assert.equal((out._id as ObjectId).toHexString(), HEX);
});

test('write path: a { $date } wrapper revives to a Date', () => {
	const iso = '2026-06-20T12:00:00.000Z';
	const out = reviveWriteValue({ $set: { created: { $date: iso } } }) as { $set: { created: unknown } };
	assert.ok(out.$set.created instanceof Date);
	assert.equal((out.$set.created as Date).toISOString(), iso);
});

// Extended-JSON write typing: an { $oid }/{ $uuid } wrapper revives on ANY
// field, not just `_id` — the grid/tree emit it only when introspection says the field is that type.
test('write path: an { $oid } under a non-_id field revives to ObjectId', () => {
	const out = reviveWriteValue({ $set: { authorId: { $oid: HEX } } }) as { $set: { authorId: unknown } };
	assert.ok(out.$set.authorId instanceof ObjectId);
	assert.equal((out.$set.authorId as ObjectId).toHexString(), HEX);
});

test('write path: an { $uuid } wrapper revives to a BSON UUID', () => {
	const out = reviveWriteValue({ $set: { token: { $uuid: UUID_STR } } }) as { $set: { token: unknown } };
	assert.ok(out.$set.token instanceof UUID);
	assert.equal((out.$set.token as UUID).toString(), UUID_STR);
});

// referencedCollections — every collection a pipeline reads (root + joins) for the EXPLAIN guard ---

test('referencedCollections returns just the root for a plain pipeline', () => {
	assert.deepEqual(referencedCollections('users', [{ $match: { a: 1 } }, { $limit: 10 }]), ['users']);
});

test('referencedCollections collects $lookup/$graphLookup.from and $unionWith targets', () => {
	const pipeline = [
		{ $lookup: { from: 'orders', localField: '_id', foreignField: 'userId', as: 'o' } },
		{ $graphLookup: { from: 'managers', startWith: '$mgr', connectFromField: 'mgr', connectToField: '_id', as: 'chain' } },
		{ $unionWith: 'archived' },
		{ $unionWith: { coll: 'legacy', pipeline: [{ $match: { x: 1 } }] } },
	];
	assert.deepEqual(referencedCollections('users', pipeline), ['users', 'orders', 'managers', 'archived', 'legacy']);
});

test('referencedCollections recurses sub-pipelines and $facet, de-duplicating', () => {
	const pipeline = [
		{ $lookup: { from: 'orders', pipeline: [{ $unionWith: 'audit' }], as: 'o' } },
		{ $facet: { a: [{ $lookup: { from: 'orders', as: 'x' } }], b: [{ $unionWith: { coll: 'audit' } }] } },
	];
	// `orders` and `audit` appear multiple times but are reported once each, in encounter order.
	assert.deepEqual(referencedCollections('users', pipeline), ['users', 'orders', 'audit']);
});

test('through an SSH tunnel, the certificate is checked against the configured host, not 127.0.0.1', () => {
	const cert = { subject: { CN: 'cluster.docdb.amazonaws.com' }, subjectaltname: 'DNS:cluster.docdb.amazonaws.com' } as unknown as PeerCertificate;
	const uri = 'mongodb://cluster.docdb.amazonaws.com:27017/?tls=true';
	const options = tunnelTlsOptions(uri, false, 'cluster.docdb.amazonaws.com');
	assert.equal(options.servername, 'cluster.docdb.amazonaws.com');
	assert.equal(options.checkServerIdentity?.('127.0.0.1', cert), undefined, 'the right certificate passes');
	// A certificate for another host fails, even though the socket went to 127.0.0.1.
	const other = { subject: { CN: 'evil.example' }, subjectaltname: 'DNS:evil.example' } as unknown as PeerCertificate;
	assert.ok(options.checkServerIdentity?.('127.0.0.1', other) instanceof Error);
	assert.equal('tlsAllowInvalidHostnames' in options, false);
});

test('the hostname check is skipped only on the connection string\'s own opt-in, or with no TLS', () => {
	assert.deepEqual(tunnelTlsOptions('mongodb://h:27017/?tls=true&tlsAllowInvalidHostnames=true', false, 'h'), {});
	assert.deepEqual(tunnelTlsOptions('mongodb://h:27017/?tlsInsecure=true', true, 'h'), {});
	assert.deepEqual(tunnelTlsOptions('mongodb://h:27017/', false, 'h'), {});
	// TLS from the form (no URI flag) is checked too; an IP address gets no SNI name.
	const byIp = tunnelTlsOptions('mongodb://10.0.0.5:27017/', true, '10.0.0.5');
	assert.equal(byIp.servername, undefined);
	assert.equal(typeof byIp.checkServerIdentity, 'function');
});

test('a saved connection string connects with the password the keychain holds for it', () => {
	const base = { id: 'm1', label: 'Docs', driver: 'mongodb', port: 0, username: '' };
	// main saved the URI without its password and handed the password back resolved.
	const saved = buildConnection({ ...base, host: 'mongodb://app@db.example:27017/shop?authSource=admin', password: 'p@ss:w/rd' });
	assert.equal(saved.uri, 'mongodb://app:p%40ss%3Aw%2Frd@db.example:27017/shop?authSource=admin');
	assert.equal(saved.options.auth, undefined);
	// A URI with no user name takes the form's user name and password as options, as before.
	const fields = buildConnection({ ...base, host: 'mongodb://db.example:27017/', username: 'app', password: 'pw' });
	assert.equal(fields.uri, 'mongodb://db.example:27017/');
	assert.deepEqual(fields.options.auth, { username: 'app', password: 'pw' });
	// One saved before the password was lifted out still carries its own, and keeps it.
	const legacy = buildConnection({ ...base, host: 'mongodb://app:own@db.example/shop', password: 'other' });
	assert.equal(legacy.uri, 'mongodb://app:own@db.example/shop');
});

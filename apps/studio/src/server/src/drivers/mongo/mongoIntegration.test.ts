/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';

import { type NativeQuery } from '../../../../shared/engine';

// End-to-end MongoDB test against a real server, gated on a Mongo-specific
// env var so the normal `npm test` (no DB) skips it. Spawns the built server (out/server/server.js)
// and drives the same `snout/executeQuery` requests the app uses. Run with, e.g.:
//   SNOUTDATA_IT_MONGO_URI=mongodb://127.0.0.1:27017 SNOUTDATA_IT_MONGO_DB=test npm test
// Focus: the write round-trip (insert/update/delete via mongo-write) and `_id` targeting — the
// explicit `{ $oid }` wrapper revives to an ObjectId, while a genuine STRING `_id` is left alone
// (the fix for the silent no-op write against string-_id collections), plus `$date` revival.
const uri = process.env.SNOUTDATA_IT_MONGO_URI;
const enabled = Boolean(uri);
const skip = enabled ? false : 'set SNOUTDATA_IT_MONGO_URI to run the MongoDB integration test';
const COLL = 'snout_it_polyglot';

const config = {
	id: 'mongo-integration',
	label: 'mongo-integration',
	driver: 'mongodb',
	host: uri,
	database: process.env.SNOUTDATA_IT_MONGO_DB ?? 'test',
};

let child: ChildProcessWithoutNullStreams | undefined;
let conn: MessageConnection | undefined;

/** Run a NativeQuery through the server and return its result envelope. */
async function run(query: NativeQuery): Promise<{ ok: boolean; error?: string; result: { rowCount: number; rows: unknown[][]; fields: { name: string }[] } }> {
	return conn!.sendRequest('snout/executeQuery', { connectionId: config.id, query }) as Promise<{ ok: boolean; error?: string; result: { rowCount: number; rows: unknown[][]; fields: { name: string }[] } }>;
}

/** The value of a named field from the first row of a mongo read. */
function field(res: { result: { rows: unknown[][]; fields: { name: string }[] } }, name: string): unknown {
	const idx = res.result.fields.findIndex((f) => f.name === name);
	return res.result.rows[0]?.[idx];
}

before(async () => {
	if (!enabled) {
		return;
	}
	child = spawn(process.execPath, ['out/server/server.js', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
	conn = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
	conn.listen();
	await conn.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
	conn.sendNotification('initialized', {});
	await conn.sendRequest('snout/connect', { config });
	// Start from a clean slate (ignore "collection doesn't exist").
	await run({ lang: 'mongo-ddl', ops: [{ op: 'dropCollection', collection: COLL }] }).catch(() => undefined);
});

after(async () => {
	if (conn) {
		await run({ lang: 'mongo-ddl', ops: [{ op: 'dropCollection', collection: COLL }] }).catch(() => undefined);
		await conn.sendRequest('snout/disconnect', config.id).catch(() => undefined);
		conn.dispose();
	}
	child?.kill();
});

describe('mongodb write round-trip (env-gated)', () => {
	test('ObjectId _id: insert, $oid-keyed update + delete, $date revival', { skip }, async () => {
		// Insert — Mongo generates an ObjectId _id.
		const ins = await run({ lang: 'mongo-write', writes: [{ op: 'insertOne', collection: COLL, document: { name: 'alpha', n: 1 } }] });
		assert.equal(ins.ok, true);
		assert.equal(ins.result.rowCount, 1);

		// Read it back and capture the generated _id (arrives as a hex string over the wire).
		const read = await run({ lang: 'mongo', collection: COLL, pipeline: [{ $match: { name: 'alpha' } }] });
		assert.equal(read.ok, true);
		const id = field(read, '_id') as string;
		assert.match(id, /^[0-9a-f]{24}$/i);

		// Update keyed by the explicit { $oid } wrapper → revives to the real ObjectId → matches 1.
		const upd = await run({ lang: 'mongo-write', writes: [{ op: 'updateOne', collection: COLL, filter: { _id: { $oid: id } }, update: { $set: { n: 2 } } }] });
		assert.equal(upd.result.rowCount, 1, 'an $oid-wrapped _id should match the ObjectId document');

		// Negative control: a BARE hex string is no longer coerced, so it does NOT match an ObjectId.
		const bare = await run({ lang: 'mongo-write', writes: [{ op: 'updateOne', collection: COLL, filter: { _id: id }, update: { $set: { n: 3 } } }] });
		assert.equal(bare.result.rowCount, 0, 'a bare string _id must not heuristically match an ObjectId');

		// $date round-trip: set a date wrapper, read it back as an ISO string.
		const iso = '2026-06-20T12:00:00.000Z';
		await run({ lang: 'mongo-write', writes: [{ op: 'updateOne', collection: COLL, filter: { _id: { $oid: id } }, update: { $set: { seen: { $date: iso } } } }] });
		const after = await run({ lang: 'mongo', collection: COLL, pipeline: [{ $match: { _id: { $oid: id } } }] });
		assert.equal(field(after, 'n'), 2);
		assert.equal(field(after, 'seen'), iso);

		// Delete keyed by $oid → gone.
		const del = await run({ lang: 'mongo-write', writes: [{ op: 'deleteOne', collection: COLL, filter: { _id: { $oid: id } } }] });
		assert.equal(del.result.rowCount, 1);
		const gone = await run({ lang: 'mongo', collection: COLL, pipeline: [{ $match: { name: 'alpha' } }] });
		assert.equal(gone.result.rowCount, 0);
	});

	test('string _id: a 24-hex STRING id is targeted by a bare string, not by $oid', { skip }, async () => {
		const sid = 'abcdefabcdefabcdefabcdef'; // 24 hex chars, but stored as a real string _id
		const ins = await run({ lang: 'mongo-write', writes: [{ op: 'insertOne', collection: COLL, document: { _id: sid, name: 'beta' } }] });
		assert.equal(ins.ok, true);

		// Bare string matches the string _id (1)...
		const hit = await run({ lang: 'mongo-write', writes: [{ op: 'updateOne', collection: COLL, filter: { _id: sid }, update: { $set: { ok: true } } }] });
		assert.equal(hit.result.rowCount, 1, 'a string _id must be matched by a bare string');

		// ...while the $oid wrapper (an ObjectId) matches nothing (0).
		const miss = await run({ lang: 'mongo-write', writes: [{ op: 'updateOne', collection: COLL, filter: { _id: { $oid: sid } }, update: { $set: { ok: false } } }] });
		assert.equal(miss.result.rowCount, 0, 'an ObjectId must not match a string _id');

		await run({ lang: 'mongo-write', writes: [{ op: 'deleteOne', collection: COLL, filter: { _id: sid } }] });
	});
});

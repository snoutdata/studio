/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMdnsQuery, parseMdnsResponse, servicesFromRecords } from './mdns';

test('the query asks PTR/IN for each name', () => {
	const q = buildMdnsQuery(['_postgresql._tcp.local']);
	assert.equal(q.readUInt16BE(4), 1, 'one question');
	assert.equal(q.subarray(12, 12 + 12).toString('latin1'), '\x0b_postgresql');
	assert.deepEqual([...q.subarray(q.length - 4)], [0, 12, 0, 1]);
});

/** A response a responder would send: PTR, SRV and A, with name compression. */
function response(): Buffer {
	const parts: Buffer[] = [];
	const header = Buffer.alloc(12);
	header.writeUInt16BE(0x8400, 2);
	header.writeUInt16BE(1, 6); // one answer
	header.writeUInt16BE(2, 10); // two additional
	parts.push(header);
	const name = (s: string): Buffer => Buffer.concat([...s.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
	const rr = (owner: Buffer, type: number, rdata: Buffer): Buffer => {
		const fixed = Buffer.alloc(10);
		fixed.writeUInt16BE(type, 0);
		fixed.writeUInt16BE(1, 2);
		fixed.writeUInt32BE(120, 4);
		fixed.writeUInt16BE(rdata.length, 8);
		return Buffer.concat([owner, fixed, rdata]);
	};
	const service = name('_postgresql._tcp.local');
	parts.push(rr(service, 12, Buffer.concat([Buffer.from([10]), Buffer.from('Office PG1'), Buffer.from([0xc0, 12])])));
	const instanceOffset = 12 + service.length + 10;
	const srvData = Buffer.alloc(6);
	srvData.writeUInt16BE(5433, 4);
	parts.push(rr(Buffer.from([0xc0, instanceOffset]), 33, Buffer.concat([srvData, name('pgbox.local')])));
	parts.push(rr(name('pgbox.local'), 1, Buffer.from([192, 168, 1, 40])));
	return Buffer.concat(parts);
}

test('a response is read through compressed names and assembled PTR → SRV → A', () => {
	const records = parseMdnsResponse(response());
	assert.deepEqual(records.map((r) => r.type), [12, 33, 1]);
	assert.equal(records[0].instance, 'Office PG1');
	assert.deepEqual(servicesFromRecords(records), [{ driver: 'postgres', instance: 'Office PG1', host: '192.168.1.40', port: 5433 }]);
});

test('a truncated or garbage packet yields what it can, never a throw', () => {
	assert.deepEqual(parseMdnsResponse(Buffer.from([1, 2, 3])), []);
	const cut = response().subarray(0, 40);
	assert.doesNotThrow(() => parseMdnsResponse(cut));
	const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 12])]);
	loop.writeUInt16BE(1, 6);
	assert.deepEqual(parseMdnsResponse(loop), []);
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// mDNS / DNS-SD, just enough to ask the local network "who offers _postgresql._tcp and _mysql._tcp"
// and read the answers (RFC 6762, RFC 6763). Pure: packets in and out as Buffers. The socket part is
// in `network.ts`. A query sent from an ordinary port is a "legacy unicast" query, which responders
// answer straight back to that port, so nothing has to bind 5353.

export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;

/** The service types asked for, and the driver each is. */
export const MDNS_SERVICES: Record<string, string> = {
	'_postgresql._tcp.local': 'postgres',
	'_mysql._tcp.local': 'mysql-aurora',
};

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

function encodeName(name: string): Buffer {
	const parts = name.split('.').filter(Boolean).map((label) => {
		const b = Buffer.from(label, 'utf8');
		return Buffer.concat([Buffer.from([b.length]), b]);
	});
	return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A PTR query for each name, in one packet. */
export function buildMdnsQuery(names: string[]): Buffer {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(names.length, 4);
	const questions = names.map((n) => {
		const tail = Buffer.alloc(4);
		tail.writeUInt16BE(TYPE_PTR, 0);
		tail.writeUInt16BE(1, 2);
		return Buffer.concat([encodeName(n), tail]);
	});
	return Buffer.concat([header, ...questions]);
}

/** Read a (possibly compressed) name at `offset`. Returns its labels and where the name ended. */
function readName(buf: Buffer, offset: number): { labels: string[]; next: number } {
	const labels: string[] = [];
	let pos = offset;
	let next = -1;
	for (let hops = 0; hops < 64; hops++) {
		if (pos >= buf.length) {
			throw new Error('name runs past the packet');
		}
		const len = buf[pos];
		if (len === 0) {
			return { labels, next: next === -1 ? pos + 1 : next };
		}
		if ((len & 0xc0) === 0xc0) {
			if (pos + 1 >= buf.length) {
				throw new Error('bad pointer');
			}
			if (next === -1) {
				next = pos + 2;
			}
			pos = ((len & 0x3f) << 8) | buf[pos + 1];
			continue;
		}
		labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
		pos += 1 + len;
	}
	throw new Error('too many name hops');
}

/** One record from a response. */
export interface MdnsRecord {
	name: string;
	type: number;
	/** PTR: the target name. SRV: the target host. A: the address. */
	data: string;
	/** SRV only. */
	port?: number;
	/** PTR only: the instance's first label, as a person would read it. */
	instance?: string;
}

/** Every answer/authority/additional record in a response. Never throws; a bad packet yields []. */
export function parseMdnsResponse(buf: Buffer): MdnsRecord[] {
	const out: MdnsRecord[] = [];
	try {
		if (buf.length < 12) {
			return out;
		}
		const qd = buf.readUInt16BE(4);
		const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
		let pos = 12;
		for (let i = 0; i < qd; i++) {
			pos = readName(buf, pos).next + 4;
		}
		for (let i = 0; i < total; i++) {
			const name = readName(buf, pos);
			pos = name.next;
			const type = buf.readUInt16BE(pos);
			const rdlen = buf.readUInt16BE(pos + 8);
			const rd = pos + 10;
			pos = rd + rdlen;
			if (pos > buf.length) {
				break;
			}
			const owner = name.labels.join('.').toLowerCase();
			if (type === TYPE_PTR) {
				const target = readName(buf, rd).labels;
				out.push({ name: owner, type, data: target.join('.').toLowerCase(), instance: target[0] });
			} else if (type === TYPE_SRV) {
				out.push({ name: owner, type, data: readName(buf, rd + 6).labels.join('.').toLowerCase(), port: buf.readUInt16BE(rd + 4) });
			} else if (type === TYPE_A && rdlen === 4) {
				out.push({ name: owner, type, data: Array.from(buf.subarray(rd, rd + 4)).join('.') });
			}
		}
	} catch {
		// keep what was read before the bad part
	}
	return out;
}

/** A service instance someone announced. */
export interface MdnsService {
	driver: string;
	/** The instance's name, e.g. "Ada's Postgres". */
	instance: string;
	/** The address to connect to (the A record, else the SRV target's name). */
	host: string;
	port: number;
}

/** Put the records together: PTR → SRV → A. Pure. */
export function servicesFromRecords(records: MdnsRecord[]): MdnsService[] {
	const out = new Map<string, MdnsService>();
	for (const ptr of records.filter((r) => r.type === TYPE_PTR && MDNS_SERVICES[r.name])) {
		const srv = records.find((r) => r.type === TYPE_SRV && r.name === ptr.data);
		if (!srv || !srv.port) {
			continue;
		}
		const a = records.find((r) => r.type === TYPE_A && r.name === srv.data);
		const host = a?.data ?? srv.data.replace(/\.$/, '');
		const key = `${host}:${srv.port}`;
		if (!out.has(key)) {
			out.set(key, { driver: MDNS_SERVICES[ptr.name], instance: ptr.instance ?? ptr.data, host, port: srv.port });
		}
	}
	return [...out.values()];
}

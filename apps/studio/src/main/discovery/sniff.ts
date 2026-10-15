/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a database port SAYS it is.
//
// An open port is a guess; a greeting is an answer. So each well-known port is probed with the
// cheapest exchange that makes its server identify itself, and only a port that has no such
// exchange here is reported on being open alone (and then offered, not selected). Pure: bytes in,
// verdict out. `probe.ts` does the socket part.

/** How a port is asked what it is. */
export type SniffKind = 'mysql' | 'postgres' | 'clickhouse' | 'tcp';

/** One well-known port and what it usually is. */
export interface ProbePort {
	port: number;
	/** The driver it would be, if it answers as expected. */
	driver: string;
	sniff: SniffKind;
	/** The default username for that engine, when there is one. */
	user?: string;
}

/**
 * The ports probed: every default port we know a driver for, plus MongoDB's. Redshift's 5439 is
 * asked the Postgres question, since nothing local answers on it but a Postgres.
 */
export const PROBE_PORTS: ProbePort[] = [
	{ port: 5432, driver: 'postgres', sniff: 'postgres', user: 'postgres' },
	{ port: 3306, driver: 'mysql-aurora', sniff: 'mysql', user: 'root' },
	{ port: 1433, driver: 'sqlserver', sniff: 'tcp', user: 'sa' },
	{ port: 1521, driver: 'oracle', sniff: 'tcp', user: 'system' },
	{ port: 8123, driver: 'clickhouse', sniff: 'clickhouse', user: 'default' },
	{ port: 27017, driver: 'mongodb', sniff: 'tcp' },
	{ port: 50000, driver: 'db2', sniff: 'tcp', user: 'db2inst1' },
	{ port: 5439, driver: 'postgres', sniff: 'postgres', user: 'postgres' },
	{ port: 30015, driver: 'hana', sniff: 'tcp', user: 'SYSTEM' },
];

/** Postgres's SSLRequest: length 8, code 80877103. A server answers one byte, S or N. */
export const PG_SSL_REQUEST = Buffer.from('00000008 04d2162f'.replace(/\s/g, ''), 'hex');

/** What ClickHouse is asked on its HTTP port. */
export const CLICKHOUSE_PING = 'GET /ping HTTP/1.0\r\nHost: localhost\r\n\r\n';

/** A verdict: which engine answered, and anything it said worth showing. */
export interface SniffVerdict {
	driver: string;
	/** "MySQL 8.0.36", "MariaDB 10.11.6". */
	product?: string;
	/** A note worth passing on (e.g. the server refused this host). */
	note?: string;
}

/**
 * Read a MySQL/MariaDB server's first packet: a 4-byte header, then protocol version 10 and a
 * NUL-terminated version string; or an error packet (0xff) when the server refuses this host,
 * which is still a MySQL answering. Returns null for anything else.
 */
export function sniffMysqlGreeting(buf: Buffer): SniffVerdict | null {
	if (buf.length < 5) {
		return null;
	}
	const payloadLen = buf.readUIntLE(0, 3);
	if (payloadLen < 1 || payloadLen > 1024) {
		return null;
	}
	const kind = buf[4];
	if (kind === 0x0a) {
		const end = buf.indexOf(0, 5);
		if (end === -1) {
			return null;
		}
		const version = buf.subarray(5, end).toString('latin1');
		if (!/^\d+\.\d+/.test(version)) {
			return null;
		}
		if (/mariadb/i.test(version)) {
			// MariaDB prefixes "5.5.5-" for old clients; the real version follows it.
			const real = /^(?:5\.5\.5-)?(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? version;
			return { driver: 'mariadb', product: `MariaDB ${real}` };
		}
		return { driver: 'mysql-aurora', product: `MySQL ${/^\d+\.\d+\.\d+/.exec(version)?.[0] ?? version}` };
	}
	if (kind === 0xff && buf.length >= 7) {
		const text = buf.subarray(7, 4 + payloadLen).toString('utf8').replace(/^#\w{5}/, '').trim();
		return { driver: 'mysql-aurora', product: 'MySQL', note: text ? `The server said: ${text}` : undefined };
	}
	return null;
}

/** A Postgres answers an SSLRequest with exactly one byte, 'S' or 'N'. */
export function sniffPostgresSslReply(buf: Buffer): SniffVerdict | null {
	if (buf.length >= 1 && (buf[0] === 0x53 || buf[0] === 0x4e)) {
		return { driver: 'postgres', product: 'PostgreSQL', note: buf[0] === 0x53 ? 'TLS available.' : undefined };
	}
	return null;
}

/** ClickHouse answers GET /ping with a 200 whose body is "Ok.". */
export function sniffClickhousePing(response: string): SniffVerdict | null {
	const [head, ...rest] = response.split(/\r?\n\r?\n/);
	if (!/^HTTP\/1\.[01] 200\b/.test(head ?? '')) {
		return null;
	}
	return rest.join('\n\n').trim() === 'Ok.' ? { driver: 'clickhouse', product: 'ClickHouse' } : null;
}

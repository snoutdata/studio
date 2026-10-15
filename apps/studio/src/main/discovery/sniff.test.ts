/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PG_SSL_REQUEST, sniffClickhousePing, sniffMysqlGreeting, sniffPostgresSslReply } from './sniff';

function mysqlPacket(payload: Buffer): Buffer {
	const head = Buffer.alloc(4);
	head.writeUIntLE(payload.length, 0, 3);
	return Buffer.concat([head, payload]);
}

test('a MySQL greeting names MySQL and its version', () => {
	const greeting = mysqlPacket(Buffer.concat([Buffer.from([0x0a]), Buffer.from('8.0.36\0'), Buffer.alloc(20)]));
	assert.deepEqual(sniffMysqlGreeting(greeting), { driver: 'mysql-aurora', product: 'MySQL 8.0.36' });
});

test('a MariaDB greeting says MariaDB, past the 5.5.5- prefix', () => {
	const greeting = mysqlPacket(Buffer.concat([Buffer.from([0x0a]), Buffer.from('5.5.5-10.11.6-MariaDB-1:10.11.6+maria~ubu2204\0'), Buffer.alloc(20)]));
	assert.deepEqual(sniffMysqlGreeting(greeting), { driver: 'mariadb', product: 'MariaDB 10.11.6' });
});

test('an error packet (host not allowed) is still a MySQL', () => {
	const err = mysqlPacket(Buffer.concat([Buffer.from([0xff, 0x6a, 0x04]), Buffer.from("Host '10.0.0.9' is not allowed to connect to this MySQL server")]));
	const v = sniffMysqlGreeting(err);
	assert.equal(v?.driver, 'mysql-aurora');
	assert.match(v?.note ?? '', /not allowed/);
});

test('anything else on 3306 is not a MySQL', () => {
	assert.equal(sniffMysqlGreeting(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')), null);
	assert.equal(sniffMysqlGreeting(Buffer.from([1, 0, 0])), null);
	assert.equal(sniffMysqlGreeting(mysqlPacket(Buffer.concat([Buffer.from([0x0a]), Buffer.from('hello\0')]))), null);
});

test('the SSLRequest is the documented 8 bytes, and S or N is a Postgres', () => {
	assert.equal(PG_SSL_REQUEST.toString('hex'), '0000000804d2162f');
	assert.equal(sniffPostgresSslReply(Buffer.from('S'))?.driver, 'postgres');
	assert.equal(sniffPostgresSslReply(Buffer.from('N'))?.driver, 'postgres');
	assert.equal(sniffPostgresSslReply(Buffer.from('H')), null);
	assert.equal(sniffPostgresSslReply(Buffer.alloc(0)), null);
});

test('ClickHouse: 200 with body "Ok."', () => {
	assert.equal(sniffClickhousePing('HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\nOk.\n')?.driver, 'clickhouse');
	assert.equal(sniffClickhousePing('HTTP/1.1 200 OK\r\n\r\n<html>'), null);
	assert.equal(sniffClickhousePing('HTTP/1.1 404 Not Found\r\n\r\nOk.'), null);
});

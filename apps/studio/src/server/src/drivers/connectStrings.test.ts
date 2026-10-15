/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { assertHanaFields, assertSnowflakeAccount, db2ConnectString, oracleConnectString } from './connectStrings';

/** Read a CLI connection string the way the Db2 CLI does: `KEY=value;`, a value in `{}` running to its `}`. */
function parseDsn(dsn: string): Map<string, string[]> {
	const keys = new Map<string, string[]>();
	let i = 0;
	while (i < dsn.length) {
		const eq = dsn.indexOf('=', i);
		if (eq < 0) {
			break;
		}
		const key = dsn.slice(i, eq).trim().toUpperCase();
		let value: string;
		if (dsn[eq + 1] === '{') {
			const close = dsn.indexOf('}', eq + 2);
			value = dsn.slice(eq + 2, close);
			i = dsn.indexOf(';', close) + 1 || dsn.length;
		} else {
			const semi = dsn.indexOf(';', eq + 1);
			value = dsn.slice(eq + 1, semi < 0 ? dsn.length : semi);
			i = semi < 0 ? dsn.length : semi + 1;
		}
		keys.set(key, [...(keys.get(key) ?? []), value]);
	}
	return keys;
}

const db2 = { database: 'SAMPLE', username: 'db2inst1', password: 'secret', ssl: undefined };

describe('the Db2 connection string', () => {
	test('a plain connection reads back as exactly its fields', () => {
		const keys = parseDsn(db2ConnectString(db2, 'db2.internal', 50000));
		assert.deepEqual([...keys.keys()], ['DATABASE', 'HOSTNAME', 'PORT', 'PROTOCOL', 'UID', 'PWD', 'CONNECTTIMEOUT']);
		assert.deepEqual(keys.get('HOSTNAME'), ['db2.internal']);
		assert.deepEqual(keys.get('PWD'), ['secret']);
	});

	test('a database or user name carrying another keyword is refused, so no injected keyword can appear', () => {
		const injected = 'X;HOSTNAME=attacker.example;PORT=50000';
		for (const config of [{ ...db2, database: injected }, { ...db2, username: injected }, { ...db2, database: 'X{' }, { ...db2, username: 'a}b' }, { ...db2, database: 'A\nB' }]) {
			assert.throws(() => db2ConnectString(config, 'db2.internal', 50000), /Db2: the (database|user name) may not contain/);
		}
		assert.throws(() => db2ConnectString(db2, 'h;HOSTNAME=attacker.example', 50000), /Db2: the host may not contain/);
	});

	test('a password with ";" is one braced value, and cannot add a keyword', () => {
		const password = 'pa;ss;HOSTNAME=attacker.example';
		const dsn = db2ConnectString({ ...db2, password }, 'db2.internal', 50000);
		const keys = parseDsn(dsn);
		assert.deepEqual(keys.get('HOSTNAME'), ['db2.internal']);
		assert.deepEqual(keys.get('PWD'), [password]);
		assert.equal(dsn.includes(`PWD={${password}};`), true);
		// A leading brace or space is braced too; a password that needs braces and holds "}" is refused.
		assert.deepEqual(parseDsn(db2ConnectString({ ...db2, password: '{x' }, 'h', 1)).get('PWD'), ['{x']);
		assert.deepEqual(parseDsn(db2ConnectString({ ...db2, password: ' x' }, 'h', 1)).get('PWD'), [' x']);
		assert.throws(() => db2ConnectString({ ...db2, password: 'a;b}c' }, 'h', 1), /cannot also hold "}"/);
		// "}" alone needs no braces and is passed as typed.
		assert.deepEqual(parseDsn(db2ConnectString({ ...db2, password: 'a}b' }, 'h', 1)).get('PWD'), ['a}b']);
	});
});

describe('the Oracle Easy Connect string', () => {
	test('host:port/service, and tcps with SSL', () => {
		assert.equal(oracleConnectString({ database: 'ORCLPDB1' }, 'ora.internal', 1521), 'ora.internal:1521/ORCLPDB1');
		assert.equal(oracleConnectString({ database: 'ORCLPDB1', ssl: { rejectUnauthorized: true } }, 'ora.internal', 2484), 'tcps://ora.internal:2484/ORCLPDB1');
		assert.equal(oracleConnectString({ database: 'svc.example.com' }, '[::1]', 1521), '[::1]:1521/svc.example.com');
	});

	test('a service or host carrying a parameter, a second address or a descriptor is refused', () => {
		for (const database of ['orcl?ssl_server_dn_match=off', 'orcl?https_proxy=attacker.example&https_proxy_port=80', '(DESCRIPTION=(ADDRESS=(HOST=attacker.example)))', 'a@b', 'a b', 'a,b']) {
			assert.throws(() => oracleConnectString({ database, ssl: true }, 'ora.internal', 2484), /Oracle: the service name may not contain/, database);
		}
		assert.throws(() => oracleConnectString({ database: 'orcl' }, 'ora.internal,attacker.example', 1521), /Oracle: the host may not contain/);
		assert.throws(() => oracleConnectString({ database: 'orcl' }, 'ora.internal/x?wallet_location=/tmp', 1521), /Oracle: the host may not contain/);
	});
});

describe('HANA and Snowflake fields', () => {
	test('HANA refuses a ";" in the user or tenant and a second server node in the host', () => {
		assert.doesNotThrow(() => assertHanaFields({ username: 'SYSTEM', database: 'HXE' }, 'hana.internal'));
		assert.throws(() => assertHanaFields({ username: 'SYSTEM', database: 'HXE;serverNode=attacker.example:30015' }, 'hana.internal'), /tenant database/);
		assert.throws(() => assertHanaFields({ username: 'X;serverNode=attacker.example:30015', database: 'HXE' }, 'hana.internal'), /user name/);
		assert.throws(() => assertHanaFields({ username: 'SYSTEM' }, 'hana.internal:30015,attacker.example'), /host/);
	});

	test('a Snowflake account is a hostname label and nothing else', () => {
		for (const account of ['xy12345', 'xy12345.eu-central-1', 'myorg-my_account']) {
			assert.doesNotThrow(() => assertSnowflakeAccount(account), account);
		}
		for (const account of ['attacker.example/', 'attacker.example#', 'x@attacker.example', 'attacker.example:443', 'x?y']) {
			assert.throws(() => assertSnowflakeAccount(account), /Snowflake: the account/, account);
		}
	});
});

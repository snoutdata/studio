/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { rootCertificates } from 'node:tls';

import { resolveSsl } from './sslCerts';
import type { ConnectionConfig } from '../shared/connection';

function connection(ssl: ConnectionConfig['ssl']): ConnectionConfig {
	return { id: 'c1', label: 'c', driver: 'clickhouse', host: 'h', port: 8443, database: '', username: 'u', ssl } as ConnectionConfig;
}

/** How many `-----BEGIN CERTIFICATE-----` blocks a PEM blob holds. */
function certCount(pem: string | undefined): number {
	return (pem ?? '').split('-----BEGIN CERTIFICATE-----').length - 1;
}

describe('resolveSsl', () => {
	// The bug this exists for: Node's `ca` option REPLACES the default trust store. Handing it the
	// RDS bundle alone made every publicly-signed server fail with "unable to get local issuer
	// certificate", and `rds` is the mode a new connection starts in. It is what stopped the app
	// reaching ClickHouse Cloud, whose endpoint has an ordinary public certificate.
	it('adds the RDS roots to the public ones rather than replacing them', () => {
		const resolved = resolveSsl(connection({ rejectUnauthorized: true, caBundle: 'rds' }));
		const ca = typeof resolved.ssl === 'object' ? resolved.ssl.ca : undefined;
		assert.ok(ca, 'rds mode must resolve to a CA blob');
		assert.ok(certCount(ca) > rootCertificates.length, 'the blob must hold the public roots AND the RDS ones');
		for (const root of rootCertificates.slice(0, 5)) {
			assert.ok(ca!.includes(root.trim()), 'a public root is missing from the resolved bundle');
		}
	});

	it('keeps rejectUnauthorized and drops the selector the drivers do not understand', () => {
		const resolved = resolveSsl(connection({ rejectUnauthorized: true, caBundle: 'rds' }));
		assert.equal(typeof resolved.ssl === 'object' && resolved.ssl.rejectUnauthorized, true);
		assert.equal(typeof resolved.ssl === 'object' && 'caBundle' in resolved.ssl, false);
	});

	// `system` mode is the one that means "whatever the OS and Node already trust", and it says so
	// by sending NO ca at all. Sending one would narrow it.
	it('sends no CA for system mode, which is what makes it the system store', () => {
		const resolved = resolveSsl(connection({ rejectUnauthorized: true }));
		assert.equal(typeof resolved.ssl === 'object' && resolved.ssl.ca, undefined);
	});

	it('leaves ssl true and ssl absent alone', () => {
		assert.equal(resolveSsl(connection(true)).ssl, true);
		assert.equal(resolveSsl(connection(undefined)).ssl, undefined);
	});

	it('explains a custom CA that cannot be read, naming the path', () => {
		assert.throws(
			() => resolveSsl(connection({ rejectUnauthorized: true, caPath: 'C:/nope/missing-ca.pem' })),
			/could not read "C:\/nope\/missing-ca\.pem"/,
		);
	});
});

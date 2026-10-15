/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

import type { ConnectionConfig, SslConfig } from '../shared/connection';
import { RDS_CA_BUNDLE } from './rdsCaBundle';

// Resolves a connection's TLS settings into the concrete `{ rejectUnauthorized, ca }`
// shape the server drivers consume. The form/config stores only *which* CA to trust
// (the bundled Amazon RDS bundle or a custom .pem path); the actual certificate text is
// loaded here, in main, at connect/test time, so the bundle ships inside app.asar and a
// custom CA file is read from disk where the keychain/secrets already live. The server
// child never sees `caBundle`/`caPath`, only the resolved PEM.

/**
 * The Amazon RDS roots PLUS the public roots Node already trusts.
 *
 * Node's `ca` option REPLACES the default trust store rather than adding to it, so handing it the
 * RDS bundle alone makes every publicly-signed server fail with "unable to get local issuer
 * certificate". That is not a hypothetical: `rds` is the mode a new connection starts in, and it
 * is what stopped the app reaching ClickHouse Cloud at all, whose endpoint uses an ordinary public
 * certificate. The setting's own description says the RDS root "isn't in the system trust store",
 * which is a reason to ADD it, not a reason to trust nothing else.
 */
function rdsAndPublicRoots(): string {
	return [...rootCertificates, RDS_CA_BUNDLE].join('\n');
}

/** Read the CA PEM for an ssl config, or undefined when no specific CA is requested. */
function resolveCa(ssl: SslConfig): string | undefined {
	if (ssl.caBundle === 'rds') {
		return rdsAndPublicRoots();
	}
	if (ssl.caPath) {
		try {
			return readFileSync(ssl.caPath, 'utf8');
		} catch (err) {
			throw new Error(`SSL CA certificate: could not read "${ssl.caPath}" (${err instanceof Error ? err.message : String(err)}).`);
		}
	}
	return ssl.ca;
}

/**
 * Return a copy of `config` whose `ssl` is reduced to what the drivers understand:
 * a plain `{ rejectUnauthorized, ca }` (or the original `true`/`false`/absent). The
 * `caBundle`/`caPath` selectors are resolved to the CA PEM here and then dropped.
 */
export function resolveSsl(config: ConnectionConfig): ConnectionConfig {
	const ssl = config.ssl;
	if (!ssl || ssl === true) {
		return config;
	}
	const ca = resolveCa(ssl);
	const resolved: SslConfig = { rejectUnauthorized: ssl.rejectUnauthorized };
	if (ca) {
		resolved.ca = ca;
	}
	return { ...config, ssl: resolved };
}

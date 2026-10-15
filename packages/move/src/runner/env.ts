/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How a spawned Postgres tool learns where to connect: its environment, never its arguments.
 *
 * A password on argv shows up in every process listing on the machine; in `PGPASSWORD` it is
 * visible only to the same user, who already holds it. The environment is built from scratch for
 * the PG* part, so a `PGSERVICE`, `PGOPTIONS` or stray `PGHOST` in the user's own shell cannot
 * change which database a move writes to.
 *
 * libpq also reads FILES on its own, from defaults that no variable has to mention: `~/.pgpass`
 * for a password, `~/.postgresql/postgresql.crt` and `.key` for a client certificate it presents to
 * any server that asks, `~/.postgresql/root.crt` for trust, and the service files. Each of those is
 * pointed at a path inside a fresh private directory that holds nothing, and Kerberos/SSPI (the
 * user's own login, offered to a server that asks for it) is refused, so the only credential a
 * tool can offer is the one the move spec supplied.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type PgSslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export interface PgAccess {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly password: string | null;
	readonly database: string;
	readonly sslmode: PgSslMode;
	/**
	 * The certificates a `verify-full` connection trusts, as PEM. libpq does not read the operating
	 * system's store on every platform, so the host hands over the same roots its own driver trusts.
	 */
	readonly caPem: string | null;
}

export interface ToolEnv {
	readonly env: NodeJS.ProcessEnv;
	/** Remove the certificate file written for this run, if one was. */
	dispose(): void;
}

export function toolEnv(access: PgAccess, base: NodeJS.ProcessEnv = process.env): ToolEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(base)) {
		if (!/^PG/i.test(name)) {
			env[name] = value;
		}
	}
	env.PGHOST = access.host;
	env.PGPORT = String(access.port);
	env.PGUSER = access.user;
	env.PGDATABASE = access.database;
	env.PGSSLMODE = access.sslmode;
	env.PGAPPNAME = 'snoutdata move';
	env.PGCONNECT_TIMEOUT = '30';
	if (access.password !== null) {
		env.PGPASSWORD = access.password;
	}

	// A directory of our own, created empty, so a path inside it names a file that does not exist
	// and that nobody else could have put there (a fixed path under a shared /tmp could be).
	let dir: string | null = mkdtempSync(join(tmpdir(), 'snout-move-'));
	const nothing = (name: string): string => join(dir!, name);
	env.PGPASSFILE = nothing('no-pgpass');
	env.PGSSLCERT = nothing('no-client.crt');
	env.PGSSLKEY = nothing('no-client.key');
	env.PGSSLROOTCERT = nothing('no-root.crt');
	env.PGSERVICEFILE = nothing('no-service.conf');
	env.PGSYSCONFDIR = dir;
	// The user's Kerberos ticket or Windows login is a credential too, offered to whichever server
	// asks for GSSAPI or SSPI. Not encrypting with it, and not authenticating with it.
	env.PGGSSENCMODE = 'disable';
	env.PGREQUIREAUTH = '!gss,!sspi';

	try {
		if (access.sslmode === 'verify-full') {
			if (!access.caPem) {
				throw new Error(`No certificates were given to verify ${access.host} against.`);
			}
			const file = join(dir, 'roots.pem');
			writeFileSync(file, access.caPem, { mode: 0o600 });
			env.PGSSLROOTCERT = file;
		}
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	return {
		env,
		dispose(): void {
			if (dir) {
				rmSync(dir, { recursive: true, force: true });
				dir = null;
			}
		}
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type Database from 'better-sqlite3';

/*
 * Opening a SQLite file, lazily (the flows ledger, the dashboards samples, the failure memory).
 *
 * Why this indirection exists, from the v1.0.17 postmortem: `import Database from 'better-sqlite3'`
 * at the top of a store is a `require` of a NATIVE binary at MAIN-PROCESS STARTUP. When the shipped
 * binary was built for the wrong runtime, that throw happened before the first window existed, so a
 * packaging mistake in one optional feature took the whole app down — no window, no menu, no way
 * for the user to even read the error.
 *
 * Loading it on first use instead means a broken or missing binary breaks exactly the feature that
 * needs a database, and the app still starts. `startup is sacred` is usually about
 * speed; this is the other half of it.
 */

/** The message a user sees if the native module cannot load at all. Names the feature the caller
 *  was in, since "better-sqlite3" means nothing to them. */
export class SqliteUnavailableError extends Error {
	constructor(readonly feature: string, readonly cause: unknown) {
		super(`${feature} needs its local database, which this build cannot load. Reinstalling the app usually fixes it.`);
		this.name = 'SqliteUnavailableError';
	}
}

/** Open (or create) a SQLite database, requiring the native module only now. `options` is passed
 *  through, which is how another tool's database is opened read-only (`{ readonly: true }`). */
export function openDatabase(path: string, feature: string, options?: Database.Options): Database.Database {
	let ctor: typeof Database;
	try {
		// A runtime require, deliberately: the main bundle is CJS, and a static import would move
		// this load back to startup, which is the failure mode being avoided.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		ctor = require('better-sqlite3') as typeof Database;
	} catch (err) {
		throw new SqliteUnavailableError(feature, err);
	}
	return new ctor(path, options);
}

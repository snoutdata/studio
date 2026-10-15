/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';

import type { ConnectionConfig } from '../../shared/connection';
import type { TestConnectionResult } from '../../shared/protocol';
import type { DatabaseDriver } from './drivers/databaseDriver';

/**
 * A Test: connect, ping, disconnect, touching no cache and no active set.
 *
 * SQLite and DuckDB are files on this computer, and both CREATE an empty database when asked to
 * open a path that is not there in their normal read-write mode. A Test must never leave a file
 * behind (a typo, or a path someone else chose), so for those two it opens the file read-only,
 * which is each engine's no-create mode (node:sqlite `readOnly` is SQLITE_OPEN_READONLY; DuckDB's
 * `access_mode=READ_ONLY` refuses a missing file), and says plainly when there is no file.
 */

/** The drivers whose database is a file path (in `database`, or `host` on an imported one). */
const FILE_DRIVERS = new Set(['sqlite', 'duckdb']);

/** The config a Test opens: a file database read-only, so opening it can never create it. */
export function configForTest(config: ConnectionConfig): ConnectionConfig {
	return FILE_DRIVERS.has(config.driver) ? { ...config, readOnly: true } : config;
}

export async function testConnection(config: ConnectionConfig, createDriver: (id: string) => DatabaseDriver): Promise<TestConnectionResult> {
	if (FILE_DRIVERS.has(config.driver)) {
		const file = config.database || config.host;
		if (file && file !== ':memory:' && !existsSync(file)) {
			return { ok: false, error: `There is no database file at ${file}. A test opens an existing file and never creates one.` };
		}
	}
	let driver: DatabaseDriver | undefined;
	try {
		driver = createDriver(config.driver);
		await driver.connect(configForTest(config));
		await driver.ping();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		await driver?.disconnect().catch(() => undefined);
	}
}
